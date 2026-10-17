import { createRequire } from 'module';
import { JsonObject } from 'swagger-ui-express';
import { operationPaths, operationSchemas, stagingParameters, stagingResponses } from './operations.js';
import { DEFAULT_SUMMARY_OPTIONS, GRAMMAR_OUTPUT_LIMIT, SUMMARY_SENTENCE_TYPES } from '../models/assist.js';
import { boundaryPaths, boundarySchemas, boundarySearchParameters } from './boundaries.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json');

const representativeSearchParameters = [
  ...boundarySearchParameters.filter(parameter => !['asOf', 'entity', 'body', 'district', 'lat', 'lon', 'address'].includes(parameter.name)),
  { name: 'boundaryId', in: 'query', description: 'Match the linked boundary ID.', schema: { type: 'integer', minimum: 1 } },
  { name: 'entity', in: 'query', description: 'Match the linked boundary entity (case-insensitive exact match).', schema: { type: 'string', example: 'City of Dallas' } },
  { name: 'body', in: 'query', description: 'Match the linked boundary body (case-insensitive exact match).', schema: { type: 'string', example: 'City Council' } },
  { name: 'title', in: 'query', description: 'Match the representative title (case-insensitive exact match).', schema: { type: 'string', example: 'Council member' } },
  { name: 'district', in: 'query', description: 'Match the district (case-insensitive exact match).', schema: { type: 'string', example: 'District 1' } },
  { name: 'servingAsOf', in: 'query', description: 'Return representatives serving on this date; defaults to the current date.', schema: { type: 'string', format: 'date', example: '2026-10-09' } },
  { name: 'electionAsOf', in: 'query', description: 'Keep representatives with an election period containing this date (from early voting start through election day).', schema: { type: 'string', format: 'date', example: '2025-04-25' } },
  { name: 'lat', in: 'query', description: 'Latitude; lon must also be supplied. Membership uses the linked boundary.', schema: { type: 'number', minimum: -90, maximum: 90, example: 32.78 } },
  { name: 'lon', in: 'query', description: 'Longitude; lat must also be supplied.', schema: { type: 'number', minimum: -180, maximum: 180, example: -96.8 } },
  { name: 'address', in: 'query', description: 'Address to geocode and search within district boundaries. Ignored when both lat and lon are provided.', schema: { type: 'string', example: '1500 Marilla St, Dallas, TX' } },
].map((parameter) => ({ ...parameter, required: false }));

