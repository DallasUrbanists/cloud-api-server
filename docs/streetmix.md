# Streetmix

## Suggestion integration

Let's imagine a neighbor opens an idea for a safer crossing. The app can request a drawing using that suggestion's saved location, ask which road they meant when several roads meet, and show the saved drawing whenever anyone opens the idea again.

The [suggestion workflow contract](../src/docs/suggestionStreetmix.ts) defines five endpoints under `/api/suggestions/:suggestionId` and the `/api/public-improvements/suggestions/:suggestionId` alias. Application API key and production App Check apply to every endpoint. User sign-in is optional for first generation and reads. Ordinary generation returns an existing attachment. Only the current signed-in author or staff may regenerate it, using `If-Match` from the current attachment GET response. Explicit regeneration fetches fresh sources and creates a new public design.

The [workflow service](../src/services/suggestionStreetmixService.ts) claims one active request per suggestion before provider calls. Initial generation shares the existing location caches; regeneration has a server-created refresh scope that remains stable across retries. Selection is valid for 15 minutes. Execution leases last 90 seconds; HTTP generation has a 60-second deadline. No background worker runs. Status reads do not advance work: clients retry the original POST, with its original key and body, to recover a stopped execution or finish saving.

The parent `suggestion/{id}` holds a small server-managed `streetmix` summary and a private active-request pointer. The permanent full result is at `suggestion/{id}/streetmix/current`; transient requests and application-scoped key mappings are in `streetmixRequests` and `streetmixRequestKeys` beneath that suggestion. Terminal request receipts have a logical 24-hour lifetime; Firestore TTL on their `expiresAt` field can clean them physically. Unresolved publication states have no automatic expiry. Candidate requests expire logically and can be superseded by a new initial/regeneration request. Suggestion deletion removes all these subcollections and leaves external public Streetmix designs intact.

Saving the attachment, current full result, and completed receipt is one transaction. A verified result is recorded before this transaction so `save_pending` recovery saves it without republishing. The service rechecks coordinates, revision, deletion, and replacement ownership before publication and saving. Ordinary suggestion updates use transactional known-field patches, preserving server-managed fields. Coordinate changes make saved summaries `stale: true`; the existing drawing remains readable. Unknown publication outcomes retain the active request and must never be retried with a fresh regeneration scope.

### Client example

Use the suggestion ID rather than sending coordinates. Keep the original POST URL, body, and idempotency key in client state until it finishes, including after a page reload. `getAppCheckToken` and optional `getUserIdToken` below are supplied by the integrating application's existing Firebase setup.

```js
const base = 'https://api.dallasurbanists.org';
const path = `/api/suggestions/${suggestion.id}/streetmix`;

async function call(path, { method = 'GET', body, key, etag } = {}) {
  const token = await getAppCheckToken();
  const userToken = await getUserIdToken(); // null for anonymous users
  const response = await fetch(base + path, {
    method,
    headers: {
      'X-API-Key': applicationApiKey,
      'X-Firebase-AppCheck': token,
      ...(userToken ? { Authorization: `Bearer ${userToken}` } : {}),
      ...(method === 'POST' ? {
        'Content-Type': 'application/json', 'Idempotency-Key': key,
      } : {}),
      ...(etag ? { 'If-Match': etag } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { response, data: await response.json() };
}

let pendingPost = { method: 'POST', body: {}, key: crypto.randomUUID() };
let pendingPath = path;
let outcome = await call(pendingPath, pendingPost);

if (outcome.response.status === 409 &&
    outcome.data.error === 'STREET_SELECTION_REQUIRED') {
  // Render candidates on a map/dropdown; wait for an explicit user choice.
  const osmWayId = await chooseRoad(outcome.data.candidates);
  pendingPath = `${path}/requests/${outcome.data.requestId}/selection`;
  pendingPost = { method: 'POST', body: { osmWayId }, key: crypto.randomUUID() };
  outcome = await call(pendingPath, pendingPost);
}

if (outcome.data.status === 'completed') {
  suggestion.streetmix = outcome.data.streetmix;
  const url = new URL(outcome.data.result.streetmixUrl);
  if (url.origin !== 'https://streetmix.net' || !/^\/-\/\d+$/.test(url.pathname)
      || url.search || url.hash || url.username || url.password) {
    throw new Error('Invalid Streetmix URL');
  }
  document.querySelector('#streetmix-preview').src = url.href;
}
// On 202 or interruption, GET data.statusUrl for progress. Resume by repeating
// call(pendingPath, pendingPost), with exactly the same key and body.
// Do not automatically create a new request after publication_uncertain.
```

