---
name: sql-table-crud
description: 'Generate full-stack TypeScript CRUD endpoints (models, services/controllers, routes, and Swagger docs) from SQL table schemas, DDL definitions, or JSON schema metadata. Use when: generating CRUD APIs for a database table, adding REST endpoints for a PostgreSQL table, creating models/controllers/routes for SQL schema.'
argument-hint: '[SQL DDL or JSON table schema]'
user-invocable: true
---

# SQL Table CRUD Generator

Generate clean, type-safe, layered RESTful CRUD endpoints in Express + TypeScript from SQL table schemas (PostgreSQL DDL, JSON table metadata, or column definitions).

## When to Use
- Implementing full CRUD endpoints for a new or existing database table.
- Converting table schema definitions (e.g., columns, types, nullability, primary/foreign keys, indexes) into TypeScript interfaces, parameterized queries, Express handlers, routes, and Swagger/OpenAPI documentation.
- Standardizing REST API patterns across the codebase.

## Workflow Procedure

### 1. Analyze Schema & Requirements
- Identify:
  - **Table Name** & Entity Name (singular vs. plural, e.g., `checkins` -> `Checkin`).
  - **Primary Key**: column name (usually `id`), data type (`bigint`, `uuid`, `serial`, etc.).
  - **Columns & Nullability**: map SQL types to TypeScript and JSON types (see [PostgreSQL Type Mappings](./references/type-mappings.md)).
  - **Auto-generated/System Columns**: identify fields managed by DB or defaults (e.g., `id`, `created_at`, `submitted_on`, `updated_at`).
  - **Foreign Keys & Indexed Fields**: identify fields likely used for filtering (e.g., `contact_id`, `event_id`, `status`).

### 2. Define TypeScript Models & DTOs
Create or update `src/models/<entityName>.ts`:
- **Database Row Interface**: Represents raw rows returned from SQL queries.
- **API Response Interface**: CamelCase or JSON-serialized shape (if transformation is applied).
- **Create DTO (`Create<Entity>DTO`)**: Required and optional fields for `POST /api/<entities>`. Exclude auto-generated PKs/timestamps unless user-supplied.
- **Update DTO (`Update<Entity>DTO`)**: Optional fields for `PATCH` or `PUT /api/<entities>/:id`.
- **Query / Filter Params Interface**: Filtering by foreign keys, pagination (`limit`, `offset`), and sorting.

### 3. Implement Data Access & Business Logic
Create or update `src/services/<entityName>Service.ts` (or controller data layer if direct queries are used):
- Use parameterized queries (`$1`, `$2`, ...) with the connection pool (`import { pool } from '../config/db.js';`).
- Implement standard operations:
  - `create(data)`: `INSERT INTO <table> (...) VALUES (...) RETURNING *;`
  - `findAll(filters)`: `SELECT * FROM <table> WHERE ... ORDER BY id DESC LIMIT $1 OFFSET $2;`
  - `findById(id)`: `SELECT * FROM <table> WHERE id = $1;`
  - `update(id, data)`: Dynamic partial `UPDATE <table> SET ... WHERE id = $... RETURNING *;` or full update.
  - `delete(id)`: `DELETE FROM <table> WHERE id = $1 RETURNING id;` (or soft delete if specified).
- Ensure safe SQL query construction with parameter arrays to prevent SQL injection.

### 4. Create Express Controller
Create `src/controllers/<entityName>Controller.ts`:
- Parse and validate path parameters (`req.params.id`), query strings (`req.query`), and request bodies (`req.body`).
- Validate required fields on creation and return `400 Bad Request` with structured error messages if validation fails.
- Return appropriate HTTP status codes:
  - `201 Created` for successful POST with `Location` header or payload.
  - `200 OK` for successful GET, PUT, PATCH, DELETE.
  - `404 Not Found` when a record by ID does not exist.
  - `400 Bad Request` for invalid inputs, missing fields, or ID parsing errors.
  - `500 Internal Server Error` caught via try/catch and passed to `next(error)` or structured JSON error.

### 5. Register Routes
Create `src/routes/<entityName>Routes.ts`:
- Define RESTful paths:
  - `GET /` -> List records with optional filter/pagination query parameters.
  - `GET /:id` -> Fetch single record.
  - `POST /` -> Create a new record.
  - `PUT /:id` or `PATCH /:id` -> Update an existing record.
  - `DELETE /:id` -> Delete a record.
- Mount router in `src/app.ts` under `/api/<entities>`.

### 6. Update Swagger / OpenAPI Documentation
Update `src/docs/swagger.ts`:
- Add component schema definitions for `<Entity>`, `Create<Entity>Input`, and `Update<Entity>Input`.
- Add endpoint paths under `/api/<entities>` and `/api/<entities>/{id}`.
- Include query parameters (pagination, foreign key filters), request bodies with example values, and responses (`200`, `201`, `400`, `404`, `500`).

### 7. Verification & Build Check
- Run `npm run build` to verify TypeScript type checking and module resolution.
- Ensure all relative imports have `.js` extensions per ESM requirements.
