import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { marked } from 'marked';

export class HomeController {
  private static cachedHtml: string | null = null;
  private static lastReadTime = 0;
  private static readonly CACHE_DURATION_MS = process.env.NODE_ENV === 'production' ? 60000 : 1000;

  private static getReadmeMarkdown(): string {
    const possiblePaths = [
      path.resolve(process.cwd(), 'README.md'),
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../README.md'),
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../README.md'),
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        try {
          return fs.readFileSync(p, 'utf-8');
        } catch {
          // Continue to next path
        }
      }
    }

    return '# Dallas Urbanists Cloud API Server\n\nREADME.md file could not be loaded.';
  }

  public static async renderHome(_req: Request, res: Response): Promise<void> {
    const now = Date.now();
    if (!HomeController.cachedHtml || (now - HomeController.lastReadTime > HomeController.CACHE_DURATION_MS)) {
      const markdown = HomeController.getReadmeMarkdown();
      const contentHtml = await marked.parse(markdown);

      HomeController.cachedHtml = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dallas Urbanists Cloud API Server</title>
  <meta name="description" content="Dallas Urbanists Cloud API Server - API web service providing database I/O and server-side operations for Dallas Urbanists client applications.">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root, [data-theme="dark"] {
      --st-dark-blue: #0c2340;
      --st-light-blue: #488be3;
      --st-yellow: #ffa800;
      --st-yellow-hover: #e09500;
      --st-sidewalk: #f5f3ee;
      --st-bg: #07172b;
      --st-surface: #0c2340;
      --st-surface-hover: #112d50;
      --st-border: #193860;
      --st-text: #f5f3ee;
      --st-text-secondary: #a9bed4;
      --st-text-muted: #748da9;
      --st-code-bg: #05101f;
      --st-card-bg: #0a1c33;
      --st-header-bg: rgba(12, 35, 64, 0.85);
      --st-table-stripe: rgba(255, 255, 255, 0.02);
      --st-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    }

    [data-theme="light"] {
      --st-dark-blue: #0c2340;
      --st-light-blue: #2563eb;
      --st-yellow: #d97706;
      --st-yellow-hover: #b45309;
      --st-sidewalk: #f8fafc;
      --st-bg: #f8fafc;
      --st-surface: #ffffff;
      --st-surface-hover: #f1f5f9;
      --st-border: #e2e8f0;
      --st-text: #0f172a;
      --st-text-secondary: #334155;
      --st-text-muted: #64748b;
      --st-code-bg: #f1f5f9;
      --st-card-bg: #ffffff;
      --st-header-bg: rgba(255, 255, 255, 0.85);
      --st-table-stripe: rgba(0, 0, 0, 0.02);
      --st-shadow: 0 4px 16px rgba(0, 0, 0, 0.06);
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background-color: var(--st-bg);
      color: var(--st-text);
      line-height: 1.65;
      font-size: 16px;
      transition: background-color 0.2s ease, color 0.2s ease;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    header.topbar {
      position: sticky;
      top: 0;
      z-index: 100;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      background-color: var(--st-header-bg);
      border-bottom: 1px solid var(--st-border);
      padding: 0.75rem 1.5rem;
    }

    .topbar-container {
      max-width: 1100px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
      flex-wrap: wrap;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      text-decoration: none;
      color: var(--st-text);
    }

    .brand-title {
      font-family: 'DM Serif Display', Georgia, serif;
      font-size: 1.25rem;
      color: var(--st-yellow);
      letter-spacing: -0.01em;
    }

    .brand-badge {
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      background: var(--st-border);
      color: var(--st-text-secondary);
      padding: 2px 8px;
      border-radius: 999px;
    }

    .nav-actions {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.45rem 0.9rem;
      font-size: 0.875rem;
      font-weight: 600;
      border-radius: 6px;
      text-decoration: none;
      cursor: pointer;
      transition: all 0.15s ease;
      border: 1px solid transparent;
      line-height: 1.4;
    }

    .btn-github {
      background-color: var(--st-surface);
      color: var(--st-text);
      border-color: var(--st-border);
    }

    .btn-github:hover {
      background-color: var(--st-surface-hover);
      border-color: var(--st-yellow);
      color: var(--st-yellow);
    }

    .btn-docs {
      background-color: var(--st-yellow);
      color: #0c2340;
    }

    .btn-docs:hover {
      background-color: var(--st-yellow-hover);
      transform: translateY(-1px);
    }

    .theme-toggle {
      background: var(--st-surface);
      border: 1px solid var(--st-border);
      color: var(--st-text);
      padding: 0.45rem 0.65rem;
      border-radius: 6px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 1rem;
      transition: all 0.15s ease;
    }

    .theme-toggle:hover {
      background-color: var(--st-surface-hover);
      border-color: var(--st-yellow);
    }

    main.container {
      max-width: 1000px;
      margin: 2rem auto;
      padding: 0 1.5rem 4rem;
      width: 100%;
      flex: 1;
    }

    .markdown-body {
      background-color: var(--st-card-bg);
      border: 1px solid var(--st-border);
      border-radius: 12px;
      padding: 2.5rem;
      box-shadow: var(--st-shadow);
    }

    @media (max-width: 768px) {
      .markdown-body {
        padding: 1.5rem;
      }
      .brand-title {
        font-size: 1.1rem;
      }
    }

    .markdown-body h1,
    .markdown-body h2 {
      font-family: 'DM Serif Display', Georgia, serif;
      font-weight: 400;
      color: var(--st-text);
      letter-spacing: -0.01em;
      margin-top: 2rem;
      margin-bottom: 1rem;
      line-height: 1.25;
    }

    .markdown-body h1 {
      font-size: 2.2rem;
      margin-top: 0;
      color: var(--st-yellow);
      border-bottom: 1px solid var(--st-border);
      padding-bottom: 0.75rem;
    }

    .markdown-body h2 {
      font-size: 1.6rem;
      border-bottom: 1px solid var(--st-border);
      padding-bottom: 0.4rem;
    }

    .markdown-body h3 {
      font-size: 1.25rem;
      font-weight: 600;
      margin-top: 1.5rem;
      margin-bottom: 0.75rem;
      color: var(--st-light-blue);
    }

    .markdown-body h4,
    .markdown-body h5,
    .markdown-body h6 {
      font-size: 1rem;
      font-weight: 600;
      margin-top: 1.25rem;
      margin-bottom: 0.5rem;
      color: var(--st-text);
    }

    .markdown-body p,
    .markdown-body ul,
    .markdown-body ol {
      margin-bottom: 1.25rem;
      color: var(--st-text-secondary);
    }

    .markdown-body ul,
    .markdown-body ol {
      padding-left: 1.75rem;
    }

    .markdown-body li {
      margin-bottom: 0.4rem;
    }

    .markdown-body strong {
      color: var(--st-text);
      font-weight: 600;
    }

    .markdown-body a {
      color: var(--st-light-blue);
      text-decoration: underline;
      text-underline-offset: 3px;
    }

    .markdown-body a:hover {
      color: var(--st-yellow);
    }

    .markdown-body hr {
      border: none;
      height: 1px;
      background-color: var(--st-border);
      margin: 2rem 0;
    }

    .markdown-body pre {
      background-color: var(--st-code-bg);
      border: 1px solid var(--st-border);
      border-radius: 8px;
      padding: 1rem 1.25rem;
      overflow-x: auto;
      margin: 1.25rem 0;
      font-family: 'JetBrains Mono', Consolas, Monaco, monospace;
      font-size: 0.875rem;
      line-height: 1.5;
    }

    .markdown-body code {
      font-family: 'JetBrains Mono', Consolas, Monaco, monospace;
      font-size: 0.875em;
      background-color: var(--st-code-bg);
      border: 1px solid var(--st-border);
      padding: 0.15em 0.4em;
      border-radius: 4px;
      color: var(--st-yellow);
    }

    .markdown-body pre code {
      background-color: transparent;
      border: none;
      padding: 0;
      color: var(--st-text);
    }

    .markdown-body table {
      width: 100%;
      border-collapse: collapse;
      margin: 1.5rem 0;
      display: block;
      overflow-x: auto;
    }

    .markdown-body th,
    .markdown-body td {
      border: 1px solid var(--st-border);
      padding: 0.65rem 1rem;
      text-align: left;
      font-size: 0.9rem;
      vertical-align: top;
    }

    .markdown-body th {
      background-color: var(--st-surface);
      color: var(--st-text);
      font-weight: 600;
    }

    /* Prevent wrapping in columns like Tags Used */
    .markdown-body th:nth-child(4),
    .markdown-body td:nth-child(4) {
      white-space: nowrap;
    }

    .markdown-body tr:nth-child(even) {
      background-color: var(--st-table-stripe);
    }

    .markdown-body blockquote {
      border-left: 4px solid var(--st-yellow);
      padding: 0.5rem 1rem;
      margin: 1.25rem 0;
      background-color: rgba(255, 168, 0, 0.05);
      border-radius: 0 6px 6px 0;
      color: var(--st-text-secondary);
    }

    footer {
      border-top: 1px solid var(--st-border);
      padding: 1.5rem;
      text-align: center;
      font-size: 0.875rem;
      color: var(--st-text-muted);
      background-color: var(--st-header-bg);
    }

    footer a {
      color: var(--st-yellow);
      text-decoration: none;
    }

    footer a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="topbar-container">
      <a href="/" class="brand">
        <span class="brand-title">Dallas Urbanists Cloud API</span>
        <span class="brand-badge">Server</span>
      </a>
      <div class="nav-actions">
        <a href="https://github.com/DallasUrbanists/cloud-api-server" target="_blank" rel="noopener noreferrer" class="btn btn-github">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path fill-rule="evenodd" clip-rule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"/>
          </svg>
          <span>GitHub</span>
        </a>
        <a href="/docs" class="btn btn-docs">
          <span>Swagger API Documentation</span>
        </a>
        <button id="themeToggleBtn" class="theme-toggle" type="button" title="Toggle dark/light theme" aria-label="Toggle theme">
          <span id="themeIcon">☀️</span>
        </button>
      </div>
    </div>
  </header>

  <main class="container">
    <article class="markdown-body">
      ${contentHtml}
    </article>
  </main>

  <footer>
    <p>Dallas Urbanists Cloud API Server &bull; <a href="https://dallasurbanists.org" target="_blank" rel="noopener noreferrer">DallasUrbanists.org</a> &bull; <a href="/docs">API Documentation</a></p>
  </footer>

  <script>
    (function() {
      var storageKey = 'urbanists_theme_preference';
      function getSavedTheme() {
        var saved = localStorage.getItem(storageKey);
        if (saved === 'light' || saved === 'dark') return saved;
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
      }

      function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        var icon = document.getElementById('themeIcon');
        if (icon) {
          icon.textContent = theme === 'dark' ? '☀️' : '🌙';
        }
      }

      var currentTheme = getSavedTheme();
      applyTheme(currentTheme);

      var toggleBtn = document.getElementById('themeToggleBtn');
      if (toggleBtn) {
        toggleBtn.addEventListener('click', function() {
          var nextTheme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
          localStorage.setItem(storageKey, nextTheme);
          applyTheme(nextTheme);
        });
      }

      // Ensure "Tags Used", "Links", and compact columns never wrap
      document.querySelectorAll('.markdown-body table').forEach(function(table) {
        var headers = Array.from(table.querySelectorAll('th'));
        headers.forEach(function(th, index) {
          var text = th.textContent.trim().toLowerCase();
          if (text.includes('tags used') || text === 'links' || text === 'method') {
            th.style.whiteSpace = 'nowrap';
            table.querySelectorAll('tr').forEach(function(row) {
              var cell = row.children[index];
              if (cell) {
                cell.style.whiteSpace = 'nowrap';
              }
            });
          }
        });
      });
    })();
  </script>
</body>
</html>`;
      HomeController.lastReadTime = now;
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(HomeController.cachedHtml);
  }
}
