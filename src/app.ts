import express, { Express, Request, Response, NextFunction } from 'express';
import swaggerUi from 'swagger-ui-express';
import dotenv from 'dotenv';
import { corsMiddleware, corsErrorHandler } from './middleware/cors.js';
import suggestionRoutes from './routes/suggestionRoutes.js';
import { swaggerDocument } from './docs/swagger.js';

dotenv.config();

export function createApp(): Express {
  const app = express();

  // Basic Middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // CORS Middleware & Error handling
  app.use(corsMiddleware);
  app.use(corsErrorHandler);

  // Swagger Documentation UI
  const swaggerUiOptions = {
    customSiteTitle: 'Dallas Urbanists API Docs',
    customCss: '.swagger-ui .topbar { background-color: #1a365d; }',
  };

  app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument, swaggerUiOptions));
  app.use('/swagger', swaggerUi.serve, swaggerUi.setup(swaggerDocument, swaggerUiOptions));
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument, swaggerUiOptions));

  // Swagger spec JSON endpoint
  app.get('/api-docs.json', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(swaggerDocument);
  });

  // Health Check
  app.get('/api/health', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'urbanists-cloud-api-server',
      databases: ['public-improvements'],
    });
  });

  // Root Welcome & Redirect helper
  app.get('/', (_req: Request, res: Response) => {
    res.send(`
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Dallas Urbanists Cloud API</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 50px auto; padding: 0 20px; line-height: 1.6; color: #2d3748; }
            h1 { color: #1a365d; margin-bottom: 0.5rem; }
            .card { background: #f7fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 24px; margin-top: 20px; }
            a.button { display: inline-block; background: #2b6cb0; color: white; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: bold; margin-top: 10px; }
            a.button:hover { background: #2c5282; }
            code { background: #edf2f7; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
          </style>
        </head>
        <body>
          <h1>Dallas Urbanists Cloud API</h1>
          <p>General purpose database and API web service hosted on Google Cloud Run.</p>
          <div class="card">
            <h3>Interactive API Documentation</h3>
            <p>Explore endpoints, view schemas, and execute test requests live:</p>
            <a class="button" href="/docs">Open Swagger API Docs & UI &rarr;</a>
          </div>
          <div class="card">
            <h3>Available Endpoints</h3>
            <ul>
              <li><code>GET /api/public-improvements/suggestions</code> - List suggestions</li>
              <li><code>POST /api/public-improvements/suggestions</code> - Create a suggestion</li>
              <li><code>GET /api/public-improvements/suggestions/:id</code> - Get suggestion by ID</li>
              <li><code>PUT /api/public-improvements/suggestions/:id</code> - Update suggestion</li>
              <li><code>DELETE /api/public-improvements/suggestions/:id</code> - Delete suggestion</li>
              <li><code>GET /api/health</code> - Service health check</li>
            </ul>
          </div>
        </body>
      </html>
    `);
  });

  // API Routes
  app.use('/api/public-improvements/suggestions', suggestionRoutes);
  // Also register alias /api/suggestions for convenience
  app.use('/api/suggestions', suggestionRoutes);

  // 404 Handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: 'Not Found',
      message: 'The requested API endpoint does not exist. Visit /docs for available endpoints.',
    });
  });

  // Global Error Handler
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Unhandled Server Error:', err);
    res.status(err.status || 500).json({
      error: err.name || 'Internal Server Error',
      message: err.message || 'An unexpected error occurred.',
    });
  });

  return app;
}
