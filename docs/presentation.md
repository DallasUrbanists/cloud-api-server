# TV presentation sessions

The Presentation API connects one `/tv` receiver, one `/remote` presenter, and any number of independent `/audience` viewers. Protocol v1 uses HTTPS polling. It does not use the suggestion WebSocket and does not change suggestion authentication.

The namespace is `/api/public-improvements/presentation`. Every response from it is `Cache-Control: no-store`. It is disabled by default; set `PRESENTATION_ENABLED=true` only when the client is ready. There is no fallback to an in-memory production store: session state, participant capabilities, code lookups, idempotency receipts, and admission limits use the configured `PUBLIC_IMPROVEMENTS_DB` Firestore database.

## Capability credentials

No Firebase account, API key, or external invitation is needed. Before each enrollment, the client creates and retains a UUID participant ID and 32 random bytes encoded as unpadded base64url. Keep both in `sessionStorage` for retry and later sync. The server stores only a SHA-256 digest of the token.

```js
const participantId = crypto.randomUUID();
const bytes = crypto.getRandomValues(new Uint8Array(32));
const participantToken = btoa(String.fromCharCode(...bytes))
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
```

Authenticated requests send `Authorization: Bearer <participantToken>` and `X-Presentation-Participant: <participantId>`. Never put either value in a URL, QR code, localStorage, analytics, or logs. Bootstrap calls include both values in JSON and require a UUID `Idempotency-Key`; keep and reuse the full request after a timeout. Successful replay returns the original safe enrollment metadata, never a token.

Presenter and audience codes are eight random characters from `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`, shown as `XXXX-XXXX`. Input ignores spaces and hyphens and is case-insensitive. Presenter and audience codes have separate lookup namespaces. A presenter QR should point to `<frontend-base>/remote#pair=<code>`; an audience QR should point to `<frontend-base>/audience#view=<code>`. Keep the participant credentials out of these fragments. Generate QR pixels locally and remove the code fragment after saving the pending enrollment request in sessionStorage.

## Routes

All JSON success bodies include `protocolVersion: 1`. Errors use `{ "error": "MACHINE_CODE", "message": "Safe user-facing message" }`. Bootstrap and admission routes are anonymous but rate limited. Session routes require the capability headers above; they never pass a presentation token through Firebase JWT verification.

| Method | Route | Access and behavior |
|---|---|---|
| `POST` | `/sessions` | Create a receiver session. JSON: `protocolVersion`, `participantId`, `participantToken`. Returns initial state, presenter code and expiry, audience code, session ID, and receiver role. 201 new, 200 same-key replay. |
| `POST` | `/pair` | Claim presenter authority with the same enrollment fields plus `code`. Returns controller role, canonical state, selected content, audience code, and expiry. A lost successful response can be replayed with the same ID, token, code, and key. |
| `POST` | `/audience/join` | Join with the same enrollment fields plus `code`. Returns audience role, private display label, state, and selected content when present. Audience receives no roster or presenter code. |
| `POST` | `/sessions/{sessionId}/sync` | Any participant. JSON requires `protocolVersion`, `lastRevision`, and `lastContentVersion`; optional `presence` is role-specific. Returns a compact unchanged envelope when the revision matches. Use `lastRevision: -1` for a full snapshot. |
| `PUT` | `/sessions/{sessionId}/state` | Controller only. Requires `Idempotency-Key`; JSON is `{protocolVersion,baseRevision,state}` with the full writable canonical state. A distinct successful write advances revision once. |
| `GET` | `/sessions/{sessionId}/ideas?limit=100&cursor=...` | Controller only. Public idea catalog, limit 1–100 and opaque cursor. Continue until `nextCursor` is null. |
| `GET` | `/sessions/{sessionId}/ideas/{ideaId}` | Controller can read any public idea. Receiver and audience can read only the current selection. |
| `GET` | `/sessions/{sessionId}/ideas/{ideaId}/streetmix-thumbnail` | Same idea read boundary. Relays only the UUID assigned to that saved idea; no upstream URL is accepted. PNG is validated and `no-store`. |
| `POST` | `/sessions/{sessionId}/pairing` | Receiver only. JSON `{protocolVersion:1}` plus `Idempotency-Key`. Rotates presenter code and revokes any current controller. |
| `DELETE` | `/sessions/{sessionId}/participants/me` | Audience leaves; controller relinquishes authority. Receiver cannot leave. Returns 204. |
| `DELETE` | `/sessions/{sessionId}` | Receiver or current controller ends the room. Authorized retries return 204. |

### Enrollment example

```http
POST /api/public-improvements/presentation/sessions
Content-Type: application/json
Idempotency-Key: 2f5b75d0-4fc0-4b12-9715-46df2221c247
```

```json
{
  "protocolVersion": 1,
  "participantId": "c13a6af0-8888-4444-8888-0bbee0cc1122",
  "participantToken": "<43-character-base64url-token>"
}
```

The response contains safe enrollment information, for example:

```json
{
  "protocolVersion": 1,
  "sessionId": "b9fcb3a3-f137-4972-864a-7e2a6c403d68",
  "participantId": "c13a6af0-8888-4444-8888-0bbee0cc1122",
  "role": "receiver",
  "expiresAt": "2026-10-21T18:10:00.000Z",
  "state": { "revision": 0, "ideaEpoch": 0, "selectedIdeaId": null, "mode": "map" },
  "presenterCode": "ABCD-EFGH",
  "presenterCodeExpiresAt": "2026-10-21T18:10:00.000Z",
  "audienceCode": "JKLM-NPQR"
}
```

