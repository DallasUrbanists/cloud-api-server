const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object) => ({ 'application/json': { schema } });
const idParameter = { name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1, maximum: 2147483647 } };
const errors = Object.fromEntries(Object.entries({ 400: 'Invalid query or ID.', 404: 'Resource not found.', 409: 'A forced sync conflicts with an active job.', 429: 'Distributed sync budget exhausted; Retry-After is provided.', 500: 'Internal failure; no internal error details are returned.', 502: 'External source or synchronous shape sync failed.', 503: 'Sync is disabled, an adapter is invalid, or a required provider is not configured.' }).map(([code, description]) => [code, { description }]));
export const boundarySearchParameters = [
  ...['entity', 'body', 'district', 'city', 'county', 'state', 'zip'].map(name => ({ name, in: 'query', required: false, schema: { type: 'string' } })),
  { name: 'lat', in: 'query', required: false, description: 'Supply with lon. Address is ignored when coordinates are supplied.', schema: { type: 'number', minimum: -90, maximum: 90 } },
  { name: 'lon', in: 'query', required: false, description: 'Supply with lat.', schema: { type: 'number', minimum: -180, maximum: 180 } },
  { name: 'address', in: 'query', required: false, description: 'Geocode an address and derive city/county/state/ZIP. Requires GOOGLE_MAPS_API_KEY.', schema: { type: 'string' } },
  { name: 'asOf', in: 'query', required: false, description: 'Boundary effective-date filter; defaults to today in America/Chicago. Expiration is exclusive.', schema: { type: 'string', format: 'date' } },
  { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 } },
  { name: 'offset', in: 'query', required: false, schema: { type: 'integer', minimum: 0, maximum: 100000, default: 0 } },
];
function tickOperation(target: 'Boundary' | 'Representative', specific: boolean, force = false) {
  return {
    tags: ['Boundary synchronization'], summary: `${force ? 'Force' : 'Request due'} ${target.toLowerCase()} synchronization`,
    description: 'Public GETs need no API key or user authentication. Due research is durably queued for the worker; short shape-only requests may complete synchronously. TTL is measured from successful sync, never from a failed invocation. Requests for the same busy target reuse its job; a different target in that boundary returns its current model instead. Forced POSTs return 409 instead of overlapping. Null service descriptors are skipped. GETs do not force fresh work. Force POSTs require an API key, canonical staff:true Firebase token, and production App Check. HEAD and prefetch cannot trigger sync. Responses are no-store.',
    security: force ? [{ ApiKeyAuth: [], BearerAuth: [], AppCheckAuth: [] }] : [],
    parameters: specific ? [idParameter] : [],
    responses: {
      200: { description: specific ? 'Current model; a null service or unexpired TTL may result in no work.' : 'Updated model after successful synchronous sync, or syncCount: 0 when no eligible idle record exists.', content: json(specific ? ref(target) : { oneOf: [ref(target), ref('SyncEmpty')] }) },
      202: { description: 'Durable work accepted; poll Location/statusUrl. The worker must be deployed separately.', headers: { Location: { schema: { type: 'string' } }, 'Retry-After': { schema: { type: 'integer', example: 5 } } }, content: json(ref('SyncAccepted')) },
      ...errors,
      ...(force ? { 401: { description: 'Invalid API key, user token, or production App Check.' }, 403: { description: 'Caller lacks the canonical staff claim.' } } : {}),
    },
  };
}
export const boundaryPaths = {
  '/api/boundaries': { get: { tags: ['Boundaries'], summary: 'Search effective boundaries', security: [], parameters: boundarySearchParameters,
    description: 'Entity/body/district use case-insensitive exact matching. Location arrays shortlist shapes; coordinate/address queries perform exact Polygon/MultiPolygon membership. For address-only (null-shape) boundaries, match any item within each populated array and all populated arrays together; missing values cannot prove membership. Empty arrays are unrestricted, but a null-shape boundary with no rules cannot establish membership. Geometry awaiting discovery is shapePending and never an address-only match. Coordinate-only requests cannot prove state-only membership without supplied state metadata.',
    responses: { 200: { description: 'Matching boundaries, paginated after spatial filtering.', content: json({ type: 'array', items: ref('Boundary') }) }, ...errors } } },
  '/api/boundary/{id}': { get: { tags: ['Boundaries'], summary: 'Get a boundary including its derived current isInEffect state', security: [], parameters: [idParameter], responses: { 200: { description: 'Boundary, including expired/future records.', content: json(ref('Boundary')) }, ...errors } } },
  '/api/tick/boundaries/shape': { get: tickOperation('Boundary', false) },
  '/api/tick/boundaries/research': { get: tickOperation('Boundary', false) },
  '/api/tick/boundary/{id}': { get: tickOperation('Boundary', true), post: tickOperation('Boundary', true, true) },
  '/api/tick/representatives': { get: tickOperation('Representative', false) },
  '/api/tick/representative/{id}': { get: tickOperation('Representative', true), post: tickOperation('Representative', true, true) },
  '/api/tick/jobs/{id}': { get: { tags: ['Boundary synchronization'], summary: 'Poll a durable sync job', security: [], parameters: [{ ...idParameter, schema: { type: 'string', pattern: '^[1-9][0-9]{0,18}$', description: 'PostgreSQL bigint ID, serialized as a string.' } }], responses: { 200: { description: 'Job status; succeeded jobs also include the current target model. Failed jobs expose only a sanitized error code.', content: json(ref('SyncJob')) }, ...errors } } },
};
const position = { type: 'array', minItems: 2, items: { type: 'number' } };
const ring = { type: 'array', minItems: 4, items: position };
const polygonCoordinates = { type: 'array', minItems: 1, items: ring };
export const boundarySchemas = {
  ServiceDescriptor: { type: 'object', nullable: true, additionalProperties: false, required: ['file', 'function', 'params'], properties: {
    file: { type: 'string', description: 'Approved compiled adapter basename; arbitrary imports are prohibited.' }, function: { type: 'string' }, params: { type: 'object', additionalProperties: true, description: 'Adapter configuration, never credentials.' },
  } },
  Boundary: { type: 'object', required: ['id', 'entityName', 'bodyName', 'districtName', 'shape', 'shapePending', 'cities', 'counties', 'states', 'zips', 'description', 'whenToContact', 'shapeService', 'researchService', 'effectiveDate', 'expirationDate', 'lastShapeSync', 'lastResearchSync', 'shapeSyncTTL', 'researchSyncTTL', 'isInEffect'], properties: {
    id: { type: 'integer' }, entityName: { type: 'string' }, bodyName: { type: 'string', nullable: true }, districtName: { type: 'string', nullable: true },
    shape: { oneOf: [
      { type: 'object', nullable: true, required: ['type', 'coordinates'], properties: { type: { type: 'string', enum: ['Polygon'] }, coordinates: polygonCoordinates } },
      { type: 'object', required: ['type', 'coordinates'], properties: { type: { type: 'string', enum: ['MultiPolygon'] }, coordinates: { type: 'array', minItems: 1, items: polygonCoordinates } } },
    ], description: 'WGS84 GeoJSON: coordinates are longitude, latitude. Null means administrative membership unless shapePending is true.' },
    shapePending: { type: 'boolean', description: 'Geometry is unknown, not intentionally address-only.' },
    ...Object.fromEntries(['cities', 'counties', 'zips', 'states'].map(name => [name, { type: 'array', items: { type: 'string' } }])),
    description: { type: 'string' }, whenToContact: { type: 'string' }, shapeService: ref('ServiceDescriptor'), researchService: ref('ServiceDescriptor'),
    effectiveDate: { type: 'string', format: 'date', nullable: true }, expirationDate: { type: 'string', format: 'date', nullable: true },
    lastShapeSync: { type: 'string', format: 'date-time', nullable: true, description: 'Most recent invocation, including failed attempts.' }, lastResearchSync: { type: 'string', format: 'date-time', nullable: true },
    shapeSyncTTL: { type: 'integer', minimum: 1, default: 365 }, researchSyncTTL: { type: 'integer', minimum: 1, default: 60 }, isInEffect: { type: 'boolean' },
  } },
  SyncEmpty: { type: 'object', required: ['syncCount'], properties: { syncCount: { type: 'integer', enum: [0] } } },
  SyncAccepted: { type: 'object', required: ['jobId', 'status', 'statusUrl'], properties: { jobId: { type: 'string' }, status: { type: 'string', enum: ['queued', 'running'] }, statusUrl: { type: 'string' } } },
  SyncJob: { type: 'object', required: ['jobId', 'targetType', 'targetId', 'status'], properties: {
    jobId: { type: 'string' }, targetType: { type: 'string', enum: ['boundary', 'representative'] }, targetId: { type: 'integer' }, status: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed'] },
    createdAt: { type: 'string', format: 'date-time' }, completedAt: { type: 'string', format: 'date-time', nullable: true }, errorCode: { type: 'string', nullable: true }, result: { oneOf: [ref('Boundary'), ref('Representative')] },
  } },
};
