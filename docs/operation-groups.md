# Atomic changes and server history

## Deployment

Apply migrations 001, 002, then `migrations/003_operation_groups.sql` **before deploying this version**: new record reads use its revision ledger. Rehearse against a non-production copy of the actual schema first. Migration 003 requires existing contacts/checkins/events tables and PostgreSQL `gen_random_uuid()`. It deliberately fails on duplicate non-null contact/event check-ins; resolve legacy duplicates with data-owner approval, never silently remove attendance. Multiple anonymous check-ins remain supported.

Triggers track all ordinary/external inserts, updates, deletes, and identity reuse. Do not disable triggers or grant clients access to inverse/lineage/history tables. The transaction service conservatively locks events, contacts and check-ins in `SHARE ROW EXCLUSIVE` mode in one order: reads remain available, writes serialize. This protects against existing external writers; it trades throughput for correctness. Account history locks serialize commit order and latest-action selection. No transaction spans begin/stage HTTP requests.

Schedule authenticated `SELECT operation_cleanup();` daily with existing database maintenance tooling, never a public route. It removes expired snapshots/commands/cursors/display context, retains minimal retries for 90 days, and preserves older transition evidence only when an unexpired action needs it. API expiry checks do not depend on timely cleanup.

## Existing endpoints

- `PUT /api/checkins/{id}` accepts optional `submitted_on`: RFC 3339 with explicit offset/Z and up to six fractional digits. Inclusive bounds: start minus two hours through end plus one hour; without an end, through start plus four hours. Moving event_id also validates the retained timestamp. Omitted timestamp is preserved; null/empty/date-only values are rejected. Undo restores trusted historical timestamps exactly, including microseconds, without applying today's user-edit time bounds.
- Attendance list and single-check-in reads add `is_self`. With contact inclusion, the authenticated attendee's own name is full; other public contacts remain redacted. `include_contact=false` still omits contacts. Existing staff/single-owner full detail access remains.
- Authorized contact PUT updates only present fields: omitted fields are unchanged. Name is optional but cannot be null/empty. Nullable fields accept null, empty arrays, and legacy empty/whitespace strings as explicit SQL NULL clearing. Only staff can change/clear roles or firebase_uid. Ordinary non-owner additive updates retain their limits and cannot clear.
- Contact/check-in reads expose opaque `revision`; single reads expose its quoted value as browser-readable `ETag`. Ordinary writes do not require revision/idempotency headers and retain immediate success responses. Safe integer response IDs remain numbers; larger BIGINTs remain exact decimal strings.

## Begin and stage

Every operation endpoint requires API key, valid Firebase user token and production App Check. Ownership is bound to verified account UID, not email/browser/source. Grouped contact changes cannot use the public additive path.

`POST /api/operation-groups` requires `Idempotency-Key` and JSON shaped as follows (replace the placeholder with a fresh UUIDv7):

```json
{
  "client_action_id": "<fresh UUIDv7>",
  "source": "event-view",
  "action_type": "save",
  "event_id": "42",
  "manifest": [
    { "resource": "contacts", "record_id": "17", "action": "PUT" },
    { "resource": "checkins", "record_id": "91", "action": "PUT" }
  ]
}
```

Source markers match `^[a-z][a-z0-9-]{0,63}$`; action_type is one of `save`, `remove`, `update`, or `delete`, so server summaries never echo arbitrary submitted text. This is classification, not authorization. Event references must exist; event-view requires event_id, other sources may omit it. UUIDv7 embeds Unix milliseconds in its first 48 bits, allowing expiry enforcement without trusting a separately editable issue date. At begin it must be less than 90 days old and no more than five minutes in the future. Client action IDs are account-unique and immutable across retries. Server group IDs are opaque UUIDs.

Manifests are nonempty and immutable, identifying each resource type, canonical decimal record ID, and PUT/DELETE action. Only one mutation per **resource type plus ID** is permitted. A contact PUT combines all changed fields; its timestamp check-in PUT is a separate target even if the numeric IDs happen to match. A new intended set requires a new group; do not silently deduplicate or split a user action into separate commits.

Begin returns 201 with group ID, context/correlation, `open_expires_at`, and retry deadlines. Open groups expire **24 hours after begin**. That deadline is independent of the 30-day Undo period starting at commit.

