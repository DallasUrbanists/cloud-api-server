/** OpenAPI contracts for the walk-audit namespace. @module */
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object) => ({ 'application/json': { schema } });
const id = { name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1, maximum: 2147483647 } };
const uuid = { ...id, schema: { type: 'string', format: 'uuid' } };
const param = (name: string, schema: object, description?: string) => ({ name, in: 'query', required: false, schema, ...(description ? { description } : {}) });
const paging = [param('limit', { type: 'integer', minimum: 1, maximum: 100, default: 25 }), param('offset', { type: 'integer', minimum: 0, default: 0 })];
const type = { type: 'string', enum: ['intersection', 'street-segment', 'point'] };
const security = [{ BearerAuth: [], AppCheckAuth: [] }];
const errors = Object.fromEntries(Object.entries({
  400: 'Invalid input, unknown fields, malformed query, or invalid geometry.',
  401: 'A valid Firebase ID token and production App Check token are required for private operations.',
  403: 'The verified caller is not permitted to perform this action.',
  404: 'The resource does not exist or a private draft is not owned by the caller.',
  409: 'Registration, stale version, reference, dependency, or concurrent-update conflict.',
  413: 'Request, answers, or captured report exceeds its size limit.',
  415: 'Unsupported request media type or image signature.',
  428: 'Photo writes require the current draft version in If-Match.',
  429: 'Generation interval or per-instance capacity exceeded; see Retry-After.',
  503: 'Network generation failed, was cancelled, or exceeded its deadline.',
  500: 'Unexpected failure; internal details are not returned.',
}).map(([status, description]) => [status, { description, content: json(ref('WalkAuditError')), ...(status === '429' ? { headers: { 'Retry-After': { schema: { type: 'integer' } } } } : {}) }]));
const envelope = (key: string, name: string) => ({ type: 'object', required: [key], properties: { [key]: ref(name) } });
const list = (key: string, name: string) => ({ type: 'object', required: [key, 'limit', 'offset', 'hasMore'], properties: { [key]: { type: 'array', items: ref(name) }, limit: { type: 'integer' }, offset: { type: 'integer' }, hasMore: { type: 'boolean' } } });
const body = (name: string) => ({ required: true, content: json(ref(name)) });
const response = (description: string, schema: object) => ({ description, content: json(schema) });
const created = (key: string, name: string) => ({ ...response('Created.', envelope(key, name)), headers: { Location: { schema: { type: 'string' } } } });
const operation = (summary: string, options: { private?: boolean; description?: string; parameters?: object[]; requestBody?: object; responses: object }) => ({
  tags: ['Walk audits'], summary, security: options.private ? security : [],
  ...(options.description ? { description: options.description } : {}), ...(options.parameters ? { parameters: options.parameters } : {}),
  ...(options.requestBody ? { requestBody: options.requestBody } : {}), responses: { ...errors, ...options.responses },
});
const noContent = { 204: { description: 'Deleted permanently; no response body.' } };
const ok = (key: string, name: string) => ({ 200: response('Resource.', envelope(key, name)) });
const pageResponse = (key: string, name: string) => ({ 200: response('Page of summaries.', list(key, name)) });

