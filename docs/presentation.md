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

Presenter and audience codes are five random numeric digits, shown without separators. Leading zeroes are allowed. Presenter and audience codes have separate lookup namespaces. A presenter QR should point to `<frontend-base>/remote#pair=<code>`; an audience QR should point to `<frontend-base>/audience#view=<code>`. Keep the participant credentials out of these fragments. Generate QR pixels locally and remove the code fragment after saving the pending enrollment request in sessionStorage.

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
  "presenterCode": "01234",
  "presenterCodeExpiresAt": "2026-10-21T18:10:00.000Z",
  "audienceCode": "56789"
}
```

The documented response omits additional default state fields for brevity; the API returns the complete canonical state.

## State and content

Canonical state uses `revision` and `ideaEpoch` (server-owned), `selectedIdeaId`, `mode` (`map|photo|description`), `camera`, `mapStyle` (`streets|satellite`), `railVisible`, `theme` (`light|dark`), `albumItemId`, `photoFrame`, `captionVisible`, `descriptionPage`, and `audienceDisplay` (`showQr`, `showCode`). Camera coordinates and zoom, photo framing, page index, IDs, types, and unknown fields are validated. The state is a complete snapshot; send absolute camera/frame values, never deltas.

Changing to a different idea advances `ideaEpoch`, selects its first valid album item, resets framing and description pagination, and centers the map on valid coordinates at zoom 16. Selecting the same idea keeps audience exploration and `ideaEpoch`. An empty album starts in description mode; clearing selection forces map mode. Album item changes reset framing. Streetmix is always last, uses contain framing, and has no effective caption while preserving the ordinary photo caption preference.

The public idea DTO includes only public summary/details, canonical description pages, location, status/date, optional emoji, and an ordered album. It excludes authorship identifiers, internal workflow data, logs, and unknown persisted fields. Photos retain saved order and get deterministic IDs from their public URL; duplicate URLs are disambiguated by order. Only HTTPS photo URLs are emitted, without userinfo, query strings, or fragments. An assigned saved Streetmix attachment is included only with a canonical `https://streetmix.net/-/<digits>` URL; it includes its stale flag and is never generated by a presentation read.

`descriptionPages` paginate `details` at 320 Unicode code points, preferring paragraph then word boundaries. Long unbroken text splits safely at code point boundaries; the text is not summarized. An empty description has one empty page. Audience members choose their own local view and content position. Those actions are presence only and never alter canonical state or another audience member.

Every sync envelope includes server time and session status/expiry/revision. It returns full state only when the revision changed, and selected content only when `lastContentVersion` differs. Only a controller receives the audience roster and audience code. Only receiver sync accepts applied revision, viewport, and render status; only audience sync accepts `localView`. Presence does not advance the presentation revision. Participant heartbeat timestamps are persisted no more than once every 15 seconds; a viewer is considered connected for 45 seconds.

## Presentation WebSocket v1

The additive endpoint is `/api/public-improvements/presentation/ws` on the configured API origin. A client derives `ws:` or `wss:` from that origin with `URL`; it does not put a token, code, query, or fragment in the socket URL. Existing REST and state DTOs remain `protocolVersion: 1`. Socket frames independently use `socketProtocolVersion: 1`. WebSockets require both `PRESENTATION_ENABLED=true` and `PRESENTATION_WEBSOCKET_ENABLED=true`; both default to false. An ordinary HTTP GET to the enabled endpoint returns `426 Upgrade Required`; the disabled endpoint returns `404`.

After opening, send this exact first frame within five seconds. The server derives the participant role from the durable session and participant documents. It sends no presentation or participant data until capability authorization and both scoped Firestore listeners have initialized.

```json
{"type":"authenticate","socketProtocolVersion":1,"protocolVersion":1,"sessionId":"<UUID>","participantId":"<UUID>","participantToken":"<existing 43-character token>"}
```

The server sends exactly one `ready` frame first, with `sequence: 1`, then zero or more `snapshot` frames. Both carry the same full envelope shape. `state` is always complete and `state.revision` equals `session.revision`. A null selection has `content: null`; a selected idea has its matching public DTO. Later sequence values are strictly increasing within the connection and restart at one after reconnect. Revision orders canonical state and content; sequence orders metadata within one connection. Intermediate revisions may be coalesced, so reconnect always begins with a full current snapshot. `changed: true` means the envelope is full, even when its revision did not change.

