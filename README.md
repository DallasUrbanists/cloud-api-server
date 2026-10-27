# Dallas Urbanists Cloud API Server

An API web service providing database I/O and server-side operations for the suite of client-side web applications created for and by **Dallas Urbanists**.

Hosted on **Google Cloud Run**, backed by **Google Cloud Firestore**, **Google Cloud SQL (PostgreSQL)**, and **Google Cloud Storage**.

---

## 🌐 Client Web Applications

This backend API server powers the following client-side applications:

| Project | Tags Used | Links |
|---|---|---|
| **Checkin Helper**<br>Tool for event check-in and attendee registration. Saves contacts and check-in records to the Dallas Urbanists PostgreSQL CRM database. | &bull; `Contacts`<br>&bull; `Checkins`<br>&bull; `Events` | &bull; [`GitHub repo`](https://github.com/DallasUrbanists/checkin-helper)<br>&bull; [`dallasurbanists.org/checkin`](https://dallasurbanists.org/checkin) |
| **Improvement Map**<br>Interactive map application for exploring, submitting, and tracking civic improvement ideas with photo attachments. | &bull; `Ideas` | &bull; [`GitHub repo`](https://github.com/DallasUrbanists/improvement-map)<br>&bull; [`map.dallasurbanists.org`](https://map.dallasurbanists.org) |

---

## Developer Documentation

- [Streetmix service and playground](docs/streetmix.md): generate approximate existing Texas cross-sections with shared caching and street confirmation through `POST /api/streetmix/designs`, and test the service at `/playground/streetmix`. Generation defaults to disabled; see the guide for setup and compatibility checks.

- [Documentation conventions](docs/documentation-conventions.md): comment format, ownership, and incremental rollout.
- [Feature guides](docs/index.md#feature-guides): Boundaries, Boundary synchronization, Assist, Representatives, Ideas, and the Recommendable Actions pilot, with system views and links to source/OpenAPI.

- [Generated-reference guide](docs/index.md): build and read the pilot TypeDoc site locally.
- [Documentation skills](docs/index.md#documentation-skills): bounded existing-code backfills and documentation synchronization alongside changes.

Run `npm run docs:build` to generate the VitePress portal and TypeDoc reference in the Git-ignored `docs-site` directory. Use `npm run docs:preview` and open its printed localhost URL; direct HTML file opening is not supported. TypeDoc generates Markdown for the pilot and selected feature layers' source-comment reference; VitePress renders it alongside the graphical Mermaid system view and conventions. Guides and reference share navigation, styling, theme, layout, and local search. `npm run docs:dev` supports live guide editing. `npm run docs:check` validates TypeDoc conversion only; the full build also checks portal links. The [Documentation workflow](.github/workflows/documentation.yml) validates the build on pull requests and `main` pushes using Ubuntu and Windows with Node 24. See [automated-check details](docs/index.md#automated-checks) for scope and required-check setup. Publication and broader feature backfill remain follow-up steps.

## 🛠️ Tech Stack

- **Runtime & Language**: Node.js, TypeScript (ESM)
- **Package Manager**: NPM
- **Web Framework**: Express.js (v5)
- **API Documentation & Testing**: Swagger UI (OpenAPI 3.0.3) with Strong Towns Custom Theme & Dark/Light Mode
- **Databases**:
  - **Google Cloud Firestore**: NoSQL multi-database architecture for public ideas and crowdsourced content.
  - **PostgreSQL (Google Cloud SQL)**: Relational database for CRM contacts and event checkins.
- **Media & Storage**: Google Cloud Storage for pre-signed photo uploads and static assets.
- **Deployment & Hosting**: Google Cloud Run & Cloud SQL Unix socket proxy.
- **Version Control**: Git

### Representatives table migration

Apply [004_representatives.sql](migrations/004_representatives.sql) to PostgreSQL to create `representatives`. The migration runs in a transaction and requires no extensions. It creates an integer identity primary key (explicit IDs are also accepted), nullable text fields, and nullable `start`/`end` timestamps without time zones. Quote `"start"` and `"end"` in SQL queries.

`emails`, `phones`, `social_accounts`, and `elections` are JSONB arrays defaulting to `[]`. Check constraints validate required properties and types, ten-digit phone strings, boolean `can_sms`, and the specified social platform values. Elections reject extra properties and require valid `YYYY-MM-DD` calendar dates. `district_bounds` stores a GeoJSON Polygon object as JSONB, validating numeric positions and closed rings with at least four positions; it does not perform spatial topology validation. All non-ID fields accept SQL `NULL`; JSON `null` is not a valid array or Polygon. This schema migration does not seed data or add API endpoints.

After the schema migration, apply [005_seed_dallas_city_council.sql](migrations/005_seed_dallas_city_council.sql) to insert the 14 Dallas district council members (not the mayor), researched on October 9, 2026. It is self-contained: the supplied district Polygon coordinates are embedded without simplification, so the original attachment is not needed when applying it. Source URLs and research caveats appear in SQL comments next to each member. Biographies and district descriptions are original factual summaries rather than copied website text.

The seed runs transactionally and serializes writes to `representatives`. Reruns skip rows matching entity, body, district, and name; they do not overwrite locally maintained records or remove former representatives. `start` uses the first verified inauguration date, falling back to the earliest **past** date in that member's recorded `elections` array when inauguration is unverified. Past means strictly before PostgreSQL `CURRENT_DATE` when the seed is applied; today's and future elections are excluded. Election-date fallbacks are approximate tenure starts and may be later than the actual first election because the recorded history is incomplete. `start` remains `NULL` if neither an inauguration date nor a past election is available; `end` remains `NULL` while a member is serving. Elections contain verified events, not a guaranteed complete history. Empty social-account arrays indicate no account was verified, and `can_sms: false` means SMS capability was not verified. Office phone numbers are stored as ten-digit strings. The script does not modify the live database until explicitly applied.

The public `GET /api/representatives` endpoint searches by linked boundary `entity`, `body`, `district`, `boundaryId`, representative `title`, serving date, election period, and/or location. Responses now contain `boundaryId`, nested `boundary`, `researchService`, `lastResearchSync`, and `researchSyncTTL`; the former top-level entity/body/district fields are removed. All supplied filters are combined. `servingAsOf` defaults to currently serving; `electionAsOf` matches early-voting start through election day. Linked boundaries must be in effect on the serving date, using Dallas time for today's boundary date. `GET /api/dallascitycouncil` retains the same fixed City of Dallas / City Council / Council member filters and excludes the mayor. Both endpoints remain public.

### Boundaries, migration, and synchronization

Use Node.js **22.13+** (Node 24 recommended). On a fresh database apply [004](migrations/004_representatives.sql), [005](migrations/005_seed_dallas_city_council.sql), [006_boundaries.sql](migrations/006_boundaries.sql), then [007_seed_boundaries.sql](migrations/007_seed_boundaries.sql). On an existing database already at 005, back up and rehearse 006/007 before applying them. The server never applies migrations automatically. Do **not** rerun 005 after 006: its legacy columns have been removed.

Migration 006 requires no PostgreSQL extensions. Generated native PostgreSQL bounding boxes and a GiST index shortlist spatial candidates before exact Turf membership checks; normalized administrative arrays also shortlist in SQL. It moves jurisdiction geometry/descriptions to `boundaries`, preserves representative IDs and contact/election history, creates required foreign keys, and refuses conflicting descriptions or geometry within one jurisdiction. Null legacy geometry is marked `shapePending`, not converted into a membership rule. It also creates durable jobs, distributed budgets, and research evidence tables. Sync timestamps use `timestamptz`; boundary calendar dates use `date`. Existing representative tenure timestamps retain their original schema.

Migration 007 contains **284 boundaries**, discovered by exact intersection with Dallas city limits from official public ArcGIS/Census sources on October 14, 2026: Texas U.S. Senate (1), congressional districts (9 for the 119th Congress and 9 future 120th-Congress districts), Texas Senate (5), Texas House (20), SBOE (5), Dallas County Judge (1), county commissioners (4), council/CPC/Park Board districts (14 each), DISD trustees (9), PIDs (16), and confirmed registered neighborhood associations (163). Geometry is embedded without simplification; the SQL file is approximately 16 MB and needs no source downloads when applied. Full district geometry is retained, not clipped to Dallas. Current congressional boundaries expire exclusively on January 3, 2027; future ones become effective that day. Source layers and keys are in [boundarySources.ts](src/services/boundarySources.ts). The expired South Dallas-Fair Park PID is excluded; year-only charter information is not converted into an invented expiration date.

**Source limitations:** the verified city neighborhood layer currently contains no HOA polygons. No HOA boundaries or board contacts are fabricated, and DCAD subdivision geometry is not treated as HOA jurisdiction. The tourism PID's hotel points are not substituted for a polygon. Supply verified HOA GeoJSON (each feature requires `properties.name`, `properties.sourceUrl`, and Polygon/MultiPolygon geometry) to the seed generator when those records become available. Newly downloaded GIS sources may contain stale information despite being official; research does not silently infer effective dates from dataset names.

```powershell
npm run seed:boundaries -- --output additional-boundaries.sql
npm run seed:boundaries -- --hoa-file verified-hoas.geojson --output additional-boundaries-with-hoas.sql
```

Generation performs public GIS reads but **no database writes**; output must be a new file. Omit `--output` for a dry run. `--metadata-only` omits geometry and marks districts `shapePending` until successfully synchronized. Seed reruns preserve locally maintained shapes, descriptions, and configured services, adopt matching legacy council boundaries, and do not duplicate source keys. Do not reapply migration 006; it is a forward migration, not an idempotent setup script.

#### Public search

- `GET /api/boundaries`: `entity`, `body`, `district`, `lat`/`lon`, `address`, `city`, `county`, `state`, `zip`, `asOf`, `limit`, `offset`.
- `GET /api/boundary/{id}`: includes expired/future records and derived `isInEffect`.
- Boundary and representative lists default to `limit=100`, permit up to 500, and paginate **after** geometry filtering.
- Supply **both** coordinates or neither; a partial pair returns 400. Coordinates override `address`. Geometry uses WGS84 longitude/latitude, honors holes and MultiPolygons, includes exterior edges, and excludes hole edges to preserve legacy representative-search behavior.
- Address lookup requires `GOOGLE_MAPS_API_KEY`; direct polygon queries do not. Geocoding derives city, county, state, and ZIP. Supplied metadata is retained as an additional filter.
- Arrays shortlist polygon boundaries; metadata-only searches return candidates, not proof of point membership. Empty arrays impose no restriction.
- For an intentional null shape, membership is OR within each populated array and AND across populated arrays. Missing required metadata cannot prove membership; null geometry with no rules never matches a location. `shapePending` is unknown geometry, never an address-only match.
- Texas U.S. Senate uses null shape and `states: ["TX"]`. Coordinate-only searches cannot establish this state-only membership; also supply `state=TX`, or use an address. County suffixes and ZIP+4 are normalized; `Texas` and `TX` are equivalent.
- `effectiveDate` is inclusive, `expirationDate` exclusive; a null date imposes no restriction. Today's date is evaluated in `America/Chicago`.

```powershell
curl.exe "http://localhost:8080/api/boundaries?state=TX&entity=United%20States&body=Senate"
curl.exe "http://localhost:8080/api/boundaries?lat=32.78&lon=-96.8&state=TX"
curl.exe "http://localhost:8080/api/representatives?boundaryId=1"
```

#### Sync routes and durable worker

Public, bodyless GET routes require neither an API key nor user authentication:

- `/api/tick/boundaries/shape`: select one due idle boundary for shape refresh.
- `/api/tick/boundaries/research`: select one due idle boundary for research.
- `/api/tick/boundary/{id}`: shape and research, only when due.
- `/api/tick/representatives`: select one due current representative for research.
- `/api/tick/representative/{id}`: research only when due.
- `/api/tick/jobs/{id}`: poll sanitized durable job status; successful jobs include the current target model.

No eligible idle batch target returns `{ "syncCount": 0 }`; an ID tick with no work returns its model. Research is queued immediately with **202**, `{ jobId, status, statusUrl }`, `Location`, and `Retry-After`. Shape-only ticks attempt up to eight seconds synchronously; on deadline they return 202 and leave durable work for the worker. A completed synchronous shape tick returns the boundary. Job IDs are strings. A busy explicit target reuses its own job; if another target in the same boundary owns the lease, it returns the requested current model instead. A batch skips busy boundaries. Source failures are not disguised as syncCount zero. HEAD/prefetch cannot trigger work; all tick responses are `no-store`.

`POST /api/tick/boundary/{id}` and `POST /api/tick/representative/{id}` force configured services regardless of TTL/backoff. They require `X-API-Key`, a Firebase bearer token with canonical `staff:true`, and **Firebase App Check in production**. A busy forced target returns 409; retry after the job completes. Null services are skipped. An out-of-term congressional boundary cannot be researched by the live-member adapter; historical/future membership is not invented.

**Deploy a worker before enabling public ticks.** The web server never leaves untracked work running after responding. Run `npm run worker:boundaries` locally or `node dist/scripts/boundaryWorker.js` as a continuously CPU-allocated worker with the same database and provider configuration. Alternatively use a scheduled Cloud Run Job invoking `node dist/scripts/boundaryWorker.js --once`; it enqueues due boundary research before draining available work and exiting. This automatically hydrates and refreshes representatives when research adapters and credentials are configured, without separate discovery ticks. Workers rescan once per minute while running, queue at most `BOUNDARY_SYNC_RESEARCH_ENQUEUE_LIMIT` new jobs per scan (default 100), and preserve TTLs, retry backoff, active-scope deduplication and global execution budgets. Unconfigured providers are logged and skipped. A request-driven Cloud Run service with background CPU throttling is not a reliable worker. Cloud Scheduler should invoke the Cloud Run Job with authenticated IAM access, not a public force endpoint.

```powershell
$env:BOUNDARY_SYNC_ENABLED = "true"
npm run worker:boundaries
# In a separate terminal:
curl.exe "http://localhost:8080/api/tick/boundaries/research"
curl.exe "http://localhost:8080/api/tick/jobs/1"
```

PostgreSQL short transactions, `FOR UPDATE SKIP LOCKED`, one active job per boundary, five-minute fenced leases, and a three-minute execution deadline prevent overlapping boundary/representative writes across instances. External calls occur outside database transactions. A crashed job can be reclaimed; stale claim tokens cannot commit. Each applied phase clears its requested flag in the same transaction, so a crash after commit does not replay that completed phase. Database statements have a 15-second deadline and lock waits a five-second deadline; result commits recheck the lease against the actual database clock. Claims are retried at most three times after lease expiry; provider failures receive one-hour backoff. Last invocation timestamps include failures; separate successful-sync timestamps schedule TTL (shape default 365 days, research 60 days). Shape and research phases commit separately, so successful geometry is retained if subsequent research fails.

Default distributed limits: 30 scheduling requests per client/minute, 10 executions/minute, 100/day, and two simultaneous jobs across workers. These count jobs, not individual provider calls. Configure `BOUNDARY_SYNC_CLIENT_PER_MINUTE`, `BOUNDARY_SYNC_GLOBAL_PER_MINUTE`, `BOUNDARY_SYNC_GLOBAL_PER_DAY`, and `BOUNDARY_SYNC_CONCURRENCY`. Global caps protect against rotating clients; add edge/IP controls (for example Cloud Armor) for public reads/geocoding and DDoS protection. Client buckets use hashed Express `req.ip`; do not trust arbitrary forwarded headers. Configure trusted proxies only for the deployment's actual proxy chain. Monitor and periodically retain/prune completed jobs and evidence according to operational retention policy.

#### Research providers and evidence

Acquire **`CONGRESS_GOV_API_KEY`**, **`OPEN_STATES_API_KEY`**, and **`GEMINI_API_KEY`**; optionally retain the existing Maps key. Public GIS needs no API key. Store keys in Secret Manager/environment variables, **never** service descriptor params. Cloud Run API/worker identities need their existing Cloud SQL connection and Secret Manager secret-access permissions; staff verification needs existing Firebase Authentication permissions. A Scheduler identity needs permission to execute the selected Cloud Run Job.

The existing GoogleGenAI SDK is sufficient. Research defaults to `gemini-3.8-flash`, configurable through `BOUNDARY_RESEARCH_MODEL`, independently of assistService. Official Google documentation checked October 14, 2026 lists this model with Google Search grounding. Grounded discovery and structured extraction are separate calls; downloaded documents are untrusted data, not instructions. No Brave/Tavily key or browser automation is required. Cheerio parses HTML, PDF.js extracts bounded PDFs, and Turf handles geographic matching.

Congress.gov/Open States adapters apply complete validated current rosters and can create representatives or mark former members ended. No new tenure-start date is guessed; an observed replacement end timestamp records the discovery, not necessarily the legal last day in office. Reappointments after an ended tenure create a new record. Official-directory AI research applies names only with matching source quotes and district evidence; email/phone quotes must also name the person. It can update original boundary summaries and contact guidance when supported by a quote naming the entity. It **never** trusts LLM claims of completeness. A server-configured singleton office can replace an incumbent only when exactly one verified current holder comes from its approved primary roster and the document supports that body/office. Ambiguous or secondary-source transitions require review instead of creating competing incumbents. A representative tick using a verified complete roster may refresh related holders and end its departed target while preserving that target's historical ID. Unsupported proposals are saved to `boundary_research_evidence` for staff review, not silently applied. Review through trusted database tooling; no public proposal-approval endpoint exists. Existing verified fields are not cleared merely because a source omitted them.

Approved files/exports are statically registered in [boundaryAdapters.ts](src/services/boundaryAdapters.ts); no arbitrary import or executable configuration is allowed. Official website hosts are allowlisted, and redirects must remain approved. For a verified neighborhood/HOA organization's website, staff may add exact reviewed HTTPS hostnames to `BOUNDARY_RESEARCH_ALLOWED_HOSTS`; the seeder retains municipal `Asso_WEB` links as candidate sources, ignored until approved. No wildcard/private/IP hosts are accepted. The registered organization directory and HOA management certificates are not guaranteed to provide public board-member contacts.

Validation uses fixture-only provider calls, migration/backfill/seed tests, geometry/date/filter tests, queue/lease/budget tests, and staff/App Check authorization tests. Run `npm run build` and `node --import tsx --test tests\boundaries.test.ts tests\boundaryMigration.test.ts tests\boundaryAdapters.test.ts tests\representatives.test.ts`. No paid live provider calls are made by these tests. For real multi-connection locking tests, securely set `BOUNDARY_TEST_DATABASE_URL` to a **dedicated test database** and run `node --import tsx --test tests\boundaryConcurrency.test.ts`; it creates and removes a uniquely named temporary schema. Include `tests\boundaryWorkerConfig.test.ts` to validate Cloud Run service/job/worker-pool socket configuration.

### Authentication configuration

The API uses two independent authorization layers:

- **API key authorization:** send `X-API-Key: <application-key>`. `OPTIONAL` endpoints work without a key; `REQUIRED` endpoints require a valid key. Keys identify applications, are configured through `API_KEYS_JSON`, and should be stored in Cloud Secret Manager rather than committed to source control. In production, API-key-required browser requests also require Firebase App Check. Local development may use a registered Firebase App Check debug token.
- **User authorization:** send `Authorization: Bearer <Firebase-ID-token>` when required. Firebase Authentication / Google Identity Platform issues the token. Only the canonical boolean custom claim `staff: true` authorizes staff; legacy `role: 'staff'` and `roles` staff entries no longer authorize staff. The `system` claim and unrelated roles retain their existing behavior. `PUBLIC` endpoints do not require a user token; `PARTIAL` endpoints return restricted data without an authorized token; `PRIVATE` endpoints require a valid token and the endpoint's ownership or role condition. Invalid JWTs are ignored on `PUBLIC` and use restricted behavior on `PARTIAL` endpoints.

### Grammar assistance

`POST /api/assist/grammar` accepts `{ "text": "Their is a meeting tomorrow." }` and returns `{ "data": { "text": "There is a meeting tomorrow." } }`. Supply a valid `X-API-Key` and, in production, `X-Firebase-AppCheck`. User sign-in is optional; supplied Firebase tokens use existing PUBLIC authentication behavior.

The validation, safety controls, model configuration, quotas, and deployment requirements below also apply to `POST /api/assist/clarity` and `POST /api/assist/summarize`. All three endpoints consume the **same** application/user/global quota buckets and per-process concurrency budget. Existing `assist-grammar-quotas` documents and their TTL policy serve all three endpoints; no new secret, environment setting, or storage migration is needed.

Only `application/json` is accepted. Grammar and clarity allow a single `text` field; summarization also allows its four documented options. Text must be nonblank, valid Unicode, and at most **5000 Unicode code points** (not UTF-16 units or grapheme clusters). The encoded body is limited to **64 KiB**, even when an operation-group header is supplied. Original whitespace is not trimmed before sending to Gemini. Corrections may slightly expand the text; output is capped at 10000 code points.

Conservative prose-only screening rejects recognizable JavaScript, HTML markup, shell/Python/SQL snippets, code fences, and unsupported control characters, including quoted code. Rejection returns `422 EXECUTABLE_CONTENT_DETECTED` with locally generated `feedback` entries containing a reason and one-based line number, never an echoed snippet. Screening uses normalized text only for detection; the original is used for correction. Parsers and patterns are not exhaustive, and conservative matches can reject legitimate technical prose. They never execute or decode submitted payloads or fetch submitted URLs.

The official `@google/genai` SDK calls the fixed `gemini-3.1-flash-lite` model using a server-only API key. Instruction templates are fixed; caller text is serialized into a separate data field. Only validated summary settings are added as server constraints, never source text. The caller cannot select models, tools, prompts, URLs, or Gemini generation settings. Tools, code execution, automatic function calling, retrieval, and conversational state are not enabled. Grammar instructions request grammar/spelling corrections only while preserving meaning, language, dialect, names, numbers, tone, and paragraph structure. Schema, completion, size, and executable-content checks apply to output. These controls reduce prompt injection and model mistakes; they **cannot guarantee** perfect corrections or that Gemini never follows embedded instructions. Client applications must display returned text as text, not executable HTML, and should let users review corrections.

Configure the following before deployment:

| Setting | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | Required | Gemini API key restricted to the Generative Language API; inject from Secret Manager, never from clients |
| `ASSIST_QUOTA_DB` | `PUBLIC_IMPROVEMENTS_DB` or `public-improvements` | Existing Firestore database for atomic shared quotas |
| `ASSIST_GLOBAL_REQUESTS_PER_MINUTE` | `100` | Aggregate quota across every application and Cloud Run replica |
| `ASSIST_APP_REQUESTS_PER_MINUTE` | `20` | Quota per application API key, shared across users and replicas |
| `ASSIST_USER_REQUESTS_PER_MINUTE` | `10` | Additional quota per authenticated UID; optional sign-in cannot bypass the application quota |
| `ASSIST_MAX_CONCURRENT` | `4` | Concurrent admitted requests per process, including quota checks; maximum configurable value is 32 |

Rate settings must be positive integers no greater than 10000. Quotas use fixed one-minute windows; bursts across window boundaries are possible. Application-key quotas are deliberately used instead of trusting spoofable forwarding headers or assuming a Cloud Run proxy address identifies an end user. Quotas consume one attempt before each model call and are not refunded for failures. Per-process concurrency is supplemented by shared global quotas across replicas.

The runtime service account needs Firestore transaction read/write access (for example `roles/datastore.user`) and access to the Gemini secret (`roles/secretmanager.secretAccessor` on that secret). Quota checks fail closed after five seconds or on storage/configuration errors, without calling Gemini. Documents in `assist-grammar-quotas` contain hashed identifiers, counters, and expiration timestamps, not keys, UIDs, or text. Enable Firestore TTL for the collection group's `expiresAt` field to clean up inactive identifiers; quota correctness does not depend on timely TTL deletion. Configure billing alerts and appropriate Google API quotas as additional cost controls.

Create a `gemini-api-key` secret using your secure secret-management workflow, then attach it to the service without exposing its value:

```bash
gcloud run services update urbanists-cloud-api-server --region us-central1 --update-secrets GEMINI_API_KEY=gemini-api-key:latest
```

Deploy the endpoint code through the existing deployment workflow. Locally, configure `GEMINI_API_KEY` in your private environment and use Application Default Credentials for the quota database. Missing Gemini configuration returns `503` and does not affect other endpoints.

All endpoint responses use `Cache-Control: no-store`. The application does not persist or log source/corrected text, provider responses, keys, or raw provider errors; Gemini's own data handling remains governed by the selected API tier and provider terms. Error statuses are `400` validation, `401` application authentication, `413` body size, `415` media type, `422` content rejection/refusal, `429` quota/concurrency, and sanitized `500`/`502`/`503`/`504` failures. `Retry-After` accompanies local throttling and selected upstream availability failures. Gemini calls have a 20-second deadline and no automatic retries; cancellation may not stop provider billing.

Run `npx tsx --test tests/assist.test.ts` for local validation, HTTP, quota, and mocked-provider tests. Live evaluation is opt-in and incurs Gemini API usage:

```bash
RUN_ASSIST_LIVE_TESTS=true npx tsx --test tests/assist.test.ts
```

Live tests check grammar correction, clarity rewriting, constrained summaries, and embedded instructions. Passing these examples is not proof of universal injection resistance; broaden evaluation with representative user text and adversarial cases before production rollout.

### Clarity assistance

`POST /api/assist/clarity` uses the same `{ "text": "..." }` request and `{ "data": { "text": "..." } }` response as grammar assistance, with a separate fixed server prompt for rewriting. It corrects grammar and spelling, removes unnecessary repetition, makes the author's intent clear, and puts the main point, purpose, or key takeaway first. It aims for a 10th-grade reading level or lower, with concise wording that preserves substance, emotional expression, tone, nuance, and meaningful emphasis.

Unlike grammar-only editing, clarity may reorder sentences and paragraphs. Instructions preserve facts, names, numbers, dates, URLs, language, dialect, qualifications, uncertainty, questions, and requests, and prohibit inventing facts, inferring missing motives, or adding commitments. Fidelity to the original message takes priority when readability or brevity conflicts with its substance. The reading-level target and rewrite quality are best-effort model goals, not guaranteed or enforced by a numerical grade check. Callers should review the result before using it.

For example, `{ "text": "I have been thinking about the faded school crosswalk on Elm Street. I feel scared when my children cross there. Please repaint it by October 20." }` may return `{ "data": { "text": "Please repaint the faded school crosswalk on Elm Street by October 20. I feel scared when my children cross there." } }`.

Validation errors use `INVALID_CLARITY_INPUT`; executable-content feedback and all other status/error codes follow the grammar contract. Both operations appear under the Swagger **Assist** tag. To run only the clarity live evaluation (two billed Gemini calls), use `RUN_ASSIST_LIVE_TESTS=true npx tsx --test --test-name-pattern='opt-in live Gemini clarity' tests/assist.test.ts`.

### Summary assistance

`POST /api/assist/summarize` returns `{ "data": { "text": "concise summary" } }` with the same authentication, 5000-code-point input limit, prose-only screening, privacy, quotas, concurrency, and provider/output safeguards as clarity. It produces a summary rather than rewriting the entire message, retaining the main point, key facts, intent, qualifications, and emotional expression as faithfully as the length limits allow.

Summaries prefer widely known common abbreviations when their meaning remains clear, such as `Elm St` instead of `Elm Street` and `Ross Ave` instead of `Ross Avenue`. This is a model-directed brevity preference, not automatic string replacement; instructions prohibit invented abbreviations, obscure acronyms, and ambiguous shortcuts that change identities or reduce readability.

Only `text` is required. Four optional JSON fields control the result:

| Field | Default | Meaning |
|---|---|---|
| `type` | `auto` | `declarative`, `imperative`, `interrogative`, `exclamatory`, or `auto`; controls only the final sentence, or lets the model choose |
| `max_sentences` | `1` | Hard maximum sentence count |
| `target_sentences` | `1` | Ideal count, not a minimum; must be no greater than `max_sentences`. Fewer sentences are allowed for shorter sources or to avoid padding or violating the character cap |
| `max_characters` | `140` | Hard maximum total Unicode code points, including spaces and punctuation |

Numeric fields must be integers between 1 and 10000, matching the existing absolute output ceiling. Numeric strings, fractions, zero, `null`, invalid types, and unknown fields are rejected before quota consumption or model calls. Defaults are applied independently: for example, `target_sentences: 2` without increasing `max_sentences` is invalid. Grammar and clarity do not accept these options.

Example request:

```json
{
  "text": "The school crosswalk on Elm Street is faded. I worry when my children cross there. Please repaint it by October 20.",
  "type": "imperative",
  "max_sentences": 2,
  "target_sentences": 1,
  "max_characters": 140
}
```

Gemini returns a structured sentence list internally; the server validates each item and joins sentence text with one space. Only the resulting `data.text` is exposed. Local checks enforce the requested character cap, sentence-list cap, and `sentence-splitter` sentence boundaries, including common English time abbreviations and multilingual sentence-ending punctuation. Ambiguous linguistic boundaries may cause conservative rejection. Final-type checks validate the model's declared type and compatible ending punctuation; grammatical mood, ideal count, reading level, and semantic fidelity remain best-effort model behavior, not infallible linguistic classification.

Invalid requests return `400 INVALID_SUMMARY_INPUT`; executable-content feedback remains `422 EXECUTABLE_CONTENT_DETECTED`. Invalid or unsafe summaries, including cap violations, return `502 ASSIST_INVALID_OUTPUT`. Results are **never silently truncated**, and no automatic repair/retry call is made. Very small character caps may be impossible to satisfy faithfully; loosen constraints when appropriate and review summaries before use. Character counts are code points, not UTF-16 units or user-perceived grapheme clusters.

The endpoint appears under Swagger **Assist**. Run its opt-in live evaluation (three billed Gemini calls) with `RUN_ASSIST_LIVE_TESTS=true npx tsx --test --test-name-pattern='opt-in live Gemini summary' tests/assist.test.ts`.

### User authentication troubleshooting

If private endpoints return `401` while public/partial endpoints behave anonymously, user authentication is missing or failing—not merely missing a staff role (which returns `403`). Cloud Run uses its runtime service account, not the local credentials used for migration. Revocation checks require `firebaseauth.users.get`; staff claim administration additionally requires user-update permission. Ensure the runtime identity has the appropriate Firebase Authentication permissions in the authentication project.

The middleware emits `user_authentication_failed` warnings with a missing/malformed credential reason or a sanitized Firebase error code. It never logs bearer tokens, decoded claims, or raw exception messages. Search Cloud Run logs for this event to distinguish credential errors from runtime permission failures; missing role claims alone do not emit authentication-failure warnings.

### Swagger Firebase App Check

Swagger initializes App Check on page load, independently of user sign-in and the Authorize button. Configure `FIREBASE_WEB_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID`, and `FIREBASE_APP_ID` from the same Firebase web app. Register that exact app under Firebase Console → App Check.

Set `FIREBASE_APPCHECK_PROVIDER` to match its registration: `recaptcha-v3` (the backwards-compatible default) or `recaptcha-enterprise`. Set `FIREBASE_RECAPTCHA_SITE_KEY` to the matching provider's site key, permitting the Swagger hostname. Never expose a secret key in these browser settings. For Enterprise, use the Enterprise website/score-based key registered in Firebase, not a separate v3 key. Set `ENABLE_SWAGGER_FIREBASE_AUTH=true` to enable the sign-in helper. The corresponding `VITE_FIREBASE_APPCHECK_PROVIDER` setting is also supported as a fallback.

For the production Enterprise registration, deploy the updated code and set `FIREBASE_APPCHECK_PROVIDER=recaptcha-enterprise` on Cloud Run (local environment files do not configure Cloud Run). Hard-refresh Swagger after deployment; token exchange should use `exchangeRecaptchaEnterpriseToken`, not `exchangeRecaptchaV3Token`. A provider mismatch can produce `App not registered` even when the app is registered for the other provider. Production App Check enforcement is unchanged; debug tokens remain development-only.

### Endpoint authorization matrix

| Endpoint group | API key | User authorization | Additional conditions |
|---|---|---|---|
| `GET /api/health` | Optional | Public | None |
| `GET /api/contacts` | Required | Partial | Staff receives full search; others need a search term and receive redacted results |
| `POST /api/contacts` | Required | Public | Duplicate challenge may be required; `roles` is not accepted |
| `GET /api/contacts/{id}` | Required | Partial | Owner or staff receives full details; others receive redacted details |
| `PUT /api/contacts/{id}` | Required | Partial | Owner/staff authorization controls additive or full updates |
| `DELETE /api/contacts/{id}` | Required | Private | Contact owner or staff; soft delete |
| `GET /api/checkins` | Required | Partial | Non-staff callers must provide `event_id`; contact data is redacted |
| `POST /api/checkins` | Optional | Public | Valid BIGINT event/contact IDs; one check-in per contact/event |
| `GET /api/checkins/{id}` | Required | Partial | Contact details depend on ownership/staff status and `include_contact` |
| `PUT`/`DELETE /api/checkins/{id}` | Required | Private | Contact owner or staff |
| Ideas reads/creation | Required | Public | `GET`, `POST`, and upload URL are public to authorized applications |
| Idea update/delete | Required | Private | Author email match or staff |
| Event reads and calendars | Optional | Public | Includes `/api/events`, `/api/events/{id}`, `/api/events/ical`, and `/meetup-ical` |
| Event writes/import | Required | Private | `staff` or `system` role |
| `GET /api/users` | Required | Private | Any authenticated user; no staff role required |
| `PUT`/`DELETE /api/users/{uid}/claims/staff` | Required | Private | Canonical `staff: true` only; never self; no system-only access |
| `POST /api/assist/grammar` | Required | Public | Production App Check; prose-only text up to 5000 code points; shared quotas |
| `POST /api/assist/clarity` | Required | Public | Same validation and shared quotas as grammar; best-effort clarity and structure rewrite |
| `POST /api/assist/summarize` | Required | Public | Same shared safeguards; validated summary options; enforced sentence and character caps |

Configure application keys through the `API_KEYS_JSON` environment variable; in Cloud Run, provide it from Secret Manager rather than committing it to source control.

### User directory

`GET /api/users` returns a JSON array of all existing Firebase Authentication users, including disabled accounts (not CRM contacts). The server reads every Firebase page; no pagination parameters are needed. Each entry contains `uid`, `email`, `displayName`, `disabled`, and boolean `staff`. Missing email/name values are `null`. `staff` is true only when the current stored custom claim is exactly `staff: true`; legacy role/roles values are not counted. Password hashes, salts, provider data, and other custom claims are never returned.

Any authenticated user may list the directory with a valid API key and non-revoked Firebase ID token; no staff role is required. Production also requires Firebase App Check. Success is `200` (an empty directory returns `[]`); invalid/missing credentials return `401`, and Firebase listing failures return a sanitized `500` without a partial list. The runtime service account needs Firebase Authentication user-read permission.

### Staff claim administration

`PUT /api/users/{uid}/claims/staff` assigns canonical `staff: true`; `DELETE` removes it. Both remove legacy staff from `role` and scalar/array `roles`, preserving unrelated roles and custom claims. No body is required. The target is a URL-encoded Firebase Authentication UID of 1–128 characters, **not a UUID**. Only a private canonical staff caller may administer another user; `system` alone never suffices and self-targeting is always forbidden, even for no-ops.

Success is an empty `204`; failures are structured JSON: `400` invalid UID, `401` invalid/missing credentials (API key, ID token, production App Check), `403` nonstaff/self, `404` unknown user, `500` internal failures. DELETE revokes refresh tokens **every time**, even if staff was already absent. If claims were removed but revocation failed (`500`), retry DELETE. PUT does not revoke tokens: the target must force-refresh its ID token to receive the new claim. Every supplied ID token is verified with revocation checking; revoked/disabled/invalid tokens are rejected on PRIVATE endpoints and fall back anonymously/restricted on PUBLIC/PARTIAL endpoints, never attaching a user.

```bash
curl -i -X PUT "$API_URL/api/users/$TARGET_UID/claims/staff" \
  -H "X-API-Key: $API_KEY" -H "Authorization: Bearer $STAFF_ID_TOKEN" \
  -H "X-Firebase-AppCheck: $APP_CHECK_TOKEN"
curl -i -X DELETE "$API_URL/api/users/$TARGET_UID/claims/staff" \
  -H "X-API-Key: $API_KEY" -H "Authorization: Bearer $STAFF_ID_TOKEN" \
  -H "X-Firebase-AppCheck: $APP_CHECK_TOKEN"
```

URL-encode `TARGET_UID` if necessary. App Check is required on all production requests to these endpoints, not only browser requests; it is not required locally. Existing `API_KEYS_JSON` and `NODE_ENV=production` settings apply. Firebase Admin uses Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS` locally or the Cloud Run service account); no new secret is needed. The runtime service account needs Firebase Authentication user read/update permissions (for example `roles/firebaseauth.admin`) and App Check verification permissions (for example `roles/firebaseappcheck.tokenVerifier`). Audit logs contain only structured actor UID, target UID, action, outcome and HTTP status, never tokens, keys, emails or claim contents.

### Staff claims migration — run before authorization cutover

The standalone `npm run migrate:staff-claims` tool uses Firebase `listUsers`, normalizing **all** recognized existing staff (`staff: true`, `role: 'staff'`, scalar `roles: 'staff'`, or array `roles` containing `'staff'`) to canonical `staff: true` and removing their legacy staff representations. Other claims/roles are preserved. It does not run on startup, build or deployment. Tests use mocks; never run it automatically against live Firebase.

1. Before deploying canonical-only authorization, inventory/back up custom claims using approved secure procedures and rehearse in a non-production Firebase project. Pause other custom-claim writers during migration: Firebase custom-claim updates replace the entire map and are not transactional. The API also uses read/merge/write, so serialize competing writes per target.
2. Use an explicitly selected project and ADC identity with user read/update permissions (`roles/firebaseauth.admin` is sufficient). Dry run is the default and never mutates users or writes checkpoints:

   ```bash
   npm run migrate:staff-claims -- --project "$FIREBASE_PROJECT_ID"
   ```

If the dry run fails, the CLI prints the underlying error code/message. Check Application Default Credentials (`gcloud auth application-default login`), the explicit project, and Firebase Authentication read/update permissions. Do not proceed to apply until the full dry run succeeds.

3. Review dry-run counts, then explicitly apply with a checkpoint file in an existing, private local directory. Reuse the same command/file to resume after interruption. The checkpoint is project-bound and saved atomically only after a complete page; a failed page is replayed safely. Run only one migration process per checkpoint/project.

   ```bash
   npm run migrate:staff-claims -- --project "$FIREBASE_PROJECT_ID" --apply --checkpoint ./staff-claims.checkpoint.json
   ```

   `--cursor <Firebase-page-token>` may start a dry run or a new apply checkpoint at a supplied cursor. Do not combine it with an existing checkpoint; omit it for the initial full migration. Completed checkpoints do not restart; use a new checkpoint for a fresh full scan. Keep checkpoints private and out of version control. They contain project/cursor metadata, not credentials.
4. Confirm a fresh **full** dry run reports zero changes. Before cutover, require every existing staff client to force-refresh its Firebase ID token (`getIdToken(true)`) or sign in again and verify `getIdTokenResult(true).claims.staff === true`. Old ID tokens retain legacy-only claims until refreshed; otherwise these clients lose staff access after deployment. Migration deliberately does not revoke tokens. Ensure at least one refreshed canonical staff administrator is available before deploying.
5. Deploy canonical-only authorization and these administration endpoints; smoke-test using the refreshed staff account and a separate target. Resume claim writers only once cutover is verified. Roll back the authorization deployment if refresh readiness cannot be confirmed; do not restore legacy staff authorization through API claims.

Apply migrations `001_add_firebase_uid.sql`, `002_event_id_bigint_foreign_key.sql`, and `003_operation_groups.sql` before deploying this version. Representative/boundary endpoints additionally require migrations 004–007 in the order documented above. Rehearse against the actual schema in a non-production database; resolve duplicate contact/event check-ins before migration 003.

### Atomic changes, history, and Undo

Owner/staff contact and check-in PUT/DELETE requests may be staged using `X-Operation-Group`, `If-Match`, and `Idempotency-Key`. Begin requires an immutable manifest and UUIDv7 client action ID; commit requires exact completeness. Commits and trusted Undo are atomic, revision/lineage checked, and account-bound. Existing requests without a group remain immediate.

Authenticated source-filtered history discovery recovers committed actions after lost responses, without local snapshots. Server history/Undo lasts 30 days; logout clears frontend state, not account history. Open groups expire after 24 hours. Each group is limited to 100 typed targets and 1 MiB canonical UTF-8 payload; one Save/Remove must never be split into separate commits. Retry metadata has a 90-day horizon enforced even after cleanup.

See the [operation-group API contract](docs/operation-groups.md) for exact byte accounting, UUIDv7/retry rules, history pagination, cross-device Ctrl-Z, lineage, error recovery, deployment and cleanup. Run `npm test` for isolated PostgreSQL contract tests and `npm run build` for TypeScript validation.

#### Rotating API keys

1. Create a new `api-keys-rotated.json` containing the existing keys and a newly generated key. Keep the JSON format used by `API_KEYS_JSON`.
2. Upload it as a new Secret Manager version:

```powershell
gcloud secrets versions add api-keys-json --data-file="api-keys-rotated.json"
```

3. Deploy the new secret version to Cloud Run:

```powershell
gcloud run services update urbanists-cloud-api-server `
  --region=us-central1 `
  --update-secrets="API_KEYS_JSON=api-keys-json:latest"
```

4. Update the client application to use the new key, then upload another secret version with the retired key removed.
5. Never commit API-key JSON files or expose Secret Manager credentials. Browser API keys identify applications but are not confidential secrets.

---

## 🌟 Features

- **Public Improvements API**: Full CRUD endpoints for managing civic improvement ideas in Firestore (`public-improvements` database), with support for photo attachments and pre-signed GCS upload URLs.
- **Contacts & CRM API**: PostgreSQL-backed contacts management with automatic data normalization (uppercase names, lowercase emails, standardized NANP phone formats) and multi-field search filtering.
- **Event Checkins API**: Record and query event check-in entries linked to CRM contacts or anonymous attendees.
- **Meetup Events & Calendar Proxy**: Proxies Dallas Urbanists Meetup iCal feeds with HTTP caching headers (`ETag`, `Last-Modified`, `Cache-Control`) and CORS headers for client-side applications.
- **Multi-Database & Multi-Cloud Architecture**: Integrates Firestore, PostgreSQL on Cloud SQL, and Google Cloud Storage seamlessly.
- **Interactive Swagger UI**: Explore all endpoints, test requests in the browser, view schemas, and switch between Dark and Light modes styled in the Strong Towns visual palette at `/docs`.
- **Domain Authorization & CORS**: Restricts production cross-origin requests to authorized domains (configured via `ALLOWED_ORIGINS`) while permitting unrestricted requests from `localhost` / `127.0.0.1` for local development and testing.

---

## 📊 Data Models & Schemas

### 1. Idea (`public-improvements` Firestore Database)

Documents in the `idea` collection inside the `public-improvements` Firestore database adhere to the following schema:

| Field | Type | Description |
|---|---|---|
| `id` | `integer` | Unique sequential integer identifier |
| `emoji` | `string` (optional) | Server-assigned emoji describing the idea; JEV assigns it at creation and on individual reads when missing |
| `creationDate` | `string` (ISO 8601) | Timestamp when idea was created |
| `modificationDate` | `string` (ISO 8601) | Timestamp of most recent update |
| `status` | `enum` | `'new'` \| `'inprogress'` \| `'stalled'` \| `'withdrawn'` \| `'completed'` |
| `author.email` | `string` (email) | Author's email address |
| `author.name` | `string` | Author's display name |
| `content.summary` | `string` | Short title / summary of the idea |
| `content.details` | `string` | Extended markdown / detailed description (default `""`) |
| `content.photos` | `array<object>` | Optional array of photos (max 10 items) |
| `content.photos[].url` | `string` (URI) | Public URL of uploaded photo |
| `content.photos[].caption` | `string` | Description / caption for photo |
| `content.photos[].timestamp` | `string` (ISO 8601) | Timestamp when photo was taken/uploaded |
| `location.latitude` | `float` (optional) | Geographical latitude coordinate |
| `location.longitude` | `float` (optional) | Geographical longitude coordinate |
| `location.description`| `string` | Landmark/corridor description (default `""`) |
| `location.address` | `string` | Street address (default `""`) |

Recommended Actions are stored as documents in `idea/{ideaId}/recommendedActions/{actionId}`. Each has summary, instructions, reason, a nullable `representativeId` (validated against PostgreSQL), nullable UTC `expirationDate`, status (`open`, `ignored`, `started`, `paused`, `cancelled`, or `finished`), and creation/modification dates. Expired actions are hidden by default and can be included with `includeExpired=true`; expiration does not alter status.

Idea activity is append-only under `idea/{ideaId}/log/{entryId}`. Idea detail returns the newest 50 entries and pagination metadata; the Ideas list omits logs. Status transitions add a server-attributed log entry atomically with the update. Repeating the current status is a no-op (`noOp: true`) and does not add another entry.

Reusable Recommendable Actions use a single Firestore `recommendableActions` collection for every status (`candidate`, `approved`, `rejected`, `closed`, `uncertain`). Approval and rejection update the same document in place; only approved actions are publicly readable and eligible for matching. Source-backed actions use their stable `sourceKey` as document ID, and changed content returns the same action to candidate status with version history. Idea-specific Recommended Actions remain separate. Entries retain exact source evidence and a version number. `boundaries` contains applicable boundary IDs; an empty array is unrestricted, otherwise any overlap with the idea's resolved boundary IDs is sufficient. Idea submission invokes Jev matching against approved entries; dynamic buckets select linked Recommended Actions after redundancy filtering: all matches at or above 80% when available, otherwise up to five at or above 15%, otherwise up to five at or above 4%. Results below 4% are excluded; weaker buckets do not fill unused slots. The former `RECOMMENDABLE_MATCH_THRESHOLD` setting is ignored. Boundary-scoped entries do not match ideas without coordinates that resolve to boundaries.

Recommendable Action routes are public: `GET /api/recommendables` lists approved entries and accepts an optional `search` term matching summary, instructions, or reason; `GET /api/recommendables/:id` retrieves one approved entry. Both work without an API key. `/api/recommendables/candidates` supports authenticated submission and staff listing, `PATCH /api/recommendables/candidates/:id` handles staff approval/rejection, and `PATCH /api/recommendables/:id` updates status for staff. Submission currently accepts official `dallascityhall.com` sources only and requires staff approval before an entry can match. `npm run scan:recommendables` checks the version-controlled source registry in `src/data/recommendableSources.ts`, skips unchanged pages using content fingerprints, and creates evidence-backed candidates when an opportunity is detected. Production uses the `recommendable-worker` Cloud Run Job, invoked daily at midnight America/Chicago by the `recommendable-worker-daily` Cloud Scheduler job; discovery never auto-publishes. A changed page with no verifiable opportunity moves its catalog entry to `uncertain` for staff review.

---

### 2. Contact (`contacts` PostgreSQL Table)

Contact records stored in the relational database adhere to the following schema:

| Field | Type | Description |
|---|---|---|
| `id` | `integer` (bigint) | Unique identifier for the contact |
| `name` | `string` | Full name of contact (automatically normalized to uppercase) |
| `created_on` | `string` (ISO 8601) | Timestamp with time zone when the record was created |
| `emails` | `array<string>` | Email addresses associated with the contact (normalized to lowercase) |
| `phones` | `array<string>` | Phone numbers (normalized to `+1-XXX-XXX-XXXX` NANP format) |
| `zip_home` | `string` (optional) | Primary residential ZIP code |
| `zip_other` | `array<string>` | Additional ZIP codes (work, advocacy areas, etc.) |
| `roles` | `array<string>` | Assigned roles (e.g. `volunteer`, `donor`, `advocate`, `organizer`) |

---

### 3. Checkin (`checkins` PostgreSQL Table)

Checkin records stored in the relational database adhere to the following schema:

| Field | Type | Description |
|---|---|---|
| `id` | `integer` (bigint) | Unique identifier for the checkin |
| `contact_id` | `integer` (nullable) | Associated contact ID (foreign key reference to `contacts.id`), or `null` for anonymous |
| `event_id` | `bigint` | Foreign key referencing `events.id` for the event checked into |
| `submitted_on` | `string` (ISO 8601) | Timestamp with time zone when the checkin was recorded |

---

### 4. Event (`events` PostgreSQL Table)

Event records stored in the relational database adhere to the following schema:

| Field | Type | Description |
|---|---|---|
| `id` | `integer` (bigint) | Unique identifier for the event |
| `uid` | `string` | Unique iCalendar identifier or external system UID |
| `start_at` | `string` (ISO 8601) | Timestamp with time zone when the event starts |
| `end_at` | `string` (ISO 8601, optional) | Timestamp with time zone when the event ends (mutually exclusive with `duration`) |
| `duration` | `string` (optional) | Duration interval (e.g. `PT2H`, mutually exclusive with `end_at`) |
| `all_day` | `boolean` | Indicates whether the event is an all-day event (default `false`) |
| `timezone` | `string` (optional) | Timezone identifier (e.g. `America/Chicago`) |
| `title` | `string` (optional) | Event title or summary |
| `description` | `string` (optional) | Description / details of the event |
| `location` | `string` (optional) | Human-readable event location or venue |
| `url` | `string` (URI, optional) | External URL for the event |
| `status` | `string` (optional) | Event status (e.g. `CONFIRMED`, `TENTATIVE`, `CANCELLED`) |
| `img` | `string` (URI, optional) | Image or banner URL |
| `classification` | `string` (optional) | Access classification (e.g. `PUBLIC`, `PRIVATE`) |
| `sequence` | `integer` | iCal revision sequence counter (default `0`) |
| `organizer_name` | `string` (optional) | Name of event organizer |
| `organizer_email` | `string` (optional) | Email of event organizer |
| `recurrence_rule` | `string` (optional) | RFC 5545 recurrence rule (RRULE) |
| `recurrence_id` | `string` (ISO 8601, optional) | Recurrence instance timestamp |
| `categories` | `array<string>` (optional) | Categories or tags |
| `resources` | `array<string>` (optional) | Allocated resources |
| `attachments` | `array<object>` (optional) | Attachment metadata |
| `geo_latitude` | `float` (numeric 9,6, optional) | Geographic latitude |
| `geo_longitude` | `float` (numeric 9,6, optional) | Geographic longitude |
| `is_hosted_by_du` | `boolean` | Flag indicating whether Dallas Urbanists is hosting (default `true`) |
| `ical_raw` | `string` (optional) | Raw VEVENT block text |
| `ical_dtstamp` | `string` (ISO 8601) | iCal generation timestamp |
| `ical_created` | `string` (ISO 8601, optional) | Timestamp when event was created upstream |
| `ical_last_modified` | `string` (ISO 8601, optional) | Timestamp when event was last updated upstream |
| `created_at` | `string` (ISO 8601) | Record creation timestamp |
| `updated_at` | `string` (ISO 8601) | Record modification timestamp |

---

## 🚀 Quick Start for Developers

### 1. Prerequisites

- [Node.js](https://nodejs.org/) (version 20 LTS or higher recommended)
- [NPM](https://www.npmjs.com/)
- [Google Cloud CLI (`gcloud`)](https://cloud.google.com/sdk/docs/install) (for deployment & GCP credentials)
- [PostgreSQL](https://www.postgresql.org/) (optional for local database testing, defaults to `127.0.0.1:5432`)

### 2. Clone the Repository

```bash
git clone https://github.com/dallas-urbanists/urbanists-cloud-api-server.git
cd urbanists-cloud-api-server
```

### 3. Install Dependencies

```bash
npm install
```

### 4. Configure Environment Variables

Copy the sample environment file:

```bash
cp .env.example .env
```

Configure your `.env` variables as needed:

```env
PORT=8080
NODE_ENV=development

# Firestore Configuration
PUBLIC_IMPROVEMENTS_DB=public-improvements
IDEAS_DATA_LAYOUT=ideas

# Google Cloud Storage
IDEA_PHOTOS_BUCKET=urbanists-idea-photos
IDEAS_MAINTENANCE=false

# PostgreSQL Database Configuration
DB_USER=postgres
DB_PASSWORD=your_postgres_password
DB_NAME=postgres
DB_HOST=127.0.0.1
DB_PORT=5432

# CORS Allowed Origins
ALLOWED_ORIGINS=https://dallasurbanists.org,https://dallasurbanists.github.io,https://dallasurbanists.web.app
```

> **Note on Local Development**: When running locally, requests from `http://localhost:*` and `http://127.0.0.1:*` are automatically authorized, regardless of the `ALLOWED_ORIGINS` setting.

### 5. Google Cloud Authentication (Local Development)

To connect to Firestore and Cloud Storage from your local environment:

```bash
gcloud auth application-default login
```

Or set the `GOOGLE_APPLICATION_CREDENTIALS` variable in your `.env` pointing to a valid service account key JSON file:

```env
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json
```

---

## 💻 Running the Server

### Development Mode (with hot-reloading)

```bash
npm run dev
```

The server starts on `http://localhost:8080`.

### Production Build & Run

```bash
npm run build
npm start
```

---

## 📖 API Documentation & Manual Testing

The server includes an interactive **Swagger UI** built with the **OpenAPI 3.0.3** specification and customized with the Strong Towns design aesthetic, featuring:
- **Dark Mode & Light Mode** toggle with instant switching and persistent `localStorage` preference.
- **Categorized Endpoints** grouped under `Ideas`, `Contacts`, `Checkins`, `Events`, and `System`.
- **Interactive "Try it out" Execution** for real-time testing and schema inspection directly in the browser.

Once the server is running, access the documentation at any of the following URLs:

- **Swagger UI**: [http://localhost:8080/docs](http://localhost:8080/docs) (also mounted at `/`, `/swagger`, and `/api-docs`)
- **OpenAPI 3.0 JSON Spec**: [http://localhost:8080/api-docs.json](http://localhost:8080/api-docs.json)
- **Health Check Endpoint**: [http://localhost:8080/api/health](http://localhost:8080/api/health)

---

## 🔌 API Endpoints Summary

### System (`System` Tag)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Check operational health, service name, and active database connections |

---

### Ideas (`Ideas` Tag)

Endpoints for managing civic improvement ideas and photo uploads in Firestore (`public-improvements` database) and Google Cloud Storage. *(Mounted at `/api/ideas` and `/api/public-improvements/ideas`).*

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/ideas/upload-url` | Generate a pre-signed GCS URL for direct photo upload |
| `GET` | `/api/ideas` | List ideas (supports `?status=`, `?authorEmail=`, `?limit=`) |
| `GET` (WebSocket upgrade) | `/api/ideas/ws` | Receive authenticated real-time create/update/delete notices; see [protocol and browser example](docs/idea-notices.md) |
| `POST` | `/api/ideas` | Create a new idea record |
| `GET` | `/api/ideas/:id` | Get idea details by integer ID |
| `PUT` | `/api/ideas/:id` | Update an existing idea by ID |
| `DELETE` | `/api/ideas/:id` | Delete an idea by ID |
| `GET` | `/api/ideas/:ideaId/recommended-actions` | List actions (`?status=`, `?includeExpired=`) |
| `POST` | `/api/ideas/:ideaId/recommended-actions` | Create a staff-managed action |
| `GET` | `/api/ideas/:ideaId/recommended-actions/:actionId` | Get one action |
| `PATCH` | `/api/ideas/:ideaId/recommended-actions/:actionId` | Update an action (staff only) |
| `DELETE` | `/api/ideas/:ideaId/recommended-actions/:actionId` | Delete an action (staff only) |
| `GET` | `/api/ideas/:ideaId/log` | Read paginated activity (`limit` max 100, opaque `cursor`) |
| `POST` | `/api/ideas/:ideaId/log` | Append activity as the Idea author or staff |

The nested routes are also available under `/api/public-improvements/ideas`. All routes require an API key; action mutations require staff authentication. Child documents are removed when an Idea is deleted, and child writes are blocked while deletion is in progress.

#### Example: Generate Signed Upload URL (`POST /api/ideas/upload-url`)

**Request Body:**
```json
{
  "filename": "street-redesign.jpg",
  "contentType": "image/jpeg"
}
```

**Response (`200 OK`):**
```json
{
  "message": "Signed upload URL generated successfully.",
  "data": {
    "uploadUrl": "https://storage.googleapis.com/urbanists-idea-photos/ideas/uploads/1727800000000-uuid.jpg?X-Goog-Algorithm=...",
    "publicUrl": "https://storage.googleapis.com/urbanists-idea-photos/ideas/uploads/1727800000000-uuid.jpg",
    "filePath": "ideas/uploads/1727800000000-uuid.jpg",
    "expiresAt": "2026-09-23T14:45:00.000Z"
  }
}
```

The browser uploads bytes with a `PUT` to `uploadUrl`, using the same `contentType`, then stores the returned `publicUrl` as the photo URL. Treat returned URLs and paths as opaque; the signer does not require an Idea ID and does not return `ideaId`.

#### Example: Create Idea (`POST /api/ideas`)

**Request Body:**
```json
{
  "status": "new",
  "author": {
    "email": "alex@dallasurbanists.org",
    "name": "Alex Rivera"
  },
  "content": {
    "summary": "Add protected bike lanes and shade trees along Elm Street",
    "details": "Installing concrete bollards and native Texas oak trees will increase pedestrian safety and lower summer heat.",
    "photos": [
      {
        "url": "https://storage.googleapis.com/urbanists-idea-photos/ideas/1/elm-street.jpg",
        "caption": "Current street condition without protected bike lane",
        "timestamp": "2026-09-23T14:30:00.000Z"
      }
    ]
  },
  "location": {
    "latitude": 32.78014,
    "longitude": -96.79701,
    "description": "Intersection of Elm St and N Akard St in Downtown Dallas",
    "address": "1500 Elm St, Dallas, TX 75201"
  }
}
```

---

### Presentation (`Presentation` Tag)

Capability-authenticated sessions connect one TV receiver, one presenter, and independent audience viewers. REST remains available with `PRESENTATION_ENABLED=true`; presentation WebSockets require the additional `PRESENTATION_WEBSOCKET_ENABLED=true`, and both switches default off. Requests use `/api/public-improvements/presentation`, require no Firebase account or application API key, and use `Authorization: Bearer <participantToken>` plus `X-Presentation-Participant` after enrollment. See the [Presentation API guide](docs/presentation.md) for enrollment, the socket protocol, state, expiry, limits, and isolated local setup.

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/public-improvements/presentation/sessions` | Create a receiver session and presenter/audience codes |
| `POST` | `/api/public-improvements/presentation/pair` | Claim presenter control with a pairing code |
| `POST` | `/api/public-improvements/presentation/audience/join` | Join as an audience viewer |
| `POST` | `/api/public-improvements/presentation/sessions/:sessionId/sync` | Poll state, content, and role-specific presence |
| `GET` (WebSocket upgrade) | `/api/public-improvements/presentation/ws` | Receive capability-authenticated full snapshots and send role-scoped presence; see [protocol guide](docs/presentation.md#presentation-websocket-v1) |
| `PUT` | `/api/public-improvements/presentation/sessions/:sessionId/state` | Write canonical presenter state with revision checks |
| `GET` | `/api/public-improvements/presentation/sessions/:sessionId/ideas` | Page through the controller's public idea catalog |
| `GET` | `/api/public-improvements/presentation/sessions/:sessionId/ideas/:ideaId` | Read a public idea DTO within role visibility rules |
| `GET` | `/api/public-improvements/presentation/sessions/:sessionId/ideas/:ideaId/streetmix-thumbnail` | Relay the saved Streetmix thumbnail for a readable idea |
| `POST` | `/api/public-improvements/presentation/sessions/:sessionId/pairing` | Rotate the presenter code as receiver |
| `DELETE` | `/api/public-improvements/presentation/sessions/:sessionId/participants/me` | Leave as audience or relinquish presenter control |
| `DELETE` | `/api/public-improvements/presentation/sessions/:sessionId` | End the room as receiver or current presenter |

---

### Contacts (`Contacts` Tag)

Endpoints for managing CRM contact records in PostgreSQL.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/contacts` | List contacts with search filters (`?name=`, `?email=`, `?phone=`, `?limit=`) |
| `POST` | `/api/contacts` | Create a new contact (normalizes name, email, and phone) |
| `GET` | `/api/contacts/:id` | Get contact record by ID |
| `PUT` | `/api/contacts/:id` | Update an existing contact by ID |
| `DELETE` | `/api/contacts/:id` | Delete a contact record by ID |

#### Example: Create Contact (`POST /api/contacts`)

**Request Body:**
```json
{
  "name": "Jane Doe",
  "emails": ["jane.doe@example.com"],
  "phones": ["214-555-0199"],
  "zip_home": "75201",
  "zip_other": ["75202"],
  "roles": ["volunteer", "advocate"]
}
```

---

### Checkins (`Checkins` Tag)

Endpoints for managing event attendance checkins in PostgreSQL.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/checkins` | List checkins with filters (`?contact_id=`, `?event_id=`, `?limit=`, `?offset=`) |
| `POST` | `/api/checkins` | Create a new event checkin entry |
| `GET` | `/api/checkins/:id` | Get checkin record by ID |
| `PUT` | `/api/checkins/:id` | Update an existing checkin record by ID |
| `DELETE` | `/api/checkins/:id` | Delete a checkin record by ID |

#### Example: Create Checkin (`POST /api/checkins`)

**Request Body:**
```json
{
  "contact_id": 1,
  "event_id": 42
}
```

---

### Events & Calendar (`Events` Tag)

Endpoints for managing PostgreSQL event records and proxying/bulk-importing Dallas Urbanists event feeds from Meetup or external iCalendar URLs. *(Mounted at `/api/events`, `/api/events/ical`, `/meetup-ical`, and `/api/meetup-ical`).*

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/events` | List events with filters (`?status=`, `?is_hosted_by_du=`, `?start_after=`, `?start_before=`, `?category=`, `?search=`, `?limit=`, `?offset=`, `?order=`) |
| `POST` | `/api/events` | Create a new event in the database |
| `GET` | `/api/events/:id` | Get event details by ID or UID |
| `PUT` | `/api/events/:id` | Update an existing event record |
| `PATCH` | `/api/events/:id` | Partially update an existing event record |
| `DELETE` | `/api/events/:id` | Delete an event record by ID or UID |
| `POST` | `/api/events/import-ical` | Bulk import events from an iCal feed URL into PostgreSQL |
| `GET` | `/api/events/ical` | Returns the Meetup iCal feed (`text/calendar; charset=utf-8`) with caching headers |
| `GET` | `/meetup-ical` | Alias route for the Meetup iCal calendar feed |

#### Example: Bulk Import Events from iCal (`POST /api/events/import-ical`)

**Request Body:**
```json
{
  "url": "https://www.meetup.com/dallasurbanists/events/ical/",
  "is_hosted_by_du": true,
  "force": false
}
```

**Response (`200 OK`):**
```json
{
  "message": "Import completed: 5 created, 2 updated, 12 skipped, 0 failed.",
  "sourceUrl": "https://www.meetup.com/dallasurbanists/events/ical/",
  "totalFound": 19,
  "created": 5,
  "updated": 2,
  "skipped": 12,
  "failed": 0,
  "items": [
    {
      "uid": "event-304918231@meetup.com",
      "title": "Dallas Urbanists Monthly Meeting",
      "action": "created",
      "id": 1
    }
  ]
}
```

---

## 🏷️ Versioning

This project follows [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`):

- **`MAJOR`**: Incompatible or breaking API changes.
- **`MINOR`**: Backwards-compatible new features and endpoints.
- **`PATCH`**: Backwards-compatible bug fixes and minor improvements.

### Single Source of Truth
The version defined in [`package.json`](./package.json) is the single source of truth. The Swagger OpenAPI specification ([`src/docs/swagger.ts`](./src/docs/swagger.ts)) automatically imports and displays this version in the interactive documentation at `/docs`.

### Bumping Versions
To update the project version, use the built-in `npm version` command:

```powershell
# For bug fixes (e.g., 1.0.0 -> 1.0.1)
npm version patch

# For new features / endpoints (e.g., 1.0.0 -> 1.1.0)
npm version minor

# For breaking changes (e.g., 1.0.0 -> 2.0.0)
npm version major
```

Running `npm version` will automatically:
1. Update `version` in `package.json` and `package-lock.json`.
2. Create a Git commit and annotated release tag (e.g., `v1.1.0`).

---

## 🚢 Deployment to Production

Pushing to `main` branch automatically triggers build and deploy to Cloud Run service.

Service name: `urbanists-cloud-api-server`

---

## 🤝 Contributing

1. Fork or branch from `main`: `git checkout -b feature/my-feature`
2. Ensure TypeScript builds cleanly without errors: `npm run build`
3. Commit your changes: `git commit -m 'feat: add new feature'`
4. Push to origin: `git push origin feature/my-feature`
5. Open a Pull Request for review
