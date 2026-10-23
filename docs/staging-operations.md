# Staging API operations

Prepared 2026-10-23 against backend baseline `b343bf2` (5.6.1). These are reviewable operator instructions, not evidence that resources exist. Repository checks, provisioning, deployment, and live acceptance are separate milestones. No frontend repository changes are part of this implementation.

## Runtime contract

`src/config/deployment.ts` validates staging before SQL pool construction and inside Firebase, Firestore, and Storage factories, including cached-client access. The reserved `K_SERVICE=urbanists-cloud-api-staging` cannot run without `DEPLOY_ENV=staging`. Staging requires production Auth/App Check behavior, full `BUILD_COMMIT`, nonempty API-key JSON and SQL password, and every explicit store identifier. Explicit Firestore overrides cannot select another database.

Suggestions, notices, contact challenges, recommendation records, presentation sessions, Streetmix receipts/location caches, and Assist quotas use `public-improvements-staging`. PostgreSQL uses `urbanists_staging` as database and login. Uploads use `urbanists-suggestion-photos-staging-143738155808`. CORS and both socket upgrade paths accept the canonical browser origin exclusively; requests without an Origin retain existing server-client behavior. CORS is not an authorization or data isolation boundary.

Staff assignment/removal returns the existing Forbidden response convention after normal API-key, production App Check, and private staff checks, before calling the mutation service. The service also rejects direct calls, and staff migration apply mode rejects staging. Shared accounts and sessions must never be seeded/reset. IAM must independently deny Auth writes.

`/api/health` describes configured deployment identity, including actual selected Firestore database, environment, commit, and optional Cloud Run revision. It does not check store readiness. Non-staging deployments retain their existing defaults; unset commit metadata is null. The existing production `npm run deploy` command is unchanged. Never run it for staging.

## Operator preflight (read only)

Use Google Cloud CLI, Firebase CLI, GitHub CLI, PostgreSQL client tools compatible with the server, and Node 24. Keep evidence in an access-controlled operator workspace outside uploaded source. Discover billing/API availability and numeric identities. Inspect existing resources before any creation; reuse matching resources. Stop on a name collision or settings that would disrupt shared production resources.

The examples below use Bash in Cloud Shell. Every mutating `gcloud`, `firebase`, or `psql` command is wrapped in `run`, which prints a shell-escaped plan by default. Set the script argument to `--apply` only after separate authorization and review. Do not enable shell tracing. Read-only discovery commands run normally. Do not paste passwords or keys into these commands.

```bash
set -euo pipefail
APPLY=false
if [[ "${1:-}" == --apply ]]; then APPLY=true; fi
run() { if "$APPLY"; then "$@"; else printf '%q ' "$@"; printf '\n'; fi; }
PROJECT=urbanists-mixer-slides-helper
REGION=us-central1
RUNTIME=api-staging-runtime@$PROJECT.iam.gserviceaccount.com
BUILD=api-staging-build@$PROJECT.iam.gserviceaccount.com
DEPLOYER=api-staging-deployer@$PROJECT.iam.gserviceaccount.com
FRONTEND=map-staging-deployer@$PROJECT.iam.gserviceaccount.com
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')
gh api repos/DallasUrbanists/cloud-api-server --jq '{id,owner_id:.owner.id,full_name}'
gh api repos/DallasUrbanists/improvement-map --jq '{id,owner_id:.owner.id,full_name}'
gcloud firestore databases list --project="$PROJECT"
gcloud firestore databases describe --project="$PROJECT" --database=public-improvements \
  --format='yaml(name,locationId,type,concurrencyMode,appEngineIntegrationMode,pointInTimeRecoveryEnablement,deleteProtectionState)'
gcloud firestore indexes composite list --project="$PROJECT" --database=public-improvements --format=json > production-indexes.json
gcloud firestore indexes fields list --project="$PROJECT" --database=public-improvements --format=json > production-field-overrides.json
gcloud firestore fields ttls list --project="$PROJECT" --database=public-improvements --format=json > production-ttls.json
gcloud storage buckets describe gs://urbanists-suggestion-photos \
  --format='yaml(location,storageClass,iamConfiguration,cors)'
gcloud run services describe urbanists-cloud-api-server --project="$PROJECT" --region="$REGION" \
  --format='yaml(spec.template.spec.containers.resources,spec.template.spec.containerConcurrency,spec.template.spec.timeoutSeconds,spec.template.metadata.annotations."autoscaling.knative.dev/minScale",spec.template.metadata.annotations."autoscaling.knative.dev/maxScale",spec.template.metadata.annotations."run.googleapis.com/cpu-throttling",spec.template.metadata.annotations."run.googleapis.com/vpc-access-connector",spec.template.metadata.annotations."run.googleapis.com/vpc-access-egress",spec.template.spec.serviceAccountName,metadata.annotations."run.googleapis.com/ingress",status.traffic)'
gcloud sql instances describe contacts-relationships-db --project="$PROJECT" \
  --format='yaml(connectionName,databaseVersion,region,settings.ipConfiguration.requireSsl)'
gcloud sql databases list --instance=contacts-relationships-db --project="$PROJECT"
gcloud iam service-accounts list --project="$PROJECT" --format='table(email,disabled)'
gcloud secrets list --project="$PROJECT" --format='table(name)'
firebase hosting:sites:list --project "$PROJECT"
```