```json
{"type":"ready","socketProtocolVersion":1,"sequence":1,"envelope":{"protocolVersion":1,"serverTime":"<ISO timestamp>","session":{"id":"<UUID>","status":"active","expiresAt":"<ISO timestamp>","revision":0},"changed":true,"state":{"revision":0,"ideaEpoch":0,"selectedIdeaId":null,"mode":"map","camera":{"latitude":32.7767,"longitude":-96.797,"zoom":13},"mapStyle":"streets","railVisible":true,"theme":"dark","albumItemId":null,"photoFrame":{"scale":1,"centerX":0.5,"centerY":0.5},"captionVisible":true,"descriptionPage":0,"audienceDisplay":{"showQr":false,"showCode":false},"iconStyle":{"size":100,"animationEnabled":true,"pulseSize":1,"pulseSpeed":1,"bobbingRotation":0,"bobbingSpeed":1,"animationEasing":"ease-in-out"}},"content":null,"participants":null,"receiver":null}}
```

Only controllers receive `participants` and `audienceCode`. Only receivers receive the existing safe `receiver` telemetry projection. Audience frames contain neither roster nor presenter code. Firestore records, token digests, receipts, presenter admission codes, and suggestion internals are never serialized. HTTP `/sync` retains its compact unchanged and null-content behavior.

The server sends an application heartbeat every 15 seconds after `ready`:

```json
{"type":"heartbeat","socketProtocolVersion":1,"id":"<connection-local identifier>","serverTime":"<ISO timestamp>"}
```

The client immediately replies and may send its initial presence or a later coalesced change:

```json
{"type":"presence","socketProtocolVersion":1,"heartbeatId":"<heartbeat id or null>","presence":{}}
```

An unsolicited presence uses JSON `null` for `heartbeatId`. Receiver presence allows `appliedRevision` (nonnegative safe integer), `viewport` (`width` and `height` from 1 through 16384), `renderStatus` (`loading`, `ready`, or `error`), and `renderError`. The accepted `renderError` values are `MAP_UNAVAILABLE`, `IMAGE_UNAVAILABLE`, `STREETMIX_UNAVAILABLE`, `CONTENT_UNAVAILABLE`, `TILE_UNAVAILABLE`, `RENDER_FAILED`, `NETWORK_ERROR`, `TIMEOUT`, `UNKNOWN`, or `null`. Audience presence allows optional `localView` (`map`, `photo`, or `description`). Controller presence is `{}`. REST and socket paths share this validator. Presence never increments canonical revision.

The server tracks at most two unacknowledged heartbeat IDs and closes retryably when the oldest reaches 30 seconds. A valid response for one outstanding ID also acknowledges older IDs; unknown, repeated, or obsolete IDs do not extend liveness. Native WebSocket pong is not an application acknowledgment. Receiver presence is validated and its heartbeat acknowledged in memory before Firestore work starts. Presence writes are serialized and reauthorize the capability transactionally. Unchanged participant `lastSeen` is persisted at most every 15 seconds; changed telemetry may persist sooner. Multiple sockets for one participant do not revoke each other. Roster connectivity expires after 45 seconds even if no Firestore write arrives at that boundary.

### Socket errors and close behavior

When it can be sent safely, an error frame precedes close:

```json
{"type":"error","socketProtocolVersion":1,"error":"PRESENTATION_UNAVAILABLE","message":"Presentation updates are temporarily unavailable.","retryAfterMs":5000}
```

`retryAfterMs` is optional, finite, from 0 to 60000, and is a minimum retry delay. Safe machine codes distinguish terminal authority (`SESSION_ENDED`, `SESSION_EXPIRED`, `INVALID_SESSION_CREDENTIAL`, `ROLE_FORBIDDEN`), socket-only incompatibility (`SOCKET_PROTOCOL_UNSUPPORTED`), shared REST/state incompatibility (`PROTOCOL_UNSUPPORTED`), and temporary disablement (`PRESENTATION_DISABLED`). Socket-only incompatibility and `PRESENTATION_DISABLED` stop socket probes for the running session while REST fallback remains available. `PROTOCOL_UNSUPPORTED` stops incompatible session I/O and preserves the current display without deleting credentials or forcing reload. Transport faults never imply revoked authority.

