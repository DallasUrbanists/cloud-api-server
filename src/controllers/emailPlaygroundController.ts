/** Serves the credential-free, editable representative-email playground. @module */
import type { Request, Response } from 'express';
import { readFile } from 'node:fs/promises';
import { descriptionSampleButtons, descriptionSampleDialog, descriptionSamplesScript } from '../utils/descriptionSamples.js';

/**
 * Serves the page with its public API base URL, defaulting to production.
 * @remarks EMAIL_PLAYGROUND_API_BASE_URL may select another HTTP(S) API or `/`
 * for the page's own origin. Invalid configuration returns a safe unavailable response.
 * The HTML view is read on each request so edits are visible after a refresh.
 * Shared sample controls and their synthetic catalog are embedded in the page.
 * @throws If the HTML view cannot be read.
 */
export async function renderEmailPlayground(_req: Request, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  let baseUrl = process.env.EMAIL_PLAYGROUND_API_BASE_URL?.trim() || 'https://api.dallasurbanists.org/';
  if (baseUrl !== '/') {
    try {
      const parsed = new URL(baseUrl);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Invalid API base URL');
      parsed.pathname = parsed.pathname.replace(/\/+$/, '') + '/';
      baseUrl = parsed.href;
    } catch {
      res.status(503).type('text').send('Email playground API base URL is not configured correctly.');
      return;
    }
  }
  const encodedBaseUrl = JSON.stringify(baseUrl).replace(/</g, '\\u003c');
  const html = await readFile(new URL('../views/emailPlayground.html', import.meta.url), 'utf8').catch(error => {
    throw new Error('Email playground is unavailable.', { cause: error });
  });
  res.type('html').send(html
    .replace('const apiBaseUrl = "https://api.dallasurbanists.org/";', () => `const apiBaseUrl = ${encodedBaseUrl};`)
    .replace('<!-- DESCRIPTION_SAMPLE_BUTTONS -->', () => descriptionSampleButtons)
    .replace('<!-- DESCRIPTION_SAMPLE_DIALOG -->', () => descriptionSampleDialog)
    .replace('/* DESCRIPTION_SAMPLES_SCRIPT */', () => descriptionSamplesScript));
}