Do not dump production container environment entries or secret payloads. Review runtime CPU/memory, concurrency, scaling, CPU allocation, timeout, ingress, networking, startup behavior and any constraints. Record deliberate staging deviations. The deploy script requires `STAGING_CPU`, `STAGING_MEMORY`, `STAGING_CONCURRENCY`, `STAGING_MIN_INSTANCES`, `STAGING_MAX_INSTANCES`, `STAGING_INGRESS`, and `STAGING_CPU_THROTTLING` (`true`/`false`) in the backend GitHub `staging` Environment. Set public-compatible ingress after review; health verification needs access to the generated and tagged URLs. Timeout is explicitly 3600 seconds for socket compatibility. No performance parity is claimed.

## Stores and identities (separately authorized provisioning)

Set `FIRESTORE_LOCATION` and `BUCKET_LOCATION` from the reviewed production settings, not from the API region. Review database mode and other settings before creating; the example assumes confirmed Native mode. Enable required APIs only if missing, under the operator identity, outside deployment: Run, Cloud Build, Artifact Registry, Firestore, SQL Admin, Secret Manager, IAM Credentials, STS, and Firebase Hosting.

```bash
: "${FIRESTORE_LOCATION:?record verified location}"
: "${BUCKET_LOCATION:?record verified location}"
# Run each create only for a confirmed absent resource.
run gcloud firestore databases create --project="$PROJECT" --database=public-improvements-staging \
  --location="$FIRESTORE_LOCATION" --type=firestore-native --delete-protection
run gcloud storage buckets create gs://urbanists-suggestion-photos-staging-143738155808 \
  --project="$PROJECT" --location="$BUCKET_LOCATION" --uniform-bucket-level-access
run gcloud storage buckets update gs://urbanists-suggestion-photos-staging-143738155808 \
  --cors-file=gcp/cors-staging.json
for id in api-staging-runtime api-staging-build api-staging-deployer map-staging-deployer; do
  run gcloud iam service-accounts create "$id" --project="$PROJECT"
done
for secret in improvement-map-staging-api-keys urbanists-staging-db-password; do
  run gcloud secrets create "$secret" --project="$PROJECT" --replication-policy=automatic
  run gcloud secrets add-iam-policy-binding "$secret" --project="$PROJECT" \
    --member="serviceAccount:$RUNTIME" --role=roles/secretmanager.secretAccessor
done
run gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$RUNTIME" \
  --role=roles/datastore.user \
  --condition='expression=resource.name=="projects/urbanists-mixer-slides-helper/databases/public-improvements-staging",title=staging-firestore-only'
run gcloud storage buckets add-iam-policy-binding gs://urbanists-suggestion-photos-staging-143738155808 \
  --member="serviceAccount:$RUNTIME" --role=roles/storage.objectUser
# Public image URL contract: review org policy and match existing public delivery behavior first.
run gcloud storage buckets add-iam-policy-binding gs://urbanists-suggestion-photos-staging-143738155808 \
  --member=allUsers --role=roles/storage.objectViewer
# Sign only as the runtime account itself; do not grant project-wide token creation.
run gcloud iam service-accounts add-iam-policy-binding "$RUNTIME" --project="$PROJECT" \
  --member="serviceAccount:$RUNTIME" --role=roles/iam.serviceAccountTokenCreator
run gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$RUNTIME" --role=roles/cloudsql.client
run gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$RUNTIME" --role=roles/firebaseauth.viewer
```