export const swaggerDocument: JsonObject = {
  openapi: '3.0.3',
  info: {
    title: 'Dallas Urbanists Cloud API',
    version: pkg.version || '1.0.0',
    description: `API web service providing database I/O and server-side operations for Dallas Urbanists client applications.

Authorization:
- API keys use the X-API-Key header. Optional endpoints work without a key; required endpoints require a valid application key. Production browser requests to required endpoints also require Firebase App Check.
- Firebase user tokens use Authorization: Bearer <Firebase ID token>. PUBLIC endpoints do not require a token, PARTIAL endpoints return redacted data without an authorized token, and PRIVATE endpoints require a valid token plus the endpoint's ownership or role condition.
- Only the canonical boolean Firebase custom claim staff:true authorizes staff; legacy role/roles staff entries do not. System and unrelated roles retain their existing behavior. All supplied ID tokens are checked for revocation; rejected tokens never attach a user and use anonymous/restricted fallback on PUBLIC/PARTIAL endpoints.
- PUT and DELETE /api/users/{uid}/claims/staff require a valid API key, production App Check, and a private canonical staff caller. System-only access and self-targeting are forbidden.

Endpoint policies:
- Contacts: GET/list and GET/{id}/PUT/{id} are API-key REQUIRED and JWT PARTIAL; POST is REQUIRED/PUBLIC; DELETE is REQUIRED/PRIVATE.
- Check-ins: GET/list and GET/{id} are REQUIRED/PARTIAL; POST is OPTIONAL/PUBLIC; PUT and DELETE are REQUIRED/PRIVATE. include_contact accepts false, partial, or full.
- Suggestions: reads, creation, and upload URLs are REQUIRED/PUBLIC; update and delete are REQUIRED/PRIVATE for the author or staff.
- Events and calendar reads are OPTIONAL/PUBLIC; event creation, updates, deletion, and iCal imports are REQUIRED/PRIVATE for staff or system roles.
- Representatives, including the Dallas City Council shortcut, and boundary reads/TTL ticks/job status are public and require no API key or user authentication.
- Forced boundary/representative tick POSTs require an API key, canonical staff user authorization, and production App Check; due research uses a separately deployed durable worker.
- Grammar, clarity, and summary assistance are REQUIRED/PUBLIC: API key and production App Check are required; user sign-in is optional.`,
    contact: {
      name: 'DallasUrbanists.org',
      url: 'https://dallasurbanists.org',
    },
  },
  servers: [
    {
      url: '/',
      description: 'Current Environment / Local Server',
    },
  ],
  security: [{ ApiKeyAuth: [], BearerAuth: [] }],
  tags: [
    {
      name: 'Suggestions',
      description: 'Endpoints for managing suggestions in the public-improvements database.',
    },
    {
      name: 'Contacts',
      description: 'Endpoints for managing contact records in the PostgreSQL database.',
    },
    {
      name: 'Checkins',
      description: 'Endpoints for managing checkin records in the PostgreSQL database.',
    },
    {
      name: 'Events',
      description: 'Endpoints for retrieving calendar feeds and event integrations.',
    },
    {
      name: 'Representatives',
      description: 'Public representative search by office, term, election period, and district geography.',
    },
    { name: 'Boundaries', description: 'Public jurisdiction geometry, administrative membership, and effective dates.' },
    { name: 'Boundary synchronization', description: 'Public TTL ticks, staff force ticks, and durable job status.' },
    {
      name: 'System',
      description: 'Health checks and server operational metadata.',
    },
    {
      name: 'Users',
      description: 'Firebase Authentication user directory and staff claim administration.',
    },
    {
      name: 'Assist',
      description: 'Server-side AI assistance for prose, with validation and shared quotas.',
    },
  ],
  paths: {
      ...operationPaths,
      ...boundaryPaths,
      '/api/health': {
      get: {
        summary: 'Server Health Check',
        description: 'Returns the operational health and environment state of the API server.',
        tags: ['System'],
        responses: {
          200: {
            description: 'Server is healthy and operational.',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/HealthResponse',
                },
              },
            },
          },
        },
      },
    },
    '/api/representatives': {
      get: {
        summary: 'Search Representatives',
        description: 'Returns representatives matching every supplied filter, with boundaryId and nested boundary information instead of the former entity/body/district fields. Without servingAsOf, currently serving representatives are returned. Linked boundaries must be in effect on the serving date (today in Dallas by default). Spatial search requires lat and lon together; address is geocoded only when that pair is absent. City/county/state/ZIP filters and null-shape membership follow /api/boundaries semantics. Public; no API key or user token required.',
        tags: ['Representatives'],
        security: [],
        parameters: representativeSearchParameters,
        responses: {
          200: {
            description: 'Matching representatives.',
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/Representative' } },
              },
            },
          },
          400: { $ref: '#/components/responses/BadRequestError' },
          404: { $ref: '#/components/responses/NotFoundError' },
          502: { $ref: '#/components/responses/BadGatewayError' },
          503: { description: 'Address search is not configured on this server.' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      },
    },
    '/api/dallascitycouncil': {
      get: {
        summary: 'Search Dallas City Council Members',
        description: 'Searches representatives using the same filters as /api/representatives, with entity=City of Dallas, body=City Council, and title=Council member fixed by the server. Caller-supplied entity, body, and title values do not override these filters. This endpoint is public and requires no API key or user token.',
        tags: ['Representatives'],
        security: [],
        parameters: representativeSearchParameters.filter((parameter) => !['entity', 'body', 'title'].includes(parameter.name)),
        responses: {
          200: {
            description: 'Matching Dallas City Council members.',
            content: {
              'application/json': {
                schema: { type: 'array', items: { $ref: '#/components/schemas/Representative' } },
              },
            },
          },
          400: { $ref: '#/components/responses/BadRequestError' },
          404: { $ref: '#/components/responses/NotFoundError' },
          502: { $ref: '#/components/responses/BadGatewayError' },
          503: { description: 'Address search is not configured on this server.' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      },
    },
    '/api/contacts': {
      get: {
        summary: 'List All Contacts',
        description: 'Retrieves all contact records ordered by ID descending from the PostgreSQL database, with optional search filtering by name, email, or phone number.',
        tags: ['Contacts'],
        parameters: [
          {
            name: 'name',
            in: 'query',
            description: 'Filter contacts by name (case-insensitive substring match, normalized to uppercase)',
            required: false,
            schema: {
              type: 'string',
              example: 'John McDonald',
            },
          },
          {
            name: 'email',
            in: 'query',
            description: 'Filter contacts by email address (case-insensitive match, normalized to lowercase)',
            required: false,
            schema: {
              type: 'string',
              example: 'john.doe@example.com',
            },
          },
          {
            name: 'phone',
            in: 'query',
            description: 'Filter contacts by phone number (normalized to standardized format e.g. +1-752-012-3456)',
            required: false,
            schema: {
              type: 'string',
              example: '+1-752-012-3456',
            },
          },
          {
            name: 'zip',
            in: 'query',
            description: 'Filter contacts by an exact home or other ZIP code match.',
            required: false,
            schema: {
              type: 'string',
              example: '75201',
            },
          },
          {
            name: 'limit',
            in: 'query',
            description: 'Maximum number of items to return',
            required: false,
            schema: {
              type: 'integer',
              minimum: 1,
              example: 50,
            },
          },
        ],
        responses: {
          200: {
            description: 'List of contacts returned successfully.',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: {
                    $ref: '#/components/schemas/Contact',
                  },
                },
              },
            },
          },
          400: {
            $ref: '#/components/responses/BadRequestError',
          },
          500: {
            $ref: '#/components/responses/InternalServerError',
          },
        },
      },
      post: {
        summary: 'Create a New Contact',
        description: 'Creates a new contact record in the PostgreSQL database.',
        tags: ['Contacts'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/CreateContactDTO',
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Contact created successfully.',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/Contact',
                },
              },
            },
          },
          400: {
            $ref: '#/components/responses/BadRequestError',
          },
          500: {
            $ref: '#/components/responses/InternalServerError',
          },
        },
      },
    },
    '/api/contacts/{id}': {
      get: {
        summary: 'Get Contact by ID',
        description: 'Retrieves a single contact record by its integer ID.',
        tags: ['Contacts'],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Integer ID of the contact',
            schema: {
              type: 'integer',
              example: 1,
            },
          },
        ],
        responses: {
          200: {
            description: 'Contact found.',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/Contact',
                },
              },
            },
          },
          400: {
            $ref: '#/components/responses/BadRequestError',
          },
          404: {
            $ref: '#/components/responses/NotFoundError',
          },
          500: {
            $ref: '#/components/responses/InternalServerError',
          },
        },
      },
      put: {
        summary: 'Update Contact',
        description: 'Updates an existing contact record by its integer ID.',
        tags: ['Contacts'],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Integer ID of the contact to update',
            schema: {
              type: 'integer',
              example: 1,
            },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/UpdateContactDTO',
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Contact updated successfully.',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/Contact',
                },
              },
            },
          },
          400: {
            $ref: '#/components/responses/BadRequestError',
          },
          404: {
            $ref: '#/components/responses/NotFoundError',
          },
          500: {
            $ref: '#/components/responses/InternalServerError',
          },
        },
      },
      delete: {
        summary: 'Delete Contact',
        description: 'Deletes a contact record by its integer ID from the PostgreSQL database.',
        tags: ['Contacts'],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Integer ID of the contact to delete',
            schema: {
              type: 'integer',
              example: 1,
            },
          },
        ],
        responses: {
          200: {
            description: 'Contact deleted successfully.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    message: {
                      type: 'string',
                      example: 'Contact with ID 1 has been deleted successfully.',
                    },
                  },
                },
              },
            },
          },
          400: {
            $ref: '#/components/responses/BadRequestError',
          },
          404: {
            $ref: '#/components/responses/NotFoundError',
          },
          500: {
            $ref: '#/components/responses/InternalServerError',
          },
        },
      },
    },
    '/api/checkins': {
      get: {
        summary: 'List All Checkins',
        description: 'Retrieves checkin records ordered by ID descending from the PostgreSQL database, with optional filtering by contact_id or event_id, and pagination.',
        tags: ['Checkins'],
        parameters: [
          {
            name: 'contact_id',
            in: 'query',
            description: 'Filter checkins by contact integer ID',
            required: false,
            schema: {
              type: 'integer',
              minimum: 1,
              example: 1,
            },
          },
          {
            name: 'event_id',
            in: 'query',
            description: 'Filter checkins by the BIGINT events.id foreign key.',
            required: false,
            schema: {
              type: 'integer',
              format: 'int64',
              minimum: 1,
              example: 42,
            },
          },
          {
            name: 'include_contact',
            in: 'query',
            description: 'Whether to include the joined contact: false, partial, or full. Defaults to false.',
            required: false,
            schema: {
              type: 'string',
              enum: ['false', 'partial', 'full'],
              default: 'false',
              example: 'partial',
            },
          },
          {
            name: 'limit',
            in: 'query',
            description: 'Maximum number of checkin records to return',
            required: false,
            schema: {
              type: 'integer',
              minimum: 1,
              example: 50,
            },
          },
          {
            name: 'offset',
            in: 'query',
            description: 'Number of checkin records to skip for pagination',
            required: false,
            schema: {
              type: 'integer',
              minimum: 0,
              example: 0,
            },
          },
        ],
        responses: {
          200: {
            description: 'List of checkins returned successfully.',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: {
                    $ref: '#/components/schemas/Checkin',
                  },
                },
              },
            },
          },
          400: {
            $ref: '#/components/responses/BadRequestError',
          },
          500: {
            $ref: '#/components/responses/InternalServerError',
          },
        },
      },
      post: {
        summary: 'Create a New Checkin',
        description: 'Creates a new checkin record in the PostgreSQL database.',
        tags: ['Checkins'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/CreateCheckinDTO',
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Checkin created successfully.',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/Checkin',
                },
              },
            },
          },
          400: {
            $ref: '#/components/responses/BadRequestError',
          },
          500: {
            $ref: '#/components/responses/InternalServerError',
          },
        },
      },
    },
    '/api/checkins/{id}': {
      get: {
        summary: 'Get Checkin by ID',
        description: 'Retrieves a single checkin record by its integer ID from the PostgreSQL database.',
        tags: ['Checkins'],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Integer ID (bigint) of the checkin record',
            schema: {
              type: 'integer',
              example: 1,
            },
          },
          {
            name: 'include_contact',
            in: 'query',
            description: 'Whether to include the joined contact: false, partial, or full. Defaults to false.',
            required: false,
            schema: {
              type: 'string',
              enum: ['false', 'partial', 'full'],
              default: 'false',
              example: 'partial',
            },
          },
        ],
        responses: {
          200: {
            description: 'Checkin record retrieved successfully.',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/Checkin',
                },
              },
            },
          },
          400: {
            $ref: '#/components/responses/BadRequestError',
          },
          404: {
            $ref: '#/components/responses/NotFoundError',
          },
          500: {
            $ref: '#/components/responses/InternalServerError',
          },
        },
      },
      put: {
        summary: 'Update Checkin',
        description: 'Updates an existing checkin record by its integer ID.',
        tags: ['Checkins'],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Integer ID of the checkin to update',
            schema: {
              type: 'integer',
              example: 1,
            },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/UpdateCheckinDTO',
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Checkin updated successfully.',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/Checkin',
                },
              },
            },
          },
          400: {
            $ref: '#/components/responses/BadRequestError',
          },
          404: {
            $ref: '#/components/responses/NotFoundError',
          },
          500: {
            $ref: '#/components/responses/InternalServerError',
          },
        },
      },
      delete: {
        summary: 'Delete Checkin',
        description: 'Deletes a checkin record by its integer ID from the PostgreSQL database.',
        tags: ['Checkins'],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Integer ID of the checkin to delete',
            schema: {
              type: 'integer',
              example: 1,
            },
          },
        ],
        responses: {
          200: {
            description: 'Checkin deleted successfully.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    message: {
                      type: 'string',
                      example: 'Checkin with ID 1 has been deleted successfully.',
                    },
                  },
                },
              },
            },
          },
          400: {
            $ref: '#/components/responses/BadRequestError',
          },
          404: {
            $ref: '#/components/responses/NotFoundError',
          },
          500: {
            $ref: '#/components/responses/InternalServerError',
          },
        },
      },
    },
    '/api/suggestions/upload-url': {
      post: {
        summary: 'Generate Signed Photo Upload URL',
        description: 'Generates a temporary V4 signed Google Cloud Storage PUT URL allowing client applications to upload resized photos directly to Cloud Storage securely.',
        tags: ['Suggestions'],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  contentType: {
                    type: 'string',
                    enum: ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif', 'image/svg+xml'],
                    example: 'image/webp',
                    description: 'MIME type of the image to upload. SVG (image/svg+xml) is supported. Default: image/webp',
                  },
                  filename: {
                    type: 'string',
                    example: 'sidewalk-photo.webp',
                    description: 'Optional original filename used to preserve file extension.',
                  },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Signed upload URL generated successfully.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    message: {
                      type: 'string',
                      example: 'Signed upload URL generated successfully.',
                    },
                    data: {
                      type: 'object',
                      properties: {
                        uploadUrl: {
                          type: 'string',
                          format: 'uri',
                          description: 'Pre-authorized V4 signed PUT URL for uploading photo binary to GCS.',
                        },
                        publicUrl: {
                          type: 'string',
                          format: 'uri',
                          description: 'Permanent public read URL to store in the suggestion photos array.',
                        },
                        filePath: {
                          type: 'string',
                          example: 'suggestions/uploads/1695484800000-uuid.webp',
                        },
                        expiresAt: {
                          type: 'string',
                          format: 'date-time',
                          example: '2026-09-23T15:15:00.000Z',
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          400: {
            $ref: '#/components/responses/BadRequestError',
          },
          500: {
            $ref: '#/components/responses/InternalServerError',
          },
        },
      },
    },
    '/api/suggestions': {
      get: {
        summary: 'List All Suggestions',
        description: 'Retrieves a list of suggestions from the public-improvements database, with optional filters.',
        tags: ['Suggestions'],
        parameters: [
          {
            name: 'status',
            in: 'query',
            description: 'Filter suggestions by status',
            required: false,
            schema: {
              type: 'string',
              enum: ['new', 'inprogress', 'stalled', 'withdrawn', 'completed'],
            },
          },
          {
            name: 'authorEmail',
            in: 'query',
            description: 'Filter suggestions by author email',
            required: false,
            schema: {
              type: 'string',
              format: 'email',
            },
          },
          {
            name: 'limit',
            in: 'query',
            description: 'Maximum number of items to return',
            required: false,
            schema: {
              type: 'integer',
              minimum: 1,
              example: 20,
            },
          },
        ],
        responses: {
          200: {
            description: 'List of suggestions returned successfully.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      type: 'array',
                      items: {
                        $ref: '#/components/schemas/Suggestion',
                      },
                    },
                    count: {
                      type: 'integer',
                      example: 1,
                    },
                  },
                },
              },
            },
          },
          400: {
            $ref: '#/components/responses/BadRequestError',
          },
          500: {
            $ref: '#/components/responses/InternalServerError',
          },
        },
      },
      post: {
        summary: 'Create a New Suggestion',
        description: 'Creates a new civic improvement suggestion in the public-improvements database. The integer ID will be auto-generated sequentially if omitted.',
        tags: ['Suggestions'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/CreateSuggestionDTO',
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Suggestion created successfully.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    message: {
                      type: 'string',
                      example: 'Suggestion created successfully.',
                    },
                    data: {
                      $ref: '#/components/schemas/Suggestion',
                    },
                  },
                },
              },
            },
          },
          400: {
            $ref: '#/components/responses/BadRequestError',
          },
          409: {
            description: 'Conflict - Suggestion with provided ID already exists.',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse',
                },
              },
            },
          },
          500: {
            $ref: '#/components/responses/InternalServerError',
          },
        },
      },
    },
    '/api/suggestions/{suggestionId}/boundaries': {
      get: {
        summary: 'List Suggestion Boundaries', tags: ['Suggestions'], security: [{ ApiKeyAuth: [] }],
        description: 'Returns the boundary records associated with the suggestion when it was created.',
        parameters: [{ name: 'suggestionId', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }],
        responses: {
          200: { description: 'Boundaries returned.', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Boundary' } }, count: { type: 'integer' } } } } } },
          400: { $ref: '#/components/responses/BadRequestError' },
          404: { $ref: '#/components/responses/NotFoundError' },
        },
      },
    },
    '/api/suggestions/{suggestionId}/representatives': {
      get: {
        summary: 'List Suggestion Representatives', tags: ['Suggestions'], security: [{ ApiKeyAuth: [] }],
        description: 'Returns representatives linked to the suggestion’s stored boundaries. Currently serving representatives are returned by default; servingAsOf selects a date.',
        parameters: [
          { name: 'suggestionId', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
          { name: 'servingAsOf', in: 'query', description: 'Return representatives serving on this date; defaults to currently serving.', schema: { type: 'string', format: 'date' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, maximum: 100000, default: 0 } },
        ],
        responses: {
          200: { description: 'Representatives returned.', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Representative' } } } } },
          400: { $ref: '#/components/responses/BadRequestError' },
          404: { $ref: '#/components/responses/NotFoundError' },
        },
      },
    },
    '/api/suggestions/{suggestionId}/recommended-actions': {
      get: {
        summary: 'List Recommended Actions', tags: ['Suggestions'], security: [{ ApiKeyAuth: [] }],
        description: 'Lists actions for a Suggestion. Expired actions are excluded unless includeExpired=true.',
        parameters: [
          { name: 'suggestionId', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
          { name: 'status', in: 'query', schema: { $ref: '#/components/schemas/RecommendedActionStatus' } },
          { name: 'includeExpired', in: 'query', schema: { type: 'boolean', default: false } },
        ],
        responses: { 200: { description: 'Actions returned.', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/RecommendedAction' } }, count: { type: 'integer' } } } } } }, 404: { $ref: '#/components/responses/NotFoundError' } },
      },
      post: {
        summary: 'Create Recommended Action', tags: ['Suggestions'], security: [{ ApiKeyAuth: [], BearerAuth: [] }],
        description: 'Staff only. representativeId is validated against PostgreSQL.',
        parameters: [{ name: 'suggestionId', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateRecommendedActionDTO' } } } },
        responses: { 201: { description: 'Action created.', content: { 'application/json': { schema: { $ref: '#/components/schemas/RecommendedActionEnvelope' } } } }, 400: { $ref: '#/components/responses/BadRequestError' }, 401: { $ref: '#/components/responses/UnauthorizedError' }, 403: { $ref: '#/components/responses/ForbiddenError' }, 404: { $ref: '#/components/responses/NotFoundError' } },
      },
    },
    '/api/recommendables': {
      get: {
        summary: 'List approved Recommendable Actions', tags: ['Suggestions'], security: [{ ApiKeyAuth: [] }],
        responses: { 200: { description: 'Approved catalog entries.', content: { 'application/json': { schema: {
          type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/RecommendableAction' } }, count: { type: 'integer' } },
        } } } } },
      },
    },
    '/api/recommendables/{id}': {
      patch: {
        summary: 'Update Recommendable Action status', tags: ['Suggestions'], security: [{ ApiKeyAuth: [], BearerAuth: [] }], description: 'Staff only. Creates a versioned status snapshot; uncertain and closed entries are excluded from matching.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['approved', 'closed', 'uncertain'] } } } } } },
        responses: { 200: { description: 'Catalog status updated.' }, 400: { $ref: '#/components/responses/BadRequestError' }, 403: { $ref: '#/components/responses/ForbiddenError' }, 404: { $ref: '#/components/responses/NotFoundError' } },
      },
    },
    '/api/recommendables/candidates': {
      post: {
        summary: 'Extract a Recommendable Action candidate', tags: ['Suggestions'], security: [{ ApiKeyAuth: [], BearerAuth: [] }],
        description: 'Authenticated users may submit an official City of Dallas source URL, a description, and optional boundary IDs. The candidate is evidence-validated and queued for staff review.',
        requestBody: { required: true, content: { 'application/json': { schema: {
          type: 'object', required: ['sourceUrl', 'description'], properties: {
            sourceUrl: { type: 'string', format: 'uri' }, description: { type: 'string', maxLength: 5000 },
            boundaries: { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: 50 },
          },
        } } } },
        responses: { 201: { description: 'Candidate created.' }, 400: { $ref: '#/components/responses/BadRequestError' }, 401: { $ref: '#/components/responses/UnauthorizedError' }, 422: { description: 'No evidence-backed public input opportunity was found.' } },
      },
      get: {
        summary: 'List Recommendable Action candidates', tags: ['Suggestions'], security: [{ ApiKeyAuth: [], BearerAuth: [] }], description: 'Staff only.',
        responses: { 200: { description: 'Candidates returned.' }, 403: { $ref: '#/components/responses/ForbiddenError' } },
      },
    },
    '/api/recommendables/candidates/{id}': {
      patch: {
        summary: 'Approve or reject a candidate', tags: ['Suggestions'], security: [{ ApiKeyAuth: [], BearerAuth: [] }], description: 'Staff only. Approved entries become eligible for matching.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['decision'], properties: { decision: { type: 'string', enum: ['approve', 'reject'] } } } } } },
        responses: { 200: { description: 'Candidate reviewed.' }, 400: { $ref: '#/components/responses/BadRequestError' }, 403: { $ref: '#/components/responses/ForbiddenError' }, 404: { $ref: '#/components/responses/NotFoundError' } },
      },
    },
    '/api/suggestions/{suggestionId}/recommended-actions/{actionId}': {
      get: { summary: 'Get Recommended Action', tags: ['Suggestions'], security: [{ ApiKeyAuth: [] }], parameters: [{ name: 'suggestionId', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'actionId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Action found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/RecommendedActionEnvelope' } } } }, 404: { $ref: '#/components/responses/NotFoundError' } } },
      patch: { summary: 'Update Recommended Action', tags: ['Suggestions'], security: [{ ApiKeyAuth: [], BearerAuth: [] }], description: 'Staff only. Repeating the current status returns noOp=true and does not append a log entry.', parameters: [{ name: 'suggestionId', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'actionId', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/UpdateRecommendedActionDTO' } } } }, responses: { 200: { description: 'Action updated or unchanged.', content: { 'application/json': { schema: { $ref: '#/components/schemas/RecommendedActionEnvelope' } } } }, 400: { $ref: '#/components/responses/BadRequestError' }, 401: { $ref: '#/components/responses/UnauthorizedError' }, 403: { $ref: '#/components/responses/ForbiddenError' }, 404: { $ref: '#/components/responses/NotFoundError' } } },
      delete: { summary: 'Delete Recommended Action', tags: ['Suggestions'], security: [{ ApiKeyAuth: [], BearerAuth: [] }], parameters: [{ name: 'suggestionId', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'actionId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Action deleted.' }, 401: { $ref: '#/components/responses/UnauthorizedError' }, 403: { $ref: '#/components/responses/ForbiddenError' }, 404: { $ref: '#/components/responses/NotFoundError' } } },
    },
    '/api/suggestions/{suggestionId}/log': {
      get: { summary: 'List Suggestion Activity', tags: ['Suggestions'], security: [{ ApiKeyAuth: [] }], parameters: [{ name: 'suggestionId', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } }, { name: 'cursor', in: 'query', schema: { type: 'string' } }], responses: { 200: { description: 'Newest-first page of activity.', content: { 'application/json': { schema: { $ref: '#/components/schemas/LoggedActionPage' } } } }, 400: { $ref: '#/components/responses/BadRequestError' }, 404: { $ref: '#/components/responses/NotFoundError' } } },
      post: {
        summary: 'Append Suggestion Activity', tags: ['Suggestions'], security: [{ ApiKeyAuth: [], BearerAuth: [] }],
        description: 'Authenticated Suggestion author or staff. Actor and timestamp are server supplied.',
        parameters: [{ name: 'suggestionId', in: 'path', required: true, schema: { type: 'integer' } }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object', required: ['summary', 'description'],
                properties: { summary: { type: 'string' }, description: { type: 'string' } },
              },
            },
          },
        },
        responses: {
          201: { description: 'Activity appended.', content: { 'application/json': { schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/LoggedAction' } } } } } },
          400: { $ref: '#/components/responses/BadRequestError' }, 401: { $ref: '#/components/responses/UnauthorizedError' },
          403: { $ref: '#/components/responses/ForbiddenError' }, 404: { $ref: '#/components/responses/NotFoundError' },
        },
      },
    },
    '/api/suggestions/{id}': {
      get: {
        summary: 'Get Suggestion by ID',
        description: 'Retrieves a single suggestion by its integer ID.',
        tags: ['Suggestions'],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Integer ID of the suggestion',
            schema: {
              type: 'integer',
              example: 1,
            },
          },
        ],
        responses: {
          200: {
            description: 'Suggestion found.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: {
                      $ref: '#/components/schemas/Suggestion',
                    },
                    logNextCursor: { type: 'string', nullable: true },
                    logHasMore: { type: 'boolean' },
                  },
                },
              },
            },
          },
          400: {
            $ref: '#/components/responses/BadRequestError',
          },
          404: {
            $ref: '#/components/responses/NotFoundError',
          },
          500: {
            $ref: '#/components/responses/InternalServerError',
          },
        },
      },
      put: {
        summary: 'Update Suggestion',
        description: 'Updates an existing suggestion by its integer ID. Modification date will be refreshed automatically.',
        tags: ['Suggestions'],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Integer ID of the suggestion to update',
            schema: {
              type: 'integer',
              example: 1,
            },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/UpdateSuggestionDTO',
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Suggestion updated successfully.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    message: {
                      type: 'string',
                      example: 'Suggestion updated successfully.',
                    },
                    data: {
                      $ref: '#/components/schemas/Suggestion',
                    },
                  },
                },
              },
            },
          },
          400: {
            $ref: '#/components/responses/BadRequestError',
          },
          404: {
            $ref: '#/components/responses/NotFoundError',
          },
          500: {
            $ref: '#/components/responses/InternalServerError',
          },
        },
      },
      delete: {
        summary: 'Delete Suggestion',
        description: 'Deletes a suggestion by its integer ID from the public-improvements database.',
        tags: ['Suggestions'],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Integer ID of the suggestion to delete',
            schema: {
              type: 'integer',
              example: 1,
            },
          },
        ],
        responses: {
          200: {
            description: 'Suggestion deleted successfully.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    message: {
                      type: 'string',
                      example: 'Suggestion with ID 1 has been deleted successfully.',
                    },
                  },
                },
              },
            },
          },
          400: {
            $ref: '#/components/responses/BadRequestError',
          },
          404: {
            $ref: '#/components/responses/NotFoundError',
          },
          500: {
            $ref: '#/components/responses/InternalServerError',
          },
        },
      },
    },
    '/api/events': {
      get: {
        summary: 'List All Events',
        description: 'Retrieves event records from the PostgreSQL database ordered by start date, with filtering by status, hosting group, date range, category, and text search.',
        tags: ['Events'],
        parameters: [
          {
            name: 'status',
            in: 'query',
            description: 'Filter events by status (e.g. CONFIRMED, TENTATIVE, CANCELLED)',
            required: false,
            schema: {
              type: 'string',
              example: 'CONFIRMED',
            },
          },
          {
            name: 'is_hosted_by_du',
            in: 'query',
            description: 'Filter events hosted directly by Dallas Urbanists (true/false)',
            required: false,
            schema: {
              type: 'boolean',
              example: true,
            },
          },
          {
            name: 'start_after',
            in: 'query',
            description: 'Filter events starting on or after this ISO 8601 timestamp',
            required: false,
            schema: {
              type: 'string',
              format: 'date-time',
              example: '2026-10-01T00:00:00.000Z',
            },
          },
          {
            name: 'start_before',
            in: 'query',
            description: 'Filter events starting on or before this ISO 8601 timestamp',
            required: false,
            schema: {
              type: 'string',
              format: 'date-time',
              example: '2026-12-31T23:59:59.000Z',
            },
          },
          {
            name: 'category',
            in: 'query',
            description: 'Filter events containing this category tag',
            required: false,
            schema: {
              type: 'string',
              example: 'Advocacy',
            },
          },
          {
            name: 'search',
            in: 'query',
            description: 'Search substring in event title, description, or location',
            required: false,
            schema: {
              type: 'string',
              example: 'Downtown',
            },
          },
          {
            name: 'order',
            in: 'query',
            description: 'Sort ordering by event start timestamp (asc or desc)',
            required: false,
            schema: {
              type: 'string',
              enum: ['asc', 'desc'],
              default: 'asc',
            },
          },
          {
            name: 'limit',
            in: 'query',
            description: 'Maximum number of event records to return (default: 50)',
            required: false,
            schema: {
              type: 'integer',
              minimum: 1,
              example: 50,
            },
          },
          {
            name: 'offset',
            in: 'query',
            description: 'Number of records to skip for pagination (default: 0)',
            required: false,
            schema: {
              type: 'integer',
              minimum: 0,
              example: 0,
            },
          },
        ],
        responses: {
          200: {
            description: 'List of events retrieved successfully.',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/EventListResponse',
                },
              },
            },
          },
          500: {
            $ref: '#/components/responses/InternalServerError',
          },
        },
      },
      post: {
        summary: 'Create a New Event',
        description: 'Creates a new event record in the PostgreSQL database. Note that either end_at or duration must be provided, but not both.',
        tags: ['Events'],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/CreateEventDTO',
              },
            },
          },
        },
        responses: {
          201: {
            description: 'Event created successfully.',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/Event',
                },
              },
            },
          },
          400: {
            $ref: '#/components/responses/BadRequestError',
          },
          409: {
            description: 'Conflict - An event with the specified UID already exists.',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ErrorResponse',
                },
              },
            },
          },
          500: {
            $ref: '#/components/responses/InternalServerError',
          },
        },
      },
    },
    '/api/events/import-ical': {
      post: {
        summary: 'Bulk Import Events from iCal Feed',
        description: 'Fetches an upstream iCalendar (.ics) feed URL, parses VEVENT entries, and bulk upserts them into the PostgreSQL events table. Creates new records or updates existing records if the incoming iCal payload has higher sequence numbers or newer modification timestamps.',
        tags: ['Events'],
        requestBody: {
          required: false,
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ImportICalDTO',
              },
            },
          },
        },
        responses: {
          200: {
            description: 'iCal bulk import completed successfully.',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ImportICalResponse',
                },
              },
            },
          },
          400: {
            $ref: '#/components/responses/BadRequestError',
          },
          502: {
            $ref: '#/components/responses/BadGatewayError',
          },
        },
      },
    },
    '/api/events/{id}': {
      get: {
        summary: 'Get Event by ID or UID',
        description: 'Retrieves a single event record by its primary key ID (integer) or unique UID string.',
        tags: ['Events'],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Event database integer ID or unique UID string',
            schema: {
              type: 'string',
              example: '1',
            },
          },
        ],
        responses: {
          200: {
            description: 'Event record retrieved successfully.',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/Event',
                },
              },
            },
          },
          400: {
            $ref: '#/components/responses/BadRequestError',
          },
          404: {
            $ref: '#/components/responses/NotFoundError',
          },
          500: {
            $ref: '#/components/responses/InternalServerError',
          },
        },
      },
      put: {
        summary: 'Update Event',
        description: 'Updates an existing event record by its database ID or UID.',
        tags: ['Events'],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Event database integer ID or unique UID string',
            schema: {
              type: 'string',
              example: '1',
            },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/UpdateEventDTO',
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Event updated successfully.',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/Event',
                },
              },
            },
          },
          400: {
            $ref: '#/components/responses/BadRequestError',
          },
          404: {
            $ref: '#/components/responses/NotFoundError',
          },
          500: {
            $ref: '#/components/responses/InternalServerError',
          },
        },
      },
      patch: {
        summary: 'Partially Update Event',
        description: 'Applies partial updates to an existing event record by its ID or UID.',
        tags: ['Events'],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Event database integer ID or unique UID string',
            schema: {
              type: 'string',
              example: '1',
            },
          },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/UpdateEventDTO',
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Event updated successfully.',
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/Event',
                },
              },
            },
          },
          400: {
            $ref: '#/components/responses/BadRequestError',
          },
          404: {
            $ref: '#/components/responses/NotFoundError',
          },
          500: {
            $ref: '#/components/responses/InternalServerError',
          },
        },
      },
      delete: {
        summary: 'Delete Event',
        description: 'Deletes an event record by its integer ID or unique UID from the PostgreSQL database.',
        tags: ['Events'],
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Event database integer ID or unique UID string',
            schema: {
              type: 'string',
              example: '1',
            },
          },
        ],
        responses: {
          200: {
            description: 'Event deleted successfully.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    message: {
                      type: 'string',
                      example: 'Event with identifier 1 has been deleted successfully.',
                    },
                  },
                },
              },
            },
          },
          400: {
            $ref: '#/components/responses/BadRequestError',
          },
          404: {
            $ref: '#/components/responses/NotFoundError',
          },
          500: {
            $ref: '#/components/responses/InternalServerError',
          },
        },
      },
    },
    '/api/events/ical': {
      get: {
        summary: 'Proxy Meetup iCal Event Feed',
        description: 'Fetches and returns the Meetup iCalendar (.ics) feed for Dallas Urbanists with CORS enabled, allowing web clients to retrieve and parse event schedules.',
        tags: ['Events'],
        responses: {
          200: {
            description: 'iCalendar feed retrieved successfully.',
            headers: {
              'Content-Type': {
                schema: {
                  type: 'string',
                  example: 'text/calendar; charset=utf-8',
                },
                description: 'MIME type of the iCalendar stream',
              },
              'Cache-Control': {
                schema: {
                  type: 'string',
                  example: 'public, max-age=300, stale-while-revalidate=600',
                },
                description: 'Caching directive for client applications',
              },
            },
            content: {
              'text/calendar': {
                schema: {
                  type: 'string',
                  example: 'BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Meetup//RemoteApi//EN\n...',
                },
              },
            },
          },
          502: {
            $ref: '#/components/responses/BadGatewayError',
          },
        },
      },
    },
    '/meetup-ical': {
      get: {
        summary: 'Proxy Meetup iCal Event Feed (Path Alias)',
        description: 'Alias for /api/events/ical directly matching check-in helper frontend proxy configurations.',
        tags: ['Events'],
        responses: {
          200: {
            description: 'iCalendar feed retrieved successfully.',
            content: {
              'text/calendar': {
                schema: {
                  type: 'string',
                },
              },
            },
          },
          502: {
            $ref: '#/components/responses/BadGatewayError',
          },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        description: 'Local development API key from API_KEYS_JSON.',
      },
      AppCheckAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Firebase-AppCheck',
        description: 'Required in production for API-key-required endpoints; optional in development.',
      },
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Firebase Authentication ID token.',
      },
    },
    schemas: {
          ...operationSchemas,
          ...boundarySchemas,
      Representative: {
        type: 'object',
        required: ['id', 'boundaryId', 'boundary', 'researchService', 'lastResearchSync', 'researchSyncTTL'],
        properties: {
          id: { type: 'integer', example: 1 },
          boundaryId: { type: 'integer' },
          boundary: { $ref: '#/components/schemas/Boundary' },
          researchService: { $ref: '#/components/schemas/ServiceDescriptor' },
          lastResearchSync: { type: 'string', format: 'date-time', nullable: true },
          researchSyncTTL: { type: 'integer', minimum: 1, default: 60 },
          title: { type: 'string', nullable: true, example: 'Council member' },
          name: { type: 'string', nullable: true, example: 'Jane Doe' },
          bio: { type: 'string', nullable: true },
          webpage_url: { type: 'string', format: 'uri', nullable: true },
          photo_url: { type: 'string', format: 'uri', nullable: true },
          emails: { type: 'array', nullable: true, items: { type: 'object' } },
          phones: { type: 'array', nullable: true, items: { type: 'object' } },
          social_accounts: { type: 'array', nullable: true, items: { type: 'object' } },
          elections: {
            type: 'array',
            nullable: true,
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                date: { type: 'string', format: 'date' },
                early_vote_start: { type: 'string', format: 'date' },
                early_vote_end: { type: 'string', format: 'date' },
                status: { type: 'string' },
              },
            },
          },
          start: { type: 'string', format: 'date-time', nullable: true },
          end: { type: 'string', format: 'date-time', nullable: true           },
        },
      },
      Contact: {
        type: 'object',
        required: ['id', 'name', 'created_on'],
        properties: {
          id: {
            type: 'integer',
            example: 1,
            description: 'Unique integer identifier (bigint) for the contact',
          },
          name: {
            type: 'string',
            example: 'Jane Doe',
            description: 'Full name of the contact',
          },
          created_on: {
            type: 'string',
            format: 'date-time',
            example: '2026-09-30T10:00:00.000Z',
            description: 'Timestamp with time zone when the contact was created',
          },
          emails: {
            type: 'array',
            items: {
              type: 'string',
              format: 'email',
            },
            nullable: true,
            example: ['jane.doe@example.com', 'j.doe@work.org'],
            description: 'List of email addresses associated with the contact',
          },
          phones: {
            type: 'array',
            items: {
              type: 'string',
            },
            nullable: true,
            example: ['+1-214-555-0199'],
            description: 'List of phone numbers associated with the contact',
          },
          zip_home: {
            type: 'string',
            nullable: true,
            example: '75201',
            description: 'Primary residential ZIP code',
          },
          zip_other: {
            type: 'array',
            items: {
              type: 'string',
            },
            nullable: true,
            example: ['75202', '75204'],
            description: 'Other relevant ZIP codes (work, advocacy areas, etc.)',
          },
          roles: {
            type: 'array',
            items: {
              type: 'string',
            },
            nullable: true,
            example: ['volunteer', 'donor', 'advocate'],
            description: 'Roles assigned to this contact',
          },
        },
      },
      CreateContactDTO: {
        type: 'object',
        required: ['name'],
        properties: {
          name: {
            type: 'string',
            example: 'Jane Doe',
            description: 'Full name of the contact',
          },
          emails: {
            type: 'array',
            items: {
              type: 'string',
              format: 'email',
            },
            example: ['jane.doe@example.com'],
            description: 'List of email addresses',
          },
          phones: {
            type: 'array',
            items: {
              type: 'string',
            },
            example: ['+1-214-555-0199'],
            description: 'List of phone numbers',
          },
          zip_home: {
            type: 'string',
            example: '75201',
            description: 'Primary residential ZIP code',
          },
          zip_other: {
            type: 'array',
            items: {
              type: 'string',
            },
            example: ['75202'],
            description: 'Additional ZIP codes',
          },
          challenge_answer: {
            type: 'integer',
            minimum: 0,
            description: 'Required only when duplicate matches are found. Send the answer from the challenge prompt returned by the previous request.',
            example: 1,
          },
        },
      },
      UpdateContactDTO: {
        type: 'object',
              minProperties: 1,
              description: 'Authorized partial update: omitted fields are preserved; null, empty arrays and legacy empty strings explicitly clear nullable fields. Empty name is invalid. Only staff may change or clear roles/firebase_uid. Ordinary non-owner updates remain additive and cannot clear.',
        properties: {
          name: {
            type: 'string',
            example: 'Jane Doe',
            description: 'Updated full name of the contact',
          },
          emails: {
            type: 'array',
            items: {
              type: 'string',
              format: 'email',
            },
            example: ['jane.doe@example.com'],
            description: 'Updated list of email addresses',
          },
          phones: {
            type: 'array',
            items: {
              type: 'string',
            },
            example: ['+1-214-555-0199'],
            description: 'Updated list of phone numbers',
          },
          zip_home: {
            type: 'string',
            example: '75201',
            description: 'Updated primary residential ZIP code',
          },
          zip_other: {
            type: 'array',
            items: {
              type: 'string',
            },
            example: ['75202', '75204'],
            description: 'Updated additional ZIP codes',
          },
          roles: {
            type: 'array',
            items: {
              type: 'string',
            },
            example: ['volunteer', 'organizer'],
            description: 'Updated roles assigned to the contact',
          },
        },
      },
      Checkin: {
        type: 'object',
        required: ['id', 'event_id', 'submitted_on'],
        properties: {
          id: {
            type: 'integer',
            example: 1,
            description: 'Unique integer identifier (bigint) for the checkin',
          },
          contact_id: {
            type: 'integer',
            nullable: true,
            example: 42,
            description: 'ID of the associated contact (bigint), or null if anonymous checkin',
          },
          event_id: {
            type: 'integer',
            format: 'int64',
            minimum: 1,
            example: 42,
            description: 'BIGINT foreign key referencing events.id.',
          },
          submitted_on: {
            type: 'string',
            format: 'date-time',
            example: '2026-10-01T14:30:00.000Z',
            description: 'Timestamp with time zone when checkin occurred',
          },
        },
      },
      CreateCheckinDTO: {
        type: 'object',
        required: ['event_id'],
        properties: {
          contact_id: {
            type: 'integer',
            nullable: true,
            example: 42,
            description: 'Optional ID of the associated contact (bigint)',
          },
          event_id: {
            type: 'integer',
            format: 'int64',
            minimum: 1,
            example: 42,
            description: 'BIGINT foreign key referencing events.id.',
          },
        },
      },
      UpdateCheckinDTO: {
        type: 'object',
              minProperties: 1,
              properties: {
                submitted_on: {
                  type: 'string',
                  format: 'date-time',
                  description: 'RFC 3339 with explicit offset, up to six fractional digits. Inclusive bounds: start minus two hours through end plus one hour, or start plus four hours if no end. Omission preserves the timestamp. Moving event_id also validates the retained timestamp.',
                },
          contact_id: {
            type: 'integer',
            nullable: true,
            example: 42,
            description: 'Updated associated contact ID (bigint) or null',
          },
          event_id: {
            type: 'integer',
            format: 'int64',
            minimum: 1,
            example: 42,
            description: 'Updated BIGINT foreign key referencing events.id.',
          },
        },
      },
      SuggestionPhoto: {
        type: 'object',
        required: ['url', 'caption', 'timestamp'],
        properties: {
          url: {
            type: 'string',
            format: 'uri',
            description: 'Public URL of the photo (hosted on Cloud Storage/CDN)',
            example: 'https://storage.googleapis.com/urbanists-suggestion-photos/suggestions/1/elm-street-lane.webp',
          },
          caption: {
            type: 'string',
            description: 'Caption or description for the photo',
            example: 'Current sidewalk layout showing lack of protected barrier',
          },
          timestamp: {
            type: 'string',
            format: 'date-time',
            description: 'ISO 8601 timestamp when photo was taken or uploaded',
            example: '2026-09-23T14:30:00.000Z',
          },
        },
      },
      SuggestionAuthor: {
        type: 'object',
        required: ['email', 'name'],
        properties: {
          email: {
            type: 'string',
            format: 'email',
            example: 'alex@dallasurbanists.org',
          },
          name: {
            type: 'string',
            example: 'Alex Rivera',
          },
        },
      },
      SuggestionContent: {
        type: 'object',
        required: ['summary'],
        properties: {
          summary: {
            type: 'string',
            example: 'Add protected bike lane and shade trees along Elm Street',
          },
          details: {
            type: 'string',
            default: '',
            example: 'Installing concrete bollards and native Texas oak trees will increase pedestrian safety and lower summer heat.',
          },
          photos: {
            type: 'array',
            description: 'Optional list of photos associated with the suggestion (max 10 photos).',
            maxItems: 10,
            items: {
              $ref: '#/components/schemas/SuggestionPhoto',
            },
          },
        },
      },
      SuggestionLocation: {
        type: 'object',
        properties: {
          latitude: {
            type: 'number',
            format: 'float',
            nullable: true,
            example: 32.78014,
          },
          longitude: {
            type: 'number',
            format: 'float',
            nullable: true,
            example: -96.79701,
          },
          description: {
            type: 'string',
            default: '',
            example: 'Intersection of Elm St and N Akard St in Downtown Dallas',
          },
          address: {
            type: 'string',
            default: '',
            example: '1500 Elm St, Dallas, TX 75201',
          },
        },
      },
      Suggestion: {
        type: 'object',
        required: ['id', 'creationDate', 'modificationDate', 'status', 'author', 'content', 'location'],
        properties: {
          id: {
            type: 'integer',
            example: 1,
            description: 'Unique integer identifier for the suggestion',
          },
          creationDate: {
            type: 'string',
            format: 'date-time',
            example: '2026-09-23T14:30:00.000Z',
          },
          modificationDate: {
            type: 'string',
            format: 'date-time',
            example: '2026-09-23T14:30:00.000Z',
          },
          status: {
            type: 'string',
            enum: ['new', 'inprogress', 'stalled', 'withdrawn', 'completed'],
            example: 'new',
          },
          author: {
            $ref: '#/components/schemas/SuggestionAuthor',
          },
          content: {
            $ref: '#/components/schemas/SuggestionContent',
          },
          location: {
            $ref: '#/components/schemas/SuggestionLocation',
          },
          log: { type: 'array', description: 'Newest page of activity. Suggestion list results omit this field.', items: { $ref: '#/components/schemas/LoggedAction' } },
        },
      },
      RecommendedActionStatus: { type: 'string', enum: ['open', 'ignored', 'started', 'paused', 'cancelled', 'finished'] },
      RecommendableAction: { type: 'object', required: ['id', 'summary', 'instructions', 'reason', 'boundaries', 'sourceUrl', 'sourceEvidence', 'sourceDescription', 'status', 'version'], properties: { id: { type: 'string' }, summary: { type: 'string' }, instructions: { type: 'string' }, reason: { type: 'string' }, boundaries: { type: 'array', description: 'Empty means unrestricted; any one matching suggestion boundary is sufficient.', items: { type: 'integer' } }, sourceUrl: { type: 'string', format: 'uri' }, sourceEvidence: { type: 'string' }, sourceDescription: { type: 'string' }, status: { type: 'string', enum: ['candidate', 'approved', 'closed', 'uncertain', 'rejected'] }, version: { type: 'integer' }, confidence: { type: 'number', nullable: true }, createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' } } },
      RecommendedAction: { type: 'object', required: ['id', 'summary', 'instructions', 'representativeId', 'reason', 'expirationDate', 'status', 'creationDate', 'modificationDate'], properties: { id: { type: 'string' }, summary: { type: 'string' }, instructions: { type: 'string' }, representativeId: { type: 'integer', nullable: true }, reason: { type: 'string' }, expirationDate: { type: 'string', format: 'date-time', nullable: true }, status: { $ref: '#/components/schemas/RecommendedActionStatus' }, recommendableId: { type: 'string' }, matchProbability: { type: 'number', minimum: 0, maximum: 1 }, creationDate: { type: 'string', format: 'date-time' }, modificationDate: { type: 'string', format: 'date-time' } } },
      CreateRecommendedActionDTO: { type: 'object', required: ['summary', 'instructions', 'reason'], properties: { summary: { type: 'string' }, instructions: { type: 'string' }, representativeId: { type: 'integer', nullable: true }, reason: { type: 'string' }, expirationDate: { type: 'string', format: 'date-time', nullable: true }, status: { $ref: '#/components/schemas/RecommendedActionStatus' } } },
      UpdateRecommendedActionDTO: { type: 'object', minProperties: 1, properties: { summary: { type: 'string' }, instructions: { type: 'string' }, representativeId: { type: 'integer', nullable: true }, reason: { type: 'string' }, expirationDate: { type: 'string', format: 'date-time', nullable: true }, status: { $ref: '#/components/schemas/RecommendedActionStatus' } }, description: 'Partial update; id and dates are server managed.' },
      RecommendedActionEnvelope: { type: 'object', properties: { message: { type: 'string' }, data: { $ref: '#/components/schemas/RecommendedAction' }, noOp: { type: 'boolean' } } },
      LoggedAction: { type: 'object', required: ['id', 'summary', 'description', 'actor', 'timestamp'], properties: { id: { type: 'string' }, summary: { type: 'string' }, description: { type: 'string' }, actor: { type: 'object', required: ['name', 'email'], properties: { name: { type: 'string' }, email: { type: 'string', format: 'email' } } }, timestamp: { type: 'string', format: 'date-time' } } },
      LoggedActionPage: { type: 'object', required: ['data', 'nextCursor', 'hasMore'], properties: { data: { type: 'array', items: { $ref: '#/components/schemas/LoggedAction' } }, nextCursor: { type: 'string', nullable: true }, hasMore: { type: 'boolean' } } },
      CreateSuggestionDTO: {
        type: 'object',
        required: ['author', 'content'],
        properties: {
          id: {
            type: 'integer',
            description: 'Optional positive integer ID. If omitted, sequential ID will be assigned automatically.',
            example: 1,
          },
          status: {
            type: 'string',
            enum: ['new', 'inprogress', 'stalled', 'withdrawn', 'completed'],
            default: 'new',
            example: 'new',
          },
          author: {
            $ref: '#/components/schemas/SuggestionAuthor',
          },
          content: {
            $ref: '#/components/schemas/SuggestionContent',
          },
          location: {
            $ref: '#/components/schemas/SuggestionLocation',
          },
        },
      },
      UpdateSuggestionDTO: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['new', 'inprogress', 'stalled', 'withdrawn', 'completed'],
            example: 'inprogress',
          },
          author: {
            type: 'object',
            properties: {
              email: {
                type: 'string',
                format: 'email',
                example: 'alex@dallasurbanists.org',
              },
              name: {
                type: 'string',
                example: 'Alex Rivera',
              },
            },
          },
          content: {
            type: 'object',
            properties: {
              summary: {
                type: 'string',
                example: 'Updated: Add protected bike lane and shade trees',
              },
              details: {
                type: 'string',
                example: 'Updated details with community petition signatures.',
              },
              photos: {
                type: 'array',
                description: 'Optional updated list of photos (max 10 photos).',
                maxItems: 10,
                items: {
                  $ref: '#/components/schemas/SuggestionPhoto',
                },
              },
            },
          },
          location: {
            type: 'object',
            properties: {
              latitude: {
                type: 'number',
                format: 'float',
                example: 32.78014,
              },
              longitude: {
                type: 'number',
                format: 'float',
                example: -96.79701,
              },
              description: {
                type: 'string',
                example: 'Elm St corridor',
              },
              address: {
                type: 'string',
                example: '1500 Elm St, Dallas, TX 75201',
              },
            },
          },
        },
      },
      Event: {
        type: 'object',
        required: ['id', 'uid', 'start_at', 'all_day', 'sequence', 'is_hosted_by_du', 'created_at', 'updated_at'],
        properties: {
          id: {
            type: 'integer',
            example: 1,
            description: 'Unique database identifier (bigint)',
          },
          uid: {
            type: 'string',
            example: 'meetup-event-304918231@meetup.com',
            description: 'Unique iCalendar UID or external system identifier',
          },
          start_at: {
            type: 'string',
            format: 'date-time',
            example: '2026-10-15T19:00:00.000Z',
            description: 'Event start timestamp with timezone',
          },
          end_at: {
            type: 'string',
            format: 'date-time',
            nullable: true,
            example: '2026-10-15T21:00:00.000Z',
            description: 'Event end timestamp with timezone (mutually exclusive with duration)',
          },
          duration: {
            type: 'string',
            nullable: true,
            example: 'PT2H',
            description: 'ISO 8601 or Postgres interval duration (mutually exclusive with end_at)',
          },
          all_day: {
            type: 'boolean',
            example: false,
            description: 'Flag indicating if this is an all-day event',
          },
          timezone: {
            type: 'string',
            nullable: true,
            example: 'America/Chicago',
            description: 'Timezone identifier for the event',
          },
          title: {
            type: 'string',
            nullable: true,
            example: 'Dallas Urbanists Monthly Meeting: Transit Futures',
            description: 'Event title or summary',
          },
          description: {
            type: 'string',
            nullable: true,
            example: 'Join us to discuss upcoming DART transit expansion plans and walkability initiatives.',
            description: 'Detailed description of the event',
          },
          location: {
            type: 'string',
            nullable: true,
            example: 'Pegasus City Brewery, 1508 Commerce St, Dallas, TX 75201',
            description: 'Human-readable location or address',
          },
          url: {
            type: 'string',
            format: 'uri',
            nullable: true,
            example: 'https://www.meetup.com/dallasurbanists/events/304918231/',
            description: 'Web URL for event details or registration',
          },
          status: {
            type: 'string',
            nullable: true,
            example: 'CONFIRMED',
            description: 'Event status (e.g. CONFIRMED, TENTATIVE, CANCELLED)',
          },
          img: {
            type: 'string',
            format: 'uri',
            nullable: true,
            example: 'https://secure.meetupstatic.com/photos/event/6/a/1/highres_518281729.webp',
            description: 'Banner or feature image URL for the event',
          },
          classification: {
            type: 'string',
            nullable: true,
            example: 'PUBLIC',
            description: 'Access classification (e.g. PUBLIC, PRIVATE, CONFIDENTIAL)',
          },
          sequence: {
            type: 'integer',
            example: 0,
            description: 'iCal revision sequence counter',
          },
          organizer_name: {
            type: 'string',
            nullable: true,
            example: 'Dallas Urbanists',
            description: 'Name of the organizing individual or entity',
          },
          organizer_email: {
            type: 'string',
            format: 'email',
            nullable: true,
            example: 'events@dallasurbanists.org',
            description: 'Contact email address of the organizer',
          },
          recurrence_rule: {
            type: 'string',
            nullable: true,
            example: 'FREQ=MONTHLY;BYDAY=3TH',
            description: 'RFC 5545 recurrence rule string (RRULE)',
          },
          recurrence_id: {
            type: 'string',
            format: 'date-time',
            nullable: true,
            description: 'Recurrence instance timestamp identifier',
          },
          categories: {
            type: 'array',
            items: {
              type: 'string',
            },
            nullable: true,
            example: ['Transit', 'Advocacy', 'Social'],
            description: 'Tags or categories associated with the event',
          },
          resources: {
            type: 'array',
            items: {
              type: 'string',
            },
            nullable: true,
            description: 'Resources or equipment allocated for the event',
          },
          attachments: {
            type: 'array',
            items: {
              type: 'object',
            },
            nullable: true,
            description: 'JSON array or object of event attachments and media',
          },
          geo_latitude: {
            type: 'number',
            format: 'float',
            nullable: true,
            example: 32.78014,
            description: 'Latitude coordinate (NUMERIC 9,6)',
          },
          geo_longitude: {
            type: 'number',
            format: 'float',
            nullable: true,
            example: -96.79701,
            description: 'Longitude coordinate (NUMERIC 9,6)',
          },
          is_hosted_by_du: {
            type: 'boolean',
            example: true,
            description: 'Flag indicating whether Dallas Urbanists is hosting or co-hosting',
          },
          ical_raw: {
            type: 'string',
            nullable: true,
            description: 'Raw VEVENT string from original iCalendar source',
          },
          ical_dtstamp: {
            type: 'string',
            format: 'date-time',
            example: '2026-10-02T20:00:00.000Z',
            description: 'iCal feed generation timestamp',
          },
          ical_created: {
            type: 'string',
            format: 'date-time',
            nullable: true,
            description: 'Timestamp when event was created in original calendar',
          },
          ical_last_modified: {
            type: 'string',
            format: 'date-time',
            nullable: true,
            description: 'Timestamp when event was last modified in original calendar',
          },
          created_at: {
            type: 'string',
            format: 'date-time',
            example: '2026-10-02T20:00:00.000Z',
            description: 'Timestamp when record was created in database',
          },
          updated_at: {
            type: 'string',
            format: 'date-time',
            example: '2026-10-02T20:00:00.000Z',
            description: 'Timestamp when record was last updated in database',
          },
        },
      },
      CreateEventDTO: {
        type: 'object',
        required: ['uid', 'start_at'],
        properties: {
          uid: {
            type: 'string',
            example: 'meetup-event-304918231@meetup.com',
            description: 'Unique event identifier',
          },
          start_at: {
            type: 'string',
            format: 'date-time',
            example: '2026-10-15T19:00:00.000Z',
            description: 'Start timestamp (ISO 8601)',
          },
          end_at: {
            type: 'string',
            format: 'date-time',
            example: '2026-10-15T21:00:00.000Z',
            description: 'End timestamp (mutually exclusive with duration)',
          },
          duration: {
            type: 'string',
            example: 'PT2H',
            description: 'Duration interval (mutually exclusive with end_at)',
          },
          all_day: {
            type: 'boolean',
            example: false,
          },
          timezone: {
            type: 'string',
            example: 'America/Chicago',
          },
          title: {
            type: 'string',
            example: 'Dallas Urbanists Monthly Meeting',
          },
          description: {
            type: 'string',
            example: 'Discussion on transit and safe streets.',
          },
          location: {
            type: 'string',
            example: 'Pegasus City Brewery, 1508 Commerce St, Dallas, TX 75201',
          },
          url: {
            type: 'string',
            format: 'uri',
            example: 'https://www.meetup.com/dallasurbanists/events/304918231/',
          },
          status: {
            type: 'string',
            example: 'CONFIRMED',
          },
          img: {
            type: 'string',
            format: 'uri',
            example: 'https://secure.meetupstatic.com/photos/event/6/a/1/highres_518281729.webp',
          },
          classification: {
            type: 'string',
            example: 'PUBLIC',
          },
          sequence: {
            type: 'integer',
            example: 0,
          },
          organizer_name: {
            type: 'string',
            example: 'Dallas Urbanists',
          },
          organizer_email: {
            type: 'string',
            format: 'email',
            example: 'events@dallasurbanists.org',
          },
          recurrence_rule: {
            type: 'string',
            example: 'FREQ=MONTHLY;BYDAY=3TH',
          },
          recurrence_id: {
            type: 'string',
            format: 'date-time',
          },
          categories: {
            type: 'array',
            items: {
              type: 'string',
            },
            example: ['Transit', 'Advocacy'],
          },
          resources: {
            type: 'array',
            items: {
              type: 'string',
            },
          },
          attachments: {
            type: 'array',
            items: {
              type: 'object',
            },
          },
          geo_latitude: {
            type: 'number',
            format: 'float',
            example: 32.78014,
          },
          geo_longitude: {
            type: 'number',
            format: 'float',
            example: -96.79701,
          },
          is_hosted_by_du: {
            type: 'boolean',
            example: true,
          },
          ical_raw: {
            type: 'string',
          },
          ical_dtstamp: {
            type: 'string',
            format: 'date-time',
          },
          ical_created: {
            type: 'string',
            format: 'date-time',
          },
          ical_last_modified: {
            type: 'string',
            format: 'date-time',
          },
        },
      },
      UpdateEventDTO: {
        type: 'object',
        properties: {
          uid: {
            type: 'string',
            example: 'meetup-event-304918231@meetup.com',
          },
          start_at: {
            type: 'string',
            format: 'date-time',
            example: '2026-10-15T19:00:00.000Z',
          },
          end_at: {
            type: 'string',
            format: 'date-time',
            nullable: true,
            example: '2026-10-15T21:00:00.000Z',
          },
          duration: {
            type: 'string',
            nullable: true,
            example: 'PT2H',
          },
          all_day: {
            type: 'boolean',
            example: false,
          },
          timezone: {
            type: 'string',
            example: 'America/Chicago',
          },
          title: {
            type: 'string',
            example: 'Dallas Urbanists Monthly Meeting (Updated)',
          },
          description: {
            type: 'string',
            example: 'Updated discussion agenda.',
          },
          location: {
            type: 'string',
            example: '1508 Commerce St, Dallas, TX 75201',
          },
          url: {
            type: 'string',
            format: 'uri',
            example: 'https://www.meetup.com/dallasurbanists/events/304918231/',
          },
          status: {
            type: 'string',
            example: 'CONFIRMED',
          },
          img: {
            type: 'string',
            format: 'uri',
          },
          classification: {
            type: 'string',
            example: 'PUBLIC',
          },
          sequence: {
            type: 'integer',
            example: 1,
          },
          organizer_name: {
            type: 'string',
            example: 'Dallas Urbanists',
          },
          organizer_email: {
            type: 'string',
            format: 'email',
            example: 'events@dallasurbanists.org',
          },
          recurrence_rule: {
            type: 'string',
          },
          recurrence_id: {
            type: 'string',
            format: 'date-time',
          },
          categories: {
            type: 'array',
            items: {
              type: 'string',
            },
            example: ['Transit', 'Advocacy'],
          },
          resources: {
            type: 'array',
            items: {
              type: 'string',
            },
          },
          attachments: {
            type: 'array',
            items: {
              type: 'object',
            },
          },
          geo_latitude: {
            type: 'number',
            format: 'float',
            nullable: true,
            example: 32.78014,
          },
          geo_longitude: {
            type: 'number',
            format: 'float',
            nullable: true,
            example: -96.79701,
          },
          is_hosted_by_du: {
            type: 'boolean',
            example: true,
          },
          ical_raw: {
            type: 'string',
          },
          ical_dtstamp: {
            type: 'string',
            format: 'date-time',
          },
          ical_created: {
            type: 'string',
            format: 'date-time',
          },
          ical_last_modified: {
            type: 'string',
            format: 'date-time',
          },
        },
      },
      ImportICalDTO: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            format: 'uri',
            example: 'https://www.meetup.com/dallasurbanists/events/ical/',
            description: 'Optional iCalendar feed URL. If omitted, defaults to the configured Dallas Urbanists Meetup feed URL.',
          },
          is_hosted_by_du: {
            type: 'boolean',
            default: true,
            example: true,
            description: 'Whether imported events should be tagged as hosted by Dallas Urbanists.',
          },
          force: {
            type: 'boolean',
            default: false,
            example: false,
            description: 'If true, forces overwrite of existing events even if sequence/timestamp is not newer.',
          },
        },
      },
      ImportICalItemResult: {
        type: 'object',
        required: ['uid', 'action'],
        properties: {
          uid: {
            type: 'string',
            example: 'meetup-event-304918231@meetup.com',
          },
          title: {
            type: 'string',
            nullable: true,
            example: 'Dallas Urbanists Monthly Meeting',
          },
          action: {
            type: 'string',
            enum: ['created', 'updated', 'skipped', 'error'],
            example: 'created',
          },
          reason: {
            type: 'string',
            example: 'Existing event is up-to-date or newer.',
          },
          id: {
            type: 'integer',
            example: 1,
          },
        },
      },
      ImportICalResponse: {
        type: 'object',
        required: ['message', 'sourceUrl', 'totalFound', 'created', 'updated', 'skipped', 'failed', 'items'],
        properties: {
          message: {
            type: 'string',
            example: 'Import completed: 5 created, 2 updated, 12 skipped, 0 failed.',
          },
          sourceUrl: {
            type: 'string',
            format: 'uri',
            example: 'https://www.meetup.com/dallasurbanists/events/ical/',
          },
          totalFound: {
            type: 'integer',
            example: 19,
          },
          created: {
            type: 'integer',
            example: 5,
          },
          updated: {
            type: 'integer',
            example: 2,
          },
          skipped: {
            type: 'integer',
            example: 12,
          },
          failed: {
            type: 'integer',
            example: 0,
          },
          items: {
            type: 'array',
            items: {
              $ref: '#/components/schemas/ImportICalItemResult',
            },
          },
        },
      },
      EventListResponse: {
        type: 'object',
        required: ['data', 'count', 'total'],
        properties: {
          data: {
            type: 'array',
            items: {
              $ref: '#/components/schemas/Event',
            },
          },
          count: {
            type: 'integer',
            example: 10,
            description: 'Number of event records in this page',
          },
          total: {
            type: 'integer',
            example: 45,
            description: 'Total matching event records in database',
          },
        },
      },
      HealthResponse: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            example: 'ok',
          },
          timestamp: {
            type: 'string',
            format: 'date-time',
            example: '2026-09-23T12:00:00.000Z',
          },
          service: {
            type: 'string',
            example: 'urbanists-cloud-api-server',
          },
          databases: {
            type: 'array',
            items: {
              type: 'string',
            },
            example: ['public-improvements'],
          },
        },
      },
      ErrorResponse: {
        type: 'object',
        properties: {
          error: {
            type: 'string',
            example: 'Bad Request',
          },
          message: {
            type: 'string',
            example: 'author.email is required and must be a valid email address.',
          },
        },
      },
    },
    responses: {
      BadRequestError: {
        description: 'Bad Request - Validation or parameter error.',
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/ErrorResponse',
            },
          },
        },
      },
      NotFoundError: {
        description: 'Not Found - Resource does not exist.',
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/ErrorResponse',
            },
          },
        },
      },
      UnauthorizedError: {
        description: 'Unauthorized - A valid API key or user token is required.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
      },
      ForbiddenError: {
        description: 'Forbidden - The authenticated user does not have the required role.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
      },
      InternalServerError: {
        description: 'Internal Server Error.',
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/ErrorResponse',
            },
          },
        },
      },
      BadGatewayError: {
        description: 'Bad Gateway - Upstream service failure or timeout.',
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/ErrorResponse',
            },
          },
        },
      },
    },
  },
};


