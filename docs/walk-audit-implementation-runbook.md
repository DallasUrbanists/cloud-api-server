# Walk-audit implementation runbook

## 1. Purpose and authority

Implement the neighborhood walk-audit domain in this Cloud API server: PostgreSQL models, Firebase-authorized CRUD endpoints, automatic OpenStreetMap network and PNG thumbnail generation, draft submission, progress, and editable reports.

This is a **future implementation runbook**, not evidence that the feature exists or that migrations have been applied. Writing this document does not start implementation. An agent given an explicit instruction to implement this runbook should execute it through verification, not stop after another plan. No previous chat or session-only plan is required. Use the [copyable agent handoff](walk-audit-implementation-handoff.md) to start that implementation.

### Confirmed requirements

The user confirmed all three decisions:

1. Use **existing Firebase authentication** rather than the source application's unverified-email/cookie flow.
2. Include **automatic OSM street-network and thumbnail generation** in the initial implementation.
3. Provide **editable reports** and **permanent cascading study deletion**, not immutable reports or study archiving.

Use the existing Cloud SQL PostgreSQL infrastructure and six namespaced tables. Preserve the workflow study → draft → submitted audit → report. Add complete domain CRUD where the source only provides part of it.

Other engineering choices below are implementation defaults that make the plan executable. They are not additional user confirmations. Ask for a decision only if repository evidence or an unavoidable architectural constraint conflicts with these defaults; do not silently omit a confirmed requirement.

### Source evidence