Create API-key JSON with the existing shape `[{"key":"<independent staging key>","name":"Improvement Map staging"}]` using independent staging entropy. Add secret versions through Secret Manager's secure input UI or stdin from an authorized password manager; never through command arguments or workflow variables. Set the SQL password through `psql`'s interactive `\password urbanists_staging`, transfer the same value directly into its staging secret. No production provider secrets are inherited. Do not use placeholder fixture credentials in cloud resources.

Reproduce all required composite indexes, field exemptions, and TTL settings from reviewed metadata against the staging database. For each required item, use the relevant command below, filling values from the export; never point an import at production. Do not copy production application documents.

```bash
run gcloud firestore indexes composite create --project="$PROJECT" --database=public-improvements-staging \
  --collection-group="$COLLECTION_GROUP" --query-scope="$QUERY_SCOPE" \
  --field-config="$FIRST_FIELD_CONFIG" --field-config="$SECOND_FIELD_CONFIG"
run gcloud firestore indexes fields update "$FIELD_PATH" --project="$PROJECT" \
  --database=public-improvements-staging --collection-group="$COLLECTION_GROUP" \
  --index="$REVIEWED_FIELD_INDEX_CONFIG"
run gcloud firestore fields ttls update "$TTL_FIELD" --project="$PROJECT" \
  --database=public-improvements-staging --collection-group="$TTL_COLLECTION_GROUP" --enable-ttl
```

Wait for index readiness and verify field settings. In particular review presentation expiry fields, Streetmix cache expiry, and Assist quota policies. Missing indexes and TTL parity remain provisioning gaps until checked. If public access prevention prevents the current public-image URL contract, stop and resolve that dependency; do not change the API contract incidentally.

### SQL bootstrap and privilege audit

Use a separate schema-owning operator role. Connect to the existing instance through a secured proxy/tunnel or approved connection; use password prompts or a protected PostgreSQL password file. `PRODUCTION_DATABASE` must be discovered. Keep the schema export private: functions may contain sensitive configuration even without rows. Export only application schemas after reviewing extensions, functions, triggers, foreign servers, database links, security-definer functions, and external side effects.

```bash
# Read-only schema export; uses an existing read-authorized identity.
pg_dump --host=127.0.0.1 --port=5432 --username="$SCHEMA_READER" \
  --dbname="$PRODUCTION_DATABASE" --schema-only --no-owner --no-privileges \
  --file=reviewed-schema.sql
sha256sum reviewed-schema.sql
# Review the export before restoration. Do not replay migrations already in this baseline.
```

With authorized DBA credentials, inspect `pg_roles`, `pg_auth_members`, database owners, and existing names first. Create absent resources only. Do not use `gcloud sql users create` and assume the resulting account is restricted. In a reviewed DBA SQL script:

```sql
CREATE ROLE urbanists_staging LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
-- Set a password using interactive \password, never a literal in this file.
CREATE DATABASE urbanists_staging; -- owned by the executing schema operator, never the runtime login
```

Run creation through `run psql ... --set=ON_ERROR_STOP=1 --file=create-staging.sql`. If a role/database already exists, inspect its effective privileges and ownership rather than replacing it. The runtime must not be a member of `cloudsqlsuperuser`, any privileged inherited role, or any production owner role.

