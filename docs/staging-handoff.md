# Non-secret staging frontend handoff

Prepared 2026-10-23. Repository implementation is under local review on `codex/staging-safeguards`, based on `b343bf2` (5.6.1). Changes are uncommitted: **there is no deployed implementation SHA**. No cloud provisioning, deployment, live data mutation, or frontend repository modification has been performed for this handoff.

## Resource receipt

| Field | Contract / observed status |
| --- | --- |
| Google Cloud/Firebase project | `urbanists-mixer-slides-helper` |
| Hosting site | `map-staging-143738155808` — existence unverified |
| Canonical frontend URL | `https://map-staging-143738155808.web.app` — contract, not live-verified |
| Hosting channel | Permanent live channel of that dedicated site |
| API service / region | `urbanists-cloud-api-staging` / `us-central1` |
| Actual API origin | **Pending provisioning/deployment; no hostname guessed** |
| Deployed backend SHA / revision | **None recorded; not deployed** |
| Previous working revision | **Unknown; capture traffic before first authorized change** |
| Tested frontend/backend SHA pair | **Pending live acceptance** |
| Firestore database | `public-improvements-staging` — existence/location/settings unverified |
| Upload bucket | `urbanists-suggestion-photos-staging-143738155808` — existence/location/delivery unverified |
| SQL instance | `urbanists-mixer-slides-helper:us-south1:contacts-relationships-db` (`us-south1`) |
| SQL database / login | `urbanists_staging` / `urbanists_staging` — existence/grants unverified |
| Runtime identity | `api-staging-runtime@urbanists-mixer-slides-helper.iam.gserviceaccount.com` |
| Build identity | `api-staging-build@urbanists-mixer-slides-helper.iam.gserviceaccount.com` |
| Backend deployer | `api-staging-deployer@urbanists-mixer-slides-helper.iam.gserviceaccount.com` |
| Frontend deployer | `map-staging-deployer@urbanists-mixer-slides-helper.iam.gserviceaccount.com` |
| Frontend WIF provider resource name | **Pending project-number/repository-ID discovery and provisioning** |
| Backend WIF provider resource name | **Pending discovery/provisioning** |
| Backend API-key reference | `improvement-map-staging-api-keys:latest` — no secret values or versions accessed |
| SQL-password reference | `urbanists-staging-db-password:latest` — no secret values or versions accessed |
| GitHub inputs populated | **Not populated or verified by this work** |

## Frontend GitHub Environment inputs

Use Environment `staging`, restricted to branch `staging`. The frontend implementer owns Hosting files and its deployment workflow. The common cloud operator owns site, identities, provider bindings, shared Auth/App Check domain authorization and restricted browser key provisioning.

| Variable | Value / prerequisite |
| --- | --- |
| `STAGING_API_ORIGIN` | Actual Cloud Run origin, pending backend deployment |
| `GCP_PROJECT_ID` | `urbanists-mixer-slides-helper` |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Full frontend provider resource name, pending provisioning |
| `GCP_SERVICE_ACCOUNT` | `map-staging-deployer@urbanists-mixer-slides-helper.iam.gserviceaccount.com` |
| `VITE_PRESENTATION_ENABLED` | `false` initially |
| `VITE_PRESENTATION_WEBSOCKET_ENABLED` | `false` initially |

| GitHub secret name | Meaning; values transferred directly via authorized secret interfaces |
| --- | --- |
| `STAGING_API_KEY` | Key accepted by staging `API_KEYS_JSON` |
| `STAGING_GOOGLE_MAPS_API_KEY` | Browser Maps key restricted to staging origin and selected APIs |
| `STAGING_FIREBASE_API_KEY` | Existing shared Firebase browser key |
| `STAGING_RECAPTCHA_SITE_KEY` | Compatible key authorized for staging |

All backend initial flags (`BOUNDARY_SYNC_ENABLED`, `STREETMIX_ENABLED`, `PRESENTATION_ENABLED`, `PRESENTATION_WEBSOCKET_ENABLED`) are `false`. No external provider credentials are supplied by the staging workflow. Assist/Gemini, TypeSafe emoji classification, Maps/geocoding, boundary research/ingestion and Streetmix external publication are unconfigured parity gaps until deliberate staging configuration and budgets are reviewed. Existing shared-user login is the intended flow; it has not been live-verified. Presentation enablement requires coordinated frontend/backend flag changes.

## Validation and remaining milestones

| Local check | Outcome |
| --- | --- |
| Node 24 / `npm ci` | Passed; lockfile unchanged. npm reported the existing high-severity `body-parser` advisory GHSA-27r3-jxmh-p828; no dependency changes made. |
| Full test suite | 437 passed, 8 opt-in skips with `npx tsx --test --test-concurrency=2 tests/*.test.ts`. Emulator addresses cleared for this run. Initial unrestricted `npm test` had one timing failure in the existing oversized WebSocket-frame test under local resource pressure; limited-concurrency retry passed. |
| Final staging-focused tests | 12 passed, including fake store operations, App Check/auth, staff service non-invocation, health, CORS/socket origins, manifest restrictions and report-only fixture commands. |
| Local Firestore emulator integration | 3 passed on `127.0.0.1:18085`, unique demo projects/default database: multi-instance presentation claim serialization, presentation snapshots/revocation/reconnect, and suggestion notices. Emulator stopped afterward. These tests do not validate named cloud database provisioning. |
| Local PostgreSQL integration | 1 passed using a new PostgreSQL 17 test cluster on `127.0.0.1:15439`; cluster stopped afterward. Tests use an isolated schema and no cloud data. |
| TypeScript build | Passed (`npm run build`). |
| Documentation build | Passed (`npm run docs:build`); TypeDoc and VitePress links validated. VitePress emitted its chunk-size advisory. |
| Workflow / deployment script | actionlint 1.7.12 passed; Node syntax check passed; only deployment job has OIDC, with branch/Environment restrictions. No GitHub workflow run or deployment was performed. |
| Source upload manifest | 128 allowlisted files inspected with `gcloud meta list-files-for-upload`; no upload performed. Credentials, `.env`, dependencies and local artifacts excluded. |
| Production command / whitespace | Production `deploy` command compared to HEAD and unchanged; `git diff --check` passed. |

The three live Gemini evaluations and ten-minute opt-in presentation soak were not run. The four other opt-in tests skipped in the full suite were subsequently run against the local Firestore emulator and PostgreSQL cluster as recorded above. Mocks, constructor-only client checks, and local socket/emulator tests do not verify cloud IAM, cloud data-store readiness, shared login, real App Check, signed cloud uploads, cloud SQL grants, or hosting.

Before live acceptance, complete [operator provisioning](staging-operations.md), verify effective runtime IAM and SQL privilege isolation, authorize the canonical Auth/App Check domain, populate GitHub inputs, and deploy the reviewed backend commit. Record its actual URL/SHA/revision/previous traffic, then deploy the frontend independently and record the tested SHA pair. Preserve data when rolling back to a compatible previous revision.