Reference repository: [DallasUrbanists/neighborhood-walk-audit](https://github.com/DallasUrbanists/neighborhood-walk-audit), reviewed at commit `0969caf8936caa31d10bce753e1243df28911510`.

Reviewed sources at that commit:

- [Data-model overview](https://github.com/DallasUrbanists/neighborhood-walk-audit/blob/0969caf8936caa31d10bce753e1243df28911510/docs/data-model.md).
- [Schema](https://github.com/DallasUrbanists/neighborhood-walk-audit/blob/0969caf8936caa31d10bce753e1243df28911510/migrations/001_init.sql).
- [Repository and transactions](https://github.com/DallasUrbanists/neighborhood-walk-audit/blob/0969caf8936caa31d10bce753e1243df28911510/src/repository.js).
- [HTTP workflows](https://github.com/DallasUrbanists/neighborhood-walk-audit/blob/0969caf8936caa31d10bce753e1243df28911510/src/server.js).
- [Network extraction](https://github.com/DallasUrbanists/neighborhood-walk-audit/blob/0969caf8936caa31d10bce753e1243df28911510/src/geospatial.js).
- [Worksheet structure](https://github.com/DallasUrbanists/neighborhood-walk-audit/blob/0969caf8936caa31d10bce753e1243df28911510/src/worksheets.js).

Use these as behavioral/schema references. Verify reuse rights before copying implementation or seed content; otherwise implement independently and author original prompts. Link to the external worksheet sources rather than reproducing their text.

### Out of scope

- Importing an existing application's database, migrating the frontend, or preserving old cookie-session endpoints.
- Creating another identity provider, replacing the existing `/api/users` API, or automatically linking ownership by unverified email.
- Firestore storage for this domain, PostGIS, GCS media migration, AI-generated report narratives, or a new UI.
- Applying production migrations, deploying, publishing, committing, or pushing without a separate instruction.

## 2. Preflight and repository safety

Initial workspace: `C:\Users\hexel\repos\DallasUrbanists\cloud-api-server`. Re-evaluate the checkout if running elsewhere; do not assume the path is universal.

1. Read current repository instructions and invoke the applicable `sql-table-crud` and `documentation-sync` skills if available.
2. Inspect staged, unstaged and untracked work before editing. Existing unrelated changes were present when this runbook was written, including the application, OpenAPI, package/lockfiles, TypeDoc, email feature and documentation. Preserve their content and staged state. Do not reset, stash, clean, restage everything, or overwrite whole shared files.
3. Re-read integration points; do not patch them using stale excerpts from this document.
4. Inspect existing dependencies and lockfile policy. The checkout currently has a pnpm lockfile/workspace while scripts are documented with npm. Follow the active lockfile/package-manager convention without creating a competing lockfile. Do not install dependencies merely as a preflight step. Add selected dependencies to the manifest first, or restore only after a missing-tool/dependency validation failure.
5. Check the next migration number. At writing, migrations end at 008; 009/010 are suggestions, not reserved names.
6. Create/update task tracking in the agent's session store. Record real dependencies and evidence as work completes; do not use this authored runbook as a progress log.

Read these existing files before the corresponding edits:

| Concern | Existing references |
| --- | --- |
| Application integration | [app](../src/app.ts), [server entry](../src/index.ts), [response formatting](../src/utils/responseFormatting.ts) |
| Database and identity | [PostgreSQL pool](../src/config/db.ts), [auth middleware](../src/middleware/auth.ts), [user routes](../src/routes/userRoutes.ts), [Firebase UID migration](https://github.com/DallasUrbanists/cloud-api-server/blob/main/migrations/001_add_firebase_uid.sql) |
| Browser access | [CORS](../src/middleware/cors.ts) |
| HTTP documentation | [OpenAPI composition](../src/docs/swagger.ts), [boundary fragment example](../src/docs/boundaries.ts) |
| Testing patterns | [migration tests](../tests/boundaryMigration.test.ts), [HTTP/database tests](../tests/representatives.test.ts), [staff-claim tests](../tests/staffClaims.test.ts) |
| Documentation | [conventions](documentation-conventions.md), [TypeScript instructions](../.github/instructions/typescript-documentation.instructions.md), [portal guide](index.md), [TypeDoc configuration](../typedoc.json), [portal configuration](https://github.com/DallasUrbanists/cloud-api-server/blob/main/docs/.vitepress/config.mts) |
| Runtime and tooling | [package manifest](../package.json), [TypeScript configuration](../tsconfig.json), [README](../README.md) |

Useful PowerShell inspection commands:

```powershell
Set-Location 'C:\Users\hexel\repos\DallasUrbanists\cloud-api-server'
git --no-pager status --short
git --no-pager diff --stat
git --no-pager diff --cached --stat
Get-ChildItem .\migrations -File
node --version
```

Use supported Node.js, currently 22.13+; Node 24 is recommended by the repository. Never point tests at the production Cloud SQL proxy or an ambient production database.

## 3. Deliverables and execution order

Suggested new paths below are **planned**, not existing files. Adjust module boundaries to current patterns without changing the contracts.

| Stage | Deliverables | Prerequisites and exit gate |
| --- | --- | --- |
| A. Schema | `migrations/009_walk_audits.sql`; optional `010_seed_walk_audit_worksheets.sql`; migration tests | Preflight; isolated schema tests prove constraints and cascades. |
| B. Types and access | `src/models/walkAudit.ts`, `src/utils/walkAuditValidation.ts`, `src/services/walkAuditStore.ts` | A; typed row/DTO conversion, safe SQL and transaction tests. |
| C. Generation | `src/services/walkAuditGeospatial.ts`, `src/services/walkAuditThumbnail.ts` | B interfaces; fixture-tested bounded network extraction and valid PNG output. |
| D. Domain workflows | `src/services/walkAuditService.ts` | B and C; all CRUD, ownership, reports and submission rules pass service tests. |
| E. HTTP integration | `src/controllers/walkAuditController.ts`, `src/routes/walkAuditRoutes.ts`; scoped application wiring | D; real Express HTTP tests exercise every approved verb and middleware boundary. |
| F. Documentation | `src/docs/walkAudits.ts`, `docs/walk-audits.md`; OpenAPI/README/portal/TypeDoc integration | E contracts; synchronized authored docs, no generated-file edits. |
| G. Acceptance | Targeted tests, build, docs build, isolated PostgreSQL restart/persistence exercise | A–F; evidence for acceptance criteria, or explicit unresolved blockers. |

Use TypeScript ESM with `.js` relative import extensions. Keep routes → controllers → services → store/pool separation; controllers do not compose SQL or fetch OSM. Add focused injection seams for query/transaction execution, fetch, clock and authorization tests. Production must always use PostgreSQL, never silently switch to in-memory demo storage.

## 4. Database implementation

Create the schema transactionally. Use integer identity IDs, TIMESTAMPTZ timestamps, JSONB for geospatial/form data, BYTEA for thumbnails, and UUID draft IDs generated with Node's `crypto.randomUUID()`. PostgreSQL extensions are not required.

### Tables

| Table | Required columns and invariants |
| --- | --- |
| `walk_audit_contributors` | `id`, unique nonempty `firebase_uid`, `display_name`, `created_on`, `updated_on`; internal generation-rate state if needed. No duplicate authentication or publicly returned email. |
| `walk_audit_studies` | `id`, `created_by`, `neighborhood`, timestamps, `version`, `location_gps`, `location_description`, `area`, `intersections`, `segments`, `thumbnail_png`; PNG content type and OSM attribution/source metadata. Geometry/network/media are generated together. |
| `walk_audit_worksheets` | `id`, `slug`, `version`, `title`, `description`, `source_url`, `recommend_for TEXT[]`, `prompts JSONB`, timestamps; unique `(slug, version)`. Pin audits/drafts to a concrete worksheet version/ID. |
| `walk_audit_audits` | `id`, `study_id`, `created_by`, `worksheet_id`, timestamps, `version`, `type`, `feature_id`, `location_gps`, `location_description`, `geojson`, `answers`. Type is `intersection` or `street-segment`. |
| `walk_audit_drafts` | UUID `id`, `study_id`, `created_by`, timestamps, `version`, nullable `editing_audit_id` and `editing_audit_version`; nullable audit-type/worksheet/feature/location fields; nonnull answers object. Partial content is allowed. |
| `walk_audit_reports` | `id`, `study_id`, `created_by`, timestamps, `version`, editable `title`/`description`, selected audit IDs, `completion NUMERIC(6,5)`, captured JSONB report data. Validate completion in [0,1]. |

Use source field semantics but camelCase API DTOs. Public projections must not include Firebase UIDs, private profile fields or auth tokens. Reports capture only sanitized public contributor information.

### Constraints and indexes

- Foreign keys for study, contributor and worksheet relationships; explicit delete policies below.
- Checks for nonempty bounded names, legal type strings, positive versions, object/array JSON shapes, valid recommendation values and nonnull answer objects.
- Shared validators enforce valid coordinates, unique prompt IDs, prompt/answer schemas and deeper geometry rules; add database constraints for critical structural invariants rather than implying JSONB validates itself.
- Ensure an edit draft cannot reference an audit from another study. Use a compatible composite foreign key/unique key or equivalent tested transactional enforcement.
- Index creator/date and study/date list paths, draft owner/updated time, report study/date and audit `(study_id, type, feature_id)`. Unique Firebase UID and worksheet `(slug, version)` provide their lookup indexes.
- Multiple contributors and multiple observations may audit the same location. Do not add a unique study/feature constraint that prevents this; progress deduplicates IDs.
- Map NUMERIC completion to JSON number and timestamps to ISO strings explicitly. Keep generated integer IDs compatible with the existing HTTP integer formatter.

### Permanent deletion matrix

| Deleting | Required result |
| --- | --- |
| Study | Physically delete the study and cascade to **all its audits, drafts and reports**, including other contributors' observations; embedded thumbnail bytes disappear with the row. No tombstone/archive substitution. |
| Audit | Physically delete that audit and cascade to its edit drafts. Do not delete its study, sibling audits or historical report snapshots. |
| Draft/report | Physically delete that row only. |
| Contributor | Physically delete only if no dependent rows; otherwise 409. Never delete Firebase accounts or CRM contacts. |
| Worksheet version | Physically delete only when unreferenced by live audits/drafts; otherwise 409. Do not cascade through shared templates to delete observations. |

Keep report audit IDs as captured membership, not foreign keys that would destroy historical snapshots on individual audit deletion. A later explicit membership edit validates its supplied IDs against currently existing same-study audits.

### Worksheet administration and seed

Define a small typed prompt schema supporting at least choice prompts and bounded text areas, stable prompt IDs, explicit options and optional flags. Require a compatible recommendation for the selected audit type. Draft answers may omit required prompts; submitted answers must satisfy the selected version's declared requirements. Do not invent mandatory answers outside that schema.

When PATCH changes a referenced worksheet definition, create a new version with a new ID and return it; retain the old version for existing records. Use transactional version allocation to avoid concurrent duplicate versions. DELETE targets a specific version. By default list the latest version per slug; allow `includeVersions=true` for explicit history. No archive behavior is needed.

Provide at least one usable original template for each supported audit type, possibly one shared template, in an optional explicit seed migration. Seed reapplication must not overwrite local edits or historical versions. Do not seed/upgrade templates on server startup.

## 5. HTTP contract and permissions

Base path: `/api/walk-audits`. Existing application APIs and `/api/users` remain unchanged. The namespaced API and Firebase identity intentionally require a future frontend migration; do not claim drop-in compatibility.

### Resources

| Relative path | Methods | Authorization/behavior |
| --- | --- | --- |
| `/contributors/me` | GET, POST, PATCH, DELETE | Private caller profile; POST creates it once from verified UID and a display name, repeated creation returns 409. Missing profile for other domain writes returns a clear 409 requiring registration. |
| `/contributors` | GET | Staff-only paginated directory; no public identity enumeration. |
| `/contributors/:id` | GET, PATCH, DELETE | Staff-only domain-profile administration. Public study/audit DTOs embed display names instead. |
| `/studies` | GET, POST | Public list; signed-in creation accepts neighborhood/area and runs automatic generation. |
| `/studies/:id` | GET, PATCH, DELETE | Public detail; organizer/staff mutations. Permanent DELETE requires `confirmPermanentDelete=true`. |
| `/studies/:id/thumbnail` | GET | Public `image/png`; not a base64 field in JSON. |
| `/studies/:id/progress` | GET | Public deduplicated coverage counts/ratios. |
| `/worksheets` | GET, POST | Public list; staff creation. Optional `type` recommendation filter. |
| `/worksheets/:id` | GET, PATCH, DELETE | Public detail; staff writes; versioning and reference constraints as above. |
| `/studies/:id/audits` | GET, POST | Public paginated list; signed-in create after final validation. |
| `/audits/:id` | GET, PATCH, DELETE | Public detail; author/staff writes. Organizer alone does not gain another author's audit edit access. |
| `/studies/:id/drafts` | GET, POST | Caller-owned drafts only; POST optionally specifies a same-study, caller-owned `editingAuditId`. |
| `/drafts/:id` | GET, PATCH, DELETE | Owner-only; staff status alone does not reveal private drafts. |
| `/drafts/:id/submit` | POST | Owner-only atomic submission/edit followed by draft removal. |
| `/studies/:id/reports` | GET, POST | Public list; organizer/staff creation. |
| `/reports/:id` | GET, PATCH, DELETE | Public detail; organizer/staff edits and permanent deletion. Reports are not immutable. |

### Request/response rules

- Item responses use `{ contributor }`, `{ study }`, `{ worksheet }`, `{ audit }`, `{ draft }` or `{ report }`. Lists use their plural key plus `limit`, `offset` and `hasMore`; fetch one extra row rather than requiring an expensive count. Progress returns `{ streets, intersections, overall }` with audited/total/ratio values.
- Page defaults: limit 25, maximum 100; offset is a nonnegative integer. Sort deterministically by creation/updated time then ID. Whitelist filters/sort choices, reject unknown mutation fields and malformed/duplicate scalar query values.
- Filter studies by creator/neighborhood; audits by type, author and worksheet; drafts by owner, study and optional updatedSince; reports by study; worksheets by recommendation and version visibility. Do not add unsupported spatial/CRM search.
- Lists use summaries. Study detail carries its bounded geometry and progress, but not all audits. Report lists omit captured answer/geometry payloads; report detail returns the bounded captured data.
- POST returns 201 and Location. A new-audit submission returns 201; editing an existing audit returns 200, derived from stored draft state. GET/PATCH return 200; successful DELETE returns 204 with no body.
- Use structured errors `{ error: '<stable-code>', message: '<safe-message>' }`. Input errors 400; unauthenticated 401; forbidden 403; missing rows/private draft concealment 404; version/reference/dependency conflict 409; body/output-size rejection 413; unsupported JSON content type 415; quota/concurrency rejection 429 with Retry-After; provider unavailable/deadline failure 503; unexpected server failure 500. Never leak SQL, credentials, provider payloads or stacks.
- Require integer `expectedVersion` on study/audit/draft/report PATCH. Compare-and-increment atomically; stale versions return 409. Draft submit also requires its expected version so it cannot unknowingly consume a stale autosave state. Empty/no-op PATCH is 400; return the updated representation/version.
- Derive `createdBy` from the verified caller. Forbid changing ownership, study ID, timestamps, generated media/network, captured report data and derived coverage through arbitrary PATCH fields.
- Report POST accepts optional `auditIds` and optional authored title/description; omission selects all current same-study audits subject to limits, and the default narrative is deterministic. Report PATCH accepts title, description and/or auditIds plus expectedVersion; rules in section 8.
- Contributor PATCH changes display name only; staff cannot reassign its Firebase UID through this API.

### Authentication and middleware integration

Reuse [userAuth](../src/middleware/auth.ts) and the canonical `staff:true` claim behavior. Private mutations use verified Firebase ID tokens; App Check protects browser access in production using the existing `appCheckAccess` mechanism. Do not ship an application API key in a public frontend. Staff routes combine private authentication with canonical staff checks. Public reads require neither key nor sign-in and must override inherited OpenAPI security explicitly.

Apply existing authorized-origin CORS, including the future frontend origin through `ALLOWED_ORIGINS` if required. Do not loosen global origins or change the email feature's special public CORS. Preserve the application integer-response formatter and the existing rejection of unsupported `X-Operation-Group` mutations.

Update parser selection **before** the ordinary JSON parser consumes the namespace. Use bounded JSON-only input, strict object checks and scoped error mapping. Suggested limits: 1 MiB study-boundary requests; 256 KiB worksheet/audit/draft/report requests; 100,000 UTF-8 bytes for answers. Do not raise unrelated endpoints' limits. Private drafts/profile/admin responses and mutations use `Cache-Control: no-store`. Thumbnail caching must revalidate so replacement/permanent deletion is not masked by a long-lived public cache.

## 6. Automatic OSM network and thumbnail generation

### Study creation contract

Input is `{ neighborhood, area }`, with area a WGS84 GeoJSON Polygon Feature. No caller-authored intersections, segments, centroid, thumbnail, Overpass URL, or arbitrary fetch URL is accepted.

1. Normalize bounded neighborhood text and validate the boundary before external I/O.
2. Validate finite coordinate ranges, closure, nondegenerate/non-self-intersecting geometry and vertex limits. Retain the source area range of 2,500 m² through 75 km² and at most 250 distinct outer-ring corners. Never silently drop holes: either support them correctly throughout querying/clipping/rendering or reject them explicitly with 400 in the first implementation. Likewise reject unsupported antimeridian-spanning boundaries instead of rendering incorrect geometry.
3. Reserve the caller's shared generation-rate allowance and a bounded generation slot. Release concurrency slots on every success/error/abort path.
4. Query OSM using administrator-configured HTTPS Overpass endpoints. Fetch only public study coordinates, not contributor identities, tokens, answers or private drafts. Preserve OSM attribution and source/fetch metadata.
5. Build validated intersection and street-segment FeatureCollections with stable typed IDs; derive centroid/description. Render a PNG directly from vector boundary/network geometry.
6. Persist the complete study, collections and PNG together, only after successful generation. Provider failures leave **no partial study**. A real valid empty network is distinct from provider failure: it may create a study with zero features, zero progress and a boundary-only thumbnail.

### Generation engineering defaults

- Overall configurable deadline: 60 seconds, including bounded retries and endpoint fallback. Use AbortController plus streaming byte limits and check the remaining budget before each attempt. Do not stack full-length retries beyond the total deadline.
- Suggested maximum OSM response: 10 MiB; maximum combined generated features: 10,000. Reject over-limit data, do not silently truncate coverage denominators. Make selected limits explicit and tested.
- Use a small configured endpoint allowlist; validate HTTPS/configuration at startup. Do not follow redirects to arbitrary destinations. Handle rate limiting, invalid JSON, upstream non-2xx, timeout and truncated responses distinctly in internal logs, but return safe errors.
- Shared per-user default: one generation start per minute, enforced atomically in PostgreSQL (for example an internal contributor `next_generation_on` field), so instances do not bypass the allowance. This reservation is allowed to survive generation failure; expose Retry-After. Mutation rate fields are never client-writable/publicly returned.
- Bound active work per instance (initial default two). State clearly that a process-local semaphore is not a cluster-wide cap. If provider-wide quotas require one, use a PostgreSQL-backed reservation/advisory-lock design or obtain an approved deployment instance cap; do not claim local memory is distributed enforcement.
- Generation endpoints should honor client disconnect/deadline cancellation where supported, release resources and not persist a study after an aborted request. A disconnect after commit remains a possible successful create; do not promise network-level exactly-once creation.
- Preserve reasonable source road classifications: primary/secondary/tertiary links and roads, unclassified, residential, living_street, service and pedestrian. Derive intersections from network topology, not merely equal street names; handle missing tags and repeated nodes deterministically.
- Clip/limit network geometry consistently to the boundary. Include fixtures for roads crossing the boundary and boundary-touching nodes; do not count out-of-study locations. IDs should encode stable OSM topology such as node ID for intersections and way/endpoints for segments; preserve `properties.id` for progress matching.
- PNG rendering uses a deterministic canvas size, padding, aspect handling and vector drawing. Use minimal existing-compatible geometry/PNG packages after dependency inspection, rather than a headless browser, basemap screenshot or CARTO key. Test decoded dimensions and nonblank pixels, not just a filename extension.

Generation is initially synchronous; document the Cloud Run timeout needed beyond the service deadline. If realistic acceptance evidence shows bounded synchronous work cannot meet the contract, stop and propose durable PostgreSQL job/status endpoints and their schema before changing the response model. Do not silently remove generation, return fabricated features, or leave an untracked background task after 201.

### Study PATCH and regeneration

Neighborhood-only updates are allowed. A boundary change regenerates centroid/network/PNG and is allowed only when the study has no audits, drafts or reports; otherwise 409. Generate outside an open SQL transaction, then lock the study and recheck expectedVersion/dependencies before atomically replacing the geometry/media. Failure or stale version preserves the previous complete study. If the study was deleted during generation, return 404; never upsert/resurrect it.

## 7. Audits, drafts and progress

### Shared final validation

Use one final-audit validation path for direct POST, direct PATCH and draft submission. Check worksheet existence/version/recommendation, required fields, prompt answer keys/types/options/lengths, location bounds, and type-correct geometry. `intersection` targets a Point; `street-segment` targets a LineString. The feature ID must exist in the correct collection of the same study; reject arbitrary IDs and mismatched geometry. Prefer resolving canonical geometry from the saved network rather than trusting a forged Feature. Draft payloads may be incomplete but may never contain malformed structural data; drafts remain private to their owners.

Keep study/author fixed during audit edits. For partial PATCH, validate the merged final record. If worksheet/type changes invalidate existing answers, require the caller to replace/clear answers coherently rather than retaining invalid keys.

### Draft lifecycle and transaction boundaries

- New draft: study must exist; owner is the token's contributor. An editing draft seeds a same-study, caller-owned audit and records its version. Staff cannot create an editing draft to inspect another user's private work.
- Autosave PATCH: allowlisted fields only, merged validation, compare expectedVersion, update timestamp/version atomically.
- Submit: lock/recheck the study, owner draft, editing audit if any, and the selected worksheet under a consistent lock order. Compare draft version and editing-audit base version, run final validation, create/update audit, delete draft, commit, return persisted audit. Rollback preserves the draft if anything fails.
- Decide and test a consistent lock order across parent deletion, edits and submissions; parent study first is a workable default. Avoid holding a transaction during OSM fetch or PNG rendering.
- Repeated/concurrent submit must never create two audits. After consumption a repeated request may return 404/409; do not claim idempotent replay without implementing persisted idempotency results.
- Concurrent direct edits, stale autosave and stale edit-draft submission must reject rather than lose another writer's work.

Progress counts distinct **known feature IDs** separately for intersections and segments. Overall completion is `(auditedIntersections + auditedSegments) / (totalIntersections + totalSegments)`, with 0 for an empty denominator. Multiple observations and worksheet types at the same location do not inflate completion. A deleted audit affects current progress only when no remaining observation covers that feature.

## 8. Editable reports

Reports are editable artifacts with captured input data, not permanently frozen reports and not live joins masquerading as historical captures.

### Create

Organizer/staff may select same-study audit IDs, or omit membership to use all current audits within limits. In one consistent PostgreSQL snapshot, capture selected public audit content, worksheet definitions, relevant study/network data, unique-feature coverage, and a deterministic original narrative. Include an optional user-authored title/description without invoking an AI provider. An empty selection is valid and yields zero coverage.

### Edit

- PATCH of title/description changes that authored content and advances report version/timestamp without rewriting captured inputs.
- PATCH with `auditIds` validates unique existing same-study IDs, then atomically replaces captured selected-audit/worksheet data and derived coverage. Keep the current authored description unless a replacement is provided; do not silently overwrite edits with a new generated narrative.
- Reject direct client writes to completion, creator, study, timestamps or raw captured JSON. Recalculate from server data.
- Same-study membership and consistent coverage must hold even if audits are edited/deleted concurrently. Use a suitable transaction isolation/locking approach and bounded conflict handling.
- Later independent audit edits/deletion or worksheet revisions do not silently mutate an existing report. Historical selected IDs may refer to now-deleted audits within captured data; explicitly supplied replacement IDs must currently exist.
- Study DELETE removes all of these reports permanently, including edited ones.

Bound report creation/edit work: suggested maximum 500 selected audits and 16 MiB captured JSON encoded size. Reject oversize explicit or implicit membership with a clear 413 and instructions to select fewer audits; never silently truncate. Report list responses omit captured content. Public captures must exclude Firebase UIDs, emails and private draft information.

## 9. Tests and integration gates

Use the existing `node:test`/tsx and PGlite tooling. Add feature tests with a discoverable `walkAudit` prefix, for example:

- `tests/walkAuditMigration.test.ts`
- `tests/walkAuditValidation.test.ts`
- `tests/walkAuditGeospatial.test.ts`
- `tests/walkAuditThumbnail.test.ts`
- `tests/walkAuditService.test.ts`
- `tests/walkAuditHttp.test.ts`
- `tests/walkAuditPostgres.test.ts` for isolated real-PostgreSQL concurrency/restart checks

Suggested names are not mandatory, but commands and docs must match the files actually created.

### Minimum evidence matrix

| Area | Required passing cases |
| --- | --- |
| Schema | Fresh isolated migration, constraints, FK/index expectations, seed rerun if promised, no changes to unrelated tables; snapshot membership survives individual audit deletion. |
| Identity | Missing/invalid/revoked credentials, canonical staff vs legacy roles, unique profile UID, private drafts concealed, UID/email redaction, body cannot spoof creator. |
| CRUD | Every implemented route/verb, pagination/filter validation, 400/401/403/404/409/413/415/429/503 cases where applicable; meaningful not-found vs dependency conflicts. |
| OSM | Deterministic topology/IDs, valid empty network, missing tags, boundary clipping, invalid/oversized payloads, rate limit, timeout, retry budget and fallback, no partial study. |
| PNG | Valid signature and decoded dimensions, visible geometry, aspect/degenerate-boundary behavior, boundary-only empty-network thumbnail. |
| Drafts | Partial save → submit → persisted audit; edit same audit without duplication; rollback retains draft; stale versions and concurrent duplicate submits. |
| Audits/progress | Foreign-study/type/feature/worksheet mismatches, answer options/limits, duplicate observations count once, deletion updates current progress correctly. |
| Reports | Create, narrative edit, membership edit, recomputed coverage, stable capture after independent edits, no private fields, empty membership, size limits, stale edit rejection. |
| Cascades | Confirmed authorized study deletion removes all audits/drafts/reports/PNG; other studies/identities/templates survive; unconfirmed/unauthorized requests change nothing; concurrent child writes leave no orphans. |
| Integration | Existing CORS, integer formatting, namespace parser limits, unsupported operation-group mutation rejection and unrelated mounted APIs remain intact. |

Do not claim PGlite or a mocked pool proves real PostgreSQL lock behavior. Test transaction services with a real transaction abstraction, not only monkeypatching `pool.query` while leaving `pool.connect` live. Real PostgreSQL concurrency tests must use separately acquired sessions, isolated databases or uniquely named schemas, and tightly scoped cleanup.

### Targeted commands

Run from the repository root in PowerShell. Use installed tools; the explicit local executable prevents accidental package downloads.

```powershell
$walkAuditTests = @(Get-ChildItem .\tests -Filter 'walkAudit*.test.ts' -File | Select-Object -ExpandProperty FullName)
if ($walkAuditTests.Count -eq 0) { throw 'No walk-audit tests found.' }
& .\node_modules\.bin\tsx.cmd --test @walkAuditTests
if ($LASTEXITCODE -ne 0) { throw 'Walk-audit tests failed.' }
npm run build
if ($LASTEXITCODE -ne 0) { throw 'TypeScript build failed.' }
npm run docs:build
if ($LASTEXITCODE -ne 0) { throw 'Documentation build failed.' }
```

During development select only the affected feature test files, rather than rerunning the full suite after each edit. At integration, combine the smallest relevant existing auth/CORS/operation-group regression selectors in one runner. Inspect failures before expanding scope; do not fix unrelated baseline problems silently.

Real-PostgreSQL tests must be opt-in with an explicit dedicated test connection variable, for example `WALK_AUDIT_TEST_DATABASE_URL`, and destructive-test enablement. They must not fall back to `DB_NAME`, the default pool, ambient cloud credentials or the production proxy. Missing isolated PostgreSQL is a reported acceptance blocker, not a passing test disguised as a skip. Use PGlite for routine offline tests, and provide runnable instructions for the real database gate.

### Restart/persistence exercise

In an isolated local database and test server:

1. Apply only the feature migration/seed after verifying the target. Create test identities through injected/auth-test fixtures or an explicitly isolated Firebase emulator; do not create production Firebase users.
2. Create contributor and worksheet, then POST a study from neighborhood/boundary and retrieve its generated PNG. Routine tests use fixture-backed HTTP responses; a live OSM smoke call requires an explicitly approved small public boundary and must not send identity/answers.
3. Create/save/submit a draft; edit its audit; create and edit a report; record IDs, versions and selected content.
4. Stop and restart the server against the same database. Read the same study/audit/report and verify content and PNG persisted.
5. DELETE the study with explicit permanent-delete confirmation. Check SQL row counts and HTTP 404s for study, thumbnail and every child while unrelated records remain.
6. Restart again and verify the deletion is still effective. Delete only the isolated test resources and stop only processes started for this exercise.

Use ephemeral ports for self-contained tests. Check server readiness before sending requests; close server/pool handles and stop helpers afterward. Never stop unrelated user-owned processes or leave verification watchers running.

## 10. Documentation and configuration

Use `src/docs/walkAudits.ts` to export paths and schemas, compose them into [the existing OpenAPI document](../src/docs/swagger.ts), and add an appropriate tag and policy summary. Document every request body/filter/status/error/auth rule from sections 5–8, including worksheet versioning, generation delay, expectedVersion, permanent-delete acknowledgment and report editing. Explicitly declare public security and Firebase/App Check requirements instead of inheriting the document's API-key defaults accidentally.

Add `docs/walk-audits.md` explaining domain relationships, storage, automatic generation, ownership, editable reports, destructive lifecycle, migration/recovery procedure and local test setup. Link to the feature OpenAPI instead of duplicating its full HTTP tables. Add scoped links to [README](../README.md), [documentation index](index.md), portal navigation and TypeDoc entry points; do not reorganize unrelated guides or edit generated reference files.

Follow existing TSDoc module/function conventions and approachable examples for new exports. Documentation sync must inspect runtime validators, controller mapping, route middleware, SQL lifecycle and tests together; a successful docs build alone does not prove contract agreement.

Document configuration in the existing environment template and feature guide without credentials. Proposed new names should be finalized once, validated at startup, and used consistently:

| Setting | Purpose |
| --- | --- |
| Existing `DB_*`/`INSTANCE_CONNECTION_NAME` | Reuse the current pool; do not introduce a second runtime DATABASE_URL convention. |
| Existing Firebase configuration | Verified identities/canonical staff and production App Check; no email-cookie auth secret. |
| Existing `ALLOWED_ORIGINS` | Additional deployed frontend origin only if needed. |
| `WALK_AUDIT_OVERPASS_URLS` | Administrator-controlled allowed HTTPS endpoints, documented delimiter/defaults. |
| `WALK_AUDIT_GENERATION_TIMEOUT_MS` | Overall bounded generation deadline; proposed default 60000. |
| `WALK_AUDIT_GENERATION_CONCURRENCY` | Explicit per-instance bound; proposed default 2. |
| `WALK_AUDIT_GENERATION_INTERVAL_MS` | Shared per-user generation interval; proposed default 60000. |
| `WALK_AUDIT_TEST_DATABASE_URL` | Opt-in isolated integration tests only, not a runtime fallback. |

Use existing Cloud SQL connectivity/roles. No new GCS bucket/IAM role or AI-service credentials are required. Distinguish application DML permissions from the account authorized to apply DDL migrations; never grant broad owner rights just for this feature. Explain any provider egress/network requirements.

## 11. Migration, recovery and release boundary

This runbook authorizes implementation only when the user tells the agent to implement; it does not authorize production DDL, deployment or data deletion.

- Test schema creation/seed on an empty isolated database and an isolated copy with representative unrelated tables/data. No need to replay unrelated CRM migrations against a fresh database if the feature has no such schema dependencies.
- Production migrations are manual or an explicitly approved deployment step, never an application startup side effect.
- Before a production change, an operator must verify backup/PITR availability, migration checksums/ordering, target database and DDL privileges, then rehearse exact application/recovery commands using the actual migration filenames.
- Since study DELETE is intentionally permanent at the application layer, ordinary API rollback cannot restore it. Backups/PITR may retain deleted data under the operator's retention policy; do not promise forensic erasure. Explain backup restoration limitations and cross-contributor deletion consequences to the future client.
- Dropping feature tables is destructive and not a normal rollback. If application rollback is needed, prefer rolling back code while retaining namespaced data. Restore from a verified backup for data recovery under operator authorization.
- Publish no deployment command using production identifiers in the handoff. Provide necessary configuration/timeout/migration instructions for an operator without running them.

## 12. Definition of done and handback

Implementation is complete only when:

1. All six entities are persistent in PostgreSQL and the approved CRUD surface is present, including report PATCH and actual physical study cascades.
2. Firebase ownership/staff/privacy and production attestation behavior are tested without changing existing APIs.
3. Study POST automatically generates a real bounded network and PNG; generation failure produces no partial study or demo fallback.
4. Transactional autosave/submission/editing, deduplicated progress, editable captured reports, stale-version handling and deletion concurrency pass their gates.
5. The smallest relevant tests, TypeScript build and documentation build pass, with real-PostgreSQL persistence/concurrency evidence or an explicitly stated blocker. Missing required acceptance evidence must not be reported as completion.
6. OpenAPI, authored feature docs, environment setup, migrations, TypeDoc/portal links and tests agree; existing staged/unstaged work is preserved.
7. Temporary fixtures/processes outside the committed test suite are cleaned up. No production mutation, deployment, commit or push occurred without separate authorization.

Final handback should concisely list delivered routes/workflows, migration filenames and manual application boundary, environment settings, commands/results actually observed, and any unresolved acceptance blockers. Include a minimal safe local request example using placeholders, never credentials. State explicitly that permanent study deletion removes other contributors' observations and all reports for that study. Do not mark missing tests or skipped persistence checks as passed.
