import { JsonObject } from 'swagger-ui-express';

export const swaggerDocument: JsonObject = {
  openapi: '3.0.3',
  info: {
    title: 'Dallas Urbanists Cloud API',
    version: '1.0.0',
    description: `API web service providing database I/O and server-side operations for Dallas Urbanists client applications.`,
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
        description: 'Retrieves all contact records ordered by ID descending from the PostgreSQL database.',
        tags: ['Contacts'],
        parameters: [
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
            description: 'Filter checkins by event identifier string',
            required: false,
            schema: {
              type: 'string',
              example: 'dallas-bike-ride-2026',
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
  },
  components: {
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
          roles: {
            type: 'array',
            items: {
              type: 'string',
            },
            example: ['member', 'volunteer'],
            description: 'Roles assigned to the contact',
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
            type: 'string',
            example: 'dallas-bike-ride-2026',
            description: 'Identifier for the event being checked into',
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
            type: 'string',
            example: 'dallas-bike-ride-2026',
            description: 'Identifier for the event',
          },
          submitted_on: {
            type: 'string',
            format: 'date-time',
            example: '2026-10-01T14:30:00.000Z',
            description: 'Optional ISO 8601 timestamp. If omitted, server defaults to current timestamp.',
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
            type: 'string',
            example: 'dallas-bike-ride-2026-v2',
            description: 'Updated event identifier string',
          },
          submitted_on: {
            type: 'string',
            format: 'date-time',
            example: '2026-10-01T15:00:00.000Z',
            description: 'Updated ISO 8601 timestamp for the checkin',
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
    },
  },
};
