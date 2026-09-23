# Dallas Urbanists Cloud API Server

An API web service providing database I/O and server-side operations for the suite of client-side web applications created for and by **Dallas Urbanists**.

Hosted on **Google Cloud Run** and backed by **Google Cloud Firestore**.

---

## 🛠️ Tech Stack

- **Runtime & Language**: Node.js, TypeScript
- **Package Manager**: NPM
- **Web Framework**: Express.js
- **API Documentation & Testing**: Swagger UI (OpenAPI 3.0)
- **Database**: Google Cloud Firestore (NoSQL, multi-database architecture)
- **Deployment & Hosting**: Google Cloud Run
- **Version Control**: Git

---

## 🌟 Features

- **Multi-Database Support**: Modular Firestore database client architecture designed to expand across multiple databases over time.
- **Public Improvements API**: Full CRUD endpoints for managing civic improvement suggestions in the `public-improvements` database (`suggestion` collection).
- **Domain Authorization & CORS**: Restricts cross-origin requests in production to authorized domains (configured via `ALLOWED_ORIGINS`) while permitting unrestricted requests from `localhost` / `127.0.0.1` for local development and testing.
- **Interactive Swagger UI**: Explore endpoints, inspect schemas, and perform manual browser-based testing at `/docs`.

---

## 📊 Data Model: Suggestion

Documents in the `suggestion` collection inside the `public-improvements` database adhere to the following schema:

| Field | Type | Description |
|---|---|---|
| `id` | `integer` | Unique sequential integer identifier |
| `creationDate` | `string` (ISO 8601) | Timestamp when suggestion was created |
| `modificationDate` | `string` (ISO 8601) | Timestamp of most recent update |
| `status` | `enum` | `'new'` \| `'inprogress'` \| `'stalled'` \| `'withdrawn'` \| `'completed'` |
| `author.email` | `string` | Author's email address |
| `author.name` | `string` | Author's display name |
| `content.summary` | `string` | Short title / summary of the suggestion |
| `content.details` | `string` | Extended markdown / detailed description (default `""`) |
| `location.latitude` | `float` (optional) | Geographical latitude coordinate |
| `location.longitude` | `float` (optional) | Geographical longitude coordinate |
| `location.description`| `string` | Textual description of landmark/corridor (default `""`) |
| `location.address` | `string` | Street address (default `""`) |

---

## 🚀 Quick Start for Developers

### 1. Prerequisites

- [Node.js](https://nodejs.org/) (version 20 LTS or higher recommended)
- [NPM](https://www.npmjs.com/)
- [Google Cloud CLI (`gcloud`)](https://cloud.google.com/sdk/docs/install) (for deployment & GCP credentials)

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

Edit `.env` to configure your settings:

```env
PORT=8080
NODE_ENV=development
PUBLIC_IMPROVEMENTS_DB=public-improvements
ALLOWED_ORIGINS=https://dallasurbanists.org,https://dallasurbanists.web.app
```

> **Note on Local Development**: When running locally, requests from `http://localhost:*` and `http://127.0.0.1:*` are automatically authorized, regardless of the `ALLOWED_ORIGINS` setting.

### 5. Google Cloud Authentication (Local Development)

To connect to Firestore from your local environment:

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

Once the server is running, open your browser to:

- **Swagger UI**: [http://localhost:8080/docs](http://localhost:8080/docs) (also available at `/swagger` and `/api-docs`)
- **OpenAPI JSON Spec**: [http://localhost:8080/api-docs.json](http://localhost:8080/api-docs.json)
- **Health Check**: [http://localhost:8080/api/health](http://localhost:8080/api/health)

You can execute queries, create new suggestions, update records, and delete test entries directly within the Swagger UI.

---

## 🔌 API Endpoints Summary

### Suggestions (`public-improvements` Database)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/public-improvements/suggestions` | List suggestions (supports `?status=`, `?authorEmail=`, `?limit=`) |
| `POST` | `/api/public-improvements/suggestions` | Create a new suggestion |
| `GET` | `/api/public-improvements/suggestions/:id` | Get suggestion details by ID |
| `PUT` | `/api/public-improvements/suggestions/:id` | Update an existing suggestion |
| `DELETE` | `/api/public-improvements/suggestions/:id` | Delete a suggestion by ID |

*(Alias routes are also mounted at `/api/suggestions` for convenience).*

### Example: Create Suggestion (`POST /api/public-improvements/suggestions`)

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
    "details": "Installing concrete bollards and native Texas oak trees will increase pedestrian safety and lower summer heat."
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

## 🚢 Deployment to Google Cloud Run

Deploy directly to Google Cloud Run using the `deploy` npm script:

```bash
npm run deploy
```

Or run the `gcloud` command directly:

```bash
gcloud run deploy urbanists-cloud-api-server \
  --source . \
  --region us-central1 \
  --allow-unauthenticated
```

---

## 🤝 Contributing

1. Fork or branch from `main`: `git checkout -b feature/my-feature`
2. Ensure TypeScript builds cleanly without errors: `npm run build`
3. Commit your changes: `git commit -m 'feat: add new feature'`
4. Push to origin: `git push origin feature/my-feature`
5. Open a Pull Request for review
