# Real-time suggestion notices

Connect to `wss://api.dallasurbanists.org/api/suggestions/ws` (alias: `/api/public-improvements/suggestions/ws`). Local development uses `ws://localhost:8080/api/suggestions/ws`. The socket is read-only and sends identifiers; fetch content through the existing REST endpoints.

## Authentication and protocol

Immediately after opening, send this JSON text frame within five seconds:

```json
{"type":"authenticate","apiKey":"your-application-key","appCheckToken":"current-firebase-app-check-token"}
```

API keys use the same `API_KEYS_JSON` configuration as REST. Production also requires a valid Firebase App Check token; development follows REST's existing App Check exemption. User sign-in is unnecessary. Browsers cannot set custom authentication headers on `new WebSocket()`, so credentials travel in this first encrypted message. Never put credentials in the URL. Query strings are rejected. Upgrade origins follow the existing CORS origin policy, including its local-development and absent-Origin allowances.

The server sends nothing until authentication succeeds and the shared Firestore listener has established its baseline:

```json
{"type":"ready","protocolVersion":1}
```

Subsequent messages have one of these shapes:

```json
{"type":"suggestion.created","suggestionId":41}
{"type":"suggestion.updated","suggestionId":41}
{"type":"suggestion.deleted","suggestionId":41}
```

All authenticated apps receive all suggestion notices. Changes to public suggestion fields, including emoji and persisted Streetmix summaries, produce notices. Internal-only changes such as `_deleting` do not. Recommended-action and activity subcollections are excluded. Initial existing records are never announced as new suggestions. Rapid writes may be combined by the underlying listener: notices invalidate cached state and are not an audit history or an exactly-once event stream.

Sending additional client messages or binary authentication frames closes the connection. Ordinary HTTP GET requests to either socket path receive `426 Upgrade Required`. Swagger describes the HTTP handshake; it does not provide a WebSocket client.

## Browser integration

Copy [the browser helper](https://github.com/DallasUrbanists/cloud-api-server/blob/main/examples/suggestion-notices.js) into your app. It obtains credentials on each connection, buffers and deduplicates notices during refreshes, debounces affected-record refreshes by 100 ms, aborts stale refreshes, and reconnects with exponential backoff and jitter between one and thirty seconds.

Example using an already initialized Firebase App Check instance and an application-owned map of suggestions:

```javascript
import { getToken } from 'firebase/app-check';
import { connectSuggestionNotices } from './suggestion-notices.js';

const apiBase = 'https://api.dallasurbanists.org';
const suggestions = new Map();

async function getCredentials() {
  const { token } = await getToken(appCheck, false);
  return { apiKey: applicationApiKey, appCheckToken: token };
}

async function read(path, signal) {
  const credentials = await getCredentials();
  return fetch(`${apiBase}${path}`, {
    signal,
    headers: {
      'X-API-Key': credentials.apiKey,
      'X-Firebase-AppCheck': credentials.appCheckToken,
    },
  });
}

const connection = connectSuggestionNotices({
  url: `${apiBase.replace('https:', 'wss:')}/api/suggestions/ws`,
  getCredentials,
  async refreshAll(signal) {
    const response = await read('/api/suggestions', signal);
    if (!response.ok) throw new Error('Refresh failed');
    const { data } = await response.json();
    if (signal.aborted) return;
    suggestions.clear();
    for (const suggestion of data) suggestions.set(suggestion.id, suggestion);
    renderSuggestions(suggestions);
  },
  async refreshSuggestions(ids, signal) {
    // Sequential reads bound bursts; applications may use bounded concurrency.
    for (const id of ids) {
      const response = await read(`/api/suggestions/${id}`, signal);
      if (response.status === 404) {
        if (!signal.aborted) suggestions.delete(id);
      } else {
        if (!response.ok) throw new Error('Refresh failed');
        const { data } = await response.json();
        if (!signal.aborted) suggestions.set(id, data);
      }
    }
    if (!signal.aborted) renderSuggestions(suggestions);
  },
  onAuthenticationRequired(code) {
    // Pause until application credentials are refreshed, then create a new connection.
    showApplicationVerificationError(code);
  },
});

// When unmounting the app/view:
// connection.stop();
```

Every `ready` must trigger a REST refresh, including after reconnecting. Notices received during that refresh are processed afterward, so an older fetch cannot overwrite a more recent update. Check the supplied `AbortSignal` before applying fetched data; the helper aborts it when that connection ends. A detail fetch returning `404` removes the record. Filtered or paginated views must also update membership/order or refresh their list query when affected suggestions change.

Authentication failures stop automatic retries. Refresh application credentials and start a new helper instance to resume. Transport and refresh failures reconnect automatically. There is no replay cursor or persisted notice history.

## Limits and close codes

| Condition | Result |
| --- | --- |
| Authentication missing or still processing after 5 seconds | `4000`; refresh credentials before retrying |
| Application authentication rejected | `4001`; refresh credentials before retrying |
| Session reaches 30 minutes | `4002`; reconnect with current credentials |
| Invalid or unexpected client message | `1008`; correct the client before reconnecting |
| Incoming message over 16 KiB | `1009` |
| Listener fails or cannot initialize within 15 seconds | `1013`; reconnect and refresh |
| Outgoing buffer exceeds 1 MiB | `1013`; reconnect and refresh |
| Shutdown | `1001`; reconnect and refresh |
| Pending authentication reaches 50 or authenticated connections reach 500 per instance | HTTP `503` with `Retry-After: 5`, or `1013` if capacity fills during authentication |

The server pings every 30 seconds and terminates connections that have not responded by the next check. Browsers respond to protocol pings automatically. Compression is disabled. Closing sockets are forcibly terminated after one second if the close handshake has not completed.

## Deployment and verification

`npm run deploy` configures Cloud Run's request timeout to 3,600 seconds. Existing deployments need that setting applied when deploying this change. Clients still handle earlier disconnects during scaling, revisions, or network interruptions. Shutdown stops upgrades, closes connections, detaches the listener, and clears timers.

Each instance with authenticated clients owns one Firestore collection listener, regardless of the number of browsers on that instance. Multiple instances observe the same committed writes, including writes from external tools. Each listener reads an initial collection snapshot and receives subsequent changes, so Firestore read costs grow with collection size, reconnects, and active instance count. Open WebSocket requests also keep Cloud Run instances active. No Redis, event-history collection, schema migration, or sticky sessions are needed.

Structured logs report connection counts, authentication timeouts/failures, listener failures, and slow clients without logging credentials, suggestion content, or raw provider errors.

Run `npm test` and `npm run build`. The two-instance integration test requires an independently running Firestore emulator:

```powershell
$env:FIRESTORE_EMULATOR_HOST = '127.0.0.1:8085'
npx tsx --test tests/suggestionWebSocketEmulator.test.ts
```

The integration test uses a unique `demo-ws-*` project and the emulator's default database; it never uses production suggestion data. Without `FIRESTORE_EMULATOR_HOST`, that test is explicitly skipped.
