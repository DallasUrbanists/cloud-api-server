# Dallas Urbanists Cloud API Server

An API web service providing database I/O and server-side operations for the suite of client-side web applications created for and by **Dallas Urbanists**.

Hosted on **Google Cloud Run**, backed by **Google Cloud Firestore**, **Google Cloud SQL (PostgreSQL)**, and **Google Cloud Storage**.

---

## 🌐 Client Web Applications

This backend API server powers the following client-side applications:

| Project | Tags Used | Links |
|---|---|---|
| **Checkin Helper**<br>Tool for event check-in and attendee registration. Saves contacts and check-in records to the Dallas Urbanists PostgreSQL CRM database. | &bull; `Contacts`<br>&bull; `Checkins`<br>&bull; `Events` | &bull; [`GitHub repo`](https://github.com/DallasUrbanists/checkin-helper)<br>&bull; [`dallasurbanists.org/checkin`](https://dallasurbanists.org/checkin) |
| **Improvement Map**<br>Interactive map application for exploring, submitting, and tracking civic improvement suggestions with photo attachments. | &bull; `Suggestions` | &bull; [`GitHub repo`](https://github.com/DallasUrbanists/improvement-map)<br>&bull; [`map.dallasurbanists.org`](https://map.dallasurbanists.org) |

---

## 🛠️ Tech Stack

- **Runtime & Language**: Node.js, TypeScript (ESM)
- **Package Manager**: NPM
- **Web Framework**: Express.js (v5)
- **API Documentation & Testing**: Swagger UI (OpenAPI 3.0.3) with Strong Towns Custom Theme & Dark/Light Mode
- **Databases**:
  - **Google Cloud Firestore**: NoSQL multi-database architecture for public suggestions and crowdsourced content.
  - **PostgreSQL (Google Cloud SQL)**: Relational database for CRM contacts and event checkins.
- **Media & Storage**: Google Cloud Storage for pre-signed photo uploads and static assets.
- **Deployment & Hosting**: Google Cloud Run & Cloud SQL Unix socket proxy.
- **Version Control**: Git

---

## 🌟 Features

- **Public Improvements API**: Full CRUD endpoints for managing civic improvement suggestions in Firestore (`public-improvements` database), with support for photo attachments and pre-signed GCS upload URLs.
- **Contacts & CRM API**: PostgreSQL-backed contacts management with automatic data normalization (uppercase names, lowercase emails, standardized NANP phone formats) and multi-field search filtering.
- **Event Checkins API**: Record and query event check-in entries linked to CRM contacts or anonymous attendees.
- **Meetup Events & Calendar Proxy**: Proxies Dallas Urbanists Meetup iCal feeds with HTTP caching headers (`ETag`, `Last-Modified`, `Cache-Control`) and CORS headers for client-side applications.
- **Multi-Database & Multi-Cloud Architecture**: Integrates Firestore, PostgreSQL on Cloud SQL, and Google Cloud Storage seamlessly.
- **Interactive Swagger UI**: Explore all endpoints, test requests in the browser, view schemas, and switch between Dark and Light modes styled in the Strong Towns visual palette at `/docs`.
- **Domain Authorization & CORS**: Restricts production cross-origin requests to authorized domains (configured via `ALLOWED_ORIGINS`) while permitting unrestricted requests from `localhost` / `127.0.0.1` for local development and testing.

---

## 📊 Data Models & Schemas

### 1. Suggestion (`public-improvements` Firestore Database)

Documents in the `suggestion` collection inside the `public-improvements` Firestore database adhere to the following schema:

| Field | Type | Description |
|---|---|---|
| `id` | `integer` | Unique sequential integer identifier |
| `creationDate` | `string` (ISO 8601) | Timestamp when suggestion was created |
| `modificationDate` | `string` (ISO 8601) | Timestamp of most recent update |
| `status` | `enum` | `'new'` \| `'inprogress'` \| `'stalled'` \| `'withdrawn'` \| `'completed'` |
| `author.email` | `string` (email) | Author's email address |
| `author.name` | `string` | Author's display name |
| `content.summary` | `string` | Short title / summary of the suggestion |
| `content.details` | `string` | Extended markdown / detailed description (default `""`) |
| `content.photos` | `array<object>` | Optional array of photos (max 10 items) |
| `content.photos[].url` | `string` (URI) | Public URL of uploaded photo |
| `content.photos[].caption` | `string` | Description / caption for photo |
| `content.photos[].timestamp` | `string` (ISO 8601) | Timestamp when photo was taken/uploaded |
| `location.latitude` | `float` (optional) | Geographical latitude coordinate |
| `location.longitude` | `float` (optional) | Geographical longitude coordinate |
| `location.description`| `string` | Landmark/corridor description (default `""`) |
| `location.address` | `string` | Street address (default `""`) |

---

### 2. Contact (`contacts` PostgreSQL Table)

Contact records stored in the relational database adhere to the following schema:

| Field | Type | Description |
|---|---|---|
| `id` | `integer` (bigint) | Unique identifier for the contact |
| `name` | `string` | Full name of contact (automatically normalized to uppercase) |
| `created_on` | `string` (ISO 8601) | Timestamp with time zone when the record was created |
| `emails` | `array<string>` | Email addresses associated with the contact (normalized to lowercase) |
| `phones` | `array<string>` | Phone numbers (normalized to `+1-XXX-XXX-XXXX` NANP format) |
| `zip_home` | `string` (optional) | Primary residential ZIP code |
| `zip_other` | `array<string>` | Additional ZIP codes (work, advocacy areas, etc.) |
| `roles` | `array<string>` | Assigned roles (e.g. `volunteer`, `donor`, `advocate`, `organizer`) |

---

### 3. Checkin (`checkins` PostgreSQL Table)

Checkin records stored in the relational database adhere to the following schema:

| Field | Type | Description |
|---|---|---|
| `id` | `integer` (bigint) | Unique identifier for the checkin |
| `contact_id` | `integer` (nullable) | Associated contact ID (foreign key reference to `contacts.id`), or `null` for anonymous |
| `event_id` | `string` | Identifier or slug for the event checked into |
| `submitted_on` | `string` (ISO 8601) | Timestamp with time zone when the checkin was recorded |

---

### 4. Event (`events` PostgreSQL Table)

Event records stored in the relational database adhere to the following schema:

| Field | Type | Description |
|---|---|---|
| `id` | `integer` (bigint) | Unique identifier for the event |
| `uid` | `string` | Unique iCalendar identifier or external system UID |
| `start_at` | `string` (ISO 8601) | Timestamp with time zone when the event starts |
| `end_at` | `string` (ISO 8601, optional) | Timestamp with time zone when the event ends (mutually exclusive with `duration`) |
| `duration` | `string` (optional) | Duration interval (e.g. `PT2H`, mutually exclusive with `end_at`) |
| `all_day` | `boolean` | Indicates whether the event is an all-day event (default `false`) |
| `timezone` | `string` (optional) | Timezone identifier (e.g. `America/Chicago`) |
| `title` | `string` (optional) | Event title or summary |
| `description` | `string` (optional) | Description / details of the event |
| `location` | `string` (optional) | Human-readable event location or venue |
| `url` | `string` (URI, optional) | External URL for the event |
| `status` | `string` (optional) | Event status (e.g. `CONFIRMED`, `TENTATIVE`, `CANCELLED`) |
| `img` | `string` (URI, optional) | Image or banner URL |
| `classification` | `string` (optional) | Access classification (e.g. `PUBLIC`, `PRIVATE`) |
| `sequence` | `integer` | iCal revision sequence counter (default `0`) |
| `organizer_name` | `string` (optional) | Name of event organizer |
| `organizer_email` | `string` (optional) | Email of event organizer |
| `recurrence_rule` | `string` (optional) | RFC 5545 recurrence rule (RRULE) |
| `recurrence_id` | `string` (ISO 8601, optional) | Recurrence instance timestamp |
| `categories` | `array<string>` (optional) | Categories or tags |
| `resources` | `array<string>` (optional) | Allocated resources |
| `attachments` | `array<object>` (optional) | Attachment metadata |
| `geo_latitude` | `float` (numeric 9,6, optional) | Geographic latitude |
| `geo_longitude` | `float` (numeric 9,6, optional) | Geographic longitude |
| `is_hosted_by_du` | `boolean` | Flag indicating whether Dallas Urbanists is hosting (default `true`) |
| `ical_raw` | `string` (optional) | Raw VEVENT block text |
| `ical_dtstamp` | `string` (ISO 8601) | iCal generation timestamp |
| `ical_created` | `string` (ISO 8601, optional) | Timestamp when event was created upstream |
| `ical_last_modified` | `string` (ISO 8601, optional) | Timestamp when event was last updated upstream |
| `created_at` | `string` (ISO 8601) | Record creation timestamp |
| `updated_at` | `string` (ISO 8601) | Record modification timestamp |

---

## 🚀 Quick Start for Developers

### 1. Prerequisites

- [Node.js](https://nodejs.org/) (version 20 LTS or higher recommended)
- [NPM](https://www.npmjs.com/)
- [Google Cloud CLI (`gcloud`)](https://cloud.google.com/sdk/docs/install) (for deployment & GCP credentials)
- [PostgreSQL](https://www.postgresql.org/) (optional for local database testing, defaults to `127.0.0.1:5432`)

### 2. Clone the Repository

```bash
git clone https://github.com/dallas-urbanists/urbanists-cloud-api-server.git
cd urbanists-cloud-api-server
```

### 3. Install Dependencies

```bash
npm install
```

### 4. Configure Environment Variables

Copy the sample environment file:

```bash
cp .env.example .env
```

Configure your `.env` variables as needed:

```env
PORT=8080
NODE_ENV=development

# Firestore Configuration
PUBLIC_IMPROVEMENTS_DB=public-improvements

# Google Cloud Storage
SUGGESTION_PHOTOS_BUCKET=urbanists-suggestion-photos

# PostgreSQL Database Configuration
DB_USER=postgres
DB_PASSWORD=your_postgres_password
DB_NAME=postgres
DB_HOST=127.0.0.1
DB_PORT=5432

# CORS Allowed Origins
ALLOWED_ORIGINS=https://dallasurbanists.org,https://dallasurbanists.github.io,https://dallasurbanists.web.app
```

> **Note on Local Development**: When running locally, requests from `http://localhost:*` and `http://127.0.0.1:*` are automatically authorized, regardless of the `ALLOWED_ORIGINS` setting.

### 5. Google Cloud Authentication (Local Development)

To connect to Firestore and Cloud Storage from your local environment:

```bash
gcloud auth application-default login
```

Or set the `GOOGLE_APPLICATION_CREDENTIALS` variable in your `.env` pointing to a valid service account key JSON file:

```env
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json
```

---

## 💻 Running the Server

### Development Mode (with hot-reloading)

```bash
npm run dev
```

The server starts on `http://localhost:8080`.

### Production Build & Run

```bash
npm run build
npm start
```

---

## 📖 API Documentation & Manual Testing

The server includes an interactive **Swagger UI** built with the **OpenAPI 3.0.3** specification and customized with the Strong Towns design aesthetic, featuring:
- **Dark Mode & Light Mode** toggle with instant switching and persistent `localStorage` preference.
- **Categorized Endpoints** grouped under `Suggestions`, `Contacts`, `Checkins`, `Events`, and `System`.
- **Interactive "Try it out" Execution** for real-time testing and schema inspection directly in the browser.

Once the server is running, access the documentation at any of the following URLs:

- **Swagger UI**: [http://localhost:8080/docs](http://localhost:8080/docs) (also mounted at `/`, `/swagger`, and `/api-docs`)
- **OpenAPI 3.0 JSON Spec**: [http://localhost:8080/api-docs.json](http://localhost:8080/api-docs.json)
- **Health Check Endpoint**: [http://localhost:8080/api/health](http://localhost:8080/api/health)

---

## 🔌 API Endpoints Summary

### System (`System` Tag)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Check operational health, service name, and active database connections |

---

### Suggestions (`Suggestions` Tag)

Endpoints for managing civic improvement suggestions and photo uploads in Firestore (`public-improvements` database) and Google Cloud Storage. *(Mounted at `/api/suggestions` and `/api/public-improvements/suggestions`).*

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/suggestions/upload-url` | Generate a pre-signed GCS URL for direct photo upload |
| `GET` | `/api/suggestions` | List suggestions (supports `?status=`, `?authorEmail=`, `?limit=`) |
| `POST` | `/api/suggestions` | Create a new suggestion record |
| `GET` | `/api/suggestions/:id` | Get suggestion details by integer ID |
| `PUT` | `/api/suggestions/:id` | Update an existing suggestion by ID |
| `DELETE` | `/api/suggestions/:id` | Delete a suggestion by ID |

#### Example: Generate Signed Upload URL (`POST /api/suggestions/upload-url`)

**Request Body:**
```json
{
  "fileName": "street-redesign.jpg",
  "contentType": "image/jpeg",
  "suggestionId": 12
}
```

**Response (`200 OK`):**
```json
{
  "uploadUrl": "https://storage.googleapis.com/urbanists-suggestion-photos/suggestions/12/1727800000000-street-redesign.jpg?X-Goog-Algorithm=...",
  "publicUrl": "https://storage.googleapis.com/urbanists-suggestion-photos/suggestions/12/1727800000000-street-redesign.jpg",
  "fileName": "suggestions/12/1727800000000-street-redesign.jpg",
  "bucket": "urbanists-suggestion-photos",
  "expiresInSeconds": 900
}
```

#### Example: Create Suggestion (`POST /api/suggestions`)

**Request Body:**
```json
{
  "status": "new",
  "author": {
    "email": "alex@dallasurbanists.org",
    "name": "Alex Rivera"
  },
  "content": {
    "summary": "Add protected bike lanes and shade trees along Elm Street",
    "details": "Installing concrete bollards and native Texas oak trees will increase pedestrian safety and lower summer heat.",
    "photos": [
      {
        "url": "https://storage.googleapis.com/urbanists-suggestion-photos/suggestions/1/elm-street.jpg",
        "caption": "Current street condition without protected bike lane",
        "timestamp": "2026-09-23T14:30:00.000Z"
      }
    ]
  },
  "location": {
    "latitude": 32.78014,
    "longitude": -96.79701,
    "description": "Intersection of Elm St and N Akard St in Downtown Dallas",
    "address": "1500 Elm St, Dallas, TX 75201"
  }
}
```

---

### Contacts (`Contacts` Tag)

Endpoints for managing CRM contact records in PostgreSQL.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/contacts` | List contacts with search filters (`?name=`, `?email=`, `?phone=`, `?limit=`) |
| `POST` | `/api/contacts` | Create a new contact (normalizes name, email, and phone) |
| `GET` | `/api/contacts/:id` | Get contact record by ID |
| `PUT` | `/api/contacts/:id` | Update an existing contact by ID |
| `DELETE` | `/api/contacts/:id` | Delete a contact record by ID |

#### Example: Create Contact (`POST /api/contacts`)

**Request Body:**
```json
{
  "name": "Jane Doe",
  "emails": ["jane.doe@example.com"],
  "phones": ["214-555-0199"],
  "zip_home": "75201",
  "zip_other": ["75202"],
  "roles": ["volunteer", "advocate"]
}
```

---

### Checkins (`Checkins` Tag)

Endpoints for managing event attendance checkins in PostgreSQL.

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/checkins` | List checkins with filters (`?contact_id=`, `?event_id=`, `?limit=`, `?offset=`) |
| `POST` | `/api/checkins` | Create a new event checkin entry |
| `GET` | `/api/checkins/:id` | Get checkin record by ID |
| `PUT` | `/api/checkins/:id` | Update an existing checkin record by ID |
| `DELETE` | `/api/checkins/:id` | Delete a checkin record by ID |

#### Example: Create Checkin (`POST /api/checkins`)

**Request Body:**
```json
{
  "contact_id": 1,
  "event_id": "dallas-bike-ride-2026",
  "submitted_on": "2026-10-01T14:30:00.000Z"
}
```

---

### Events & Calendar (`Events` Tag)

Endpoints for managing PostgreSQL event records and proxying/bulk-importing Dallas Urbanists event feeds from Meetup or external iCalendar URLs. *(Mounted at `/api/events`, `/api/events/ical`, `/meetup-ical`, and `/api/meetup-ical`).*

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/events` | List events with filters (`?status=`, `?is_hosted_by_du=`, `?start_after=`, `?start_before=`, `?category=`, `?search=`, `?limit=`, `?offset=`, `?order=`) |
| `POST` | `/api/events` | Create a new event in the database |
| `GET` | `/api/events/:id` | Get event details by ID or UID |
| `PUT` | `/api/events/:id` | Update an existing event record |
| `PATCH` | `/api/events/:id` | Partially update an existing event record |
| `DELETE` | `/api/events/:id` | Delete an event record by ID or UID |
| `POST` | `/api/events/import-ical` | Bulk import events from an iCal feed URL into PostgreSQL |
| `GET` | `/api/events/ical` | Returns the Meetup iCal feed (`text/calendar; charset=utf-8`) with caching headers |
| `GET` | `/meetup-ical` | Alias route for the Meetup iCal calendar feed |

#### Example: Bulk Import Events from iCal (`POST /api/events/import-ical`)

**Request Body:**
```json
{
  "url": "https://www.meetup.com/dallasurbanists/events/ical/",
  "is_hosted_by_du": true,
  "force": false
}
```

**Response (`200 OK`):**
```json
{
  "message": "Import completed: 5 created, 2 updated, 12 skipped, 0 failed.",
  "sourceUrl": "https://www.meetup.com/dallasurbanists/events/ical/",
  "totalFound": 19,
  "created": 5,
  "updated": 2,
  "skipped": 12,
  "failed": 0,
  "items": [
    {
      "uid": "event-304918231@meetup.com",
      "title": "Dallas Urbanists Monthly Meeting",
      "action": "created",
      "id": 1
    }
  ]
}
```

---

## 🏷️ Versioning

This project follows [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`):

- **`MAJOR`**: Incompatible or breaking API changes.
- **`MINOR`**: Backwards-compatible new features and endpoints.
- **`PATCH`**: Backwards-compatible bug fixes and minor improvements.

### Single Source of Truth
The version defined in [`package.json`](./package.json) is the single source of truth. The Swagger OpenAPI specification ([`src/docs/swagger.ts`](./src/docs/swagger.ts)) automatically imports and displays this version in the interactive documentation at `/docs`.

### Bumping Versions
To update the project version, use the built-in `npm version` command:

```powershell
# For bug fixes (e.g., 1.0.0 -> 1.0.1)
npm version patch

# For new features / endpoints (e.g., 1.0.0 -> 1.1.0)
npm version minor

# For breaking changes (e.g., 1.0.0 -> 2.0.0)
npm version major
```

Running `npm version` will automatically:
1. Update `version` in `package.json` and `package-lock.json`.
2. Create a Git commit and annotated release tag (e.g., `v1.1.0`).

---

## 🚢 Deployment to Production

Pushing to `main` branch automatically triggers build and deploy to Cloud Run service.

Service name: `urbanists-cloud-api-server`

---

## 🤝 Contributing

1. Fork or branch from `main`: `git checkout -b feature/my-feature`
2. Ensure TypeScript builds cleanly without errors: `npm run build`
3. Commit your changes: `git commit -m 'feat: add new feature'`
4. Push to origin: `git push origin feature/my-feature`
5. Open a Pull Request for review