/** Public reads explicitly override the document-wide API-key security requirement. */
export const walkAuditPaths = {
  '/api/walk-audits/contributors/me': {
    get: operation('Read my contributor profile', { private: true, responses: ok('contributor', 'WalkAuditContributor') }),
    post: operation('Create my contributor profile', { private: true, requestBody: body('WalkAuditContributorInput'), responses: { 201: created('contributor', 'WalkAuditContributor') } }),
    patch: operation('Change my display name', { private: true, requestBody: body('WalkAuditContributorInput'), responses: ok('contributor', 'WalkAuditContributor') }),
    delete: operation('Delete my unreferenced profile', { private: true, responses: noContent }),
  },
  '/api/walk-audits/contributors': { get: operation('List contributor profiles', { private: true, description: 'Canonical staff claim required. No Firebase UIDs or email addresses are returned.', parameters: paging, responses: pageResponse('contributors', 'WalkAuditContributor') }) },
  '/api/walk-audits/contributors/{id}': {
    get: operation('Read a contributor profile', { private: true, description: 'Staff only.', parameters: [id], responses: ok('contributor', 'WalkAuditContributor') }),
    patch: operation('Change a contributor display name', { private: true, description: 'Staff only; Firebase identity cannot be changed.', parameters: [id], requestBody: body('WalkAuditContributorInput'), responses: ok('contributor', 'WalkAuditContributor') }),
    delete: operation('Delete an unreferenced contributor', { private: true, description: 'Staff only. Dependent domain data prevents deletion; Firebase accounts and CRM contacts are untouched.', parameters: [id], responses: noContent }),
  },
  '/api/walk-audits/dashboard': { get: operation('List my or other public studies', { private: true, description: 'Mine means creator or submitted contributor; other includes every remaining study, including zero-audit studies. Groups paginate independently in newest-first order.', parameters: [...paging, { ...param('group', { type: 'string', enum: ['mine', 'other'] }), required: true }], responses: pageResponse('studies', 'WalkAuditDashboardStudy') }) },
  '/api/walk-audits/studies': {
    get: operation('List studies', { parameters: [...paging, param('creator', { type: 'integer', minimum: 1 }), param('neighborhood', { type: 'string', maxLength: 200 })], responses: pageResponse('studies', 'WalkAuditStudySummary') }),
    post: operation('Create a study and generate its street network', { private: true, description: 'Synchronous Overpass generation may take up to the configured deadline. The boundary must be a simple single-ring WGS84 Polygon Feature of 2,500 m²–75 km² with at most 250 corners. Generation failures save no study. Supply both allowedAuditTypes and questionnaires with matching keys, or omit both to pin the two legacy default templates. Definitions are permanently assigned to the study.', requestBody: body('WalkAuditStudyInput'), responses: { 201: created('study', 'WalkAuditStudy') } }),
  },
  '/api/walk-audits/studies/{id}': {
    get: operation('Read a study and current coverage', { parameters: [id], responses: ok('study', 'WalkAuditStudy') }),
    patch: operation('Edit or regenerate a study', { private: true, description: 'Organizer or staff only. Boundary changes regenerate the network and PNG and require no audits, drafts, or reports. expectedVersion prevents stale edits.', parameters: [id], requestBody: body('WalkAuditStudyPatch'), responses: ok('study', 'WalkAuditStudy') }),
    delete: operation('Permanently delete a study', { private: true, description: 'Organizer or staff only. This physically deletes all audits, private drafts, reports, and the thumbnail, including other contributors’ observations.', parameters: [id, { ...param('confirmPermanentDelete', { type: 'string', enum: ['true'] }), required: true }], responses: noContent }),
  },
  '/api/walk-audits/studies/{id}/thumbnail': { get: operation('Read the generated PNG thumbnail', { parameters: [id], responses: { 200: { description: 'PNG image; caches must revalidate.', content: { 'image/png': { schema: { type: 'string', format: 'binary' } } } } } }) },
  '/api/walk-audits/studies/{id}/progress': { get: operation('Read deduplicated network coverage', { parameters: [id], responses: { 200: response('Distinct known features with zero for an empty network.', ref('WalkAuditProgress')) } }) },
  '/api/walk-audits/studies/{id}/route-preview': { post: operation('Preview the shortest saved-network route', { private: true, description: 'A is a saved intersection; B is within one meter of a saved street edge and may be midblock. Disconnected or coincident endpoints fail. The server derives all route slices, geometry, and distance.', parameters: [id], requestBody: body('WalkAuditRouteIntent'), responses: ok('route', 'WalkAuditRoutePreview') }) },
  '/api/walk-audits/worksheets': {
    get: operation('List worksheet versions', { description: 'The latest version of each slug is returned by default.', parameters: [...paging, param('type', type), param('includeVersions', { type: 'boolean', default: false })], responses: pageResponse('worksheets', 'WalkAuditWorksheet') }),
    post: operation('Create a worksheet', { private: true, description: 'Canonical staff only. Prompts are original authored content.', requestBody: body('WalkAuditWorksheetInput'), responses: { 201: created('worksheet', 'WalkAuditWorksheet') } }),
  },
  '/api/walk-audits/worksheets/{id}': {
    get: operation('Read a pinned worksheet version', { parameters: [id], responses: ok('worksheet', 'WalkAuditWorksheet') }),
    patch: operation('Create a revised worksheet version', { private: true, description: 'Staff only. A new ID and version are allocated; existing audits and drafts keep the earlier definition.', parameters: [id], requestBody: body('WalkAuditWorksheetPatch'), responses: ok('worksheet', 'WalkAuditWorksheet') }),
    delete: operation('Delete an unreferenced worksheet version', { private: true, description: 'Staff only; live audit or draft references cause 409.', parameters: [id], responses: noContent }),
  },
  '/api/walk-audits/studies/{id}/audits': {
    get: operation('List study audit summaries', { parameters: [id, ...paging, param('type', type), param('author', { type: 'integer', minimum: 1 }), param('worksheet', { type: 'integer', minimum: 1 })], responses: pageResponse('audits', 'WalkAuditAuditSummary') }),
    post: operation('Submit an audit directly', { private: true, description: 'The feature and geometry are resolved against the study network and answers must satisfy the pinned worksheet.', parameters: [id], requestBody: body('WalkAuditAuditInput'), responses: { 201: created('audit', 'WalkAuditAudit') } }),
  },
  '/api/walk-audits/audits/{id}': {
    get: operation('Read an audit', { parameters: [id], responses: ok('audit', 'WalkAuditAudit') }),
    patch: operation('Edit an audit', { private: true, description: 'Author or staff only. A submitted type and its pinned worksheet are immutable, including for staff. Legacy street locations can be retained or replaced by a complete route.', parameters: [id], requestBody: body('WalkAuditAuditPatch'), responses: ok('audit', 'WalkAuditAudit') }),
    delete: operation('Delete an audit', { private: true, description: 'Author or staff only. Its edit drafts are removed; historical report captures remain.', parameters: [id], responses: noContent }),
  },
  '/api/walk-audits/studies/{id}/drafts': {
    get: operation('List my private drafts in a study', { private: true, parameters: [id, ...paging, param('updatedSince', { type: 'string', format: 'date-time' })], responses: pageResponse('drafts', 'WalkAuditDraft') }),
    post: operation('Start a private draft', { private: true, description: 'An edit draft may only seed an audit owned by this caller in this study.', parameters: [id], requestBody: body('WalkAuditDraftInput'), responses: { 201: created('draft', 'WalkAuditDraft') } }),
  },
  '/api/walk-audits/drafts/{id}': {
    get: operation('Read my private draft', { private: true, description: 'Staff status does not bypass draft ownership.', parameters: [uuid], responses: ok('draft', 'WalkAuditDraft') }),
    patch: operation('Autosave my draft', { private: true, parameters: [uuid], requestBody: body('WalkAuditDraftPatch'), responses: ok('draft', 'WalkAuditDraft') }),
    delete: operation('Delete my draft', { private: true, parameters: [uuid], responses: noContent }),
  },
  '/api/walk-audits/drafts/{id}/submit': { post: operation('Atomically submit my draft', { private: true, description: 'The expected draft version and any editing-audit base version are checked. Validation failures roll back and retain the draft; successful submission consumes it.', parameters: [uuid], requestBody: body('WalkAuditVersionInput'), responses: { 200: response('Existing audit updated.', envelope('audit', 'WalkAuditAudit')), 201: created('audit', 'WalkAuditAudit') } }) },
  '/api/walk-audits/drafts/{id}/photos/{slot}': {
    get: operation('Read my private draft photo', { private: true, parameters: [uuid, { name: 'slot', in: 'path', required: true, schema: { type: 'integer', minimum: 1, maximum: 3 } }], responses: { 200: { description: 'Private image bytes; no-store.', content: Object.fromEntries(['image/jpeg', 'image/png', 'image/webp'].map(media => [media, { schema: { type: 'string', format: 'binary' } }])) } } }),
    put: operation('Upload or replace a private draft photo', { private: true, description: 'Owner only; unavailable on edit drafts. Send verified JPEG, PNG, or WebP bytes up to 2 MiB. If-Match is the quoted current draft version; success increments it.', parameters: [uuid, { name: 'slot', in: 'path', required: true, schema: { type: 'integer', minimum: 1, maximum: 3 } }, { name: 'If-Match', in: 'header', required: true, schema: { type: 'string', example: '"1"' } }], requestBody: { required: true, content: Object.fromEntries(['image/jpeg', 'image/png', 'image/webp'].map(media => [media, { schema: { type: 'string', format: 'binary' } }])) }, responses: ok('draft', 'WalkAuditDraft') }),
    delete: operation('Remove a private draft photo', { private: true, description: 'Removing an already-empty slot still advances the version to fence a delayed upload.', parameters: [uuid, { name: 'slot', in: 'path', required: true, schema: { type: 'integer', minimum: 1, maximum: 3 } }, { name: 'If-Match', in: 'header', required: true, schema: { type: 'string', example: '"1"' } }], responses: ok('draft', 'WalkAuditDraft') }),
  },
  '/api/walk-audits/audits/{id}/photos/{slot}': { get: operation('Read a public submitted photo', { parameters: [id, { name: 'slot', in: 'path', required: true, schema: { type: 'integer', minimum: 1, maximum: 3 } }], responses: { 200: { description: 'Verified image bytes; caches must revalidate.', content: Object.fromEntries(['image/jpeg', 'image/png', 'image/webp'].map(media => [media, { schema: { type: 'string', format: 'binary' } }])) } } }) },
  '/api/walk-audits/studies/{id}/reports': {
    get: operation('List report summaries', { parameters: [id, ...paging], responses: pageResponse('reports', 'WalkAuditReportSummary') }),
    post: operation('Capture a report', { private: true, description: 'Organizer or staff only. Omit auditIds to select all current audits, or supply a unique same-study selection (including an empty array). Maximum 500 audits and 16 MiB captured JSON.', parameters: [id], requestBody: body('WalkAuditReportInput'), responses: { 201: created('report', 'WalkAuditReport') } }),
  },
  '/api/walk-audits/reports/{id}': {
    get: operation('Read a captured report', { parameters: [id], responses: ok('report', 'WalkAuditReport') }),
    patch: operation('Edit a report', { private: true, description: 'Organizer or staff only. Text edits retain captured inputs; supplying auditIds replaces the capture and recomputes coverage while preserving the authored description unless explicitly changed.', parameters: [id], requestBody: body('WalkAuditReportPatch'), responses: ok('report', 'WalkAuditReport') }),
    delete: operation('Delete a report', { private: true, description: 'Organizer or staff only.', parameters: [id], responses: noContent }),
  },
};

