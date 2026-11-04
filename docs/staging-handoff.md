# Non-secret staging frontend handoff

Completed 2026-10-23 (America/Chicago). **Infrastructure and GitHub configuration are complete, and the backend is deployed and verified.** The frontend was not deployed, its repository files were not modified, and a complete frontend/backend browser rollout is not claimed.

## Deployment receipt

| Field | Verified value |
| --- | --- |
| Google Cloud/Firebase project | `urbanists-mixer-slides-helper` |
| Discovered project number | `143738155808` |
| Hosting site | `map-staging-143738155808` — separate site, zero Hosting releases |
| Canonical frontend URL | `https://map-staging-143738155808.web.app` — site provisioned, application not deployed |
| Hosting channel | Permanent live channel of the dedicated staging site |
| Actual staging API origin | `https://urbanists-cloud-api-staging-kmjlhmx2cq-uc.a.run.app` |
| Cloud Run service / region | `urbanists-cloud-api-staging` / `us-central1` |
| Deployed backend full SHA | `f819b41ef0a7c429b76fc4e2864a269f14874bc8` |
| Current Cloud Run revision | `urbanists-cloud-api-staging-00002-vid` |
| Current traffic | `urbanists-cloud-api-staging-00002-vid=100` |
| Previous working revision | `urbanists-cloud-api-staging-00001-quk` — same tested backend SHA |
| Previous traffic before the update | `urbanists-cloud-api-staging-00001-quk=100` |
| Current image digest | `sha256:1e91833e54dace4cb0511f44f1d61c4633f58d7f88ecba43c4a8880baaa7c171` |
| Successful GitHub run | [Staging API run 40040844109](https://github.com/DallasUrbanists/cloud-api-server/actions/runs/40040844109), attempt 3; checks and deployment succeeded |
| Backend publication | Automatic staging push workflow, OIDC, dedicated source-build account, tested checkout, candidate health verification and traffic publication |
| Default branches | `main` in both repositories; no main push/merge or release tags |
| Tested frontend/backend SHA pair | Pending separately authorized frontend deployment and browser acceptance |

Public `/api/health` returned the actual revision and full SHA, `status=ok`, `service=urbanists-cloud-api-server`, `environment=staging`, and exactly `databases=["public-improvements-staging"]`. Health identifies configuration; the store and IAM evidence below comes from separate live checks.

The post-deployment receipt and operator-guide updates remain local review changes on `codex/staging-safeguards`; the pushed deployment branch remains at the tested SHA above.

## Provisioned stores and identities

| Resource | Actual configuration |
| --- | --- |
| Firestore | `public-improvements-staging`, `us-south1`, Native / Standard, pessimistic concurrency, delete protection enabled; PITR disabled as in production |
| Firestore indexes/settings | Required `suggestion` composite index (`author.email`, `id`, document name) reproduced and READY; default single-field indexes retained; production has no additional field overrides or TTL policies to reproduce |
| Upload bucket | `urbanists-suggestion-photos-staging-143738155808`, `us-central1`, uniform bucket access, canonical-origin CORS, public image URL delivery |
| Existing SQL instance | `urbanists-mixer-slides-helper:us-south1:contacts-relationships-db`, PostgreSQL 18.6 |
| SQL database / login | `urbanists_staging` / `urbanists_staging`; independently generated staging password |
| SQL schema baseline | Schema-only export of `postgres.public`, restored without rows, owners or grants; 16 tables and 7 functions; no migration replay |
| Schema export SHA-256 | `dab931bea6768e031cd3a35e22c2980b9b7acdf579da123419142af7987e0c68` |
| Runtime identity | `api-staging-runtime@urbanists-mixer-slides-helper.iam.gserviceaccount.com` |
| Source-build identity | `api-staging-build@urbanists-mixer-slides-helper.iam.gserviceaccount.com` |
| Backend deployer | `api-staging-deployer@urbanists-mixer-slides-helper.iam.gserviceaccount.com` |
| Frontend deployer | `map-staging-deployer@urbanists-mixer-slides-helper.iam.gserviceaccount.com` |
| API-key secret reference | `improvement-map-staging-api-keys:latest`, current version `1` |
| SQL-password secret reference | `urbanists-staging-db-password:latest`, current version `1` |

Synthetic fixtures remain for frontend testing: suggestion `910000001`, SQL contact/event IDs `-910000001`, and object `staging-fixtures/v1/bus-stop.svg`. They contain `.invalid` emails and no shared Firebase UID. Fixture inserts override generated identity columns without advancing their sequences. No production records were copied. The schema export remains an operator artifact outside uploaded source, not checked into Git.

Runtime settings are 1 CPU, 512 MiB, concurrency 80, minimum 0, maximum 2 instances, CPU throttling enabled, public ingress and 3600-second timeout. Staging deliberately caps at 2 rather than production's observed 20 instances and uses 3600 rather than production's observed 300-second timeout for socket compatibility. No performance parity claim is made.

All initial backend flags remain `false`: `BOUNDARY_SYNC_ENABLED`, `STREETMIX_ENABLED`, `PRESENTATION_ENABLED`, `PRESENTATION_WEBSOCKET_ENABLED`. `NODE_ENV=production` is enforced. Enable presentation only together with frontend flags in a separate coordinated test.

## WIF and GitHub configuration

| Field | Configured value |
| --- | --- |
| Backend repository ID | `1380497678` |
| Frontend repository ID | `1384197967` |
| Repository owner ID | `129811100` |
| Backend provider | `projects/143738155808/locations/global/workloadIdentityPools/api-staging/providers/github` |
| Frontend provider | `projects/143738155808/locations/global/workloadIdentityPools/map-staging/providers/github` |
| Backend Environment subject | `repo:DallasUrbanists@129811100/cloud-api-server@1380497678:environment:staging` |
| Frontend Environment subject | `repo:DallasUrbanists@129811100/improvement-map@1384197967:environment:staging` |

Both providers require their numeric repository/owner IDs, `refs/heads/staging`, the exact Environment subject, and the corresponding `DallasUrbanists/<repository>/.github/workflows/deploy-staging.yml@refs/heads/staging` workflow reference. Immutable subject prefixes were discovered through GitHub's API; existing OIDC customization was preserved. Both `staging` Environments allow only the exact staging branch.

Backend OIDC and source deployment were exercised successfully. Frontend federation is configured but has not been exercised by a frontend deployment job. Frontend branch/workflow bootstrap remains frontend work; no frontend branch/files were pushed here. Backend push deployment works without merging main. Workflow dispatch still requires the workflow to reach the default branch through normal review.

The backend Environment contains `GCP_WORKLOAD_IDENTITY_PROVIDER` and seven runtime variables: `STAGING_CPU=1`, `STAGING_MEMORY=512Mi`, `STAGING_CONCURRENCY=80`, `STAGING_MIN_INSTANCES=0`, `STAGING_MAX_INSTANCES=2`, `STAGING_INGRESS=all`, `STAGING_CPU_THROTTLING=true`. Backend secret values come only from the two staging Secret Manager references.

All required frontend Environment variables are populated:

| Variable | Value |
| --- | --- |
| `STAGING_API_ORIGIN` | `https://urbanists-cloud-api-staging-kmjlhmx2cq-uc.a.run.app` |
| `GCP_PROJECT_ID` | `urbanists-mixer-slides-helper` |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/143738155808/locations/global/workloadIdentityPools/map-staging/providers/github` |
| `GCP_SERVICE_ACCOUNT` | `map-staging-deployer@urbanists-mixer-slides-helper.iam.gserviceaccount.com` |
| `VITE_PRESENTATION_ENABLED` | `false` |
| `VITE_PRESENTATION_WEBSOCKET_ENABLED` | `false` |

All four required frontend Environment secrets are populated: `STAGING_API_KEY`, `STAGING_GOOGLE_MAPS_API_KEY`, `STAGING_FIREBASE_API_KEY`, `STAGING_RECAPTCHA_SITE_KEY`. Values were transferred directly through authorized cloud APIs and GitHub's encrypted secret interface. **No required GitHub inputs remain missing.**

The existing Auth domain list and the frontend's existing Enterprise reCAPTCHA key were extended only with `map-staging-143738155808.web.app`; existing domains, provider configuration and enforcement were preserved. The shared Firebase browser key required no referrer change. A new staging Maps key permits only `https://map-staging-143738155808.web.app/*` and the Maps JavaScript, Places and Geocoding APIs needed by the frontend.

## Isolation and live verification evidence

- Runtime Firestore access is conditioned on staging. Runtime create/read/delete succeeded there. A read-only production Firestore transaction was denied (403), with zero production document writes attempted. Project/organization policies were inspected for broader grants. Policy Troubleshooter could not resolve named database resources; that result is a limitation, not a positive permission proof.
- Runtime bucket permission checks returned staging create/update/delete and no corresponding production bucket writes. Runtime access to the production SQL-password secret was absent. Staging secrets are resource-scoped.
- Shared Auth permission checks allowed `firebaseauth.users.get` and denied create/update/delete. HTTP/socket App Check rejection and unit tests cover shared-user protections. No shared users, claims or sessions were changed.
- The SQL login has no superuser, createdb, createrole, replication, bypass-RLS privileges, memberships or database ownership. It cannot write tables or create schemas/databases in `postgres` or `crm-db`, and has no executable security-definer functions there. PUBLIC/default privileges were inspected; no production grant changes were required. DML/sequence/function grants apply only in staging.
- Live seed execution used staging getters and short-lived runtime impersonation. Signed PUT returned 200; canonical-origin preflight, exclusion of the production map origin, runtime self-signing and public image delivery passed. The temporary upload was deleted; the deterministic fixture object remains.
- Reserved suggestion/contact/event IDs and the fixture object were verified absent from production through targeted read-only checks and present in staging.
- Staging health matched database/SHA/revision. The deployed API read the synthetic SQL event (200). Canonical CORS preflight returned 204; the production origin was rejected (403).
- Protected requests with the accepted staging key rejected missing/invalid App Check (401). Staging socket handshake succeeded, then rejected missing App Check (4001). Both suggestion aliases and the presentation socket rejected the production origin (403). Disabled presentation REST returned 404.
- Production health remained 200 and revision/traffic remained `urbanists-cloud-api-server-00105-cp7=100`. The production deployment command is unchanged. The staging Hosting site has zero releases; no frontend deployment occurred.

IAM scope: runtime database/bucket/secret writes are confined to staging; shared Auth is read-only, SQL instance connection is project-scoped with database grants isolating records, and signing targets the runtime identity. Backend source-deployment/build roles and frontend Hosting Admin have project scope in this shared project. Backend Run Admin is scoped to the staging service. No Owner/Editor shortcuts or service-account keys were used; the temporary bootstrap project-admin condition was removed.

The temporary operator impersonation grant was removed after validation; runtime self-signing remains configured.

## Checks and remaining acceptance

`npm ci`, the full local suite (437 passed, 8 opt-in skips), `npm run build`, `npm run docs:build`, actionlint and script syntax checks passed. GitHub install/tests/build and deployment succeeded for the deployed SHA. An initial Linux fixture-hash failure blocked deployment; explicit checkout line endings corrected that existing issue. Synthetic SQL seeding exposed generated identity columns, now supported by the fixture tool. Prior local checks included 12 focused tests, three Firestore emulator integrations and one isolated PostgreSQL concurrency integration; these remain distinct from the cloud evidence above.

Remaining limits: frontend deployment, existing-account browser sign-in, positive browser reCAPTCHA/App Check, an accepted frontend/backend SHA pair, interactive Maps/PWA/mobile behavior, the complete protected browser submission/upload journey, presentation pairing when enabled, and frontend WIF execution remain frontend live acceptance work. Gemini/Assist, TypeSafe, backend Maps/geocoding and research credentials were not copied from production or enabled for these tests. No paid-provider evaluations, ten-minute soak, ingestion or Streetmix publication were run. Application quota stores are isolated; shared-project provider quotas/budgets need review before broader provider testing. The existing high-severity `body-parser` advisory GHSA-27r3-jxmh-p828 remains a separate dependency issue.

## Verified rollback

Publication was paused, traffic restored to `urbanists-cloud-api-staging-00001-quk`, health and the synthetic SQL event verified, then traffic returned to `urbanists-cloud-api-staging-00002-vid` and publication resumed. The Firestore fixture update time and object's generation stayed unchanged. Both revisions use the same tested SHA and schema; no reset or down-migration occurred.

For a future authorized rollback, pause publication and confirm compatibility with any later schema changes, then restore the known working revision:

```powershell
gh workflow disable 394676063 --repo DallasUrbanists/cloud-api-server
gcloud run services update-traffic urbanists-cloud-api-staging --project=urbanists-mixer-slides-helper --region=us-central1 --to-revisions=urbanists-cloud-api-staging-00001-quk=100
Invoke-RestMethod 'https://urbanists-cloud-api-staging-kmjlhmx2cq-uc.a.run.app/api/health'
```

Verify identity, application behavior and schema compatibility. Revert/repair the faulty staging commit through review before `gh workflow enable 394676063 --repo DallasUrbanists/cloud-api-server`. Final state: **revision `urbanists-cloud-api-staging-00002-vid` at 100%, workflow active, fixture data preserved**.

See [staging operations](staging-operations.md) for provisioning, fixture cleanup and releases. Repository readiness, infrastructure/GitHub configuration and the backend checks above are complete; frontend/browser acceptance remains a separate milestone.