Embed the returned `result.streetmixUrl` with the same iframe settings as the playground. Credentials are sent only to this API and never to the iframe:

```html
<iframe id="streetmix-preview" title="Generated Streetmix design"
  style="width:100%;height:620px;border:0" allowfullscreen
  referrerpolicy="strict-origin-when-cross-origin"
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads">
</iframe>
```

To replace a design, first `GET` the attachment and retain its `ETag`; then POST `{}` to `${path}/regenerate` with a fresh idempotency key, that ETag in `If-Match`, and the author's or staff user's Firebase token. Handle ambiguity with the same selection flow. A `412` means the attachment changed; read it again before offering another regeneration. Completed same-key retries return their original receipt without replacing a newer design. Full saved results remain readable after transient request receipts expire.

The Streetmix service reconstructs an approximate existing Texas road or street cross-section from a coordinate and publishes an anonymous design on streetmix.net. A caller can open the public design and remix it into a Streetmix account. Estimates describe missing mapped details; they are not surveyed measurements or proposed improvements.

The testing page is **`/playground/streetmix`** on the API server. Paste a comma-separated coordinate pair into **Coordinates**, click **Generate**, with no credentials to enter. Both `32.78014, -96.79701` and `-96.79701, 32.78014` work: clicking Generate identifies the order using a coarse Texas envelope (latitude 25–37, longitude −107 to −93) and sends numeric latitude/longitude to the API. The envelope only disambiguates the pair; the API still checks the Texas state polygon. The page obtains App Check tokens automatically using the same Firebase web configuration, reCAPTCHA site key, and provider settings as Swagger. No API key or token is embedded in the page or entered by the user. The browser calls `POST /api/streetmix/playground/designs`, which requires App Check in production and uses a dedicated shared playground quota and retry namespace. The Firebase SDK manages its App Check token cache and automatic refresh. Generation creates a public street; the interface shows its link, selected location, warnings, estimates, and complete JSON.

Browser verification runs before the generation request, with a 10-second limit. In production, missing configuration, failed SDK loading, or unsuccessful verification prevents submission and displays a retry message. The page uses reCAPTCHA v3 or Enterprise according to `FIREBASE_APPCHECK_PROVIDER` (with the existing `VITE_` fallback); production never embeds an App Check debug token. Local development can use the existing debug-token configuration, and does not require App Check when Firebase settings are absent. API authentication and server-side verification remain unchanged.

## Data and responsibilities

1. The [controller](../src/controllers/streetmixController.ts) validates coordinates and the retry key and combines a 60-second deadline with disconnect cancellation.
2. [Source adapters](../src/services/streetmixSources.ts) check Texas membership using the [Census States polygon layer](https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/0), request OSM ways through Overpass, and retrieve official Dallas centerlines only after confirming Dallas city membership. Only configured public service URLs are used.
3. The nearest eligible OSM carriageway within 100 meters wins. Equal-distance ties use OSM way ID. When the next candidate is within 10 meters of the nearest candidate, or any candidate is on a bridge, in a tunnel, or on a nonzero mapped layer, generation returns `409 STREET_SELECTION_REQUIRED` with names, OSM way IDs, distances, bearings, and grade-separation clues. No publication occurs. The playground maps the candidates over OpenStreetMap tiles, with blue candidate lines, an orange selected carriageway, numbered markers matching the dropdown, and a red requested-coordinate dot. Clicking a line or marker updates the dropdown; changing the dropdown updates the highlight. The arrow follows OSM way direction, not necessarily legal travel direction. Geometry is clipped to 250 meters around the coordinate. The map loads Leaflet 1.9.4 on demand; a failed map or tile load leaves the dropdown usable. The page sends only its origin as the cross-origin referrer for map tiles. The playground lets the caller choose the intended road. Confirm with an offered `osmWayId` and a new request key; arbitrary way IDs are rejected. Freeways, ramps, alleys, service roads, private roads, and non-road paths are outside this version.
4. The [builder](../src/services/streetmixBuilder.ts) constructs the drawing with left/right referenced to OSM node order. Widths are stored in meters and displayed in feet. Mapped roadway width does not include the added sidewalks. Divided roads with a sufficiently certain opposing carriageway are reconstructed across both directions with one central median; otherwise the result explicitly remains carriageway-only.
5. The [service](../src/services/streetmixService.ts) persists a draft and publication intent, then uses the [publisher](../src/services/streetmixPublisher.ts) to create exactly once and verify the stored cross-section before returning success.

