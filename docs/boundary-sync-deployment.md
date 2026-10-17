# Deploy boundary synchronization on Google Cloud

This runbook configures provider keys, runs the durable worker as a scheduled Cloud Run Job, and enables public ticks. Commands use **Bash**, including Git Bash. Run them from the repository root in the same terminal so variables remain available.

Migration 006 and seed 007 have already been imported for this deployment. **Do not rerun 006 or the old representative migration 005.** See [Boundary synchronization](boundary-synchronization.md) for architecture and [OpenAPI](../src/docs/swagger.ts) for HTTP contracts.

## 1. Prerequisites and deployment variables

You need permission to deploy Cloud Run services/jobs, manage secrets and service-account IAM, and create Cloud Scheduler jobs. Granting roles requires an administrator if your account lacks IAM permissions. These commands modify cloud resources and can incur costs; review placeholders first.

```bash
project="urbanists-mixer-slides-helper"
region="us-central1"
service="urbanists-cloud-api-server"
instance="contacts-relationships-db"
connection="${project}:us-south1:${instance}"
job="boundary-sync-worker"
# Retained Cloud Scheduler resource name; the job now runs daily.
schedule="boundary-sync-worker-every-minute"
worker_name="boundary-sync-worker"
scheduler_name="boundary-sync-scheduler"
worker_sa="${worker_name}@${project}.iam.gserviceaccount.com"
scheduler_sa="${scheduler_name}@${project}.iam.gserviceaccount.com"

# Matches the existing API deployment. Change if your runtime uses another login.
db_user="postgres"
db_name="postgres"
db_password_secret="contacts-db-password"

gcloud auth list
gcloud services enable run.googleapis.com cloudscheduler.googleapis.com \
  secretmanager.googleapis.com sqladmin.googleapis.com --project="$project"
```

Confirm the existing service region and SQL connection name before proceeding. The API and job can run in `us-central1` while SQL is in `us-south1`, matching the existing deployment, but cross-region connections add latency and may add cost.

Check the imported records in Query Explorer:

```sql
SELECT count(*) AS seeded_boundaries
FROM boundaries
WHERE source_key IS NOT NULL;
```

The supplied seed contains 284 records. Runtime database credentials must have SQL permissions on the boundary, representative, job, budget, and evidence tables and their sequences. Cloud SQL IAM connectivity alone does not grant PostgreSQL table permissions. Use the existing working API database login initially; a dedicated least-privilege SQL login can be configured separately.

## 2. Acquire provider keys

