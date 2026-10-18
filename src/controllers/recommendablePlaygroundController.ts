import { recommendableMockDescriptions } from '../data/recommendableMockDescriptions.js';
import type { Request, Response } from 'express';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

/** Public, ephemeral interface for testing approved civic actions. */
export class RecommendablePlaygroundController {
  static markedScript(_req: Request, res: Response): void {
    res.sendFile(path.join(path.dirname(require.resolve('marked')), 'marked.umd.js'));
  }

  static purifyScript(_req: Request, res: Response): void {
    res.sendFile(path.join(path.dirname(require.resolve('dompurify')), 'purify.min.js'));
  }

  static render(_req: Request, res: Response): void {
    res.type('html').send(playgroundHtml);
  }
}

export const playgroundHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Recommendables Playground | Dallas Urbanists</title>
<style>
:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#07172b;color:#f5f3ee;line-height:1.6}
*{box-sizing:border-box}body{margin:0}header{border-bottom:1px solid #193860;background:#0c2340;padding:1rem 1.5rem}a{color:#85b8ff}
main{max-width:850px;margin:2.5rem auto;padding:0 1.25rem}h1{font-family:Georgia,serif;font-weight:normal;color:#ffa800;line-height:1.2}p{color:#a9bed4}
form,.card{padding:1.5rem;border:1px solid #193860;border-radius:10px;background:#0c2340;margin:1rem 0}
label{display:block;font-weight:600;margin-bottom:.4rem}textarea,input{width:100%;font:inherit;padding:.7rem;background:#05101f;color:#f5f3ee;border:1px solid #748da9;border-radius:5px}
textarea{min-height:170px;resize:vertical}.coordinates{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-top:1rem}button{font:inherit;font-weight:700;padding:.7rem 1.2rem;background:#ffa800;color:#0c2340;border:0;border-radius:5px;cursor:pointer}button:disabled{opacity:.6;cursor:wait}
:focus-visible{outline:3px solid #85b8ff;outline-offset:3px}.card h3{margin-top:0}.card p{white-space:pre-wrap;overflow-wrap:anywhere}.probability{color:#ffa800;font-weight:700}#status{min-height:1.6em}#status.error{color:#ffb3ac}small{color:#a9bed4}footer{margin-top:2rem;color:#a9bed4}
.card.match-primary{border-color:#b98014;border-left:4px solid #ffa800;background:#172b3e}.card.match-secondary{border-color:#426c96;border-left:4px solid #85b8ff;background:#0c2340}.card.match-secondary .probability{color:#a5ccff}.card.match-tertiary{border-color:#34465c;background:#0a1c30}.card.match-tertiary h3,.card.match-tertiary .probability{color:#a9bed4}
.result-toggle[hidden]{display:none}.representative+.representative{margin-top:1rem}.representative strong{color:#f5f3ee}.contact{margin-top:.5rem}.contact small{display:block}.boundaries th:first-child{width:40%}
.result-toggle{display:flex;align-items:center;gap:.6rem;font-weight:400}.result-toggle input{width:auto;accent-color:#ffa800}
#status:empty{display:none}.boundaries{margin-top:2rem;overflow-x:auto}.boundaries table{width:100%;border-collapse:collapse;text-align:left;color:#a9bed4}.boundaries caption{text-align:left;font-size:1.1rem;font-weight:700;color:#f5f3ee;margin-bottom:.75rem}.boundaries th,.boundaries td{padding:.65rem .8rem;border:1px solid #193860;vertical-align:top}.boundaries th{background:#0c2340;color:#f5f3ee}.boundaries td:last-child{overflow-wrap:anywhere}.boundaries tbody tr:nth-child(even){background:#0a1c33}
.description-tools{margin-top:.6rem}.description-tools button{background:transparent;color:#a5ccff;border:1px solid #426c96;padding:.4rem .75rem;font-size:.875rem}
.card{display:flow-root}.match-photos{float:right;display:flex;flex-direction:column;max-width:100%;gap:.75rem;padding-left:1rem;margin:1rem 0}.match-photos a{display:block;min-width:0}.match-photos img{display:block;max-width:100%;width:auto;height:auto;max-height:220px;object-fit:contain;background:#05101f;border:1px solid #193860;border-radius:6px}.match-photos[hidden],.match-photos a[hidden]{display:none}
.instructions{margin:1rem 0;color:#a9bed4;overflow-wrap:anywhere}.instructions p{white-space:normal}.instructions ol,.instructions ul{padding-left:1.5rem}.instructions li+li{margin-top:.4rem}.instructions pre{overflow-x:auto;padding:.75rem;background:#05101f;border-radius:5px}.instructions code{font-family:monospace}
@media(width < 580px){.match-photos{float:none;width:100%;padding-left:0}.match-photos img{width:100%;max-height:none}}
@media(max-width:520px){.coordinates{grid-template-columns:1fr}main{margin-top:1.5rem}form,.card{padding:1rem}}
</style></head><body>
<main><h1>Recommendables Playground</h1>
<form id="match-form">
<label for="text">What would you like to improve?</label><textarea id="text" name="text" maxlength="10000" required placeholder="Describe an issue or idea in your own words…"></textarea>
<div class="description-tools"><button id="random-description" type="button">Get random description</button></div>
<div class="coordinates"><div><label for="latitude">Latitude</label><input id="latitude" name="latitude" type="number" min="-90" max="90" step="any" value="32.7767" aria-describedby="location-help"></div>
<div><label for="longitude">Longitude</label><input id="longitude" name="longitude" type="number" min="-180" max="180" step="any" value="-96.7970" aria-describedby="location-help"></div></div>
<p id="location-help"><small>Defaults to downtown Dallas. Clear both coordinates to test unrestricted actions only.</small></p>
<button id="submit" type="submit">Find recommendable actions</button>
</form>
<section aria-labelledby="results-heading" id="results" aria-busy="false"><h2 id="results-heading">Results</h2><p id="status" role="status" aria-live="polite">Enter text and submit to test the catalog.</p><div id="output"></div><label id="low-toggle" class="result-toggle" hidden><input id="show-all" type="checkbox"> Show low matches (20% to 50% probability)</label></section>
</main>
<script src="/playground/recommendables/marked.js"></script>
<script src="/playground/recommendables/purify.js"></script>
<script>
const form = document.getElementById('match-form');
const button = document.getElementById('submit');
const status = document.getElementById('status');
const output = document.getElementById('output');
const results = document.getElementById('results');
const showAll = document.getElementById('show-all');
const lowToggle = document.getElementById('low-toggle');
let lastResult = null;
const mockDescriptions = ${JSON.stringify(recommendableMockDescriptions).replace(/</g, '\u003c')};
document.getElementById('random-description').addEventListener('click', () => {
  document.getElementById('text').value = mockDescriptions[Math.floor(Math.random() * mockDescriptions.length)];
});
function element(tag, text, parent, className) {
  const node = document.createElement(tag); node.textContent = text;
  if (className) node.className = className;
  parent.append(node); return node;
}
function renderResult(result) {
    output.replaceChildren();
    const d = result.diagnostics;
    const hasLowMatches = result.eligibleActions.some(action => action.matchProbability >= 0.2 && action.matchProbability < 0.5);
    lowToggle.hidden = !hasLowMatches;
    let toggleInserted = false;
    const actions = result.eligibleActions.filter(action => action.matchProbability >= (showAll.checked ? 0.2 : 0.5));
    status.textContent = !d.catalogCount ? 'The approved catalog is empty.' : !d.eligibleCount ? 'No actions are geographically eligible for this test.' : !actions.length ? (showAll.checked ? 'No actions reached 20%.' : (hasLowMatches ? 'No actions reached 50%. Check the box to show low matches.' : 'No actions reached 20%.')) : '';
    for (const action of actions) {
      const tier = action.matchProbability >= 0.8 ? 'primary' : action.matchProbability >= 0.5 ? 'secondary' : 'tertiary';
      if (tier === 'tertiary' && !toggleInserted) { output.append(lowToggle); toggleInserted = true; }
      const card = element('article', '', output, 'card match-' + tier);
      element('h3', action.summary, card);
      element('span', 'JEV match probability: ' + (action.matchProbability * 100).toFixed(1) + '%' + ' · ' + tier[0].toUpperCase() + tier.slice(1), card, 'probability');
      const photos = (Array.isArray(action.photos) ? action.photos : []).flatMap(photo => {
        try {
          if (typeof photo !== 'string') return [];
          const url = new URL(photo);
          return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? [url.href] : [];
        } catch { return []; }
      });
      if (photos.length) {
        const gallery = element('div', '', card, 'match-photos');
        for (const [index, url] of [...new Set(photos)].entries()) {
          const link = element('a', '', gallery);
          link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
          const photo = element('img', '', link);
          photo.alt = action.summary + ' — photo ' + (index + 1);
          photo.loading = 'lazy'; photo.decoding = 'async'; photo.referrerPolicy = 'no-referrer';
          photo.addEventListener('error', () => {
            link.hidden = true;
            gallery.hidden = Array.from(gallery.children).every(child => child.hidden);
          });
          photo.src = url;
        }
      }
      const instructions = element('div', '', card, 'instructions');
      instructions.innerHTML = DOMPurify.sanitize(marked.parse(action.instructions), {
        ALLOWED_TAGS: ['p', 'br', 'ol', 'ul', 'li', 'a', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr'],
        ALLOWED_ATTR: ['href', 'title', 'start'],
        ALLOW_DATA_ATTR: false,
      });
      element('p', 'Why: ' + action.why, card);
      element('p', 'Why not: ' + action.whyNot, card);
      try {
        const url = new URL(action.sourceUrl);
        if (url.protocol === 'https:' || url.protocol === 'http:') {
          const link = element('a', 'View source', card); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
        }
      } catch {}
    }
    if (hasLowMatches && !toggleInserted) output.append(lowToggle);
    const boundaryContainer = element('div', '', output, 'boundaries');
    const table = element('table', '', boundaryContainer);
    element('caption', 'Resolved boundaries', table);
    const header = element('tr', '', element('thead', '', table));
    element('th', 'Boundary', header).setAttribute('scope', 'col');
    element('th', 'Representative', header).setAttribute('scope', 'col');
    const body = element('tbody', '', table);
    for (const boundary of d.boundaries) {
      const row = element('tr', '', body);
      element('td', boundary.name, row);
      const cell = element('td', '', row);
      const representatives = boundary.representatives || [];
      if (!representatives.length) element('span', 'No current representative on file.', cell);
      for (const representative of representatives) {
        const contactCard = element('div', '', cell, 'representative');
        element('strong', [representative.name, representative.title].filter(Boolean).join(' — ') || 'Representative', contactCard);
        for (const [field, scheme, fallback] of [['phones', 'tel:', 'Phone'], ['emails', 'mailto:', 'Email']]) {
          const contacts = Array.isArray(representative[field]) ? representative[field] : [];
          for (const contact of contacts) {
            const value = contact && contact[field === 'phones' ? 'phone' : 'email'];
            if (typeof value !== 'string' || !value.trim()) continue;
            const line = element('div', '', contactCard, 'contact');
            element('span', (contact.label || fallback) + ': ', line);
            const link = element('a', value, line);
            link.href = scheme + encodeURIComponent(value);
            if (contact.when_to_use) element('small', contact.when_to_use, line);
          }
        }
      }
    }
    if (!d.boundaries.length) element('td', 'None', element('tr', '', body)).setAttribute('colspan', '2');

}
showAll.addEventListener('change', () => { if (lastResult) renderResult(lastResult); });
form.addEventListener('submit', async event => {
  event.preventDefault();
  const text = document.getElementById('text').value;
  const latitude = document.getElementById('latitude').value;
  const longitude = document.getElementById('longitude').value;
  lastResult = null; lowToggle.hidden = true; status.className = ''; output.replaceChildren();
  if (!text.trim()) { status.textContent = 'Please enter a civic issue or idea.'; return; }
  if ((latitude === '') !== (longitude === '')) { status.textContent = 'Enter both coordinates, or clear both.'; return; }
  const body = { text };
  if (latitude !== '') { body.latitude = Number(latitude); body.longitude = Number(longitude); }
  button.disabled = true; results.setAttribute('aria-busy', 'true'); status.textContent = 'Checking boundaries and matching actions…';
  try {
    const response = await fetch('/api/recommendables/match', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || 'Matching could not complete. Please retry.');
    lastResult = result;
    renderResult(result);
  } catch (error) {
    output.replaceChildren(); status.className = 'error'; status.textContent = error.message || 'Matching failed. Please retry.';
  } finally { button.disabled = false; results.setAttribute('aria-busy', 'false'); }
});
</script></body></html>`;
