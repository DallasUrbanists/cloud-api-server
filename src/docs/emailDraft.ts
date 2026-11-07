/** OpenAPI definitions for public email drafts and playground selectors. @module */
const id = (name: string) => ({ name, in: 'query', required: true, schema: { type: 'integer', minimum: 1 } });
const error = { description: 'Safe error response.', content: { 'application/json': { schema: { $ref: '#/components/schemas/EmailDraftError' } } } };
const retryableError = { ...error, headers: { 'Retry-After': { description: 'Suggested delay in seconds when supplied.', schema: { type: 'integer', minimum: 1 } } } };

/** Public response shapes for email drafting and paginated selector data. */
export const emailDraftSchemas = {
  EmailDraft: { type: 'object', additionalProperties: false, required: ['subject_line', 'email_body', 'recipient_email_string'], properties: {
    subject_line: { type: 'string', example: 'A shaded bus stop' }, email_body: { type: 'string', description: 'Plain-text email body; newline characters preserve paragraph breaks.', example: 'Dear Council Member,\n\nPlease consider adding shade near the bus stop.\n\nThank you.' },
    recipient_email_string: { type: 'string', description: 'Comma-separated usable addresses from the representative record, including office and staff; empty when none are usable.', example: 'office@example.org,staff@example.org' },
  } },
  EmailDraftError: { type: 'object', required: ['error', 'message'], properties: { error: { type: 'string' }, message: { type: 'string' } } },
  UnsavedEmailSuggestion: { type: 'object', additionalProperties: false, required: ['description', 'latitude', 'longitude', 'representativeId'], properties: {
    description: { type: 'string', minLength: 1, maxLength: 10000, description: 'Nonblank unsaved suggestion text sent to Gemini, at most 10,000 UTF-16 code units.' },
    latitude: { type: 'number', minimum: -90, maximum: 90 }, longitude: { type: 'number', minimum: -180, maximum: 180 }, representativeId: { type: 'integer', minimum: 1 },
  } },
  EmailSuggestionPage: { type: 'object', required: ['data', 'nextCursor'], properties: {
    data: { type: 'array', items: { type: 'object', required: ['id', 'emoji', 'summary', 'author', 'date'], properties: { id: { type: 'integer' }, emoji: { type: 'string' }, summary: { type: 'string' }, author: { type: 'string' }, date: { type: 'string' } } } },
    nextCursor: { type: 'string', nullable: true, description: 'Pass as cursor to obtain the next page; null is the final page.' },
  } },
  EmailRepresentativePage: { type: 'object', required: ['data', 'nextOffset'], properties: {
    data: { type: 'array', items: { type: 'object', required: ['id', 'name', 'title', 'boundary'], properties: { id: { type: 'integer' }, name: { type: 'string', nullable: true }, title: { type: 'string', nullable: true }, boundary: { type: 'string' } } } },
    nextOffset: { type: 'integer', nullable: true, description: 'Pass as offset to obtain the next page; null is the final page.' },
  } },
};