swaggerDocument.tags.push({name:'Operations',description:'Account-bound atomic changes, discoverable history, and verified Undo.'});
for (const resource of ['contacts','checkins']) {
  const path = swaggerDocument.paths[`/api/${resource}/{id}`];
  for (const method of ['put','delete']) {
    path[method].parameters.push(...stagingParameters);
    Object.assign(path[method].responses,stagingResponses);
  }
  path.get.responses[200].headers = {ETag:{schema:{type:'string'},description:'Quoted opaque revision token for If-Match when staging.'}};
}
for (const schema of ['Contact','Checkin']) {
  swaggerDocument.components.schemas[schema].properties.revision = {type:'string',description:'Opaque resource revision token from reads; ordinary writes do not require it.'};
}
swaggerDocument.components.schemas.Checkin.properties.is_self = {type:'boolean',description:'Verified UID matches the linked contact; false for anonymous or unauthenticated rows.'};
swaggerDocument.paths['/api/checkins'].get.description += ' Non-staff attendance lists expose the authenticated attendee?s own full name and safe is_self marker; other contacts remain redacted. include_contact=false still omits contacts.';
for (const field of ['emails','phones','zip_home','zip_other','roles']) {
  swaggerDocument.components.schemas.UpdateContactDTO.properties[field].nullable = true;
}
swaggerDocument.components.schemas.UpdateContactDTO.properties.firebase_uid = {type:'string',nullable:true,description:'Staff-only assignment or explicit clearing; omission preserves the value.'};