```bash
# All restore destinations are literal staging names. The runtime user does not restore schemas.
run psql --host=127.0.0.1 --port=5432 --username="$SCHEMA_OWNER" \
  --dbname=urbanists_staging --set=ON_ERROR_STOP=1 --single-transaction --file=reviewed-schema.sql
```

Record the schema hash, source schema revision, restore timestamp, extensions, and already-applied migrations. The checked-in migration directory is not an empty-database bootstrap. Apply only reviewed later migrations. Run this grant script as the owner, connected explicitly to `urbanists_staging` with `ON_ERROR_STOP=1`:

```sql
SELECT current_database() = 'urbanists_staging' AS correct_database \gset
\if :correct_database
REVOKE ALL ON DATABASE urbanists_staging FROM PUBLIC;
GRANT CONNECT ON DATABASE urbanists_staging TO urbanists_staging;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO urbanists_staging;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO urbanists_staging;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO urbanists_staging;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO urbanists_staging;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO urbanists_staging;
\else
\echo 'Refusing grants outside staging'
\quit 1
\endif
```

Audit each production database read-only, using `has_database_privilege`, `has_schema_privilege`, `has_table_privilege` and `has_function_privilege` for `urbanists_staging`, all inherited roles, and PUBLIC. Inspect default ACLs, security-definer functions and foreign servers. Test for INSERT/UPDATE/DELETE/TRUNCATE/TRIGGER/CREATE and write-capable EXECUTE, as well as object ownership. No destructive permission probes. If existing PUBLIC/inherited grants permit production writes, stop: production ACL changes require a separate reviewed authorization. `NOINHERIT` alone is insufficient if role membership allows `SET ROLE`.

### Source build and deployment IAM

Keep provisioning out of ordinary source deployment. Grant the backend deployer `roles/run.sourceDeveloper` and `roles/serviceusage.serviceUsageConsumer` on the project, and `roles/iam.serviceAccountUser` on the runtime and build accounts. Grant `roles/run.builder` to the dedicated build identity on the project. These source-build roles have project scope; this is not a claim that deployment credentials can only modify staging. Restrict OIDC aggressively and review actual effective permissions. An administrator may need to set the staging service's public invoker policy at bootstrap; do not solve `setIamPolicy` failures with project Owner/Editor. Pre-create/review the source Artifact Registry repository and build source bucket when required so deployers do not bootstrap unrelated infrastructure. Review custom build identity logging and source/artifact permissions under the current source-deployment requirements.

The deploy command explicitly retains public invocation with `--allow-unauthenticated`. After an authorized operator performs the first staging service bootstrap, grant the deployer `roles/run.admin` on that staging service so subsequent deploys can set its invocation policy. This service binding does not grant IAM administration over the production service. Complete bootstrap and the binding before enabling automatic publication; an absent service cannot receive a service-scoped binding in advance.

```bash
run gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$DEPLOYER" --role=roles/run.sourceDeveloper
run gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$DEPLOYER" --role=roles/serviceusage.serviceUsageConsumer
run gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$BUILD" --role=roles/run.builder
for identity in "$RUNTIME" "$BUILD"; do
  run gcloud iam service-accounts add-iam-policy-binding "$identity" --project="$PROJECT" \
    --member="serviceAccount:$DEPLOYER" --role=roles/iam.serviceAccountUser
done
# After the separately authorized first staging service bootstrap:
run gcloud run services add-iam-policy-binding urbanists-cloud-api-staging --project="$PROJECT" --region=us-central1 \
  --member="serviceAccount:$DEPLOYER" --role=roles/run.admin
```

Use IAM Policy Analyzer/Troubleshooter and reviewed ancestor policies to inspect effective runtime access. Firestore database conditions do not override broader roles. Confirm no production datastore/object/secret writes, Auth updates or session revocations; test necessary Auth reads and token verification. SQL IAM permits instance connection, while database grants provide application record isolation. Record the distinction. Runtime/build/deployer identities must not be interchangeable.

