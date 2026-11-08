# Walk audits

Neighbors can define a study area, record observations at intersections, points, or along streets, and assemble a report. The server uses the existing Cloud SQL PostgreSQL pool and Firebase identity. The namespaced API serves the shared frontend; it is not a drop-in replacement for the original application's cookie sessions. The [OpenAPI fragment](../src/docs/walkAudits.ts), also served in `/docs`, owns the endpoint, validation, and response contract.

## How data fits together

A contributor profile belongs to one verified Firebase UID but public responses show only its display name and domain ID. A profile is required for domain writes, including staff administration; creating the profile is the registration step. A study has an organizer, polygon boundary, generated street and intersection collections, OSM attribution, and a PNG stored in the same PostgreSQL row. Worksheet IDs pin a specific version of the prompts. Drafts are private to their owner, including from staff. Submitted audits are public; an organizer cannot edit someone else's audit merely by organizing the study. Canonical `staff:true` can administer public domain records but cannot read another person's draft. Private requests require Firebase authentication and, in production, App Check; public reads need neither an application API key nor sign-in. Existing authorized-origin CORS applies.

Each study pins one immutable questionnaire for every enabled audit type. Authors can choose intersection, street segment, and point in any nonempty combination and provide 1–30 authored choice or text prompts for each. If an older study-create client omits both configuration fields, the server pins the explicit intersection and street default templates. Submitted audit types and historical worksheet IDs cannot be changed; an older mismatched draft is kept for reference and must be replaced by a separate draft.

Draft autosaves and audit edits use `expectedVersion` to reject stale changes. Submitting a draft validates its assigned worksheet and location, locks the study before its children, and creates or updates an audit in the same transaction that consumes the draft. A failed submission retains the draft. Transaction lock waits are bounded to five seconds and individual statements to fifteen seconds; a lock conflict returns 409. Point observations remain points on a saved street edge. New street observations require a shortest route from a saved intersection to a street endpoint, which may be midblock; legacy single-edge observations remain valid until their location is explicitly replaced. Coverage unions edge intervals and distinguishes partial edges, while point counts do not imply network coverage.

An audit can include up to three JPEG, PNG, or WebP photos, each at most 2 MiB. Draft photo reads and writes require the draft owner; writes also require the quoted current draft version in `If-Match`. Submission atomically transfers those images to the public audit. Existing audit edits preserve their photos. DTOs and report captures contain descriptors, never image bytes; deletion of the parent removes its stored bytes.

Reports capture sanitized study, worksheet, and selected public audit data. Text edits preserve the capture. Replacing the selected audit IDs explicitly refreshes captured inputs and coverage, while keeping the author's description unless it is changed. Later audit edits or individual audit deletion do not change existing captures. An omitted selection captures all current audits, subject to the 500-audit and 16 MiB bounds; an empty selection is valid. Completion is stored to five decimal places. No AI provider is used.

**Study deletion is permanent.** An organizer or staff member must supply `confirmPermanentDelete=true`; the operation physically removes every audit, draft, report, and the SQL-stored PNG for that study, including observations and reports created by other contributors. Deleting an individual audit also deletes its edit drafts, but does not remove historical report snapshots. Contributor profiles and worksheet versions cannot be deleted while referenced. Firebase accounts and CRM records are never deleted by this feature.

## Generation and configuration

Study creation validates a single simple, closed WGS84 polygon without holes or antimeridian crossings, then requests public road topology from Overpass. Only boundary coordinates are sent upstream. The server clips roads to the boundary, derives intersections from shared nodes, and renders a deterministic PNG locally. A valid empty network is allowed; an upstream failure creates no study. No basemap, CARTO key, GCS bucket, or new database extension is required. OSM attribution is returned with the study.

