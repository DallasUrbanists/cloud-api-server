import express, { Express, Request, Response, NextFunction } from 'express';
import swaggerUi from 'swagger-ui-express';
import dotenv from 'dotenv';
import { corsMiddleware, corsErrorHandler } from './middleware/cors.js';
import suggestionRoutes from './routes/suggestionRoutes.js';
import contactRoutes from './routes/contactRoutes.js';
import checkinRoutes from './routes/checkinRoutes.js';
import operationGroupRoutes from './routes/operationGroupRoutes.js';
import eventsRoutes from './routes/eventsRoutes.js';
import userRoutes from './routes/userRoutes.js';
import { swaggerDocument } from './docs/swagger.js';
import { HomeController } from './controllers/homeController.js';
import { formatResponseIntegers } from './utils/responseFormatting.js';

dotenv.config();

export function createApp(): Express {
  const app = express();

  // Basic Middleware
  const ordinaryJson = express.json();
  const operationJson = express.json({ limit: '2mb' });
  app.use((req, res, next) => {
    const isOperation = req.path === '/api/operation-groups' || req.path.startsWith('/api/operation-groups/');
    return (isOperation || req.header('X-Operation-Group') !== undefined ? operationJson : ordinaryJson)(req, res, next);
  });
  app.use(express.urlencoded({ extended: true }));

  // PostgreSQL returns BIGINT values as strings. Normalize integer response fields
  // at the HTTP boundary so every endpoint emits JSON numbers consistently.
  app.use((_req, res, next) => {
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => originalJson(formatResponseIntegers(body))) as typeof res.json;
    next();
  });

  // CORS Middleware & Error handling
  app.use(corsMiddleware);
  app.use(corsErrorHandler);
    app.use((req, res, next) => {
      if (req.header('X-Operation-Group') !== undefined && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
        && (!['PUT', 'DELETE'].includes(req.method) || !/^\/api\/(contacts|checkins)\/\d+\/?$/.test(req.path))) {
        res.status(400).json({ error: 'UNSUPPORTED_GROUP_MUTATION', message: 'Operation groups support only per-record contact/check-in PUT and DELETE requests.' });
        return;
      }
      next();
    });

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
    .swagger-ui .topbar-wrapper > *:not(.link):not(#swagger-theme-btn):not(#swagger-auth-btn):not(#swagger-auth-panel) {
      display: none !important;
    }

    /*.swagger-ui .topbar button:not(#swagger-theme-btn),
    .swagger-ui .topbar .theme-toggle:not(#swagger-theme-btn),
    .swagger-ui .topbar .theme-switch,
    .swagger-ui .topbar [aria-label*="theme" i]:not(#swagger-theme-btn),
    .swagger-ui .topbar [title*="theme" i]:not(#swagger-theme-btn) {
      display: none !important;
    }*/

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

    .swagger-auth-panel {
      position: absolute;
      top: 52px;
      right: 20px;
      z-index: 1000;
      display: flex;
      gap: 6px;
      align-items: center;
      padding: 10px;
      background: var(--st-surface);
      border: 1px solid var(--st-border);
      border-radius: 8px;
      box-shadow: var(--st-shadow);
    }

    .swagger-auth-panel input {
      width: 170px;
      padding: 6px 8px;
      color: var(--st-text);
      background: var(--st-input-bg);
      border: 1px solid var(--st-border);
      border-radius: 4px;
    }

    .swagger-auth-divider {
      color: var(--st-text-secondary);
      font-size: 0.8rem;
    }

    .swagger-auth-status {
      max-width: 220px;
      color: var(--st-text-secondary);
      font-size: 0.8rem;
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
    swaggerOptions: {
      docExpansion: 'none',
    },
  };

  // Serve Swagger theme and local Firebase sign-in helper.
  app.get('/swagger-theme.js', (_req: Request, res: Response) => {
    const firebaseWebConfig = JSON.stringify({
      apiKey: process.env.FIREBASE_WEB_API_KEY || process.env.VITE_FIREBASE_API_KEY || '',
      authDomain: process.env.FIREBASE_AUTH_DOMAIN || process.env.VITE_FIREBASE_AUTH_DOMAIN || '',
      projectId: process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID || '',
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || process.env.VITE_FIREBASE_STORAGE_BUCKET || '',
      messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || process.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
      appId: process.env.FIREBASE_APP_ID || process.env.VITE_FIREBASE_APP_ID || '',
    });
    const firebaseWebApiKey = JSON.stringify(
      process.env.FIREBASE_WEB_API_KEY && process.env.ENABLE_SWAGGER_FIREBASE_AUTH === 'true'
        ? process.env.FIREBASE_WEB_API_KEY
        : '',
    );
    const recaptchaSiteKey = JSON.stringify(
      process.env.FIREBASE_RECAPTCHA_SITE_KEY || process.env.VITE_RECAPTCHA_SITE_KEY || '',
    );
    const appCheckProvider = JSON.stringify(
      process.env.FIREBASE_APPCHECK_PROVIDER || process.env.VITE_FIREBASE_APPCHECK_PROVIDER || 'recaptcha-v3',
    );
    const appCheckDebugToken = JSON.stringify(
      process.env.NODE_ENV !== 'production'
        ? process.env.FIREBASE_APPCHECK_DEBUG_TOKEN || process.env.VITE_FIREBASE_APPCHECK_DEBUG_TOKEN || ''
        : '',
    );
    res.setHeader('Content-Type', 'application/javascript');
    res.send(`
      (function() {
        const firebaseWebConfig = ${firebaseWebConfig};
        const firebaseWebApiKey = ${firebaseWebApiKey};
        const recaptchaSiteKey = ${recaptchaSiteKey};
        const appCheckProvider = ${appCheckProvider};
        const appCheckDebugToken = ${appCheckDebugToken};
        let appCheckReady = Promise.resolve();

        function loadScript(src) {
          return new Promise(function(resolve, reject) {
            const script = document.createElement('script');
            script.src = src;
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
          });
        }

        if (firebaseWebConfig.apiKey && recaptchaSiteKey) {
          if (appCheckDebugToken) window.FIREBASE_APPCHECK_DEBUG_TOKEN = appCheckDebugToken;
          const appCheckSetup = loadScript('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js')
            .then(function() { return loadScript('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-check-compat.js'); })
            .then(function() {
              if (!firebase.apps.length) firebase.initializeApp(firebaseWebConfig);
              let provider;
              if (appCheckProvider === 'recaptcha-enterprise') {
                provider = new firebase.appCheck.ReCaptchaEnterpriseProvider(recaptchaSiteKey);
              } else if (appCheckProvider === 'recaptcha-v3') {
                provider = new firebase.appCheck.ReCaptchaV3Provider(recaptchaSiteKey);
              } else {
                throw new Error('FIREBASE_APPCHECK_PROVIDER must be recaptcha-v3 or recaptcha-enterprise.');
              }
              firebase.appCheck().activate(provider, true);
            })
            .catch(function(error) { console.warn('Swagger Firebase App Check unavailable:', error); });
          // Never block Swagger requests if a CDN, extension, or network policy prevents SDK loading.
          appCheckReady = Promise.race([
            appCheckSetup,
            new Promise(function(resolve) { setTimeout(resolve, 3000); }),
          ]);
        }

        const originalFetch = window.fetch.bind(window);
        window.fetch = function(input, init) {
          const requestUrl = new URL(typeof input === 'string' ? input : input.url, window.location.href);
          // Only API calls need App Check. Excluding Firebase and reCAPTCHA traffic avoids
          // recursively requesting an App Check token while Firebase is obtaining one.
          if (requestUrl.origin !== window.location.origin || !requestUrl.pathname.startsWith('/api/')) {
            return originalFetch(input, init);
          }
          return appCheckReady.then(function() {
            if (typeof firebase === 'undefined' || !firebase.apps.length || !firebase.appCheck) {
              return originalFetch(input, init);
            }
            const tokenPromise = firebase.appCheck().getToken();
            const tokenTimeout = new Promise(function(resolve) { setTimeout(function() { resolve(null); }, 3000); });
            return Promise.race([tokenPromise, tokenTimeout]).then(function(result) {
              const headers = new Headers((init && init.headers) || (input instanceof Request ? input.headers : undefined));
              if (result && result.token) headers.set('X-Firebase-AppCheck', result.token);
              return originalFetch(input, Object.assign({}, init, { headers: headers }));
            });
          }).catch(function() {
            return originalFetch(input, init);
          });
        };

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
              if (!child.classList.contains('link') && !['swagger-theme-btn', 'swagger-auth-btn', 'swagger-auth-panel'].includes(child.id)) {
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

        function initFirebaseAuth() {
          if (!firebaseWebApiKey || document.getElementById('swagger-auth-btn')) return;
          const topbarWrapper = document.querySelector('.swagger-ui .topbar .topbar-wrapper');
          if (!topbarWrapper) return;

          const button = document.createElement('button');
          button.id = 'swagger-auth-btn';
          button.className = 'swagger-theme-toggle';
          button.type = 'button';
          button.textContent = '🔐 Firebase Sign In';

          const panel = document.createElement('form');
          panel.id = 'swagger-auth-panel';
          panel.className = 'swagger-auth-panel';
          panel.hidden = true;
          panel.innerHTML = '<button class="swagger-theme-toggle" id="swagger-google-sign-in" type="button">Sign in with Google</button>' +
            '<span class="swagger-auth-divider">or</span>' +
            '<input name="email" type="email" placeholder="Email" required />' +
            '<input name="password" type="password" placeholder="Password" required />' +
            '<button class="swagger-theme-toggle" type="submit">Sign in</button>' +
            '<span class="swagger-auth-status" aria-live="polite"></span>';

          const status = panel.querySelector('.swagger-auth-status');
          const authorize = function(idToken, userLabel) {
            if (!window.ui || !window.ui.preauthorizeApiKey) throw new Error('Swagger authorization is not ready. Refresh and try again.');
            window.ui.preauthorizeApiKey('BearerAuth', idToken);
            status.textContent = 'Signed in as ' + userLabel + '.';
          };
          button.onclick = function() { panel.hidden = !panel.hidden; };
          panel.querySelector('#swagger-google-sign-in').onclick = async function() {
            status.textContent = 'Opening Google sign-in…';
            try {
              if (typeof firebase === 'undefined') {
                await loadScript('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
              }
              await loadScript('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth-compat.js');
              if (!firebase.apps.length) firebase.initializeApp(firebaseWebConfig);
              const provider = new firebase.auth.GoogleAuthProvider();
              const result = await firebase.auth().signInWithPopup(provider);
              const user = result.user;
              authorize(await user.getIdToken(), user.email || 'Google account');
            } catch (error) {
              status.textContent = error.message || 'Google sign-in failed.';
            }
          };
          panel.onsubmit = async function(event) {
            event.preventDefault();
            status.textContent = 'Signing in…';
            const form = new FormData(panel);
            try {
              const response = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + encodeURIComponent(firebaseWebApiKey), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: form.get('email'), password: form.get('password'), returnSecureToken: true }),
              });
              const data = await response.json();
              if (!response.ok) throw new Error(data.error?.message || 'Firebase sign-in failed.');
              authorize(data.idToken, form.get('email') || 'Firebase account');
              panel.querySelector('input[name="password"]').value = '';
            } catch (error) {
              status.textContent = error.message || 'Sign-in failed.';
            }
          };

          topbarWrapper.appendChild(button);
          topbarWrapper.appendChild(panel);
        }

        function initSwaggerControls() {
          initToggleBtn();
          initFirebaseAuth();
        }

        applyTheme(getTheme());
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', initSwaggerControls);
        } else {
          initSwaggerControls();
        }

        // Retry in case Swagger UI topbar renders asynchronously
        const interval = setInterval(function() {
          if (document.querySelector('.swagger-ui .topbar .topbar-wrapper')) {
            initSwaggerControls();
            clearInterval(interval);
          }
        }, 200);
        setTimeout(function() { clearInterval(interval); }, 5000);
      })();
    `);
  });

  const swaggerSetup = swaggerUi.setup(swaggerDocument, swaggerUiOptions);

  // Homepage: Render README.md with top navigation to GitHub and API Docs
  app.get('/', HomeController.renderHome);

  // Interactive Swagger Documentation UI
  app.use('/docs', swaggerUi.serve, swaggerSetup);
  app.use('/swagger', swaggerUi.serve, swaggerSetup);
  app.use('/api-docs', swaggerUi.serve, swaggerSetup);

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

  // API Routes
  app.use('/api/public-improvements/suggestions', suggestionRoutes);
  app.use('/api/suggestions', suggestionRoutes); // Also register alias /api/suggestions for convenience
  app.use('/api/contacts', contactRoutes);
  app.use('/api/checkins', checkinRoutes);
  app.use('/api/operation-groups', operationGroupRoutes);
  app.use('/api/events', eventsRoutes);
  app.use('/api/users', userRoutes);
  app.use('/meetup-ical', eventsRoutes);
  app.use('/api/meetup-ical', eventsRoutes);

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
