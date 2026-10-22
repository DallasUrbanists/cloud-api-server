/** OpenAPI definitions for the accountless TV presentation protocol. */
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object) => ({ 'application/json': { schema } });
const capabilityHeaders = [
  { name: 'Authorization', in: 'header', required: true, schema: { type: 'string', example: 'Bearer <participantToken>' }, description: '32-byte random base64url presentation participant token. This is not a Firebase token.' },
  { name: 'X-Presentation-Participant', in: 'header', required: true, schema: { type: 'string', format: 'uuid' } },
];
const sessionId = { name: 'sessionId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } };
const ideaId = { name: 'ideaId', in: 'path', required: true, schema: { type: 'string', pattern: '^[1-9][0-9]*$' } };
const idem = { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Generate once per request and reuse with the same complete JSON body after an uncertain response.' };
const capabilities = { tags: ['Presentation'], security: [], parameters: capabilityHeaders };
const errors = Object.fromEntries(['401', '403', '404', '409', '410', '422', '426', '429', '503'].map(status => [status, {
  description: ({
    '401': 'Invalid or revoked participant capability.', '403': 'This participant role cannot perform the action.',
    '404': 'Presentation feature disabled or selected public idea unavailable.', '409': 'Revision, pairing claim, or idempotency conflict; REVISION_CONFLICT includes the current envelope.',
    '410': 'Pairing code or session expired, or session ended.', '422': 'Invalid request fields or state.',
    '426': 'Protocol version is unsupported.', '429': 'Admission rate limit reached; includes Retry-After.',
    '503': 'Presentation persistence or provider unavailable.',
  } as Record<string, string>)[status], headers: ['429', '503'].includes(status) ? { 'Retry-After': { schema: { type: 'integer', minimum: 1 } } } : undefined,
  content: json(ref('PresentationError')),
}]));
const enrollment = {
  type: 'object', additionalProperties: false,
  required: ['protocolVersion', 'participantId', 'participantToken'],
  properties: {
    protocolVersion: { type: 'integer', enum: [1] }, participantId: { type: 'string', format: 'uuid' },
    participantToken: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$', description: 'Client-generated, 32-byte base64url secret. Stored by the API only as a SHA-256 digest.' },
    code: { type: 'string', pattern: '^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ -]{8,10}$', description: 'Eight characters; spaces and one optional hyphen are ignored.' },
  },
};
const state = {
  type: 'object', additionalProperties: false,
  required: ['selectedIdeaId', 'mode', 'camera', 'mapStyle', 'railVisible', 'theme', 'albumItemId', 'photoFrame', 'captionVisible', 'descriptionPage', 'audienceDisplay'],
  properties: {
    selectedIdeaId: { type: 'string', nullable: true, pattern: '^[1-9][0-9]*$' }, mode: { type: 'string', enum: ['map', 'photo', 'description'] },
    camera: { type: 'object', additionalProperties: false, required: ['latitude', 'longitude', 'zoom'], properties: { latitude: { type: 'number', minimum: -85.05112878, maximum: 85.05112878 }, longitude: { type: 'number', minimum: -180, maximum: 180 }, zoom: { type: 'number', minimum: 1, maximum: 20 } } },
    mapStyle: { type: 'string', enum: ['streets', 'satellite'] }, railVisible: { type: 'boolean' }, theme: { type: 'string', enum: ['light', 'dark'] },
    albumItemId: { type: 'string', nullable: true }, photoFrame: { type: 'object', additionalProperties: false, required: ['scale', 'centerX', 'centerY'], properties: { scale: { type: 'number', minimum: 1, maximum: 4 }, centerX: { type: 'number', minimum: 0, maximum: 1 }, centerY: { type: 'number', minimum: 0, maximum: 1 } } },
    captionVisible: { type: 'boolean' }, descriptionPage: { type: 'integer', minimum: 0 }, audienceDisplay: { type: 'object', additionalProperties: false, required: ['showQr', 'showCode'], properties: { showQr: { type: 'boolean' }, showCode: { type: 'boolean' } } },
    iconStyle: { type: 'object', additionalProperties: false, required: ['size', 'animationEnabled', 'pulseSize', 'pulseSpeed', 'bobbingRotation', 'bobbingSpeed'], properties: { size: { type: 'number', minimum: 50, maximum: 400 }, animationEnabled: { type: 'boolean' }, pulseSize: { type: 'number', minimum: 1, maximum: 3 }, pulseSpeed: { type: 'number', minimum: 0.5, maximum: 3 }, bobbingRotation: { type: 'number', minimum: 0, maximum: 90 }, bobbingSpeed: { type: 'number', minimum: 0.5, maximum: 3 }, animationEasing: { type: 'string', enum: ['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out'] } } },
  },
};
const response = (description: string, schema: object, contentType = 'application/json') => ({ description: `${description} Cache-Control: no-store.`, content: { [contentType]: { schema } } });
const bootstrapPost = (summary: string, requestSchema: object, success: object, extraParameters: any[] = []) => ({
  tags: ['Presentation'], security: [], summary,
  description: 'Accountless bootstrap. Requires protocolVersion 1, a client-generated UUID participantId, a client-generated 32-byte participantToken, and a UUID Idempotency-Key. Reuse the same request on retry. No Firebase sign-in or API key is used.',
  parameters: [idem, ...extraParameters], requestBody: { required: true, content: json(requestSchema) },
  responses: { ...errors, '200': response('Enrollment replay or success.', success), '201': response('New receiver session.', success), '422': errors['422'], '426': errors['426'] },
});

export const presentationSchemas = {
  PresentationError: { type: 'object', required: ['error', 'message'], properties: { error: { type: 'string' }, message: { type: 'string' }, current: { type: 'object', description: 'Current canonical sync envelope on REVISION_CONFLICT.' } } },
  PresentationState: state,
  PresentationAlbumItem: { oneOf: [
    { type: 'object', required: ['id', 'kind', 'url', 'caption'], properties: { id: { type: 'string' }, kind: { type: 'string', enum: ['photo'] }, url: { type: 'string', format: 'uri' }, caption: { type: 'string' } } },
    { type: 'object', required: ['id', 'kind', 'url', 'streetmixId', 'thumbnailPath', 'stale'], properties: { id: { type: 'string' }, kind: { type: 'string', enum: ['streetmix'] }, url: { type: 'string', pattern: '^https://streetmix\\.net/-/[0-9]+$' }, streetmixId: { type: 'string' }, thumbnailPath: { type: 'string' }, stale: { type: 'boolean' } } },
  ] },
  PresentationIdea: { type: 'object', required: ['id', 'contentVersion', 'creationDate', 'status', 'summary', 'details', 'descriptionPages', 'location', 'album'], properties: {
    id: { type: 'string', pattern: '^[1-9][0-9]*$' }, contentVersion: { type: 'string' }, creationDate: { type: 'string', format: 'date-time' }, status: { type: 'string' }, summary: { type: 'string' }, details: { type: 'string' }, authorName: { type: 'string', description: 'Public author display name, when provided.' }, descriptionPages: { type: 'array', items: { type: 'string' }, description: 'Canonical pages of at most 320 Unicode code points.' },
    location: { type: 'object', required: ['latitude', 'longitude', 'address', 'description'], properties: { latitude: { type: 'number', nullable: true }, longitude: { type: 'number', nullable: true }, address: { type: 'string' }, description: { type: 'string' } } }, emoji: { type: 'string' }, album: { type: 'array', items: ref('PresentationAlbumItem') },
  } },
  PresentationEnrollment: { type: 'object', required: ['protocolVersion', 'sessionId', 'participantId', 'role', 'expiresAt', 'state'], properties: {
    protocolVersion: { type: 'integer', enum: [1] }, sessionId: { type: 'string', format: 'uuid' }, participantId: { type: 'string', format: 'uuid' }, role: { type: 'string', enum: ['receiver', 'controller', 'audience'] }, displayName: { type: 'string' }, expiresAt: { type: 'string', format: 'date-time' }, state: ref('PresentationState'), presenterCode: { type: 'string' }, presenterCodeExpiresAt: { type: 'string', format: 'date-time' }, audienceCode: { type: 'string' }, content: { allOf: [ref('PresentationIdea')], nullable: true },
  } },
  PresentationSync: { type: 'object', required: ['protocolVersion', 'serverTime', 'session', 'changed', 'state', 'content', 'participants', 'receiver'], properties: {
    protocolVersion: { type: 'integer', enum: [1] }, serverTime: { type: 'string', format: 'date-time' }, session: { type: 'object', properties: { id: { type: 'string', format: 'uuid' }, status: { type: 'string', enum: ['waiting', 'active', 'ended', 'expired'] }, expiresAt: { type: 'string', format: 'date-time' }, revision: { type: 'integer' } } }, changed: { type: 'boolean' }, state: { allOf: [ref('PresentationState')], nullable: true }, content: { allOf: [ref('PresentationIdea')], nullable: true },
    participants: { type: 'array', nullable: true, items: { type: 'object', required: ['id', 'displayName', 'connected', 'localView', 'lastSeenAt'], properties: { id: { type: 'string', format: 'uuid' }, displayName: { type: 'string' }, connected: { type: 'boolean' }, localView: { type: 'string', nullable: true }, lastSeenAt: { type: 'string', format: 'date-time' } } } }, audienceCode: { type: 'string', description: 'Controller-only audience code.' }, receiver: { type: 'object', nullable: true },
  } },
};

export const presentationApiPaths = {
  '/api/public-improvements/presentation/ws': { get: {
    tags: ['Presentation'], security: [], summary: 'Connect to capability-authenticated presentation updates (WebSocket)',
    description: 'This path accepts a WebSocket upgrade only. An ordinary HTTP GET returns 426 when both PRESENTATION_ENABLED and PRESENTATION_WEBSOCKET_ENABLED are true, or 404 when disabled. After upgrade, send the exact authenticate frame from the [presentation protocol guide](https://github.com/DallasUrbanists/cloud-api-server/blob/main/docs/presentation.md#presentation-websocket-v1) within five seconds. The server derives role from the existing durable participant capability; no API key, Firebase token, or App Check token is used. State frames are full JSON snapshots, not a normal HTTP JSON stream. The socket accepts presence only; all presentation commands remain HTTPS requests.',
    responses: {
      '101': { description: 'WebSocket upgraded; application capability authentication and listener initialization are still required before presentation data is sent.' },
      '403': { description: 'Upgrade origin rejected.' }, '404': { description: 'Presentation WebSockets are disabled or the path is unavailable.' },
      '426': { description: 'Ordinary HTTP requests must use WebSocket upgrade.' }, '503': { description: 'Connection capacity or listener availability reached; retry later.' },
    },
  } },
  '/api/public-improvements/presentation/sessions': { post: bootstrapPost('Create a receiver session', enrollment, ref('PresentationEnrollment')) },
  '/api/public-improvements/presentation/pair': { post: bootstrapPost('Claim presenter authority', { ...enrollment, required: [...enrollment.required, 'code'] }, ref('PresentationEnrollment')) },
  '/api/public-improvements/presentation/audience/join': { post: bootstrapPost('Join as an audience viewer', { ...enrollment, required: [...enrollment.required, 'code'] }, ref('PresentationEnrollment')) },
  '/api/public-improvements/presentation/sessions/{sessionId}/sync': { post: { ...capabilities, summary: 'Synchronize state, content, and role-specific presence', parameters: [sessionId, ...capabilities.parameters], requestBody: { required: true, content: json({ type: 'object', additionalProperties: false, required: ['protocolVersion', 'lastRevision', 'lastContentVersion'], properties: { protocolVersion: { type: 'integer', enum: [1] }, lastRevision: { type: 'integer', minimum: -1 }, lastContentVersion: { type: 'string', nullable: true }, presence: { type: 'object' } } }) }, responses: { ...errors, '200': response('Changed or compact unchanged sync envelope.', ref('PresentationSync')) } } },
  '/api/public-improvements/presentation/sessions/{sessionId}/state': { put: { ...capabilities, summary: 'Write full canonical state (controller only)', parameters: [sessionId, ...capabilities.parameters, idem], requestBody: { required: true, content: json({ type: 'object', additionalProperties: false, required: ['protocolVersion', 'baseRevision', 'state'], properties: { protocolVersion: { type: 'integer', enum: [1] }, baseRevision: { type: 'integer', minimum: 0 }, state: ref('PresentationState') } }) }, responses: { ...errors, '200': response('Canonical forced-sync envelope.', ref('PresentationSync')), '409': errors['409'] } } },
  '/api/public-improvements/presentation/sessions/{sessionId}/ideas': { get: { ...capabilities, summary: 'List public ideas for the controller', description: 'Limit is 1–100; the opaque cursor supports the full catalog without a hard first-page cap.', parameters: [sessionId, ...capabilities.parameters, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 100 } }, { name: 'cursor', in: 'query', schema: { type: 'string' } }], responses: { ...errors, '200': response('Public DTO catalog page.', { type: 'object', properties: { protocolVersion: { type: 'integer', enum: [1] }, items: { type: 'array', items: ref('PresentationIdea') }, nextCursor: { type: 'string', nullable: true } } }) } } },
  '/api/public-improvements/presentation/sessions/{sessionId}/ideas/{ideaId}': { get: { ...capabilities, summary: 'Read a public idea DTO', description: 'Controllers may read any public idea. Receivers and audience viewers may read only the current selection.', parameters: [sessionId, ideaId, ...capabilities.parameters], responses: { ...errors, '200': response('Narrow public idea DTO.', { type: 'object', properties: { protocolVersion: { type: 'integer', enum: [1] }, idea: ref('PresentationIdea') } }) } } },
  '/api/public-improvements/presentation/sessions/{sessionId}/ideas/{ideaId}/streetmix-thumbnail': { get: { ...capabilities, summary: 'Relay the selected idea’s assigned Streetmix thumbnail', description: 'The upstream UUID is read from the saved suggestion attachment; no caller URL is accepted and credentials are never forwarded.', parameters: [sessionId, ideaId, ...capabilities.parameters], responses: { ...errors, '200': response('Validated PNG, up to 5 MiB.', { type: 'string', format: 'binary' }, 'image/png') } } },
  '/api/public-improvements/presentation/sessions/{sessionId}/pairing': { post: { ...capabilities, summary: 'Rotate presenter pairing (receiver only)', parameters: [sessionId, ...capabilities.parameters, idem], requestBody: { required: true, content: json({ type: 'object', additionalProperties: false, required: ['protocolVersion'], properties: { protocolVersion: { type: 'integer', enum: [1] } } }) }, responses: { ...errors, '200': response('New presenter code; any previous controller is revoked.', { type: 'object', properties: { protocolVersion: { type: 'integer', enum: [1] }, presenterCode: { type: 'string' }, presenterCodeExpiresAt: { type: 'string', format: 'date-time' } } }) } } },
  '/api/public-improvements/presentation/sessions/{sessionId}/participants/me': { delete: { ...capabilities, summary: 'Leave as an audience member or relinquish presenter authority', parameters: [sessionId, ...capabilities.parameters], responses: { ...errors, '204': { description: 'Participant left. No response body.' } } } },
  '/api/public-improvements/presentation/sessions/{sessionId}': { delete: { ...capabilities, summary: 'End the presentation room (receiver or controller)', parameters: [sessionId, ...capabilities.parameters], responses: { ...errors, '204': { description: 'Room ended. Repeated authorized requests are idempotent.' } } } },
};