Stage existing per-record PUT/DELETE with these headers:

```http
X-Operation-Group: <group ID>
Idempotency-Key: <stable staged-request key>
If-Match: "<revision from record read>"
```

Staging returns 202 with group/operation IDs and `staged:true`, not a changed live record. Reject unexpected targets/actions and second distinct requests for the same target. Exact retries replay receipts and add no slots/bytes. Only successfully persisted mutations count toward completeness.

## Atomic commit and exact limits

`POST /api/operation-groups/{id}/commit` with Idempotency-Key requires an exact one-to-one match between manifest and stages, not merely matching counts. Four stages for five intended items cannot commit; unexpected/duplicate items cannot fill a gap. Recheck current permissions, revisions, relationships, timestamps and constraints before applying all mutations in one transaction. Trusted snapshots, predecessor lineage, discoverable history and receipt are committed atomically with domain data. Any failure changes nothing.

A group allows **100 distinct typed targets** and **1,048,576 bytes** of cumulative canonical UTF-8 JSON. Editing contact details and time for 50 attendees can consume all 100. Frontends should validate limits but must not automatically split one Save/Remove into separately committed groups.

Byte accounting adds:

1. Canonical normalized begin object `{client_action_id,source,action_type,event_id,manifest}`: event_id is null when omitted, IDs are canonical strings, manifest entries are sorted by resource/ID.
2. Each successfully staged distinct `{resource,record_id,action,command}` object: command contains normalized accepted writable fields, or `{}` for DELETE.

Canonical JSON recursively sorts object keys, preserves array order, uses JSON escaping with no extra whitespace, and counts UTF-8 bytes (not character count). Clearing/normalization/protected-field rules run before accounting. Headers, keys, expected revisions, server receipts, dependencies and inverse snapshots are excluded. Unknown request properties are ignored, not persisted or counted. Failed stages and exact retries add zero bytes. Limits are enforced before storing a stage and live writes; status exposes `payload_bytes`. An additional 2 MiB decoded JSON body cap applies to operation endpoints/grouped requests before route processing, including unrecognized properties. Ordinary requests retain their existing 100 KiB JSON-body cap. Grouped POST creation, event/suggestion writes, and other unsupported mutations return 400 `UNSUPPORTED_GROUP_MUTATION` instead of accidentally writing outside the group.

## Discover history and recover

`GET /api/operation-groups?source=event-view&limit=25&cursor=...` discovers this caller's committed/undone actions retained for 30 days, even without a group ID. Optional event_id narrows scope. Limit is 1–100, default 25. Opaque durable cursors are account/filter-bound, expire after 24 hours, and hold the first page's commit-order high-water mark. Restart on INVALID_CURSOR; fetch a fresh first page for newer commits.

Entries provide group/client action IDs, source, action type, event ID, affected count, safe server-generated summary, commit time/order, Undo expiry and committed/undone status. Commit order is monotonic per account across tabs/devices and represented as a **decimal string**, compared numerically. Known restrictions are safe codes; `undo_availability` is advisory. `unknown` permits an Undo attempt, not a guarantee. Constraints/current ownership are authoritative only during locked Undo validation.

History/status is private/no-store, never exposes private snapshots, before/after values, account UIDs or other accounts' actions. Source/context are validated classification, not proof of a specific application. After a lost commit response or reload, fetch server history and optionally correlate client_action_id. No local before/after storage is needed, and discovery works without a retained request ID.

For Ctrl-Z choose the greatest still-committed order in the declared source/event scope, **including blocked entries**. Send Undo JSON with source, optional event_id, expected_latest_group_id and expected_latest_commit_order. The backend rechecks latest under the account lock. A newer cross-device action returns LATEST_ACTION_CHANGED; a blocked latest reports conflict and never silently falls back to an older eligible action. Refresh history after success. Explicit group Undo may send `{}`, but all safety checks still apply.

## Undo lineage and logout