| Close code | Meaning and client behavior |
|---|---|
| `4000` | Authentication timeout; retry with fallback. |
| `4001` | Rejected capability; terminal for that participant. |
| `4003` | Ended or expired session; the preceding machine error distinguishes them. A bare code is terminal without guessing which. |
| `4004` | Unsupported version; bare close is socket-only incompatibility. A preceding `PROTOCOL_UNSUPPORTED` stops incompatible session I/O. |
| `1008` | Invalid frame or policy; disable socket probes for this running session and retain REST fallback and credentials. |
| `1009` | Incoming frame exceeded 32 KiB; disable socket probes for this running session. |
| `1013` | Temporary unavailability, overload, slow consumer, or heartbeat timeout; reconnect and use fallback. |
| `1001` | Server shutdown; reconnect and use fallback. |
| `1000` | Intentional local teardown. An unsolicited remote `1000` is recoverable and does not prove that the room ended. |

Network failures, abnormal close, server failure, handshake timeout, and constructor failure recover through fallback. A known terminal machine error takes precedence over its close. Failed browser upgrades may conceal HTTP response details; clients must not infer credential revocation from an upgrade failure. Unknown application close codes disable socket probes for the current run while preserving REST use.

### Recovery, limits, and multi-instance behavior

The server authenticates within five seconds and initializes session and participant listeners within 15 seconds after authentication. The client bounds opening through ready to 25 seconds and starts HTTP sync immediately while the first socket dials. During a later socket loss it promptly resumes fallback. A candidate socket takes metadata ownership only after its valid, non-stale full `ready` snapshot is applied. REST commands and their idempotency receipts remain HTTPS-only; a socket snapshot never acknowledges a pending command. Retry minima are independent for sockets, HTTP sync, and HTTPS writes. CORS exposes both `ETag` and `Retry-After` to browser clients.

Each server instance allows at most 50 pending and 500 authenticated presentation sockets, four concurrent sockets per participant, 500 per session, 32 KiB incoming frames, 10 messages per second with burst 20, and 1 MiB buffered outgoing data. Compression is disabled. Snapshot work coalesces for 100 ms and retains only the latest pending state; terminal errors bypass that queue. Slow sockets close with `1013`, and a close handshake is force-terminated after one second. These are per-instance resource bounds, not room admission limits. The 1 MiB buffer threshold does not limit a valid public DTO; the emitted DTO has no arbitrary truncation. Timer and listener counts return to zero after the last local socket leaves.

Each instance reference-counts one Firestore session document listener and one participant collection listener per active session. Those durable listeners deliver committed changes across instances without sticky sessions or an in-memory-only broadcast. The service reauthorizes before sending each projection and on observed membership changes. Session watchers also run the existing selected-content refresh lease every five seconds, enforce absolute expiry while idle, and refresh the 45-second roster connectivity boundary without REST polling. Listener failure stops delivery and closes retryably. These timers and listeners stop with the last socket for that session. REST-only clients retain the existing `/sync` maintenance behavior.

### Rollout and Cloud Run operations

Both switches are opt-in and remain disabled until an operator rolls out a compatible client and backend. For a later backend-first rollout, verify the running service's request timeout, maximum concurrency, instance limits, Firestore listener permissions, and expected active-connection cost in the Cloud Run service configuration and metrics. Cloud Run treats WebSockets as long-running HTTP requests subject to the configured request timeout, so clients need reconnect recovery. Cloud Run documents a maximum request timeout of 60 minutes, a default of five minutes, and up to 1,000 concurrent connections per container; these platform limits do not replace the per-instance application limits above. WebSocket requests keep an instance active and incur instance-based billing while connected. Cloud Run may route later connections to another instance, so the Firestore listeners provide shared state propagation. Review the current [Cloud Run WebSocket guidance](https://docs.cloud.google.com/run/docs/triggering/websockets) before rollout. Enable `PRESENTATION_WEBSOCKET_ENABLED` only after `PRESENTATION_ENABLED` is deliberately enabled; rollback by disabling the socket switch first, then the presentation API switch if required. No live configuration is changed by this implementation.

## Expiry, limits, and errors

An unpaired room and its presenter code expire after ten minutes. The first successful pairing sets an absolute four-hour room expiry. Re-pairing does not extend that deadline. Presenter codes expire after ten minutes or one successful claim. The audience code works until the room expires and can admit any number of viewers. Ended rooms and expired rooms cannot be revived; end retains a tombstone through the room's original expiry, while Firestore TTL is optional cleanup only.

Admission uses Firestore transaction counters shared across service instances:

- Create: 5 requests per minute per `req.ip`.
- Presenter pair and audience join: 10 requests per minute per IP, in separate purpose buckets.