swaggerDocument.components.schemas.User = {
  type: 'object',
  required: ['uid', 'email', 'displayName', 'disabled', 'staff'],
  properties: {
    uid: { type: 'string', description: 'Firebase Authentication UID (not a UUID).' },
    email: { type: 'string', nullable: true },
    displayName: { type: 'string', nullable: true },
    disabled: { type: 'boolean' },
    staff: { type: 'boolean', description: 'True only when the current stored custom claim staff is exactly boolean true; legacy role/roles claims are not counted.' },
  },
};
swaggerDocument.paths['/api/users'] = {
  get: {
    tags: ['Users'],
    summary: 'List all current users and staff status',
    description: 'Returns all existing Firebase Authentication users, including disabled accounts, as a JSON array. Reads all Firebase pages internally; no pagination parameters are needed. Requires a valid API key, a verified non-revoked Firebase ID token, and production App Check. Any authenticated user is allowed; no staff role is required. Missing email/name values are null. Password hashes, salts, provider data, and unrelated custom claims are not exposed.',
    security: [{ ApiKeyAuth: [], BearerAuth: [], AppCheckAuth: [] }],
    responses: {
      200: {
        description: 'All current users; an empty directory returns an empty array.',
        content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/User' } } } },
      },
      ...Object.fromEntries(Object.entries({
        401: 'Missing/invalid API key, ID token (including revoked/disabled users), or production App Check.',
        500: 'Firebase user listing failed; internal details and partial results are not exposed.',
      }).map(([status, description]) => [status, {
        description,
        content: { 'application/json': { schema: {
          type: 'object', required: ['error', 'message'],
          properties: { error: { type: 'string' }, message: { type: 'string' } },
        } } },
      }])),
    },
  },
};