### WIF, Hosting, Auth and browser setup

Create separate backend/frontend pools or separate providers with equivalent restrictive bindings. Discover numeric repository/owner IDs using the preflight commands and project number from Google Cloud. The following is a backend example; repeat with distinct frontend pool/provider and its discovered IDs, repository name `improvement-map`, and `$FRONTEND` identity. Set GitHub Environment `staging` deployment branch policy to `staging` only. Keep `main` the default branch.

```bash
: "${BACKEND_REPOSITORY_ID:?discovered numeric ID}"
: "${OWNER_ID:?discovered numeric owner ID}"
POOL=api-staging
PROVIDER=github
run gcloud iam workload-identity-pools create "$POOL" --project="$PROJECT" --location=global --display-name='Backend staging'
CONDITION="assertion.repository_id=='$BACKEND_REPOSITORY_ID' && assertion.repository_owner_id=='$OWNER_ID' && assertion.ref=='refs/heads/staging' && assertion.sub=='repo:DallasUrbanists/cloud-api-server:environment:staging' && assertion.workflow_ref=='DallasUrbanists/cloud-api-server/.github/workflows/deploy-staging.yml@refs/heads/staging'"
run gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" --project="$PROJECT" --location=global \
  --workload-identity-pool="$POOL" --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping='google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id' \
  --attribute-condition="$CONDITION"
run gcloud iam service-accounts add-iam-policy-binding "$DEPLOYER" --project="$PROJECT" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL/attribute.repository_id/$BACKEND_REPOSITORY_ID"
run firebase hosting:sites:create map-staging-143738155808 --project "$PROJECT"
```

Authorize `map-staging-143738155808.web.app` in the existing Auth authorized domains and compatible App Check/reCAPTCHA settings through their administrative interfaces. Preserve all production domains and provider settings. Do not create a new Auth project or shared users. Provision a staging Maps browser key with HTTP referrers restricted to `https://map-staging-143738155808.web.app/*` and only needed APIs. Transfer keys directly into authorized GitHub secrets interfaces. Frontend Hosting deployment IAM must be separately reviewed; any project-wide `roles/firebasehosting.admin` grant must be recorded honestly. Do not modify the existing/default Hosting site. The frontend implementer owns its Hosting files and workflow.

## Deployment and fixtures

Backend `staging` Environment requires the seven reviewed runtime variables above plus `GCP_WORKLOAD_IDENTITY_PROVIDER` (full backend provider resource name). Runtime/build/deployer identity names and resource identifiers are fixed in the deployment script. Secret references are staging-only: `improvement-map-staging-api-keys:latest` and `urbanists-staging-db-password:latest`. Record resolved secret versions for each release; rotation through `latest` can affect later instance starts and rollbacks.

The workflow checks PRs targeting staging without cloud credentials. Staging pushes and dispatches on staging deploy only after Node 24 `npm ci`, `npm test`, and `npm run build`. The deployment checks out the tested SHA, grants OIDC only to the deployment job, serializes publication without cancelling active deployments, and checks the branch head before build/deploy and again before publication. A later push after that final check is handled by the next serialized run. It records previous traffic before deployment, deploys a tagged candidate, verifies health environment/SHA/revision/database, moves traffic, then verifies the service URL. A first deployment omits --no-traffic because Cloud Run rejects that flag for a new service; it receives initial traffic before verification and has no previous rollback target. Do not hand its URL to testers until verification succeeds. Failed post-publication checks require the recorded rollback procedure.

```bash
# Safe plan only; requires reviewed sizing variables but does not call cloud tools.
npm run deploy:staging
# Only after separate deployment authorization, on a clean identified staging checkout:
npm ci
npm test
npm run build
npm run deploy:staging -- --apply
```