Responses over quota use 429 `RATE_LIMITED` and `Retry-After`. The app does not trust arbitrary `X-Forwarded-For`; IP identity comes from Express `req.ip` with the existing proxy configuration. JSON bodies are limited to 32 KiB. Session JSON, including binary thumbnail responses, is `no-store`.

Common safe errors are `PAIRING_CLAIMED`, `PAIRING_EXPIRED`, `SESSION_EXPIRED`, `SESSION_ENDED`, `INVALID_SESSION_CREDENTIAL`, `ROLE_FORBIDDEN`, `IDEA_UNAVAILABLE`, `INVALID_PRESENTATION_STATE`, `PROTOCOL_UNSUPPORTED`, `REVISION_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `RATE_LIMITED`, `PRESENTATION_DISABLED`, and `PRESENTATION_UNAVAILABLE`. A revision conflict includes the current forced-sync envelope. Reuse the same idempotency key only for an identical request; a different request returns `IDEMPOTENCY_CONFLICT`.

## Local setup and frontend API base

For the full API, set `PRESENTATION_ENABLED=true` in the local server environment. Set `PRESENTATION_WEBSOCKET_ENABLED=true` only when testing the socket endpoint. Never point local session traffic at production Firestore.

```powershell
$env:PRESENTATION_ENABLED = "true"
$env:PRESENTATION_WEBSOCKET_ENABLED = "true"
npm run dev
```

For an isolated presentation-only process, use `npm run smoke:presentation-websocket`. The script requires a reachable loopback Firestore emulator, pins a unique `demo-*` project, binds the HTTP server to `127.0.0.1:8187`, enables both backend switches, and seeds only a synthetic idea. The current Firestore emulator supports only its default database, so each run gets an isolated demo project and a named cleanup namespace inside that project's `(default)` database. It fails closed when the emulator is absent or non-loopback. It prints the API base URL and exact Firestore project/database/namespace for cleanup. Use `http://127.0.0.1:8187` as the frontend API origin; it does not invoke the general development server or use ADC credentials.

For a local client, point its API origin at `http://localhost:8080` and build requests under `/api/public-improvements/presentation`. On another device on the same network, use the development machine's reachable host name/IP and add the frontend origin to `ALLOWED_ORIGINS`. The existing Firestore application-default credentials and `PUBLIC_IMPROVEMENTS_DB` must point at a development/emulator database for local session traffic.

The service account needs Firestore transaction read/write access for `presentationSessions`, `presentationCodeLookups`, `presentationBootstrapReceipts`, and `presentationRateLimits`. Session, participant, lookup, receipt, and limiter documents carry an `expiresAt` Firestore timestamp for cleanup and a millisecond deadline used by authorization. Operators may enable Firestore TTL on the `expiresAt` field for collection groups `presentationSessions`, `participants`, `receipts`, `presentationCodeLookups`, `presentationBootstrapReceipts`, and `presentationRateLimits`. TTL is asynchronous cleanup only; authorization never depends on it. Do not point tests at production Firestore.

The focused suite is `node node_modules/tsx/dist/cli.mjs --test tests/presentation.test.ts tests/presentationAuth.test.ts tests/presentationContent.test.ts tests/presentationWebSocket.test.ts tests/suggestionWebSocket.test.ts`. The two-instance WebSocket proof is `$env:FIRESTORE_EMULATOR_HOST='127.0.0.1:8085'; node node_modules/tsx/dist/cli.mjs --test tests/presentationEmulator.test.ts tests/presentationWebSocketEmulator.test.ts tests/suggestionWebSocketEmulator.test.ts` using a running local emulator; each test uses a unique `demo-*` project and the isolated `(default)` database because the emulator does not yet support named databases. Tests clean only their unique demo project data and skip when no emulator is configured. A skipped test is not integration evidence.

An explicit ten-minute no-polling soak is available as `$env:FIRESTORE_EMULATOR_HOST='127.0.0.1:8085'; $env:PRESENTATION_WEBSOCKET_SOAK='1'; node node_modules/tsx/dist/cli.mjs --test tests/presentationWebSocketSoak.test.ts`. It has a 12-minute test timeout and is skipped during ordinary `npm test` runs. It performs one controller interaction, sends and acknowledges server heartbeats without `/sync` requests, simulates an abrupt request-timeout disconnect and one manual reconnect, then advances the injected service clock to the absolute four-hour expiry. It uses a unique demo project and does not retry the soak automatically.