swaggerDocument.paths['/api/users/{uid}/claims/staff'] = Object.fromEntries(
  ['put', 'delete'].map(method => [method, {
    tags: ['Users'],
    summary: method === 'put' ? 'Assign canonical staff claim' : 'Remove staff claims and revoke refresh tokens',
    description: 'Bodyless operation on a Firebase Authentication UID (not a UUID). Requires a valid API key, production App Check, and a verified non-revoked caller with staff:true. System-only and legacy staff roles are insufficient. Self-targeting is forbidden, including no-ops. Unrelated custom claims and roles are preserved; legacy staff entries in role/roles are removed. DELETE revokes refresh tokens on every success, including when staff was already absent. If revocation fails after the claims update, retry DELETE. PUT requires the target to refresh its ID token to observe staff:true.',
    security: [{ ApiKeyAuth: [], BearerAuth: [], AppCheckAuth: [] }],
    parameters: [{ name: 'uid', in: 'path', required: true, description: 'Firebase Authentication UID; URL-encode as a path segment.', schema: { type: 'string', minLength: 1, maxLength: 128 } }],
    responses: {
      204: { description: 'Claim operation completed; no response body.' },
      ...Object.fromEntries(Object.entries({
        400: 'Invalid Firebase UID (must contain 1–128 characters).',
        401: 'Missing/invalid API key, ID token (including revoked/disabled users), or production App Check.',
        403: 'Caller is not canonical staff, or targets their own UID.',
        404: 'Target Firebase user does not exist.',
        500: 'Claim update or token revocation failed; internal details are not exposed.',
      }).map(([status, description]) => [status, {
        description,
        content: { 'application/json': { schema: {
          type: 'object', required: ['error', 'message'],
          properties: { error: { type: 'string' }, message: { type: 'string' } },
        } } },
      }])),
    },
  }]),
);

