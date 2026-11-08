# Maintainer prompt: migrate neighborhood-walk-audit to the shared API

Copy the prompt below to the maintainer or coding agent working in [DallasUrbanists/neighborhood-walk-audit](https://github.com/DallasUrbanists/neighborhood-walk-audit).

---

You maintain `DallasUrbanists/neighborhood-walk-audit`. Prepare its migration from its standalone backend to the shared `DallasUrbanists/cloud-api-server` walk-audit API.

## Status and source of truth

**These endpoints are planned/in development, not confirmed implemented or deployed.** Keep production on its current backend until the API maintainer supplies a working staging environment, implemented OpenAPI, and acceptance evidence. Do not treat this prompt as a release announcement or automatically switch traffic.

The implementation specification is `docs/walk-audit-implementation-runbook.md` in the `cloud-api-server` development checkout. Obtain that document from the API maintainer if it is not yet published; do not assume it is on the default branch. Its [local copy](walk-audit-implementation-runbook.md) accompanies this prompt in the API repository. Final implemented OpenAPI and tested staging behavior govern integration; report discrepancies rather than guessing.

The source application was reviewed at commit `0969caf8936caa31d10bce753e1243df28911510`. Inspect your current implementation and tests before editing because it may have changed. Preserve unrelated work.

## What the shared backend will provide

The intended base is `<API_ORIGIN>/api/walk-audits`, backed by the existing Cloud SQL PostgreSQL infrastructure:

- Contributor profiles linked to verified Firebase users, replacing unverified email entry and signed session cookies.
- Studies created from neighborhood/boundary, with automatic OpenStreetMap network, centroid and PNG thumbnail generation.
- Versioned worksheet definitions, submitted audits, private autosaved drafts, deduplicated progress and editable reports.
- Permanent study deletion that cascades to **all** associated audits, drafts, reports and stored thumbnails, including other contributors' observations.

### Planned endpoint mapping

Every new path below is relative to `/api/walk-audits`:

| Existing application interaction | New integration |
| --- | --- |
| `/api/session` sign-in/out | Firebase client sign-in/out; authenticated `GET/POST /contributors/me` for the domain profile. No replacement cookie-session endpoint. |
| `/api/dashboard` | Compose `/contributors/me` and paginated `/studies` using the finalized creator filter. There is no planned dashboard endpoint. |
| Study creation/read | `POST /studies`, `GET /studies/:id`; study list via `GET /studies`. |
| Study update/delete | `PATCH /studies/:id`, `DELETE /studies/:id?confirmPermanentDelete=true`. |
| Study thumbnail/progress | `GET /studies/:id/thumbnail`, `GET /studies/:id/progress`. |
| Worksheet selection | `GET /worksheets?type=intersection` or `type=street-segment`; detail via `/worksheets/:id`. |
| Draft creation/autosave/read | `POST /studies/:id/drafts`, `GET/PATCH /drafts/:id`; list via `GET /studies/:id/drafts`. |
| Draft submission/discard | `POST /drafts/:id/submit`, `DELETE /drafts/:id`. |
| Audit read/create/update/delete | `GET/POST /studies/:id/audits`, `GET/PATCH/DELETE /audits/:id`. |
| Reports | `GET/POST /studies/:id/reports`, `GET/PATCH/DELETE /reports/:id`. |

Worksheet writes are staff-only. Studies/reports are managed by organizer/staff; individual audits by their author/staff. Organizer status alone does not grant edit access to another contributor's audit. Drafts belong exclusively to their owner; staff status does not make drafts readable. Public study/audit/report/worksheet reads do not require sign-in.

## Migration instructions

### 1. Confirm the integration contract before cutover

Request the API staging origin, release/development branch, implemented OpenAPI, Firebase project/auth-provider configuration, App Check setup, allowed frontend origins and seed worksheet availability. Ask for a contract/version freeze for the client migration. Do not invent configuration values or embed server credentials.

Use an environment-configured API origin and an explicit backend-selection feature flag; keep the legacy backend as the initial default. Preserve existing deep links and visual workflows by mapping them through a client adapter, not by expecting old API paths to remain supported.

### 2. Replace identity handling

Integrate the agreed Firebase sign-in provider. Send `Authorization: Bearer <Firebase ID token>` on private requests and `X-Firebase-AppCheck` where production attestation is required. Use Firebase SDK token refresh, not long-lived manually stored tokens. Do not embed a server `X-API-Key` in browser code.

After sign-in, fetch `/contributors/me`; if missing, register a profile with a display name. Handle the exact finalized missing-profile/duplicate-profile response codes, including a possible registration race. The server derives UID/creator from the token; do not send `createdBy` to claim ownership. Use contributor ID for domain creator comparisons, not a Firebase UID or a legacy numeric user ID.

Remove dependence on `/api/session` and the signed `walk_audit_user` cookie. Sign-out clears local user/draft caches as well as the Firebase session. Email entry alone is no longer authentication. Never automatically claim legacy studies/audits merely because an entered email matches an account.

### 3. Add one API adapter and update data handling

Centralize origin/path construction, token/App Check attachment, JSON parsing, version handling and safe errors. Public reads remain usable anonymously. Do not assume cross-origin cookies or same-origin relative requests will authenticate the new API.

Planned item envelopes are `{ contributor }`, `{ study }`, `{ worksheet }`, `{ audit }`, `{ draft }`, `{ report }`; lists contain a plural array plus `limit`, `offset`, `hasMore`. The proposed default limit is 25, maximum 100. Iterate pages instead of assuming a complete list. Confirm actual filter names and response fields against implemented OpenAPI.

Study detail will not embed every audit. Load paginated audits separately and use the progress endpoint; do not keep the existing assumption that one study request returns all observations/permissions. Do not require old `permissions`, `user`, `creatorName` or joined worksheet fields unless they appear in the finalized response. Client permission displays are only hints; the server remains authoritative.

Store the returned numeric IDs/UUIDs and versions. Do not hardcode worksheet IDs or assume they match the old database. Pin each draft/audit to the actual selected worksheet version; a staff edit may create a new worksheet ID rather than rewriting a referenced definition.

### 4. Adapt study creation and map rendering

POST only neighborhood and a WGS84 GeoJSON Polygon Feature as `area`. The shared server generates the network/centroid/thumbnail; do not send caller-generated collections, thumbnail bytes, creator, or an Overpass URL. Preserve longitude/latitude order in GeoJSON; location objects use the final API's named latitude/longitude fields.

Show a pending/progress state for network generation, respect quota Retry-After, and handle provider-unavailable responses without fabricating a saved study. Do not blindly auto-retry POST after a connection failure: the first request may have committed even if the browser missed the response. Prevent double-click submissions and provide a recovery/check-list flow.

Render intersections/segments and stable `properties.id` values supplied by the API. Preserve OSM attribution. Resolve returned thumbnail paths against the configured API origin rather than accidentally using the frontend origin. Treat a valid empty network as zero coverage, not a provider error.

Boundary changes are intended to be rejected once audits, drafts or reports exist. Surface the conflict rather than discarding observations or silently replacing their network. Neighborhood-only editing remains separate.

### 5. Make autosave and submission version-aware

Include `expectedVersion` in study/audit/draft/report PATCH and draft-submit requests as required by the implemented contract. Replace local versions with successful response versions. Serialize autosaves per draft, debounce edits and await in-flight saves before submitting. On 409, fetch/reconcile and let the user resolve stale work; do not overwrite blindly or retry indefinitely.

An editing draft is created with `editingAuditId` for a same-study, caller-owned audit. The server decides whether submission creates or edits; remove reliance on a caller-supplied `editing` flag. A successful submit consumes the draft. Handle 201 for a new audit, 200 for an edit, and 204/no body on deletes. A repeated submission after consumption is not guaranteed to replay successfully.

Use structured server messages for validation. Preserve unsaved work in session memory when authentication expires; any durable offline/private draft storage needs an explicit privacy and account-switching design, not a shared service-worker cache.

### 6. Enable editable reports and explicit destructive actions

Add report editing for title, narrative description and selected audit IDs. Coverage/captured data are server-derived; do not submit arbitrary completion or snapshot JSON. Changing membership recalculates captured data/coverage; editing narrative alone does not. Later unrelated audit edits/deletion do not automatically rewrite an existing report.

Before study deletion, display a clear irreversible-action confirmation identifying the study and explaining that **everyone's audits, drafts, reports and thumbnail for that study will be permanently removed**. Send the explicit confirmation flag only after the user confirms. Do not label this action Archive. Individual audit/report/draft deletion is a separate, narrower action.

After successful deletion, clear relevant cached pages, map overlays and pending autosaves; do not recreate the deleted study or resubmit its queued child writes. Do not rely on browser confirmation as authorization: handle server ownership failures correctly.

### 7. Review hosting and service-worker behavior

Update CSP `connect-src`/`img-src` as needed for the actual API and Firebase/App Check endpoints; coordinate authorized origins with the API maintainer. Do not loosen origins indiscriminately. Audit fetch calls, thumbnail URLs and service-worker matchers for old same-origin `/api/*` assumptions.

Do not cache private profiles, drafts, Authorization-bearing requests or mutation responses in a public/offline cache. Respect server no-store/revalidation behavior. Clear relevant client caches on sign-out, identity switch, deletion and backend selection changes. Old and new backends must not share version/ID-specific cache keys.

Retain the old repository/database backend until acceptance and retention decisions are complete. Once cutover is approved, remove or disable duplicate persistence, email-cookie authentication, server-side OSM/thumbnail/report generation and demo-storage fallback that the shared API now owns. Do not remove unrelated static hosting, frontend routing or security middleware still needed by the application.

### 8. Treat historical-data migration as a separate approved operation

The API implementation does **not** include automatic import. Before moving production records, inventory and back up users, studies, worksheets/versions, audits, drafts, reports and thumbnail bytes. Coordinate an operator-owned import plan with the API maintainer rather than importing browser-side or replaying public create endpoints.

Require explicit legacy→new mappings for contributor identities, study/worksheet/audit/report IDs and draft references. Securely verify ownership; source email/cookies did not prove email ownership. Preserve original GeoJSON feature IDs, worksheet definitions, timestamps, relationships and thumbnail content through an authorized import path. Recreating historical studies through automatic-generation POST can change the network and invalidate old feature references, so it is not a substitute for import.

The old reports did not capture full historical audit/worksheet content. Do not claim newly reconstructed data is the original historical snapshot; document reconstruction/provenance limits. Do not migrate signed cookies, tokens or secrets. Define checksums/count reconciliation, an agreed write freeze, final incremental export, read verification and rollback boundaries before touching production.

### 9. Test and cut over deliberately

Use fixtures/mock contracts while endpoints are unavailable; keep the new integration disabled. When staging is ready, verify:

- Public browsing and deep links; Firebase sign-in/out/profile registration; approved CORS/CSP/App Check behavior.
- Study creation produces real network data and a readable PNG; pagination loads all required observations.
- Draft autosave, resume, edit, conflict recovery and submission; unique-feature progress.
- Editable reports, membership/coverage changes and historical-capture behavior.
- Owner/organizer/staff restrictions and no cross-account draft exposure.
- 401/403/404/409/413/429/503 handling, Retry-After, safe failed-POST recovery and no accidental duplicate writes.
- Explicitly confirmed cascading deletion in an **isolated test study**, with unrelated studies preserved and deleted data absent after restart.
- Service-worker/cache invalidation, account switching, mobile map behavior and no regression to the existing UI.

Do not dual-write without an approved consistency design. Switch production only after API readiness, client acceptance and any separately authorized data import are complete. Keep the previous release and a documented rollback procedure. If writes have occurred in the new database, switching the flag back is not a lossless rollback: coordinate a write freeze and reconciliation before re-enabling legacy writes.

## Expected maintainer handback

Provide the inspected current-state summary, old→new API mapping, configuration needs, implementation/test changes, staging verification results, unresolved API dependencies, data-import proposal if needed, and a gated cutover/rollback checklist. Clearly distinguish implemented/tested behavior from planned assumptions. Do not deploy, migrate production data, or delete production studies without explicit authorization.
