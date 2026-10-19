/**
 * OpenAPI contract for the coordinate-to-Streetmix API and public testing page.
 * @module
 */

const evidence = { type: 'object', required: ['field', 'value', 'basis', 'source', 'retrievedAt'], properties: {
  field: { type: 'string' }, value: { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
  basis: { type: 'string', enum: ['mapped', 'derived', 'estimated'] }, source: { type: 'string' }, retrievedAt: { type: 'string', format: 'date-time' },
} };
const coordinate = { type: 'object', required: ['latitude', 'longitude'], additionalProperties: false, properties: {
  latitude: { type: 'number', minimum: -90, maximum: 90, example: 32.78014 }, longitude: { type: 'number', minimum: -180, maximum: 180, example: -96.79701 },
} };
const candidate = { type: 'object', required: ['osmWayId', 'name', 'highway', 'distanceMeters', 'bearingDegrees', 'layer', 'bridge', 'tunnel', 'osmUrl', 'geometry', 'snappedCoordinate'], properties: { osmWayId: { type: 'integer' }, name: { type: 'string' }, highway: { type: 'string' }, distanceMeters: { type: 'number' }, bearingDegrees: { type: 'number' }, layer: { type: 'string' }, bridge: { type: 'boolean' }, tunnel: { type: 'boolean' }, osmUrl: { type: 'string', format: 'uri' }, oppositeOsmWayId: { type: 'integer', description: 'A conservatively matched opposing carriageway; both sides will be modeled if width checks pass.' }, geometry: { type: 'array', description: 'OSM way segments clipped to a 250-meter square around the request; each segment preserves mapped way direction.', items: { type: 'array', items: coordinate } }, snappedCoordinate: coordinate } };
const error = { description: 'Safe generation error.', content: { 'application/json': { schema: { type: 'object', required: ['error', 'message'], properties: { error: { type: 'string' }, message: { type: 'string' }, candidates: { type: 'array', items: candidate, description: 'Present for STREET_SELECTION_REQUIRED. No design has been published for that response.' } } } } } };

/** Dedicated schemas keep generated Streetmix data separate from evidence metadata. */
export const streetmixSchemas = {
  StreetmixCoordinates: coordinate,
  StreetmixRequest: { ...coordinate, properties: { ...coordinate.properties, osmWayId: { type: 'integer', minimum: 1, description: 'Optional explicit road confirmation, selected from STREET_SELECTION_REQUIRED candidates.' } } },
  StreetmixEvidence: evidence,
  StreetmixDesign: { type: 'object', required: ['street', 'plugins'], properties: {
    plugins: { type: 'object' }, street: { type: 'object', required: ['name', 'schemaVersion', 'units', 'width', 'segments', 'location'], properties: {
      name: { type: 'string' }, schemaVersion: { type: 'integer', enum: [35] }, units: { type: 'integer', enum: [1], description: 'Imperial display; stored widths are meters.' }, width: { type: 'number', description: 'Total cross-section width in meters, including sidewalks.' },
      segments: { type: 'array', items: { type: 'object', required: ['id', 'type', 'variantString', 'width', 'elevation', 'slope'], properties: {
        id: { type: 'string' }, type: { type: 'string' }, variantString: { type: 'string' }, width: { type: 'number' }, elevation: { type: 'number' }, slope: { type: 'object', properties: { on: { type: 'boolean' }, values: { type: 'array', items: { type: 'number' } } } },
      } } }, location: { type: 'object', properties: { latlng: { type: 'object', properties: { lat: { type: 'number' }, lng: { type: 'number' } } }, label: { type: 'string' }, hierarchy: { type: 'object', additionalProperties: { type: 'string' } } } },
    } },
  } },
  StreetmixResult: { type: 'object', required: ['streetmixUrl', 'streetmixId', 'design', 'selectedStreet', 'snappedCoordinate', 'viewingDirection', 'evidence', 'estimates', 'warnings', 'generatedAt'], properties: {
    streetmixUrl: { type: 'string', format: 'uri' }, streetmixId: { type: 'string', format: 'uuid' }, design: { $ref: '#/components/schemas/StreetmixDesign' },
    selectedStreet: { type: 'object', required: ['osmWayId', 'name', 'highway', 'distanceMeters', 'carriagewayOnly'], properties: { osmWayId: { type: 'integer' }, name: { type: 'string' }, highway: { type: 'string' }, distanceMeters: { type: 'number' }, carriagewayOnly: { type: 'boolean' }, dallasStreetName: { type: 'string' } } },
    snappedCoordinate: { $ref: '#/components/schemas/StreetmixCoordinates' }, viewingDirection: { type: 'object', required: ['bearingDegrees', 'description'], properties: { bearingDegrees: { type: 'number' }, description: { type: 'string' } } },
    evidence: { type: 'array', items: { $ref: '#/components/schemas/StreetmixEvidence' } }, estimates: { type: 'array', items: { $ref: '#/components/schemas/StreetmixEvidence' } }, warnings: { type: 'array', items: { type: 'string' } }, generatedAt: { type: 'string', format: 'date-time' },
    dividedRoad: { type: 'object', description: 'Present when both opposing carriageways are represented. Optional on single-carriageway and legacy receipts.', properties: { oppositeOsmWayId: { type: 'integer' }, medianWidthMeters: { type: 'number' }, medianWidthBasis: { type: 'string', enum: ['mapped', 'estimated'] }, centerlineSeparationMeters: { type: 'number' } } },
    quality: { type: 'object', description: 'Counts classify decisions, not a numerical confidence score. Optional on legacy receipts.', properties: { mappedCount: { type: 'integer' }, derivedCount: { type: 'integer' }, estimatedCount: { type: 'integer' }, unknownDetails: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' } } },
    cache: { type: 'object', description: 'Shared design snapshot metadata; optional on legacy receipts. Results are shared across applications.', properties: { hit: { type: 'boolean' }, generatedAt: { type: 'string', format: 'date-time' }, expiresAt: { type: 'string', format: 'date-time' }, coordinatePrecision: { type: 'integer', enum: [5] } } },
  } },
};

/** Runtime authentication is required for generation even though the playground page is public. */
export const streetmixPaths = {
  '/api/streetmix/designs': { post: {
    tags: ['Streetmix'], summary: 'Reconstruct and publish an approximate existing Texas road or street',
    description: 'Creates a public anonymous street that callers can open and remix. Requires API key and production App Check; user authentication is optional. Disabled unless STREETMIX_ENABLED=true. Completes within a bounded 60-second request. Estimates and provider conflicts are explicit. Texas membership is checked against the Census state polygon. Nearest eligible road within 100 meters is used only when unambiguous and at grade; otherwise STREET_SELECTION_REQUIRED returns candidates for explicit osmWayId confirmation. Shared source data lasts one hour and verified designs last 24 hours, keyed by coordinates rounded to five decimals, selected OSM way, matched opposing way, and cache version. Divided-road pairing requires same road identity/class, same grade, opposing traffic, local overlap, and 4–45 m separation. A clear pair produces both directions and one median; uncertain pairs remain explicitly carriageway-only. Median width is mapped when available or estimated from centerline spacing minus modeled carriageway half-widths. Conflicting or implausible widths return 422. Concurrent callers share work across replicas. Same-key retries replay completed results or verify a known publication without recreating it. Keys are scoped to the application credential and retained for 24 hours. Never automatically start a new request key after PUBLICATION_UNCERTAIN.',
    security: [{ ApiKeyAuth: [] }], parameters: [
      { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{16,128}$' }, description: 'Reuse exactly for retries of the same coordinates.' },
      { name: 'X-Firebase-AppCheck', in: 'header', required: false, schema: { type: 'string' }, description: 'Required in production.' },
    ], requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/StreetmixRequest' } } } },
    responses: {
      '201': { description: 'Verified public design, or the original same-key receipt.', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreetmixResult' } } } },
      '400': { ...error, description: 'Invalid coordinates, JSON, or request key.' }, '401': { ...error, description: 'Application access verification failed.' }, '409': { ...error, description: 'Street selection required (with candidates), conflicting request key, active reservation, or expired attempt. Confirm a candidate with osmWayId and a new idempotency key.' },
      '413': { ...error, description: 'Body exceeds 64 KiB.' }, '415': { ...error, description: 'application/json required.' }, '422': { ...error, description: 'Outside Texas, no suitable street, invalid road selection, or inconsistent mapped data.' },
      '429': { ...error, description: 'Application minute or global UTC-day quota exceeded.', headers: { 'Retry-After': { schema: { type: 'integer' }, description: 'Seconds until the quota window resets.' } } },
      '502': { ...error, description: 'Provider failure, uncertain publication, or failed read-back. Retry with the same key.' }, '503': { ...error, description: 'Feature disabled, storage unavailable, or generation unavailable.' }, '504': { ...error, description: 'Generation deadline exceeded. Retry with the same key.' },
    },
  } },
  '/api/streetmix/playground/designs': { post: {
    tags: ['Streetmix'], summary: 'Generate a design from the credential-free playground',
    description: 'Requires Firebase App Check in production, obtained automatically by the playground. No API key or user token is required. Uses a shared playground minute quota and separate retry namespace, plus the same shared location cache, road confirmation, global publication budget, feature flag, validation, 60-second deadline, and result contract as /api/streetmix/designs.',
    security: [], parameters: [
      { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{16,128}$' } },
      { name: 'X-Firebase-AppCheck', in: 'header', required: false, schema: { type: 'string' }, description: 'Required in production.' },
    ],
    requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/StreetmixRequest' } } } },
    responses: { '201': { description: 'Verified design or original same-key receipt.', content: { 'application/json': { schema: { $ref: '#/components/schemas/StreetmixResult' } } } },
      '400': error, '401': { ...error, description: 'Missing or invalid App Check token.' }, '409': error, '413': error, '415': error, '422': error, '429': error, '502': error, '503': error, '504': error },
  } },
  '/api/streetmix/playground/candidates': { post: {
    tags: ['Streetmix'], summary: 'Preview nearby roads without publishing a design', security: [],
    description: 'Read-only map-click discovery. Requires production App Check and an Idempotency-Key, uses the shared location source cache and application quota, and never reserves publication budget or creates a Streetmix design. Returns an empty candidate array when no supported road is nearby.',
    parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{16,128}$' } }, { name: 'X-Firebase-AppCheck', in: 'header', required: false, schema: { type: 'string' }, description: 'Required in production.' }],
    requestBody: { required: true, content: { 'application/json': { schema: coordinate } } },
    responses: { '200': { description: 'Road choices for the coordinate; no design has been published.', content: { 'application/json': { schema: { type: 'object', properties: { coordinate, candidates: { type: 'array', items: candidate } } } } } }, '400': error, '401': error, '413': error, '415': error, '422': error, '429': error, '502': error, '503': error, '504': error },
  } },
  '/playground/streetmix': { get: { tags: ['Streetmix'], summary: 'Open the Streetmix testing form', security: [], responses: { '200': { description: 'Public HTML page with automatic Firebase App Check. No credentials need to be entered.', content: { 'text/html': { schema: { type: 'string' } } } } } } },
};