/** All operations are anonymous; generation is a billable, quota-limited POST. */
export const emailDraftPaths = {
  '/api/email/generate': { post: {
    tags: ['Email drafts'], summary: 'Generate an editable email to a representative', security: [],
    description: 'Public, no API key, App Check, or user authentication. Accepts any existing representative. Gemini receives free text and a location placeholder, not the structured address or coordinates; free text may still contain personal details. Gemini is asked to judge whether an address helps and favor [ADDRESS] for site-specific concerns; it may omit it for general requests. The server replaces [ADDRESS] in the subject and body using the saved address, a Google reverse-geocoded street address, or coordinates on lookup failure. A trailing ", USA" is removed from the address. With no valid address or coordinates it uses an unspecified location. Model compliance is not guaranteed. The API never sends email. Shared quota and process-local concurrency limits apply; attempts are not refunded after provider failure.',
    parameters: [id('suggestionId'), id('representativeId')],
    responses: { '200': { description: 'Draft and recorded recipient addresses; recipient_email_string may be empty.', content: { 'application/json': { schema: { $ref: '#/components/schemas/EmailDraft' } } } }, '400': error, '404': error, '413': error, '422': error, '429': retryableError, '500': error, '502': error, '503': retryableError, '504': error },
  } },
  '/api/email/generate-unsaved': { post: {
    tags: ['Email drafts'], summary: 'Generate an email from an unsaved suggestion', security: [],
    description: 'Public, quota-limited draft generation. The submitted description goes to Gemini and is not saved; it may contain personal details. Structured coordinates are withheld from Gemini but may be sent to Google Maps Geocoding. Gemini is asked to judge whether an address helps and favor [ADDRESS] for site-specific concerns; it may omit it for general requests. The server replaces [ADDRESS] in the subject and body with a reverse-geocoded street address, or coordinates if lookup fails. A trailing ", USA" is removed from the address. Model compliance is not guaranteed. Any stored representative may be selected. The API never sends email.',
    requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/UnsavedEmailSuggestion' } } } },
    responses: { '200': { description: 'Editable draft and recorded recipient addresses.', content: { 'application/json': { schema: { $ref: '#/components/schemas/EmailDraft' } } } }, '400': error, '404': error, '413': error, '415': error, '422': error, '429': retryableError, '500': error, '502': error, '503': retryableError, '504': error },
  } },
  '/api/email/suggestions': { get: {
    tags: ['Email drafts'], summary: 'List minimal public suggestion choices', security: [],
    description: 'Lists all statuses in ID order, including author names but not author emails or full records. Pages contain up to 100 choices.',
    parameters: [{ name: 'cursor', in: 'query', required: false, schema: { type: 'string', pattern: '^[0-9]+$' } }],
    responses: { '200': { description: 'Suggestion choices.', content: { 'application/json': { schema: { $ref: '#/components/schemas/EmailSuggestionPage' } } } }, '400': error, '500': error },
  } },
  '/api/email/representatives': { get: {
    tags: ['Email drafts'], summary: 'List current representatives for a suggestion', security: [],
    description: 'Current representatives matching either a saved suggestion’s boundaries or an exact map point. Provide suggestionId or both latitude and longitude, not both forms. Pages contain up to 100 choices; shape-less boundaries without matching administrative hints cannot be resolved from coordinates alone.',
    parameters: [{ ...id('suggestionId'), required: false }, { name: 'latitude', in: 'query', schema: { type: 'number', minimum: -90, maximum: 90 } }, { name: 'longitude', in: 'query', schema: { type: 'number', minimum: -180, maximum: 180 } }, { name: 'offset', in: 'query', required: false, schema: { type: 'integer', minimum: 0, maximum: 9007199254740891, default: 0 } }],
    responses: { '200': { description: 'Representative choices.', content: { 'application/json': { schema: { $ref: '#/components/schemas/EmailRepresentativePage' } } } }, '400': error, '404': error, '500': error },
  } },
  '/api/email/locations': { get: {
    tags: ['Email drafts'], summary: 'Search for an address for the email playground', security: [],
    description: 'Server-side Google Places API (New) proxy. Supply input for predictions or placeId for details, plus the same sessionToken for a search session. Requires GOOGLE_MAPS_API_KEY with Places API (New) enabled; the key remains server-side.',
    parameters: [{ name: 'input', in: 'query', schema: { type: 'string', minLength: 3, maxLength: 200 } }, { name: 'placeId', in: 'query', schema: { type: 'string', maxLength: 300 } }, { name: 'sessionToken', in: 'query', required: true, schema: { type: 'string', minLength: 16, maxLength: 64 } }],
    responses: { '200': { description: 'Address predictions or selected address coordinates.', content: { 'application/json': { schema: { oneOf: [{ type: 'object', required: ['suggestions'], properties: { suggestions: { type: 'array', items: { type: 'object', required: ['placeId', 'text'], properties: { placeId: { type: 'string' }, text: { type: 'string' } } } } } }, { type: 'object', required: ['latitude', 'longitude', 'address'], properties: { latitude: { type: 'number' }, longitude: { type: 'number' }, address: { type: 'string' } } }] } } } }, '400': error, '503': error },
  } },
  '/playground/email': { get: { tags: ['Email drafts'], summary: 'Open the public email playground', description: 'Browser requests use EMAIL_PLAYGROUND_API_BASE_URL, defaulting to https://api.dallasurbanists.org/. Set / for same-origin or an absolute HTTP(S) API base with optional path prefix. Credentials, query parameters and fragments are not accepted in the base URL.', security: [], responses: { '200': { description: 'Public HTML page.', content: { 'text/html': { schema: { type: 'string' } } } }, '500': error, '503': { description: 'Invalid playground API base URL configuration.', content: { 'text/plain': { schema: { type: 'string' } } } } } } },
};