swaggerDocument.components.schemas.GrammarInput = {
  type: 'object', required: ['text'], additionalProperties: false,
  properties: { text: { type: 'string', minLength: 1, maxLength: 5000, description: 'Nonblank prose; maximum 5000 Unicode code points. Whitespace is preserved. Recognizable code, HTML markup, and unsupported control characters are rejected.', example: 'Their is a meeting tomorrow.' } },
};
swaggerDocument.components.schemas.GrammarResponse = {
  type: 'object', required: ['data'], additionalProperties: false,
  properties: { data: {
    type: 'object', required: ['text'], additionalProperties: false,
    properties: { text: { type: 'string', minLength: 1, maxLength: 10000, example: 'There is a meeting tomorrow.' } },
  } },
};
swaggerDocument.components.schemas.GrammarError = {
  type: 'object', required: ['error', 'message'],
  properties: {
    error: { type: 'string' }, message: { type: 'string' },
    feedback: { type: 'array', description: 'Local code-screening feedback, when input is rejected. Source snippets are never echoed.', items: {
      type: 'object', required: ['reason', 'line'],
      properties: { reason: { type: 'string' }, line: { type: 'integer', minimum: 1 } },
    } },
  },
};
swaggerDocument.paths['/api/assist/grammar'] = {
  post: {
    tags: ['Assist'],
    summary: 'Correct grammar and spelling in prose',
    description: 'Uses Gemini 3.1 Flash-Lite with fixed server instructions and data-only input. Requires a valid application API key and production App Check. Firebase user sign-in is optional; invalid user tokens fall back to anonymous access. Only application/json with the text field is accepted, up to 5000 Unicode code points and 64 KiB encoded body. Recognizable executable snippets (including quoted code) and HTML markup are rejected before quota consumption or Gemini calls. Output is checked for shape, size, completion, and executable content. These are defense-in-depth controls, not guarantees of model correctness or exhaustive code detection. Preserves language and dialect rather than translating. No text is persisted or logged by this application. Shared fixed-window quotas and per-instance concurrency limits apply.',
    security: [{ ApiKeyAuth: [], AppCheckAuth: [] }, { ApiKeyAuth: [], AppCheckAuth: [], BearerAuth: [] }],
    requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/GrammarInput' } } } },
    responses: {
      200: {
        description: 'Corrected prose, or unchanged text if no corrections are needed.',
        headers: { 'Cache-Control': { schema: { type: 'string', example: 'no-store' } } },
        content: { 'application/json': { schema: { $ref: '#/components/schemas/GrammarResponse' } } },
      },
      ...Object.fromEntries(Object.entries({
        400: 'Invalid JSON, invalid text, unknown fields, or text exceeding 5000 Unicode code points.',
        401: 'Missing or invalid application API key or production App Check.',
        413: 'Encoded request body exceeds 64 KiB.',
        415: 'Content-Type must be application/json.',
        422: 'Recognizable executable content or unsupported controls detected (with local feedback), or model safety refusal.',
        429: 'Shared quota or per-instance concurrency limit reached; retry after the indicated delay.',
        500: 'Unexpected assistance failure; internal details are not exposed.',
        502: 'Provider failure, incomplete generation, or invalid/unsafe output.',
        503: 'Gemini or quota storage is unavailable, unconfigured, or misconfigured.',
        504: 'Gemini did not finish within the 20-second deadline.',
      }).map(([status, description]) => [status, {
        description,
        headers: {
          'Cache-Control': { schema: { type: 'string', example: 'no-store' } },
          ...(['429', '503'].includes(status) ? { 'Retry-After': { description: 'Seconds to wait when supplied.', schema: { type: 'integer', minimum: 1 } } } : {}),
        },
        content: { 'application/json': { schema: { $ref: '#/components/schemas/GrammarError' } } },
      }])),
    },
  },
};

