import { createRequire } from 'module';
import { JsonObject } from 'swagger-ui-express';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json');

export const swaggerDocument: JsonObject = {
  openapi: '3.0.3',
  info: {
    title: 'Dallas Urbanists Cloud API',
    version: pkg.version || '1.0.0',
    description: `API web service providing database I/O and server-side operations for Dallas Urbanists client applications.

Authorization:
- API keys use the X-API-Key header. Optional endpoints work without a key; required endpoints require a valid application key. Production browser requests to required endpoints also require Firebase App Check.
- Firebase user tokens use Authorization: Bearer <Firebase ID token>. PUBLIC endpoints do not require a token, PARTIAL endpoints return redacted data without an authorized token, and PRIVATE endpoints require a valid token plus the endpoint's ownership or role condition.
- Administrators assign staff and system roles through Firebase custom claims.

Endpoint policies:
- Contacts: GET/list and GET/{id}/PUT/{id} are API-key REQUIRED and JWT PARTIAL; POST is REQUIRED/PUBLIC; DELETE is REQUIRED/PRIVATE.
- Check-ins: GET/list and GET/{id} are REQUIRED/PARTIAL; POST is OPTIONAL/PUBLIC; PUT and DELETE are REQUIRED/PRIVATE. include_contact accepts false, partial, or full.
- Suggestions: reads, creation, and upload URLs are REQUIRED/PUBLIC; update and delete are REQUIRED/PRIVATE for the author or staff.
- Events and calendar reads are OPTIONAL/PUBLIC; event creation, updates, deletion, and iCal imports are REQUIRED/PRIVATE for staff or system roles.`,
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
      name: 'System',
      description: 'Health checks and server operational metadata.',
    },
  ],
  paths: {
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
                    example: 'image/webp',
                    description: 'MIME type of the image to upload. Default: image/webp',
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
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Firebase Authentication ID token.',
      },
    },
    schemas: {
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
        required: ['name'],
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
        properties: {
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
        },
      },
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