OSM attribution and the way URL are included in evidence. Preserve that attribution when displaying or redistributing results; OpenStreetMap data is available under the [ODbL](https://www.openstreetmap.org/copyright). Dallas names are corroboration only: road right-of-way fields and planning classifications are not substituted for measured cross-section widths.

## Estimates and representation

When lane counts are absent, defaults are one lane on one-way roads, two total on residential/tertiary/unclassified roads, and two total on primary/secondary roads, avoiding an assumed four-lane rural highway. Directional lane counts refine these defaults. Incompatible explicit counts or widths cause a validation error instead of silently replacing evidence.

Default widths are 10 feet for residential/living-street travel lanes, 11 feet for other travel lanes and shared turn lanes, 8 feet for parallel parking, 16 feet for mapped perpendicular/diagonal parking, 5 feet for sidewalks and bike facilities, and 4 feet for mapped medians and cycle separators. Explicit widths take priority. A mapped overall roadway width can derive otherwise estimated lane widths when the result is plausible.

Sidewalks default to both sides only with explicit `urban=yes` or `rural=no` context. On other roads with rural or unknown context, unmapped sidewalks are omitted, with estimated absence in the drawing and an explicit note that actual presence is unknown. Mapped sidewalk tags always take precedence. Parking, bike facilities, medians, and shoulders require mapped evidence. Mapped shoulders use a schematic striped buffer, with mapped widths where available and an explicitly estimated 3-foot width otherwise; they are never labeled bike lanes. Unmapped shoulders, drainage ditches, clear zones, and adjacent land uses are not invented. Unpaved surfaces generate a warning because Streetmix pavement appearance is schematic. Location labels use Texas and only mapped city names, rather than assuming Dallas. Unsupported facility variants are omitted with warnings; turn movements are shown schematically as travel lanes, except explicit shared center turn lanes. Building boundaries, surface colors, and elevations are schematic. No imagery analysis, AI inference, trees, or street furniture is added without positional evidence.

The result includes `quality` counts for mapped, derived, and estimated decisions, plus unknown details and a plain-language summary. These counts are not a confidence score. The playground displays them, all estimates, and mapped/derived evidence. Supported facility and width decisions record their basis (`mapped`, `derived`, or `estimated`), source, and retrieval time. Retrieval time is not a claim that the underlying map observation is current. A fresh request can still reproduce outdated mapped conditions.

## Requests, retries, and storage

The [OpenAPI source](../src/docs/streetmix.ts) owns the full HTTP contract. The external `/api/streetmix/designs` endpoint retains its API key and production App Check requirements, with optional user identity. The dedicated playground endpoint requires production App Check without an API key; it uses the same feature flag, validation, deadlines, publication budget, and generation service. No new account integration is needed.

```json
{ "latitude": 32.78014, "longitude": -96.79701 }
```

Supply an `Idempotency-Key` with 16–128 letters, digits, hyphens, or underscores. A UUID works. Reuse exactly the same key and coordinates after an interrupted request. The playground's **Retry request** does this even if the inputs have since been edited; **Generate Streetmix design** intentionally starts a new request.

The existing Firestore database stores `streetmix-requests`, `streetmix-quotas`, and `streetmix-location-cache`. Credentials and request keys are hashed before they identify documents. External API reservations are scoped to the API credential, so keep the same credential when retrying. All playground browsers share a separate application namespace and minute quota; their random request keys isolate retries. Logical request expiry is 24 hours. Optional Firestore TTL policies on `expiresAt` clean up old documents; TTL deletion is not required for logical expiry. No SQL migration or separate database is required.

### Shared location cache and simultaneous callers

All applications and playground users share source discovery for one hour and verified designs for 24 hours. Coordinates are rounded to five decimal places (roughly a one-meter cell); the selected OSM way and a `texas-v3` design implementation version also distinguish designs (source discovery retains its separate version). Nearby points in different cells are separate; different selected roads never share a design. Source discovery is shared even when multiple users need to confirm a road. One source refresh after an hour may occur before a 24-hour design is reused. Evidence retains the original source retrieval time.

Firestore transactions grant one worker a 90-second lease. Other replicas wait for that worker within their own 60-second HTTP deadlines. Disconnecting a waiting caller does not cancel the owner. Expired read/build leases may be replaced, but every write checks its attempt identity, preventing a stale owner from publishing. Transient failures before publication can retry; errors are not cached as successful results.

Publication intent and the draft are persisted before creating a street. A record in `publishing` is never automatically taken over, even after lease or cache expiry. Waiters can time out and retry, but no new request key or application can repeat creation for that cached location. `published` records recover through read-back verification only. These unresolved records receive no Firestore TTL field; investigate them manually without blindly clearing the record. Only ready source/design cache records receive an `expiresAt` TTL field; logical expiry works without TTL configuration.

A fresh request key still consumes its application request quota, including cache hits. Replaying a completed request receipt consumes no additional quota. Only the worker actually publishing reserves a global daily publication slot. Cached results include `cache.hit`, original generation time, expiry, and coordinate precision. Legacy receipts remain replayable and can omit the new `cache` and `quality` metadata.

The cache returns the same public Streetmix design link to multiple callers. Remix it into your own account to make a separate proposal. After 24-hour result expiry a fresh generation may publish a new design. Change the cache version when changing cross-section semantics or the Streetmix compatibility fixture; a deployment alone does not invalidate cached snapshots.

Provider reads retry at most once and have bounded time and response size. Creation is never retried. A known publication may remain public even if subsequent verification fails. The API returns success only after verification; provider metadata such as creator IP is never returned.

## Configuration and rollout

```dotenv
STREETMIX_ENABLED=false
STREETMIX_OVERPASS_URL=https://maps.mail.ru/osm/tools/overpass/api/interpreter
STREETMIX_OSM_FALLBACK_ENABLED=false
STREETMIX_APP_REQUESTS_PER_MINUTE=10
STREETMIX_GLOBAL_PUBLICATIONS_PER_DAY=100
```

Application quotas count fresh generation attempts, including failed attempts; the global UTC-day budget reserves slots before publication, including failed or uncertain dispatches. Retry receipts and verification-only requests do not reserve new slots. Quota storage fails closed. The publication cap bounds the service's contribution to Streetmix traffic; public Overpass availability still depends on its operator.

`STREETMIX_OVERPASS_URL` selects the server-managed Overpass interpreter. Use an HTTPS URL ending in `/interpreter`, without URL credentials, query parameters, or fragments. Callers cannot supply an endpoint or Overpass query. Verify a provider returns nonempty Texas ways with geometry before selecting it; some responsive public instances only cover other regions.

When `STREETMIX_OSM_FALLBACK_ENABLED=true`, a failed Overpass request falls back to one small-area main OSM map read. The bounding box extends roughly 150 meters in each direction; response size and time remain bounded, incomplete ways are omitted, and the normal 100-meter selection rule still applies. Results explicitly warn when fallback data was used. Overpass gets one attempt of at most 20 seconds, leaving time for the fallback inside the overall deadline. The fallback is intended for this low-volume pilot, not bulk extraction.

The serialized schema and supported variants are pinned to Streetmix commit `ec096318577dfa6b07fcb8604259d90f8c332e75` in [the compatibility fixture](../src/data/streetmixCompatibility.json). Treat compatibility with the deployed Streetmix site as a launch dependency, not a guarantee from source inspection.

Run the automated checks and a read-only provider check first:

```powershell
node --import tsx --test tests/streetmix.test.ts
npm run build
npm run docs:build
npm run smoke:streetmix
```

The smoke command defaults to public data reads and prints a draft without publication. It supports `--latitude=...`, `--longitude=...`, and `--osm-way-id=...` for an explicit confirmed candidate when publishing. Review representative residential, one-way, arterial, rural, unpaved, and bridge/intersection locations. Confirm that out-of-state points are rejected. Check simultaneous distinct application requests produce one published ID, and that repeat requests report a shared cache hit. For a deliberate live publication test, enable the feature in that process and supply a stable key:

```powershell
$env:STREETMIX_ENABLED = 'true'
npm run smoke:streetmix -- --publish --request-key=streetmix-launch-check-001
```

Publication mode uses the normal service, Firestore reservations, quotas, and read-back verification. Repeat the exact command after an interrupted run. Open the returned link and verify rendering and remixing before enabling production. No deployment is performed by the smoke script.

`streetmix_provider` events report provider duration and success/failure; `streetmix_generation` events report generation duration, estimate counts, error codes, and whether publication started. Monitor upstream errors, uncertain outcomes, and latency after enablement. Keep the feature disabled if the external contract or browser rendering has not been verified.

Map location picking: **Choose location on map** opens the map before generation. A background click updates the coordinate input, moves the red dot, and calls `POST /api/streetmix/playground/candidates`. This preview uses App Check, shared source caching, and application request quotas, and never publishes a design, even when only one road is found. Choose a carriageway and confirm explicitly to publish. Road and numbered-marker clicks select a candidate without moving the input location. Map clicks while a request is loading are ignored, avoiding overlapping requests. Retry preserves whether the interrupted request was a preview or a generation. Empty results leave the map available to choose another spot.

## Divided roads and medians

A selected one-way road is paired only with a public same-name or same-reference road of the same highway class and grade. Traffic must oppose within 20 degrees, have local parallel overlap, and be 4–45 meters apart with opposing traffic on the expected side for Texas. Roundabouts, grade-separated roads, same-direction parallels, neighboring-block endpoints, and ambiguous near-ties are not joined. Missing or uncertain counterparts produce a carriageway-only warning.

For a clear pair, each side retains its own lane count, lane widths, parking, shoulders and bicycle tags. The opposing cross-section is reflected into the selected way's viewing direction, including asymmetric lane widths and directional variants. Median-side sidewalks are suppressed as a derived drawing decision so the two outer sidewalks are not duplicated through the median. One shared median replaces individual median tags. Its width uses consistent mapped `median:width` values if available, otherwise centerline separation minus the two modeled carriageway half-widths; this estimate is not a surveyed measurement. Inferred widths below 0.5 meters or above 30 meters, contradictory mapped widths, and combined cross-sections above 100 meters or 64 segments are rejected for review.

The result's `dividedRoad` metadata names the other way and median width/basis; `selectedStreet.carriagewayOnly` is false for a combined design. The playground marks a matched counterpart in purple and states whether both carriageways were included. Median material, height, landscaping, and pedestrian facilities remain unknown. Start a new Generate request to obtain the new combined design; existing public Streetmix links and same-key legacy receipts remain unchanged.

After successful generation or a cached replay, the playground automatically loads the verified Streetmix URL in an interactive iframe and scrolls to the result. **Open in Streetmix** remains available for the full site. The iframe only receives the validated public design URL; application credentials are not forwarded. It is reset to a blank page on a new lookup, failed generation, or road-selection prompt so a stale design cannot be mistaken for the current result. The preview does not make another generation request.