swaggerDocument.components.schemas.ClarityInput = {
  ...swaggerDocument.components.schemas.GrammarInput,
  properties: { text: {
    ...swaggerDocument.components.schemas.GrammarInput.properties.text,
    example: 'I have been thinking about the faded school crosswalk on Elm Street. I feel scared when my children cross there. Please repaint it by October 20.',
  } },
};
swaggerDocument.components.schemas.ClarityResponse = {
  ...swaggerDocument.components.schemas.GrammarResponse,
  properties: { data: {
    ...swaggerDocument.components.schemas.GrammarResponse.properties.data,
    properties: { text: {
      ...swaggerDocument.components.schemas.GrammarResponse.properties.data.properties.text,
      example: 'Please repaint the faded school crosswalk on Elm Street by October 20. I feel scared when my children cross there.',
    } },
  } },
};
swaggerDocument.components.schemas.ClarityError = { ...swaggerDocument.components.schemas.GrammarError };
const grammarOperation = swaggerDocument.paths['/api/assist/grammar'].post;
swaggerDocument.paths['/api/assist/clarity'] = {
  post: {
    ...grammarOperation,
    summary: 'Rewrite prose for improved clarity and structure',
    description: 'Rewrites text while retaining its substance, meaning, intent, tone, and emotional expression as faithfully as possible. Fixes grammar and spelling, removes unnecessary repetition, clearly expresses the author\'s intent, and leads with the main point, purpose, or key takeaway. Aims for a 10th-grade reading level or lower and concise wording without sacrificing essential content or nuance. May reorder sentences and paragraphs; does not invent facts, motives, or commitments. Fidelity takes priority over brevity and readability. These quality goals are best effort, not guaranteed or enforced by a reading-grade score. Grammar and clarity share the same quota buckets, concurrency budget, Gemini API key, and configuration. ' + grammarOperation.description,
    requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ClarityInput' } } } },
    responses: Object.fromEntries(Object.entries(grammarOperation.responses).map(([status, response]) => [status, {
      ...(response as JsonObject),
      ...(status === '200' ? { description: 'Prose rewritten for clarity and structure, or unchanged text if it already meets the editing goals.' } : {}),
      content: { 'application/json': { schema: { $ref: `#/components/schemas/${status === '200' ? 'ClarityResponse' : 'ClarityError'}` } } },
    }])),
  },
};

