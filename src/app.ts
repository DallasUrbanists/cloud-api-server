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

  // Swagger Documentation UI with Strong Towns Theme (Dark & Light) & Typography
  const swaggerCustomCss = `
    @import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

    :root, [data-theme="dark"] {
      --st-dark-blue: #0c2340;
      --st-light-blue: #488be3;
      --st-yellow: #ffa800;
      --st-sidewalk: #f5f3ee;
      --st-bg: #07172b;
      --st-surface: #0c2340;
      --st-surface-hover: #112d50;
      --st-border: #193860;
      --st-text: #f5f3ee;
      --st-text-secondary: #a9bed4;
      --st-text-muted: #748da9;
      --st-topbar-bg: #0c2340;
      --st-card-bg: #0c2340;
      --st-input-bg: #05101f;
      --st-code-bg: #05101f;
      --st-btn-bg: #ffa800;
      --st-btn-color: #0c2340;
      --st-btn-hover: #e09500;
      --st-badge-bg: #ffa800;
      --st-badge-text: #0c2340;
      --st-op-get-bg: rgba(43, 122, 75, 0.12);
      --st-op-get-border: #2b7a4b;
      --st-op-post-bg: rgba(255, 168, 0, 0.12);
      --st-op-post-border: #ffa800;
      --st-op-put-bg: rgba(72, 139, 227, 0.12);
      --st-op-put-border: #488be3;
      --st-op-delete-bg: rgba(245, 101, 101, 0.12);
      --st-op-delete-border: #f56565;
      --st-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    }

    [data-theme="light"] {
      --st-dark-blue: #0c2340;
      --st-light-blue: #488be3;
      --st-yellow: #ffa800;
      --st-sidewalk: #f5f3ee;
      --st-bg: #f5f3ee;
      --st-surface: #ffffff;
      --st-surface-hover: #f0ede4;
      --st-border: #dcd6c8;
      --st-text: #0c2340;
      --st-text-secondary: #4a5d73;
      --st-text-muted: #6e7f93;
      --st-topbar-bg: #0c2340;
      --st-card-bg: #ffffff;
      --st-input-bg: #ffffff;
      --st-code-bg: #ece8df;
      --st-btn-bg: #0c2340;
      --st-btn-color: #ffffff;
      --st-btn-hover: #173860;
      --st-badge-bg: #0c2340;
      --st-badge-text: #ffffff;
      --st-op-get-bg: rgba(43, 122, 75, 0.08);
      --st-op-get-border: #2b7a4b;
      --st-op-post-bg: rgba(255, 168, 0, 0.08);
      --st-op-post-border: #b86b00;
      --st-op-put-bg: rgba(72, 139, 227, 0.08);
      --st-op-put-border: #306cb5;
      --st-op-delete-bg: rgba(179, 57, 57, 0.08);
      --st-op-delete-border: #b33939;
      --st-shadow: 0 4px 14px rgba(12, 35, 64, 0.08);
    }

    body, .swagger-ui {
      background-color: var(--st-bg) !important;
      color: var(--st-text) !important;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important;
      transition: background-color 0.25s ease, color 0.25s ease;
    }

    .swagger-ui .wrapper {
      max-width: 1100px !important;
      padding: 0 20px !important;
    }

    .swagger-ui .topbar {
      background-color: var(--st-topbar-bg) !important;
      border-bottom: 3px solid var(--st-yellow) !important;
      padding: 12px 0 !important;
    }

    .swagger-ui .topbar .topbar-wrapper {
      display: flex !important;
      align-items: center !important;
      justify-content: space-between !important;
      max-width: 1100px !important;
      padding: 0 20px !important;
    }

    .swagger-ui .topbar a {
      font-family: 'DM Serif Display', Georgia, serif !important;
      font-size: 1.3rem !important;
      color: #ffffff !important;
      text-decoration: none !important;
    }

    .swagger-ui .topbar svg {
      fill: #ffffff !important;
    }

    /* Hide any extraneous or broken default topbar toggles/buttons */
    .swagger-ui .topbar-wrapper > *:not(.link):not(#swagger-theme-btn) {
      display: none !important;
    }

    .swagger-ui .topbar button:not(#swagger-theme-btn),
    .swagger-ui .topbar .theme-toggle:not(#swagger-theme-btn),
    .swagger-ui .topbar .theme-switch,
    .swagger-ui .topbar [aria-label*="theme" i]:not(#swagger-theme-btn),
    .swagger-ui .topbar [title*="theme" i]:not(#swagger-theme-btn) {
      display: none !important;
    }

    /* Swagger Theme Toggle Button */
    .swagger-theme-toggle {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: rgba(255, 255, 255, 0.12);
      border: 1px solid rgba(255, 255, 255, 0.25);
      color: #ffffff;
      padding: 6px 14px;
      border-radius: 9999px;
      cursor: pointer;
      font-family: 'Inter', sans-serif;
      font-size: 0.85rem;
      font-weight: 600;
      transition: all 0.2s ease;
      white-space: nowrap;
    }

    .swagger-theme-toggle:hover {
      background: rgba(255, 255, 255, 0.22);
      border-color: var(--st-yellow);
      color: var(--st-yellow);
    }

    .swagger-ui .info {
      margin: 30px 0 20px !important;
    }

    .swagger-ui .info .title {
      font-family: 'DM Serif Display', Georgia, serif !important;
      color: var(--st-text) !important;
      font-size: 2.3rem !important;
    }

    .swagger-ui .info p, .swagger-ui .info li, .swagger-ui .info td {
      color: var(--st-text-secondary) !important;
      font-size: 0.95rem !important;
    }

    .swagger-ui .info a {
      color: var(--st-light-blue) !important;
    }

    .swagger-ui .scheme-container {
      background-color: var(--st-surface) !important;
      box-shadow: var(--st-shadow) !important;
      border: 1px solid var(--st-border) !important;
      border-radius: 8px !important;
      padding: 16px 20px !important;
      margin-bottom: 24px !important;
    }

    .swagger-ui .scheme-container .schemes-title {
      color: var(--st-text) !important;
    }

    .swagger-ui select {
      background-color: var(--st-input-bg) !important;
      color: var(--st-text) !important;
      border: 1px solid var(--st-border) !important;
      border-radius: 6px !important;
      padding: 6px 10px !important;
    }

    .swagger-ui .opblock-tag {
      font-family: 'DM Serif Display', Georgia, serif !important;
      font-size: 1.45rem !important;
      color: var(--st-text) !important;
      border-bottom: 1px solid var(--st-border) !important;
      padding: 12px 0 !important;
    }

    .swagger-ui .opblock-tag small {
      color: var(--st-text-muted) !important;
      font-family: 'Inter', sans-serif !important;
      font-size: 0.85rem !important;
    }

    /* Operation Blocks */
    .swagger-ui .opblock {
      background-color: var(--st-surface) !important;
      border-radius: 8px !important;
      box-shadow: var(--st-shadow) !important;
      margin: 0 0 16px !important;
      border: 1px solid var(--st-border) !important;
    }

    .swagger-ui .opblock .opblock-summary {
      border-color: var(--st-border) !important;
      padding: 8px 16px !important;
    }

    .swagger-ui .opblock .opblock-summary-method {
      font-family: 'JetBrains Mono', monospace !important;
      font-weight: 700 !important;
      border-radius: 6px !important;
      text-shadow: none !important;
    }

    .swagger-ui .opblock .opblock-summary-path,
    .swagger-ui .opblock .opblock-summary-path__deprecated {
      color: var(--st-text) !important;
      font-family: 'JetBrains Mono', monospace !important;
      font-size: 0.95rem !important;
    }

    .swagger-ui .opblock .opblock-summary-description {
      color: var(--st-text-secondary) !important;
      font-size: 0.88rem !important;
    }

    /* Method specific borders and colors */
    .swagger-ui .opblock.opblock-get {
      border-color: var(--st-op-get-border) !important;
      background: var(--st-op-get-bg) !important;
    }
    .swagger-ui .opblock.opblock-get .opblock-summary-method { background: #2b7a4b !important; color: #fff !important; }

    .swagger-ui .opblock.opblock-post {
      border-color: var(--st-op-post-border) !important;
      background: var(--st-op-post-bg) !important;
    }
    .swagger-ui .opblock.opblock-post .opblock-summary-method { background: var(--st-yellow) !important; color: #0c2340 !important; }

    .swagger-ui .opblock.opblock-put {
      border-color: var(--st-op-put-border) !important;
      background: var(--st-op-put-bg) !important;
    }
    .swagger-ui .opblock.opblock-put .opblock-summary-method { background: var(--st-light-blue) !important; color: #fff !important; }

    .swagger-ui .opblock.opblock-delete {
      border-color: var(--st-op-delete-border) !important;
      background: var(--st-op-delete-bg) !important;
    }
    .swagger-ui .opblock.opblock-delete .opblock-summary-method { background: #c53030 !important; color: #fff !important; }

    /* Expanded operation body */
    .swagger-ui .opblock-body {
      background: var(--st-surface-hover) !important;
    }

    .swagger-ui .opblock-section-header {
      background-color: var(--st-surface) !important;
      border-bottom: 1px solid var(--st-border) !important;
      color: var(--st-text) !important;
    }

    .swagger-ui .opblock-section-header h4 {
      color: var(--st-text) !important;
      font-family: 'Inter', sans-serif !important;
      font-weight: 600 !important;
    }

    .swagger-ui table.parameters {
      color: var(--st-text) !important;
    }

    .swagger-ui table.parameters th {
      color: var(--st-text-secondary) !important;
      border-bottom: 1px solid var(--st-border) !important;
    }

    .swagger-ui .parameter__name {
      color: var(--st-text) !important;
      font-family: 'JetBrains Mono', monospace !important;
    }

    .swagger-ui .parameter__type {
      color: var(--st-light-blue) !important;
      font-family: 'JetBrains Mono', monospace !important;
    }

    .swagger-ui .parameter__in {
      color: var(--st-text-muted) !important;
    }

    .swagger-ui table.responses-table {
      color: var(--st-text) !important;
    }

    .swagger-ui table.responses-table th {
      color: var(--st-text-secondary) !important;
      border-bottom: 1px solid var(--st-border) !important;
    }

    .swagger-ui .response-col_status {
      font-family: 'JetBrains Mono', monospace !important;
      color: var(--st-text) !important;
    }

    .swagger-ui .response-col_description {
      color: var(--st-text-secondary) !important;
    }

    /* Buttons & Inputs */
    .swagger-ui .btn {
      font-family: 'Inter', sans-serif !important;
      font-weight: 600 !important;
      border-radius: 6px !important;
      border: 1px solid var(--st-border) !important;
      color: var(--st-text) !important;
      background-color: var(--st-surface) !important;
      box-shadow: none !important;
    }

    .swagger-ui .btn:hover {
      background-color: var(--st-surface-hover) !important;
      border-color: var(--st-light-blue) !important;
    }

    .swagger-ui .btn.execute {
      background-color: var(--st-btn-bg) !important;
      color: var(--st-btn-color) !important;
      border-color: var(--st-btn-bg) !important;
    }

    .swagger-ui .btn.execute:hover {
      background-color: var(--st-btn-hover) !important;
    }

    .swagger-ui .btn.cancel {
      border-color: #f56565 !important;
      color: #f56565 !important;
    }

    .swagger-ui input[type=text], .swagger-ui textarea {
      background-color: var(--st-input-bg) !important;
      color: var(--st-text) !important;
      border: 1px solid var(--st-border) !important;
      border-radius: 6px !important;
      font-family: 'JetBrains Mono', monospace !important;
    }

    .swagger-ui .model-box, .swagger-ui section.models {
      background-color: var(--st-surface) !important;
      border: 1px solid var(--st-border) !important;
      border-radius: 8px !important;
    }

    .swagger-ui section.models h4 {
      font-family: 'DM Serif Display', Georgia, serif !important;
      color: var(--st-text) !important;
      font-size: 1.3rem !important;
    }

    .swagger-ui .model-title {
      font-family: 'JetBrains Mono', monospace !important;
      color: var(--st-text) !important;
    }

    .swagger-ui .model {
      color: var(--st-text) !important;
      font-family: 'JetBrains Mono', monospace !important;
    }

    .swagger-ui .model .property {
      color: var(--st-light-blue) !important;
    }

    .swagger-ui .highlight-code pre, .swagger-ui .microlight {
      background-color: var(--st-code-bg) !important;
      color: var(--st-text) !important;
      border: 1px solid var(--st-border) !important;
      border-radius: 6px !important;
      font-family: 'JetBrains Mono', monospace !important;
    }

    .swagger-ui svg {
      fill: var(--st-text) !important;
    }

    .swagger-ui .dialog-ux .modal-ux {
      background: var(--st-surface) !important;
      border: 1px solid var(--st-border) !important;
      color: var(--st-text) !important;
    }

    .swagger-ui .dialog-ux .modal-ux-header h3 {
      color: var(--st-text) !important;
      font-family: 'DM Serif Display', Georgia, serif !important;
    }
  `;

  const swaggerUiOptions = {
    customSiteTitle: 'Dallas Urbanists API Docs',
    customCss: swaggerCustomCss,
    customJs: '/swagger-theme.js',
    customCssUrl: 'https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap',
  };

  // Serve swagger theme synchronization script
  app.get('/swagger-theme.js', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/javascript');
    res.send(`
      (function() {
        function getTheme() {
          return localStorage.getItem('urbanists_theme') || 'dark';
        }

        function applyTheme(theme) {
          document.documentElement.setAttribute('data-theme', theme);
          if (document.body) {
            document.body.setAttribute('data-theme', theme);
          }
          const btn = document.getElementById('swagger-theme-btn');
          if (btn) {
            btn.innerHTML = theme === 'dark' ? '<span>☀️</span> Light Mode' : '<span>🌙</span> Dark Mode';
          }
        }

        function toggleSwaggerTheme() {
          const current = getTheme();
          const next = current === 'dark' ? 'light' : 'dark';
          localStorage.setItem('urbanists_theme', next);
          applyTheme(next);
        }

        function initToggleBtn() {
          applyTheme(getTheme());
          const topbarWrapper = document.querySelector('.swagger-ui .topbar .topbar-wrapper');
          if (topbarWrapper) {
            // Remove any extraneous buttons or elements that are not the main link or our button
            Array.from(topbarWrapper.children).forEach(function(child) {
              if (!child.classList.contains('link') && child.id !== 'swagger-theme-btn') {
                child.remove();
              }
            });

            if (!document.getElementById('swagger-theme-btn')) {
              const btn = document.createElement('button');
              btn.id = 'swagger-theme-btn';
              btn.className = 'swagger-theme-toggle';
              btn.type = 'button';
              btn.onclick = toggleSwaggerTheme;
              btn.innerHTML = getTheme() === 'dark' ? '<span>☀️</span> Light Mode' : '<span>🌙</span> Dark Mode';
              topbarWrapper.appendChild(btn);
            }
          }
        }

        applyTheme(getTheme());
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', initToggleBtn);
        } else {
          initToggleBtn();
        }

        // Retry in case Swagger UI topbar renders asynchronously
        const interval = setInterval(function() {
          if (document.querySelector('.swagger-ui .topbar .topbar-wrapper')) {
            initToggleBtn();
            clearInterval(interval);
          }
        }, 200);
        setTimeout(function() { clearInterval(interval); }, 5000);
      })();
    `);
  });

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
      <html lang="en" data-theme="dark">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Dallas Urbanists Cloud API</title>
          <link rel="preconnect" href="https://fonts.googleapis.com">
          <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
          <link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
          <style>
            :root {
              --font-heading: 'DM Serif Display', Georgia, serif;
              --font-body: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              --font-mono: 'JetBrains Mono', Menlo, Monaco, Consolas, monospace;

              /* Light Mode Variables (Strong Towns Brand Palette) */
              --bg: #f5f3ee;             /* Sidewalk */
              --surface: #ffffff;        /* White */
              --surface-hover: #faf8f5;
              --border: #e4dfd5;
              --text-primary: #0c2340;   /* Dark Blue */
              --text-secondary: #4a5d73;
              --text-muted: #6e7f93;
              --accent-gold: #ffa800;    /* Yellow */
              --accent-blue: #488be3;    /* Light Blue */
              --brand-dark: #0c2340;     /* Dark Blue */
              --button-bg: #0c2340;
              --button-hover: #173860;
              --button-text: #ffffff;
              --code-bg: #ece8df;
              --code-text: #0c2340;
              --method-get: #2b7a4b;
              --method-post: #b86b00;
              --method-put: #306cb5;
              --method-delete: #b33939;
              --shadow: 0 4px 14px rgba(12, 35, 64, 0.08);
            }

            [data-theme="dark"] {
              /* Dark Mode Variables (Strong Towns Brand Palette) */
              --bg: #07172b;
              --surface: #0c2340;        /* Dark Blue Core */
              --surface-hover: #112d50;
              --border: #193860;
              --text-primary: #f5f3ee;   /* Sidewalk */
              --text-secondary: #a9bed4;
              --text-muted: #748da9;
              --accent-gold: #ffa800;    /* Yellow */
              --accent-blue: #488be3;    /* Light Blue */
              --brand-dark: #0c2340;
              --button-bg: #ffa800;
              --button-hover: #e09500;
              --button-text: #0c2340;
              --code-bg: #05101f;
              --code-text: #ffa800;
              --method-get: #48bb78;
              --method-post: #ffa800;
              --method-put: #488be3;
              --method-delete: #f56565;
              --shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
            }

            * { box-sizing: border-box; margin: 0; padding: 0; }
            body {
              font-family: var(--font-body);
              background: var(--bg);
              color: var(--text-primary);
              max-width: 860px;
              margin: 0 auto;
              padding: 40px 24px 60px;
              line-height: 1.6;
              transition: background-color 0.25s ease, color 0.25s ease;
            }

            .header {
              display: flex;
              justify-content: space-between;
              align-items: flex-start;
              gap: 20px;
              margin-bottom: 28px;
              padding-bottom: 20px;
              border-bottom: 2px solid var(--border);
            }

            .header-info { flex: 1; }

            .badge {
              display: inline-block;
              font-family: var(--font-body);
              font-size: 0.75rem;
              font-weight: 700;
              text-transform: uppercase;
              letter-spacing: 0.06em;
              background: var(--accent-gold);
              color: #0c2340;
              padding: 3px 9px;
              border-radius: 4px;
              margin-bottom: 12px;
            }

            h1 {
              font-family: var(--font-heading);
              font-size: 2.35rem;
              line-height: 1.15;
              color: var(--text-primary);
              margin-bottom: 8px;
              letter-spacing: -0.01em;
            }

            .subtitle {
              font-size: 1.05rem;
              color: var(--text-secondary);
            }

            .theme-toggle {
              display: inline-flex;
              align-items: center;
              gap: 8px;
              background: var(--surface);
              border: 1px solid var(--border);
              color: var(--text-primary);
              padding: 8px 14px;
              border-radius: 9999px;
              cursor: pointer;
              font-family: var(--font-body);
              font-size: 0.85rem;
              font-weight: 600;
              box-shadow: var(--shadow);
              transition: all 0.2s ease;
              white-space: nowrap;
            }
            .theme-toggle:hover {
              background: var(--surface-hover);
              border-color: var(--accent-blue);
            }

            .card {
              background: var(--surface);
              border: 1px solid var(--border);
              border-radius: 12px;
              padding: 24px;
              margin-top: 24px;
              box-shadow: var(--shadow);
              transition: background-color 0.25s ease, border-color 0.25s ease;
            }

            h3 {
              font-family: var(--font-heading);
              font-size: 1.4rem;
              margin-bottom: 10px;
              color: var(--text-primary);
              display: flex;
              align-items: center;
              gap: 8px;
            }

            p {
              color: var(--text-secondary);
              font-size: 0.96rem;
            }

            a.button {
              display: inline-flex;
              align-items: center;
              gap: 8px;
              background: var(--button-bg);
              color: var(--button-text);
              padding: 12px 22px;
              border-radius: 8px;
              text-decoration: none;
              font-weight: 600;
              font-size: 0.95rem;
              margin-top: 16px;
              transition: background 0.2s ease, transform 0.15s ease;
            }
            a.button:hover {
              background: var(--button-hover);
              transform: translateY(-1px);
            }

            .endpoints-list {
              list-style: none;
              margin-top: 14px;
              display: flex;
              flex-direction: column;
              gap: 10px;
            }

            .endpoint-item {
              display: flex;
              align-items: center;
              flex-wrap: wrap;
              gap: 10px;
              padding: 8px 12px;
              background: var(--bg);
              border: 1px solid var(--border);
              border-radius: 6px;
              font-size: 0.9rem;
            }

            .method {
              font-family: var(--font-mono);
              font-size: 0.75rem;
              font-weight: 700;
              padding: 2px 7px;
              border-radius: 4px;
              min-width: 58px;
              text-align: center;
            }
            .method.get { background: rgba(72, 187, 120, 0.15); color: var(--method-get); }
            .method.post { background: rgba(255, 168, 0, 0.15); color: var(--method-post); }
            .method.put { background: rgba(72, 139, 227, 0.15); color: var(--method-put); }
            .method.delete { background: rgba(245, 101, 101, 0.15); color: var(--method-delete); }

            code {
              font-family: var(--font-mono);
              background: var(--code-bg);
              color: var(--code-text);
              padding: 2px 8px;
              border-radius: 4px;
              font-size: 0.88rem;
              font-weight: 500;
            }

            .endpoint-desc {
              color: var(--text-secondary);
              font-size: 0.85rem;
              margin-left: auto;
            }

            footer {
              margin-top: 40px;
              text-align: center;
              font-size: 0.82rem;
              color: var(--text-muted);
            }

            footer a {
              color: var(--accent-blue);
              text-decoration: none;
            }
            footer a:hover {
              text-decoration: underline;
            }
          </style>
          <script>
            // Theme initialization & toggle logic (Dark Mode by default)
            (function() {
              const savedTheme = localStorage.getItem('urbanists_theme') || 'dark';
              document.documentElement.setAttribute('data-theme', savedTheme);
            })();

            function toggleTheme() {
              const html = document.documentElement;
              const current = html.getAttribute('data-theme') || 'dark';
              const next = current === 'dark' ? 'light' : 'dark';
              html.setAttribute('data-theme', next);
              localStorage.setItem('urbanists_theme', next);
              updateThemeButton();
            }

            function updateThemeButton() {
              const current = document.documentElement.getAttribute('data-theme') || 'dark';
              const btn = document.getElementById('theme-toggle-btn');
              if (btn) {
                btn.innerHTML = current === 'dark' 
                  ? '<span>☀️</span> Light Mode' 
                  : '<span>🌙</span> Dark Mode';
              }
            }

            document.addEventListener('DOMContentLoaded', updateThemeButton);
          </script>
        </head>
        <body>
          <div class="header">
            <div class="header-info">
              <span class="badge">Strong Towns Local Conversation</span>
              <h1>Dallas Urbanists Cloud API</h1>
              <p class="subtitle">General purpose database and API web service hosted on Google Cloud Run.</p>
            </div>
            <button id="theme-toggle-btn" class="theme-toggle" onclick="toggleTheme()" aria-label="Toggle Theme">
              <span>☀️</span> Light Mode
            </button>
          </div>

          <div class="card">
            <h3>Interactive API Documentation</h3>
            <p>Explore endpoints, view schemas, and execute test requests live:</p>
            <a class="button" href="/docs">Open Swagger API Docs & UI &rarr;</a>
          </div>

          <div class="card">
            <h3>Available Endpoints</h3>
            <ul class="endpoints-list">
              <li class="endpoint-item">
                <span class="method get">GET</span>
                <code>/api/public-improvements/suggestions</code>
                <span class="endpoint-desc">List suggestions</span>
              </li>
              <li class="endpoint-item">
                <span class="method post">POST</span>
                <code>/api/public-improvements/suggestions</code>
                <span class="endpoint-desc">Create a suggestion</span>
              </li>
              <li class="endpoint-item">
                <span class="method get">GET</span>
                <code>/api/public-improvements/suggestions/:id</code>
                <span class="endpoint-desc">Get suggestion by ID</span>
              </li>
              <li class="endpoint-item">
                <span class="method put">PUT</span>
                <code>/api/public-improvements/suggestions/:id</code>
                <span class="endpoint-desc">Update suggestion</span>
              </li>
              <li class="endpoint-item">
                <span class="method delete">DELETE</span>
                <code>/api/public-improvements/suggestions/:id</code>
                <span class="endpoint-desc">Delete suggestion</span>
              </li>
              <li class="endpoint-item">
                <span class="method get">GET</span>
                <code>/api/health</code>
                <span class="endpoint-desc">Service health check</span>
              </li>
            </ul>
          </div>

          <footer>
            Dallas Urbanists &bull; Inspired by <a href="https://www.strongtowns.org" target="_blank" rel="noopener noreferrer">Strong Towns</a>
          </footer>
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