const string = { type: 'string' }, integer = { type: 'integer', minimum: 1 }, timestamp = { type: 'string', format: 'date-time' };
const properties = { type: 'object', additionalProperties: true };
const gps = { type: 'object', additionalProperties: false, required: ['longitude', 'latitude'], properties: { longitude: { type: 'number', minimum: -180, maximum: 180 }, latitude: { type: 'number', minimum: -90, maximum: 90 } } };
const auditProperties = { type, worksheetId: integer, featureId: string, locationGps: gps, locationDescription: { type: 'string', maxLength: 500 }, geojson: properties, routeSelection: ref('WalkAuditRouteIntent'), answers: { type: 'object', additionalProperties: { type: 'string' } } };
const draftProperties = { type: { ...type, nullable: true }, worksheetId: { ...integer, nullable: true }, featureId: { ...string, nullable: true }, locationGps: { ...gps, nullable: true }, locationDescription: { ...string, nullable: true }, geojson: { ...properties, nullable: true }, routeSelection: ref('WalkAuditPartialRouteIntent'), answers: auditProperties.answers };
const worksheetProperties = { slug: string, title: string, description: string, sourceUrl: { type: 'string', format: 'uri' }, recommendFor: { type: 'array', items: type }, prompts: { type: 'array', items: ref('WalkAuditPrompt') } };
const baseRecord = { id: integer, createdOn: timestamp, updatedOn: timestamp, version: integer };
const authoredBy = { type: 'object', required: ['id', 'displayName'], properties: { id: integer, displayName: string } };
const versioned = { expectedVersion: integer };

