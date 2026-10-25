/** Idea-linked Streetmix wire contracts shared by both idea route aliases. @module */
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object) => ({ 'application/json': { schema } });
const point = { type: 'object', required: ['latitude', 'longitude'], properties: { latitude: { type: 'number' }, longitude: { type: 'number' } } };

/** Permanent attachment and recoverable workflow response schemas. */
export const ideaStreetmixSchemas = {
  IdeaStreetmix: { type: 'object', nullable: true, description: 'Server-managed current attachment. Legacy ideas return null. Readable without user sign-in; application access is required.', required: ['streetmixId', 'streetmixUrl', 'selectedStreet', 'coordinate', 'snappedCoordinate', 'generatedAt', 'savedAt', 'requestId', 'revision', 'stale'], properties: {
    streetmixId: { type: 'string' }, streetmixUrl: { type: 'string', format: 'uri', description: 'HTTPS Streetmix editor URL. Never append API credentials.' }, selectedStreet: { type: 'object' }, coordinate: point, snappedCoordinate: point,
    dividedRoad: { type: 'object' }, generatedAt: { type: 'string', format: 'date-time' }, savedAt: { type: 'string', format: 'date-time' }, requestId: { type: 'string', format: 'uuid' }, revision: { type: 'integer', minimum: 1 }, stale: { type: 'boolean', description: 'Saved coordinates differ from the current idea location.' },
  } },
  IdeaStreetmixWorkflow: { type: 'object', required: ['requestId', 'status', 'statusUrl'], properties: {
    requestId: { type: 'string', format: 'uuid' }, status: { type: 'string', enum: ['generating', 'publishing', 'awaiting_selection', 'save_pending', 'completed', 'failed', 'publication_uncertain', 'expired'] }, statusUrl: { type: 'string' },
    coordinate: point, candidates: { type: 'array', items: ref('StreetmixCandidate') }, selectionExpiresAt: { type: 'string', format: 'date-time' }, streetmix: ref('IdeaStreetmix'), result: ref('StreetmixResult'), error: { type: 'string' }, message: { type: 'string' },
  } },
};
const id = { name: 'ideaId', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } };
const requestId = { name: 'requestId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const appCheck = { name: 'X-Firebase-AppCheck', in: 'header', required: false, schema: { type: 'string' }, description: 'Required in production.' };
const key = { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{16,128}$' }, description: 'Scoped to application, idea, and phase. Reuse the key and body on retry; confirmation uses its own key.' };
const etag = { ETag: { schema: { type: 'string' }, description: 'Current attachment revision; use as If-Match for regeneration.' } };
const errors = Object.fromEntries(Object.entries({ 400: 'Invalid identifier, body, or idempotency key.', 401: 'Invalid application access, or missing regeneration user authentication.', 403: 'Replacement requires signed-in author or canonical staff.', 404: 'Idea or request not found; transient receipts expire after 24 hours.', 409: 'STREET_SELECTION_REQUIRED includes candidates and request ID; also selection expiry/conflict, changed idea, deletion, or idempotency conflict.', 412: 'Attachment ETag is outdated.', 415: 'application/json required.', 422: 'Invalid coordinates, outside Texas, unsupported road, or invalid selection.', 428: 'Regeneration requires If-Match.', 429: 'Application or publication quota exceeded.', 502: 'Provider error or publication uncertainty; retry the same operation, never start another publication.', 503: 'Storage/provider unavailable or feature disabled.', 504: 'Deadline exceeded; recover using request ID or the same POST key.' }).map(([status, description]) => [status, { description, content: json({ type: 'object', properties: { ...ideaStreetmixSchemas.IdeaStreetmixWorkflow.properties } }) }]));
const common = { tags: ['Streetmix'], security: [{ ApiKeyAuth: [] }] };
function post(summary: string, description: string, selection = false, regenerate = false) {
  return { ...common, summary, description, parameters: [id, ...(selection ? [requestId] : []), appCheck, key,
    ...(regenerate ? [{ name: 'If-Match', in: 'header', required: true, schema: { type: 'string' } }, { name: 'Authorization', in: 'header', required: true, schema: { type: 'string' }, description: 'Bearer Firebase ID token for the current author or staff.' }] : [{ name: 'Authorization', in: 'header', required: false, schema: { type: 'string' }, description: 'Required when confirming a regeneration request; optional for first generation.' }])],
    requestBody: { required: true, content: json({ type: 'object', additionalProperties: false, ...(selection ? { required: ['osmWayId'], properties: { osmWayId: { type: 'integer', minimum: 1 } } } : { properties: {} }) }) },
    responses: { ...errors, '200': { description: 'Saved current attachment or same-key completion receipt.', headers: etag, content: json(ref('IdeaStreetmixWorkflow')) }, '201': { description: 'First attachment generated, verified, and automatically saved.', headers: etag, content: json(ref('IdeaStreetmixWorkflow')) }, '202': { description: 'Active workflow or save_pending. Read statusUrl; retry the original POST to recover. Reads do not execute work.', headers: { 'Retry-After': { schema: { type: 'integer' } } }, content: json(ref('IdeaStreetmixWorkflow')) } },
  };
}
const paths = {
  '/streetmix/thumbnail': {
    get: { ...common, summary: 'Read the saved design PNG thumbnail', description: 'Relays Streetmix’s thumbnail API because it disallows cross-origin image hotlinking. Uses only the currently saved street UUID. Requires application access, without user sign-in; never forwards application credentials upstream. Does not publish or regenerate designs.', parameters: [id, appCheck], responses: {
      '200': { description: 'PNG image, up to 5 MiB. Cache-Control: no-store.', content: { 'image/png': { schema: { type: 'string', format: 'binary' } } } },
      '401': errors['401'], '404': { description: 'Idea, attachment, or stored thumbnail unavailable.' }, '503': { description: 'Thumbnail provider unavailable or returned an invalid PNG.' },
    } },
  },
  '/streetmix': {
    get: { ...common, summary: 'Read the permanent current Streetmix attachment', parameters: [id, appCheck], responses: { '200': { description: 'Saved result or null, plus active workflow if present. No user sign-in required.', headers: etag, content: json({ type: 'object', required: ['streetmix', 'result', 'activeRequest'], properties: { streetmix: ref('IdeaStreetmix'), result: { allOf: [ref('StreetmixResult')], nullable: true }, activeRequest: { allOf: [ref('IdeaStreetmixWorkflow')], nullable: true } } }) }, '401': errors['401'], '404': errors['404'], '409': errors['409'], '503': errors['503'] } },
    post: post('Generate and save the first idea Streetmix attachment', 'Uses only stored idea coordinates. Anyone with application access can generate the first design. An existing attachment is returned without regenerating. Ambiguity requires explicit selection. Concurrent callers join one workflow. Initial generation uses shared location caching. Writes finish within a 60-second request; recovery uses fenced 90-second leases. No worker is started.'),
  },
  '/streetmix/regenerate': { post: post('Regenerate and replace the current attachment', 'Requires existing attachment, current ETag, and signed-in author or staff. Fetches fresh sources and publishes one new design using a server-created refresh scope stable across retries. Existing attachment stays readable. A consumed ETag may replay its completed same-key receipt.', false, true) },
  '/streetmix/requests/{requestId}/selection': { post: post('Confirm an offered road and automatically save the design', 'Confirm only a candidate offered by this request within 15 minutes. Server revalidates road eligibility from source data. Initial requests need no user sign-in; regeneration requires current author/staff. Result includes both carriageways when conservatively paired.', true) },
  '/streetmix/requests/{requestId}': { get: { ...common, summary: 'Read request progress without triggering generation', parameters: [id, requestId, appCheck], responses: { '200': { description: 'Workflow state, candidates, verified result, or safe failure. Completed receipts retained 24 hours; unresolved publications never automatically expire.', content: json(ref('IdeaStreetmixWorkflow')) }, '401': errors['401'], '404': errors['404'], '503': errors['503'] } } },
};

/** Both aliases mount the same controller and authorization policies. */
export const ideaStreetmixPaths = Object.fromEntries(['/api/ideas', '/api/public-improvements/ideas'].flatMap(prefix => Object.entries(paths).map(([suffix, definition]) => [`${prefix}/{ideaId}${suffix}`, definition])));