The server requires outbound HTTPS access to the configured providers. `WALK_AUDIT_OVERPASS_URLS` is a comma-separated list of one to four HTTPS URLs without credentials, query strings, or fragments; defaults are `https://overpass-api.de/api/interpreter` and `https://overpass.kumi.systems/api/interpreter`. The overall generation deadline defaults to 60,000 ms (`WALK_AUDIT_GENERATION_TIMEOUT_MS`, range 1,000–300,000). The process-local concurrency limit defaults to 2 (`WALK_AUDIT_GENERATION_CONCURRENCY`, range 1–20); it is not a cluster-wide quota. The database enforces one generation start per contributor per 60,000 ms across instances (`WALK_AUDIT_GENERATION_INTERVAL_MS`, range 1,000–86,400,000). A reservation can remain after a failed attempt. Cloud Run's request timeout must exceed the generation deadline plus database and response overhead. A deployment needing a provider-wide cap must add distributed control or an explicitly configured instance cap.

The runtime uses the existing `DB_*` and `INSTANCE_CONNECTION_NAME`, Firebase settings, and `ALLOWED_ORIGINS`; there is no second runtime database URL. See the [environment template](../.env.example). Mutation JSON is limited to 256 KiB, except study boundary mutations at 1 MiB; answers are limited to 100,000 UTF-8 bytes. Private responses and mutations are no-store, while thumbnail caches must revalidate.

## Migration and recovery

An operator must explicitly apply `migrations/009_walk_audits.sql`, then `migrations/010_seed_walk_audit_worksheets.sql`, then `migrations/011_study_questionnaires_routes_photos.sql`. The third migration backfills each existing study with two assignments: the latest submitted audit's worksheet for each type, or the highest version of the corresponding explicit default slug. Missing required defaults abort the transaction. It does not rewrite historical audits, answers, geometry, or report captures. No migration runs on startup. Use a DDL-authorized migration account separately from the application's least-privilege DML role.

Rolling back application code while retaining these tables is safer than dropping them. Application rollback cannot restore a deleted study; recovery requires an authorized restore from a verified backup and is limited by the available retention and restore procedure. Backups may retain deleted data under the operator's retention policy. No production migration or deletion is performed by the test commands below.

For an explicitly isolated local test database, inspect the target first and apply the three SQL files in order with an error-stopping migration tool. The optional automated PostgreSQL test creates and drops only a unique schema within a dedicated local database named `walk_audit_test`; it refuses non-loopback URLs and requires both `WALK_AUDIT_TEST_DATABASE_URL` and `WALK_AUDIT_TEST_DESTRUCTIVE=true`. It applies the feature SQL itself, uses fixture-backed Overpass responses and test-only identities, exercises concurrent requests, and starts and stops its own API fixture processes.

```powershell
$env:WALK_AUDIT_TEST_DATABASE_URL = 'postgresql://test-user@127.0.0.1:5432/walk_audit_test'
$env:WALK_AUDIT_TEST_DESTRUCTIVE = 'true'
& .\node_modules\.bin\tsx.cmd --test tests\walkAuditPostgres.test.ts
```

Without both variables, the real-PostgreSQL test is skipped and does not establish persistence or lock behavior. The remaining `walkAudit*.test.ts` tests use local fixtures and PGlite. Run them with the TypeScript and documentation builds before release:

```powershell
$walkAuditTests = @(Get-ChildItem .\tests -Filter 'walkAudit*.test.ts' -File | Select-Object -ExpandProperty FullName)
& .\node_modules\.bin\tsx.cmd --test @walkAuditTests
npm run build
npm run docs:build
```

For local browser rehearsals, build the sibling frontend and run
`tsx tests/helpers/walkAuditBrowserFixture.ts` from this repository. This helper
binds only to loopback and uses an in-memory PGlite database, fixture street
topology, and test-only identities; it does not contact Cloud SQL or perform a
real Firebase/App Check exchange. Stop it when finished. It is not part of the
production runtime.

For a local authenticated request, use an actual test Firebase ID token and, in production, an App Check token in the headers. For example, after creating a profile, a public study can be retrieved without credentials:

```powershell
curl.exe 'http://localhost:8080/api/walk-audits/studies/1'
```