swaggerDocument.components.schemas.SummaryInput = {
  ...swaggerDocument.components.schemas.GrammarInput,
  properties: {
    text: { ...swaggerDocument.components.schemas.GrammarInput.properties.text, example: 'The school crosswalk on Elm Street is faded. I feel scared when my children cross there. Please repaint it by October 20.' },
    type: { type: 'string', enum: SUMMARY_SENTENCE_TYPES, default: DEFAULT_SUMMARY_OPTIONS.type, description: 'Grammatical type of only the final summary sentence; auto lets the model choose.' },
    max_sentences: { type: 'integer', minimum: 1, maximum: GRAMMAR_OUTPUT_LIMIT, default: DEFAULT_SUMMARY_OPTIONS.max_sentences, description: 'Hard maximum number of summary sentences, checked using the server sentence parser.' },
    target_sentences: { type: 'integer', minimum: 1, maximum: GRAMMAR_OUTPUT_LIMIT, default: DEFAULT_SUMMARY_OPTIONS.target_sentences, description: 'Ideal sentence count, not a minimum; must not exceed max_sentences. Shorter sources or tight character limits may produce fewer sentences without padding.' },
    max_characters: { type: 'integer', minimum: 1, maximum: GRAMMAR_OUTPUT_LIMIT, default: DEFAULT_SUMMARY_OPTIONS.max_characters, description: 'Hard maximum total Unicode code points, including spaces and punctuation across all sentences.' },
  },
};
swaggerDocument.components.schemas.SummaryResponse = {
  ...swaggerDocument.components.schemas.GrammarResponse,
  properties: { data: {
    ...swaggerDocument.components.schemas.GrammarResponse.properties.data,
    properties: { text: {
      ...swaggerDocument.components.schemas.GrammarResponse.properties.data.properties.text,
      description: 'Concise summary within the requested max_characters and max_sentences. Internal sentence metadata is not returned.',
      example: 'Please repaint the faded school crosswalk on Elm Street by October 20 to help children cross safely.',
    } },
  } },
};
swaggerDocument.components.schemas.SummaryError = { ...swaggerDocument.components.schemas.GrammarError };
swaggerDocument.paths['/api/assist/summarize'] = {
  post: {
    ...grammarOperation,
    summary: 'Summarize a message within sentence and character limits',
    description: 'Produces a concise summary rather than a full rewrite, leading with the main point and preserving substance, intent, key facts, qualifications, and emotional expression as faithfully as the limits allow. Prefers widely known common abbreviations when clear in context, such as Elm St for Elm Street and Ross Ave for Ross Avenue, without inventing abbreviations or using ambiguous shorthand that changes identities or meaning. Uses Gemini 3.1 Flash-Lite with fixed editing instructions, data-only source text, and separately validated summary settings. Requires an application API key and production App Check; user sign-in is optional. Accepts application/json with text and four optional fields: type (auto by default), max_sentences (1), target_sentences (1), and max_characters (140). Numeric options must be integers from 1 through 10000, with target_sentences no greater than max_sentences. Input remains limited to 5000 Unicode code points and a 64 KiB body, with the same prose-only screening and rejection feedback as clarity. Sentence and character caps are checked locally; violating output returns 502 ASSIST_INVALID_OUTPUT and is never silently truncated or automatically retried. Sentence counting uses sentence-splitter with common English time abbreviations and multilingual sentence-ending punctuation; ambiguous boundaries may cause conservative rejection. Final grammatical type and target count are model-directed, with declared-type and punctuation consistency checks, not guarantees of semantic classification. Aims for clear, concise, 10th-grade readability or lower without inventing content or following embedded instructions. Shares all quotas, concurrency limits, deadlines, output/code safety checks, no-store behavior, and privacy controls with grammar and clarity. No new configuration is required.',
    requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/SummaryInput' } } } },
    responses: Object.fromEntries(Object.entries(grammarOperation.responses).map(([status, response]) => [status, {
      ...(response as JsonObject),
      ...(status === '200' ? { description: 'Concise summary satisfying the requested hard sentence and character caps.' } : {}),
      ...(status === '400' ? { description: 'Invalid JSON, input text, unknown fields, option type/range, or target_sentences greater than max_sentences; error code INVALID_SUMMARY_INPUT.' } : {}),
      ...(status === '502' ? { description: 'Provider failure, invalid/unsafe output, or summary failing the requested caps or final-type consistency checks. No truncated result is returned.' } : {}),
      content: { 'application/json': { schema: { $ref: `#/components/schemas/${status === '200' ? 'SummaryResponse' : 'SummaryError'}` } } },
    }])),
  },
};