`POST /api/operation-groups/{id}/undo` with Idempotency-Key restores trusted originals atomically, including ID, nulls, arrays, BIGINTs and timestamp precision. Revisions advance. Server-managed predecessors allow A, B, Undo B, then Undo A: only verified inverses can restore earlier heads. Ordinary edits, edit-then-revert, unexplained revisions and ordinary ID recreation remain barriers. Every target/dependency must pass current permission, identity, lineage, expiry, FK and uniqueness checks; any conflict restores nothing.

Internal inverse receipts never appear as new user-undoable actions or receive a new action commit order. No redo is provided. Completed inverse retries do not advance revisions again.

History and sensitive snapshots expire **30 days from original commit**, including undone entries. Undo/logout do not extend it. Logout clears frontend UI/history/correlation state but retains account-bound server history and eligibility; same-account login rediscovers it, another account cannot. This replaces logout-clears-eligibility. Browser 100-action/1-MiB history limits disappear: server pagination/retention replace them, not the distinct per-group mutation limits.

## Retry horizon and errors

Stable keys replay unchanged requests. Scopes are account/begin, group/staged target, and group/commit/undo/cancel. Changed input on a scoped key conflicts; correcting input needs a new key. Client action ID reuse with a different manifest/context conflicts even with a new transport key. Completed retries replay before open/Undo/latest checks and cannot execute again; terminal commit/Undo repeats with a new key return completed state without writes. Receipts can describe an earlier response; history/status is the current authority.

Retry horizon is **90 days**: begin from embedded UUIDv7 time (`begin_retry_expires_at`), existing-group mutation requests from group creation (`retry_expires_at`). Horizon checks precede replay. Cleaning metadata cannot recreate an old begin: the intrinsic UUIDv7 time still rejects it. Cleanup retains a group's minimal identity/retries until both its creation-based and UUIDv7-based deadlines have elapsed, including the permitted five-minute future-clock skew; otherwise a future-dated action could be recreated in that gap. This small clock-skew retention buffer does not extend Undo or discoverable history. Unknown/removed group IDs return 404 and never create new groups via stage/commit/Undo. After 30 days, retries return only minimal metadata, not additional Undo eligibility/private data. A replayed stage receipt confirms past staging; inspect status to recover its completed group.

| HTTP / code | Required frontend response |
|---|---|
| 400 INVALID_*, EMPTY_UPDATE, MANIFEST_REQUIRED | Correct input; new key for changed payload. |
| 400 INVALID_CURSOR | Restart scoped pagination. |
| 401 authentication failure | Sign in/refresh credentials. |
| 403 RECORD_FORBIDDEN, PERMISSION_REVOKED | Report denied ownership/role; do not bypass. |
| 404 GROUP_NOT_FOUND, RECORD_NOT_FOUND | Discover history/refresh; never recreate that group ID. |
| 409 MANIFEST_INCOMPLETE | Stage missing items in the still-open group, then retry commit. |
| 409 OUTSIDE_MANIFEST, DUPLICATE_TARGET | Correct request/intended set; exact retry retains original key/payload. |
| 409 IDEMPOTENCY_CONFLICT, ACTION_ID_CONFLICT | Recover original request; new action ID only for a genuinely new action. |
| 409 REVISION_CONFLICT, UNDO_CONFLICT, RESTORATION_CONFLICT | Refresh/report conflict; no partial writes or older-action fallback. |
| 409 LATEST_ACTION_CHANGED | Refresh scoped server history. |
| 410 GROUP_EXPIRED | Open deadline passed: begin a new group if still intended. |
| 410 UNDO_EXPIRED | Undo window ended; do not replay as a new inverse. |
| 410 RETRY_HORIZON_EXPIRED | Old action cannot replay; recover state where available. A genuinely new action needs a fresh UUIDv7. |
| 413 GROUP_LIMIT_EXCEEDED / body cap | Report oversized action, never silently split commits. |
| 428 REVISION_REQUIRED | Fetch current revision and supply If-Match. |
| 500 INTERNAL_ERROR | Recover status/history before retrying with the original key. |

## Validation

Run `npm test` and `npm run build`. Tests execute migration/transaction logic against isolated embedded PostgreSQL (PGlite), never Cloud SQL or live credentials. Actual-schema migration rehearsal and multi-connection PostgreSQL locking/load validation are deployment prerequisites and are not silently performed by these commands.
