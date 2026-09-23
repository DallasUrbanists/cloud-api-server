import { JsonObject } from 'swagger-ui-express';

export const swaggerDocument: JsonObject = {
  openapi: '3.0.3',
  info: {
    title: 'Dallas Urbanists Cloud API',
    version: '1.0.0',
    description: `
API web service providing database I/O and server-side operations for Dallas Urbanists client applications.

### Key Features
- **Firestore multi-database integration** with primary database \`public-improvements\`
- **Suggestion management** (Create, Read, Update, Delete)
- **Domain Authorization & CORS protection** with unrestricted local testing
- **Hosted on Google Cloud Run**

### Databases
- **public-improvements**: Hosts civic improvements suggestions, ideas, and neighborhood infrastructure feedback.
    `,
    contact: {
      name: 'Dallas Urbanists, Main Website',
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
      name: 'Public Improvements - Suggestions',
      description: 'Endpoints for managing urban improvement suggestions in the public-improvements database.',
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
    '/api/public-improvements/suggestions/upload-url': {
      post: {
        summary: 'Generate Signed Photo Upload URL',
        description: 'Generates a temporary V4 signed Google Cloud Storage PUT URL allowing client applications to upload resized photos directly to Cloud Storage securely.',
        tags: ['Public Improvements - Suggestions'],
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
    '/api/public-improvements/suggestions': {
      get: {
        summary: 'List All Suggestions',
        description: 'Retrieves a list of suggestions from the public-improvements database, with optional filters.',
        tags: ['Public Improvements - Suggestions'],
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
        tags: ['Public Improvements - Suggestions'],
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
    '/api/public-improvements/suggestions/{id}': {
      get: {
        summary: 'Get Suggestion by ID',
        description: 'Retrieves a single suggestion by its integer ID.',
        tags: ['Public Improvements - Suggestions'],
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
        tags: ['Public Improvements - Suggestions'],
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
        tags: ['Public Improvements - Suggestions'],
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