The apply command refuses dirty/untracked source, other branches, unidentified SHAs, stale remote staging heads, and unexpected upload manifest entries. `.gcloudignore` uploads only package metadata, TypeScript configuration and `src/`, excluding credentials and `.env` files. Inspect `gcloud meta list-files-for-upload` locally before the first deployment; it neither uploads source nor provisions resources. Do not rely solely on Git ignore. The production deploy command stays explicit and unchanged.

Use an isolated shell with the complete validated staging environment and authorized staging ADC/proxy credentials for fixtures; supply secrets securely. Fixtures are not in CI deployment:

```bash
npm run seed:staging            # reports manifest, no clients or network
npm run reset:staging           # reports targeted cleanup, no clients or network
npm run seed:staging -- --apply
npm run reset:staging -- --apply
```

The manifest reserves one positive suggestion ID, negative SQL contact/event IDs, and one object path. It uses synthetic names and `.invalid` emails with no shared Firebase UID. Creation refuses unrelated collisions. Reset removes only marked fixture suggestions (including fixture descendants), matching SQL records, and the marked object with a generation precondition. Coordinate with testers before reset: edits/descendants on fixture records will be destroyed. Foreign-key dependencies stop SQL deletion; resolve those deliberately. SQL changes are transactional; cross-store changes are not atomic and may need an idempotent retry after partial failure. Do not run concurrent seed/reset sessions or permit tester edits to fixture records during cleanup. Broad resets are not provided; they would destroy testers' staging data and require separate coordination. Public reference fixtures under `data/` and the boundary/Dallas 311 seed commands require separate review against the schema baseline, staging configuration, and external provider budgets; do not blindly replay migrations or bulk data imports.

Initial `BOUNDARY_SYNC_ENABLED`, `STREETMIX_ENABLED`, `PRESENTATION_ENABLED`, and `PRESENTATION_WEBSOCKET_ENABLED` are all `false`. Enabling Streetmix can publish externally and needs deliberate authorization. Enable presentation flags together with frontend flags when testing. AI, Maps/geocoding, research, ingestion and publication integrations remain parity gaps until staging secrets and budgets are configured explicitly; shared-project ambient permissions must not silently enable paid providers. The deployment intentionally does not carry production provider credentials.

## Acceptance and rollback

Live acceptance remains operator work: sign in with an existing user and real App Check; confirm invalid/missing App Check fails; submit a synthetic idea and signed image upload; inspect only staging records and objects; exercise SQL reference/recommendation behavior; verify notices and, when enabled, presentation pairing/sockets. Inspect effective IAM and SQL privileges without production writes. Perform read-only production health checks. Demonstrate failed code checks block publication, stale SHA skipping, and restoration of a previous compatible staging revision. Record the tested frontend/backend commit pair; independent deployments do not guarantee compatibility.

Pause staging publication (disable the workflow or coordinate the staging Environment), confirm schema compatibility, and restore the recorded traffic mapping without data resets or down-migrations:

```bash
: "${PREVIOUS_REVISION:?use recorded previously working staging revision}"
run gcloud run services update-traffic urbanists-cloud-api-staging --project="$PROJECT" \
  --region=us-central1 --to-revisions="$PREVIOUS_REVISION=100"
```

For a previously split allocation, restore its recorded revision percentages instead. Verify health and application behavior, revert the faulty staging commit through review, then resume publication. Keep data intact. Review `latest` secret rotations and candidate tags when evaluating rollback compatibility. If no previous working revision exists, pause publication and repair staging; do not invent a rollback target.

Bootstrap on a task branch, review against main, merge through the normal review process, then create staging from updated main. Workflow dispatch requires the workflow on the default branch. Features target staging; hotfixes target main and merge back. Promote recurring staging batches with ordinary merge PRs, not squash promotions. Backend production releases remain separately authorized; coordinate compatible backend-first deployment with the frontend's normal release process.

## References

- [Cloud Run source deployment requirements](https://docs.cloud.google.com/run/docs/deploying-source-code)
- [Firestore database conditions](https://firebase.google.com/docs/firestore/manage-databases)
- [WIF deployment pipeline claims and numeric IDs](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines)
- [Frontend handoff receipt](staging-handoff.md)