| Provider | Get access | Environment variable | Used for |
| --- | --- | --- | --- |
| Congress.gov | Request a key at [api.congress.gov](https://api.congress.gov/sign-up/) | `CONGRESS_GOV_API_KEY` | Current U.S. senators and congressional representatives |
| Open States | Create an account/request API access at [Open States](https://openstates.org/api/register/) | `OPEN_STATES_API_KEY` | Texas Senate and House members |
| Gemini Developer API | Create a key in [Google AI Studio](https://aistudio.google.com/apikey) | `GEMINI_API_KEY` | Evidence-backed research from approved official documents |

Check each provider's current access, billing, and quota policies. For Gemini, confirm billing/quota and access to a model supporting both Google Search grounding and structured JSON extraction. The existing `@google/genai` SDK is sufficient; no additional search SDK or Brave/Tavily key is required.

`BOUNDARY_RESEARCH_MODEL` defaults in code to `gemini-3.8-flash`. Verify that model is available to your key before using it; otherwise choose a supported model with the required capabilities. The deployment commands below require an explicit model value rather than assume access. This setting is independent of the Assist model.

Public ArcGIS geometry does not require a key. `GOOGLE_MAPS_API_KEY` is optional for address geocoding on the API, not required by the worker. Keep any existing Maps configuration. Do not put provider keys in SQL service descriptors, Git, browser configuration, or command-line literals.

## 3. Store keys in Secret Manager

These are suggested secret resource names; environment variable names above must remain exact. Run this helper once per key. It creates a secret if missing, then adds a version using a hidden prompt; the value is not entered into shell history. Do not use shell tracing (`set -x`) while handling keys.

```bash
put_secret() {
  local name="$1"
  local value
  if ! gcloud secrets describe "$name" --project="$project" >/dev/null 2>&1; then
    gcloud secrets create "$name" --replication-policy=automatic \
      --project="$project" || return 1
  fi
  read -r -s -p "Paste value for $name: " value
  printf '\n'
  if [ -z "$value" ]; then
    echo "Empty value; no version added." >&2
    unset value
    return 1
  fi
  printf '%s' "$value" | gcloud secrets versions add "$name" \
    --data-file=- --project="$project"
  local result=$?
  unset value
  return "$result"
}

put_secret congress-gov-api-key
put_secret open-states-api-key
put_secret gemini-api-key
```

If Gemini is already stored in a different secret, reuse that secret and substitute its name in subsequent commands. The database password secret should already exist; do not replace its value with a provider key.

## 4. Configure runtime identities and permissions

Create dedicated job and scheduler identities if they do not already exist:

```bash
gcloud iam service-accounts create "$worker_name" \
  --display-name="Boundary sync worker" --project="$project"
gcloud iam service-accounts create "$scheduler_name" \
  --display-name="Boundary sync scheduler" --project="$project"

api_sa=$(gcloud run services describe "$service" --region="$region" \
  --project="$project" --format='value(spec.template.spec.serviceAccountName)')
printf 'API runtime service account: %s\n' "$api_sa"
```

If creation reports an account already exists, reuse it. Ensure `api_sa` is nonempty before continuing. Grant Cloud SQL connection access to the worker; the existing API identity should already have it:

```bash
gcloud projects add-iam-policy-binding "$project" \
  --member="serviceAccount:$worker_sa" --role=roles/cloudsql.client

for secret in congress-gov-api-key open-states-api-key gemini-api-key; do
  for identity in "$api_sa" "$worker_sa"; do
    gcloud secrets add-iam-policy-binding "$secret" --project="$project" \
      --member="serviceAccount:$identity" --role=roles/secretmanager.secretAccessor
  done
done

gcloud secrets add-iam-policy-binding "$db_password_secret" --project="$project" \
  --member="serviceAccount:$worker_sa" --role=roles/secretmanager.secretAccessor
```

Both API and worker need provider keys: the API checks configuration before accepting work and may execute short shape work; the worker makes research calls. The deployer also needs permission to act as the selected runtime identities. The worker does not need Firebase staff, project Editor, or Storage Admin permissions for this workflow.

## 5. Deploy the API with ticks disabled

First deploy the application version containing the worker and boundary feature. A source deployment builds its production image; confirm the build completes successfully. Preserve existing secrets, authentication, Maps, and other service configuration by using update flags.

```bash
read -r -p "Supported Gemini research model ID: " research_model
# Stop here if research_model is empty or model access is not confirmed.

gcloud run deploy "$service" --source . --region="$region" --project="$project" \
  --add-cloudsql-instances="$connection" \
  --update-env-vars="NODE_ENV=production,DB_USER=$db_user,DB_NAME=$db_name,INSTANCE_CONNECTION_NAME=$connection,BOUNDARY_SYNC_ENABLED=false,BOUNDARY_RESEARCH_MODEL=$research_model,BOUNDARY_SYNC_CLIENT_PER_MINUTE=30,BOUNDARY_SYNC_GLOBAL_PER_MINUTE=10,BOUNDARY_SYNC_GLOBAL_PER_DAY=100,BOUNDARY_SYNC_CONCURRENCY=2" \
  --update-secrets="DB_PASSWORD=$db_password_secret:latest,CONGRESS_GOV_API_KEY=congress-gov-api-key:latest,OPEN_STATES_API_KEY=open-states-api-key:latest,GEMINI_API_KEY=gemini-api-key:latest"
```

Use a supported Node runtime (minimum 22.13; Node 24 recommended). This command leaves the service's existing invocation IAM unchanged; the API must retain its existing public invocation access for public routes. Do not deploy the worker as an HTTP service: it does not listen on `PORT`.

Capture the immutable image from the ready revision, so API and worker run the same code:

```bash
revision=$(gcloud run services describe "$service" --region="$region" \
  --project="$project" --format='value(status.latestReadyRevisionName)')
image=$(gcloud run revisions describe "$revision" --region="$region" \
  --project="$project" --format='value(status.imageDigest)')
api_url=$(gcloud run services describe "$service" --region="$region" \
  --project="$project" --format='value(status.url)')
printf 'Revision: %s\nImage: %s\nAPI: %s\n' "$revision" "$image" "$api_url"
```

Stop if any value is empty or the ready revision is not your successful deployment. The production image must contain `dist/scripts/boundaryWorker.js`; the existing build script compiles it. Repeat image capture and job deployment on future application releases; the job does not automatically follow API revisions.

## 6. Deploy and verify the Cloud Run Job

The job supplies CPU throughout execution. `--once` drains claimable work and exits when idle or after a claim/execution error pass. It does **not** enqueue work or scan for fresh tasks on its own.

```bash
gcloud run jobs deploy "$job" --image="$image" \
  --region="$region" --project="$project" --service-account="$worker_sa" \
  --set-cloudsql-instances="$connection" \
  --command=node --args=dist/scripts/boundaryWorker.js,--once \
  --tasks=1 --parallelism=1 --cpu=1 --memory=1Gi \
  --task-timeout=1800s --max-retries=0 \
  --set-env-vars="NODE_ENV=production,DB_USER=$db_user,DB_NAME=$db_name,INSTANCE_CONNECTION_NAME=$connection,BOUNDARY_SYNC_ENABLED=true,BOUNDARY_RESEARCH_MODEL=$research_model,BOUNDARY_SYNC_CLIENT_PER_MINUTE=30,BOUNDARY_SYNC_GLOBAL_PER_MINUTE=10,BOUNDARY_SYNC_GLOBAL_PER_DAY=100,BOUNDARY_SYNC_CONCURRENCY=2" \
  --set-secrets="DB_PASSWORD=$db_password_secret:latest,CONGRESS_GOV_API_KEY=congress-gov-api-key:latest,OPEN_STATES_API_KEY=open-states-api-key:latest,GEMINI_API_KEY=gemini-api-key:latest"

gcloud run jobs execute "$job" --region="$region" --project="$project" --wait

gcloud logging read \
  "resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"$job\"" \
  --project="$project" --limit=30 --format='value(timestamp,textPayload)'
```

Expect `Boundary worker connected; polling durable PostgreSQL jobs.` An empty queue means a quick successful exit. This verifies startup/database access, **not provider credentials**. A job can also exit successfully after recording a provider failure; verify individual job status in the smoke test below.

The 30-minute task limit bounds an invocation, not a guarantee the queue drains. PostgreSQL leases, retry limits, and publication fences coordinate overlapping executions. Work interrupted by a task timeout becomes reclaimable after its lease expires. Provider failures have retry backoff; Cloud Run task retries are disabled here to avoid an extra immediate retry layer.

## 7. Schedule the worker with authenticated IAM

Allow the scheduler identity to execute only this job:

```bash
gcloud run jobs add-iam-policy-binding "$job" --region="$region" \
  --project="$project" --member="serviceAccount:$scheduler_sa" \
  --role=roles/run.invoker

gcloud scheduler jobs create http "$schedule" --location="$region" \
  --project="$project" --schedule='0 0 * * *' --time-zone=America/Chicago \
  --uri="https://run.googleapis.com/v2/projects/$project/locations/$region/jobs/$job:run" \
  --http-method=POST --oauth-service-account-email="$scheduler_sa" \
  --oauth-token-scope=https://www.googleapis.com/auth/cloud-platform \
  --headers=Content-Type=application/json --message-body='{}' \
  --attempt-deadline=30s --max-retry-attempts=0
```

For an existing schedule, use `gcloud scheduler jobs update http` instead of `create`. This Google API call uses **OAuth**, not an OIDC token and not an application API key. The Cloud Scheduler service agent needs its standard service-agent role; do not substitute the scheduler caller for that service agent. A successful Scheduler delivery means execution was requested, not that research succeeded.

The job runs once daily at midnight America/Chicago. This trades queue latency for lower job-start frequency; adjust the schedule if a different daily time is needed. A longer-lived, always-CPU worker is an alternative; ordinary request-throttled HTTP background execution is not.

## 8. Enable public ticks and smoke-test

Only after worker startup succeeds, enable ticks on the API:

```bash
gcloud run services update "$service" --region="$region" --project="$project" \
  --update-env-vars=BOUNDARY_SYNC_ENABLED=true

# Confirm the deployed environment configuration (does not print secret values).
gcloud run services describe "$service" --region="$region" --project="$project" \
  --format='yaml(spec.template.spec.containers[0].env)'

# Reads and due ticks require no application key or Firebase login.
curl --fail-with-body "$api_url/api/boundaries?state=TX&limit=1"
curl --fail-with-body -i "$api_url/api/tick/boundaries/research"
```

A due research request normally returns `202` with `jobId` and `statusUrl`. No eligible target returns `{"syncCount":0}`; that is not a provider test. Use the returned status path, not a guessed ID:

```bash
status_path="/api/tick/jobs/REPLACE_WITH_RETURNED_JOB_ID"

# Optional immediate execution instead of waiting for the schedule.
gcloud run jobs execute "$job" --region="$region" --project="$project" --wait
curl --fail-with-body "$api_url$status_path"
```

Poll until `succeeded` or `failed`. Inspect the returned sanitized error code and worker logs on failure. Verify representative/boundary data, not merely HTTP acceptance. Check at least one due boundary for each configured research adapter (Congress, Open States, official/Gemini); one successful research job does not validate all providers. Choose explicit IDs from the boundary list and request `/api/tick/boundary/ID` when due. Each such tick may also refresh geometry. Fresh TTLs or null service descriptors can produce a current model without invoking a provider. Do not use public GETs to force a fresh record; protected force POSTs retain staff, application-key, and production App Check requirements.

Enabling the flag **does not schedule discovery**. The worker schedule drains queued work; an application or separate scheduler must call public due-tick routes to enqueue it. Each batch tick selects at most one target, so choose a controlled trigger cadence. Do not place force endpoints on a public cron. Future/expired congressional records cannot be researched as current officeholders by the live adapter.

## 9. Monitoring, rotation, and pause

- Monitor failed/queued jobs, lease recovery, provider quotas, and Gemini spend. Defaults allow 100 executions/day, 10/minute, and two concurrent claims globally; these count jobs, not provider requests or tokens. Match limit values across API and worker.
- Keep `BOUNDARY_RESEARCH_ALLOWED_HOSTS` empty unless staff have reviewed exact additional organization hosts. Configure the same reviewed list on API and worker; never use wildcards. Some neighborhood/HOA research will need review or have no verifiable public contacts.
- Public reads/geocoding need separate edge/quota protection. Job/evidence retention is an operational responsibility. Do not expose SQL credentials or raw research evidence publicly.
- To rotate a key, add a Secret Manager version, then redeploy/update both API and job. Environment-variable secrets are resolved at instance startup; existing warm API instances do not automatically reload them. Pin numeric secret versions instead of `latest` when reproducible rollbacks are required.

Pause new scheduling through public ticks and pause automatic worker launches:

```bash
gcloud run services update "$service" --region="$region" --project="$project" \
  --update-env-vars=BOUNDARY_SYNC_ENABLED=false
gcloud scheduler jobs pause "$schedule" --location="$region" --project="$project"
```

This does not cancel already-running work or delete queued jobs. Review active executions before cancelling a specific execution in Cloud Run; an interrupted lease requires recovery time. To resume, ensure worker configuration is still enabled, resume the scheduler, and re-enable the API flag.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| API `503` with `SYNC_DISABLED` | API revision has `BOUNDARY_SYNC_ENABLED=true` exactly. |
| API `503` with `PROVIDER_NOT_CONFIGURED` | Required provider environment variable is present on the API, not only the job. |
| Worker refuses to start | Job flag is true, compiled entrypoint exists, and Node/runtime matches the build. |
| Worker cannot connect | SQL attachment, connection name, Cloud SQL Client IAM, password secret, DB login/table/sequence grants, and any required private networking. |
| Queued jobs never finish | Scheduler execution/IAM, job logs, global budgets, active leases, and worker enabled state. |
| Provider failure despite nonempty key | Key validity, upstream permissions/quota/billing, model access, source availability, and sanitized job error. |
| Scheduler `403` | Job-level invoker grant, OAuth caller identity, deployer's act-as permission, and Scheduler service-agent role. |
| `429` or idle worker with queued jobs | Distributed minute/day budgets or concurrency ceiling; inspect before increasing spend limits. |

Commands in this runbook are deployment guidance, not evidence that provider access or production execution has been tested. Validate the deployed system using the smoke tests above.