/** Schemas describe the authored inputs and sanitized public output. */
export const walkAuditSchemas = {
  WalkAuditError: { type: 'object', required: ['error', 'message'], properties: { error: string, message: string } },
  WalkAuditContributor: { type: 'object', required: ['id', 'displayName', 'createdOn', 'updatedOn'], properties: { id: integer, displayName: string, createdOn: timestamp, updatedOn: timestamp } },
  WalkAuditContributorInput: { type: 'object', additionalProperties: false, required: ['displayName'], properties: { displayName: { type: 'string', minLength: 1, maxLength: 120 } } },
  WalkAuditArea: { type: 'object', required: ['type', 'geometry'], properties: { type: { type: 'string', enum: ['Feature'] }, properties, geometry: { type: 'object', required: ['type', 'coordinates'], properties: { type: { type: 'string', enum: ['Polygon'] }, coordinates: { type: 'array', description: 'Exactly one closed outer ring of longitude/latitude pairs.', items: { type: 'array', items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } } } } } } } },
  WalkAuditStudyInput: { type: 'object', additionalProperties: false, required: ['neighborhood', 'area'], description: 'Provide both allowedAuditTypes and questionnaires with matching keys, or omit both for the legacy defaults.', properties: { neighborhood: { type: 'string', maxLength: 200 }, area: ref('WalkAuditArea'), allowedAuditTypes: { type: 'array', minItems: 1, maxItems: 3, uniqueItems: true, items: type }, questionnaires: { type: 'object', additionalProperties: ref('WalkAuditQuestionnaireInput') } } },
  WalkAuditStudyPatch: { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { ...versioned, neighborhood: string, area: ref('WalkAuditArea') } },
  WalkAuditStudySummary: { type: 'object', properties: { ...baseRecord, neighborhood: string, createdBy: authoredBy } },
  WalkAuditDashboardStudy: { allOf: [ref('WalkAuditStudySummary'), { type: 'object', properties: { auditCount: { type: 'integer', minimum: 0 }, isOrganizer: { type: 'boolean' }, hasContributed: { type: 'boolean' } } }] },
  WalkAuditFeatureCollection: { type: 'object', required: ['type', 'features'], properties: { type: { type: 'string', enum: ['FeatureCollection'] }, features: { type: 'array', items: { type: 'object', required: ['type', 'properties', 'geometry'], properties: { type: { type: 'string', enum: ['Feature'] }, properties: { type: 'object', required: ['id'], properties: { id: string, name: { ...string, nullable: true }, highway: string } }, geometry: { type: 'object', required: ['type', 'coordinates'], properties: { type: { type: 'string', enum: ['Point', 'LineString'] }, coordinates: { type: 'array', description: 'A position for an intersection or an array of positions for a street segment.', items: {} } } } } } } } },
  WalkAuditStudy: { allOf: [ref('WalkAuditStudySummary'), { type: 'object', properties: { locationGps: gps, locationDescription: string, area: ref('WalkAuditArea'), intersections: ref('WalkAuditFeatureCollection'), segments: ref('WalkAuditFeatureCollection'), sourceMetadata: properties, allowedAuditTypes: { type: 'array', items: type }, questionnaires: { type: 'object', additionalProperties: ref('WalkAuditQuestionnaire') }, progress: ref('WalkAuditProgress') } }] },
  WalkAuditProgress: { type: 'object', required: ['streets', 'intersections', 'points', 'overall'], properties: { streets: { type: 'object', properties: { audited: { type: 'integer' }, partial: { type: 'integer' }, total: { type: 'integer' }, ratio: { type: 'number' }, coverage: { type: 'array', items: properties } } }, intersections: { type: 'object', properties: { audited: { type: 'integer' }, total: { type: 'integer' }, ratio: { type: 'number' } } }, points: { type: 'object', properties: { observations: { type: 'integer' } } }, overall: { type: 'object', properties: { audited: { type: 'integer' }, total: { type: 'integer' }, ratio: { type: 'number' }, coverageApplicable: { type: 'boolean' } } } } },
  WalkAuditQuestionnaireInput: { type: 'object', additionalProperties: false, required: ['prompts', 'sourceMetadata'], properties: { prompts: { type: 'array', minItems: 1, maxItems: 30, items: ref('WalkAuditPrompt') }, sourceMetadata: { type: 'object', required: ['questions'], properties: { catalogVersion: { type: 'string', maxLength: 100 }, questions: { type: 'object', additionalProperties: { type: 'object', properties: { sourceQuestionId: string } } } } } } },
  WalkAuditQuestionnaire: { type: 'object', required: ['worksheetId', 'title', 'prompts', 'sourceMetadata'], properties: { worksheetId: integer, title: string, catalogVersion: string, prompts: { type: 'array', items: ref('WalkAuditPrompt') }, sourceMetadata: properties } },
  WalkAuditRouteEnd: { type: 'object', additionalProperties: false, required: ['featureId', 'locationGps'], properties: { featureId: string, locationGps: gps } },
  WalkAuditRouteIntent: { type: 'object', additionalProperties: false, required: ['startIntersectionId', 'end'], properties: { startIntersectionId: string, end: ref('WalkAuditRouteEnd') } },
  WalkAuditPartialRouteIntent: { type: 'object', additionalProperties: false, nullable: true, required: ['startIntersectionId'], properties: { startIntersectionId: string, end: ref('WalkAuditRouteEnd') } },
  WalkAuditRouteSelection: { type: 'object', nullable: true, required: ['startIntersectionId', 'end', 'edges', 'lengthMeters'], properties: { startIntersectionId: string, end: ref('WalkAuditRouteEnd'), edges: { type: 'array', items: { type: 'object', required: ['featureId', 'fromFraction', 'toFraction'], properties: { featureId: string, fromFraction: { type: 'number', minimum: 0, maximum: 1 }, toFraction: { type: 'number', minimum: 0, maximum: 1 } } } }, lengthMeters: { type: 'number', minimum: 0 } } },
  WalkAuditRoutePreview: { type: 'object', required: ['routeSelection', 'geojson'], properties: { routeSelection: ref('WalkAuditRouteSelection'), geojson: properties } },
  WalkAuditPhoto: { type: 'object', required: ['id', 'slot', 'contentType', 'byteCount', 'createdOn', 'path'], properties: { id: { type: 'string', format: 'uuid' }, slot: { type: 'integer', minimum: 1, maximum: 3 }, contentType: { type: 'string', enum: ['image/jpeg', 'image/png', 'image/webp'] }, byteCount: { type: 'integer', minimum: 1, maximum: 2097152 }, createdOn: timestamp, path: string } },
  WalkAuditPrompt: { type: 'object', additionalProperties: false, required: ['id', 'type', 'label', 'required'], properties: { id: string, type: { type: 'string', enum: ['choice', 'text'] }, label: string, required: { type: 'boolean' }, options: { type: 'array', items: string }, maxLength: { type: 'integer', minimum: 1, maximum: 10000 } } },
  WalkAuditWorksheetInput: { type: 'object', additionalProperties: false, required: Object.keys(worksheetProperties), properties: worksheetProperties },
  WalkAuditWorksheetPatch: { type: 'object', additionalProperties: false, properties: Object.fromEntries(Object.entries(worksheetProperties).filter(([key]) => key !== 'slug')) },
  WalkAuditWorksheet: { type: 'object', properties: { ...baseRecord, ...worksheetProperties } },
  WalkAuditAuditInput: { type: 'object', additionalProperties: false, required: ['type', 'locationDescription', 'answers'], description: 'The assigned worksheet is derived if omitted. Point/intersection require featureId and locationGps; new streets require a complete routeSelection and may omit derived geometry.', properties: auditProperties },
  WalkAuditAuditPatch: { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { ...versioned, ...auditProperties } },
  WalkAuditDraftPatch: { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { ...versioned, ...draftProperties } },
  WalkAuditAuditSummary: { type: 'object', properties: { ...baseRecord, studyId: integer, createdBy: authoredBy, type, worksheetId: integer, featureId: string, locationGps: gps, locationDescription: string, routeSelection: ref('WalkAuditRouteSelection'), photos: { type: 'array', items: ref('WalkAuditPhoto') } } },
  WalkAuditAudit: { allOf: [ref('WalkAuditAuditSummary'), { type: 'object', properties: { geojson: properties, answers: auditProperties.answers } }] },
  WalkAuditDraftInput: { type: 'object', additionalProperties: false, properties: { editingAuditId: integer } },
  WalkAuditDraft: { type: 'object', properties: { ...baseRecord, id: { type: 'string', format: 'uuid' }, studyId: integer, createdBy: integer, editingAuditId: { ...integer, nullable: true }, editingAuditVersion: { ...integer, nullable: true }, ...draftProperties, routeSelection: { oneOf: [ref('WalkAuditPartialRouteIntent'), ref('WalkAuditRouteSelection')], nullable: true }, photos: { type: 'array', items: ref('WalkAuditPhoto') } } },
  WalkAuditVersionInput: { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: versioned },
  WalkAuditReportInput: { type: 'object', additionalProperties: false, properties: { title: string, description: string, auditIds: { type: 'array', maxItems: 500, uniqueItems: true, items: integer } } },
  WalkAuditReportPatch: { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { ...versioned, title: string, description: string, auditIds: { type: 'array', maxItems: 500, uniqueItems: true, items: integer } } },
  WalkAuditReportSummary: { type: 'object', properties: { ...baseRecord, studyId: integer, createdBy: authoredBy, title: string, description: string, auditIds: { type: 'array', items: integer }, completion: { type: 'number', minimum: 0, maximum: 1 }, coverageApplicable: { type: 'boolean', description: 'Absent on historical captures.' } } },
  WalkAuditReport: { allOf: [ref('WalkAuditReportSummary'), { type: 'object', properties: { capturedData: properties } }] },
};