The documented response omits additional default state fields for brevity; the API returns the complete canonical state.

## State and content

Canonical state uses `revision` and `ideaEpoch` (server-owned), `selectedIdeaId`, `mode` (`map|photo|description`), `camera`, `mapStyle` (`streets|satellite`), `railVisible`, `theme` (`light|dark`), `albumItemId`, `photoFrame`, `captionVisible`, `descriptionPage`, and `audienceDisplay` (`showQr`, `showCode`). Camera coordinates and zoom, photo framing, page index, IDs, types, and unknown fields are validated. The state is a complete snapshot; send absolute camera/frame values, never deltas.

Changing to a different idea advances `ideaEpoch`, selects its first valid album item, resets framing and description pagination, and centers the map on valid coordinates at zoom 16. Selecting the same idea keeps audience exploration and `ideaEpoch`. An empty album starts in description mode; clearing selection forces map mode. Album item changes reset framing. Streetmix is always last, uses contain framing, and has no effective caption while preserving the ordinary photo caption preference.

The public idea DTO includes only public summary/details, canonical description pages, location, status/date, optional emoji, and an ordered album. It excludes authorship identifiers, internal workflow data, logs, and unknown persisted fields. Photos retain saved order and get deterministic IDs from their public URL; duplicate URLs are disambiguated by order. Only HTTPS photo URLs are emitted, without userinfo, query strings, or fragments. An assigned saved Streetmix attachment is included only with a canonical `https://streetmix.net/-/<digits>` URL; it includes its stale flag and is never generated by a presentation read.

`descriptionPages` paginate `details` at 320 Unicode code points, preferring paragraph then word boundaries. Long unbroken text splits safely at code point boundaries; the text is not summarized. An empty description has one empty page. Audience members choose their own local view and content position. Those actions are presence only and never alter canonical state or another audience member.

Every sync envelope includes server time and session status/expiry/revision. It returns full state only when the revision changed, and selected content only when `lastContentVersion` differs. Only a controller receives the audience roster and audience code. Only receiver sync accepts applied revision, viewport, and render status; only audience sync accepts `localView`. Presence does not advance the presentation revision. Participant heartbeat timestamps are persisted no more than once every 15 seconds; a viewer is considered connected for 45 seconds.

## Expiry, limits, and errors

An unpaired room and its presenter code expire after ten minutes. The first successful pairing sets an absolute four-hour room expiry. Re-pairing does not extend that deadline. Presenter codes expire after ten minutes or one successful claim. The audience code works until the room expires and can admit any number of viewers. Ended rooms and expired rooms cannot be revived; end retains a tombstone through the room's original expiry, while Firestore TTL is optional cleanup only.

Admission uses Firestore transaction counters shared across service instances:

- Create: 5 requests per minute per `req.ip`.
- Presenter pair and audience join: 10 requests per minute per IP, in separate purpose buckets.

Responses over quota use 429 `RATE_LIMITED` and `Retry-After`. The app does not trust arbitrary `X-Forwarded-For`; IP identity comes from Express `req.ip` with the existing proxy configuration. JSON bodies are limited to 32 KiB. Session JSON, including binary thumbnail responses, is `no-store`.

Common safe errors are `PAIRING_CLAIMED`, `PAIRING_EXPIRED`, `SESSION_EXPIRED`, `SESSION_ENDED`, `INVALID_SESSION_CREDENTIAL`, `ROLE_FORBIDDEN`, `IDEA_UNAVAILABLE`, `INVALID_PRESENTATION_STATE`, `PROTOCOL_UNSUPPORTED`, `REVISION_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `RATE_LIMITED`, `PRESENTATION_DISABLED`, and `PRESENTATION_UNAVAILABLE`. A revision conflict includes the current forced-sync envelope. Reuse the same idempotency key only for an identical request; a different request returns `IDEMPOTENCY_CONFLICT`.

## Local setup and frontend API base

Set `PRESENTATION_ENABLED=true` in the local server environment, then start the API from this repository:

```powershell
$env:PRESENTATION_ENABLED = "true"
npm run dev
```

For a local client, point its API origin at `http://localhost:8080` and build requests under `/api/public-improvements/presentation`. On another device on the same network, use the development machine's reachable host name/IP and add the frontend origin to `ALLOWED_ORIGINS`. The existing Firestore application-default credentials and `PUBLIC_IMPROVEMENTS_DB` must point at a development/emulator database for local session traffic.

The service account needs Firestore transaction read/write access for `presentationSessions`, `presentationCodeLookups`, `presentationBootstrapReceipts`, and `presentationRateLimits`. Session, participant, lookup, receipt, and limiter documents carry an `expiresAt` Firestore timestamp for cleanup and a millisecond deadline used by authorization. Operators may enable Firestore TTL on the `expiresAt` field for collection groups `presentationSessions`, `participants`, `receipts`, `presentationCodeLookups`, `presentationBootstrapReceipts`, and `presentationRateLimits`. TTL is asynchronous cleanup only; authorization never depends on it. Do not point tests at production Firestore.

The focused suite is `node --import tsx --test tests/presentation.test.ts tests/presentationAuth.test.ts tests/presentationContent.test.ts`. The two-service transaction proof is `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node --import tsx --test tests/presentationEmulator.test.ts` using a running local Firestore emulator; the test creates a `demo-*` project and a named `presentation-emulator-test` database.
