/**
 * Same-origin Streetmix test interface with automatic browser attestation.
 * @module
 */
import type { Request, Response } from 'express';

/** Serves the public form. Generation uses a dedicated App Check protected playground endpoint. */
export function renderStreetmixPlayground(_req: Request, res: Response): void {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  const appCheckConfig = {
    required: process.env.NODE_ENV === 'production',
    firebase: {
      apiKey: process.env.FIREBASE_WEB_API_KEY || process.env.VITE_FIREBASE_API_KEY || '',
      authDomain: process.env.FIREBASE_AUTH_DOMAIN || process.env.VITE_FIREBASE_AUTH_DOMAIN || '',
      projectId: process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID || '',
      appId: process.env.FIREBASE_APP_ID || process.env.VITE_FIREBASE_APP_ID || '',
    },
    siteKey: process.env.FIREBASE_RECAPTCHA_SITE_KEY || process.env.VITE_RECAPTCHA_SITE_KEY || '',
    provider: process.env.FIREBASE_APPCHECK_PROVIDER || process.env.VITE_FIREBASE_APPCHECK_PROVIDER || 'recaptcha-v3',
    ...(process.env.NODE_ENV !== 'production' ? { debugToken: process.env.FIREBASE_APPCHECK_DEBUG_TOKEN || process.env.VITE_FIREBASE_APPCHECK_DEBUG_TOKEN || '' } : {}),
  };
  // Only public Firebase configuration enters HTML. Escape script delimiters even
  // if an operator accidentally configures an HTML-like value.
  const serialized = JSON.stringify(appCheckConfig).replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  res.type('html').send(streetmixPlaygroundHtml.replace('/* STREETMIX_APPCHECK_CONFIG */null', () => serialized));
}

/** Test form with lazy Firebase SDK loading, automatic App Check, and no embedded application credentials. */
export const streetmixPlaygroundHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="anonymous">
<title>Streetmix playground | Dallas Urbanists</title><style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#07172b;color:#f5f3ee;line-height:1.5}*{box-sizing:border-box}body{margin:0}header{padding:1rem 1.5rem;background:#0c2340;border-bottom:1px solid #193860}a{color:#85b8ff}main{max-width:850px;margin:2rem auto;padding:0 1.25rem}h1{font:2.2rem Georgia,serif;color:#ffa800}h2{font-size:1.2rem}p,small{color:#a9bed4}.card{padding:1.3rem;background:#0c2340;border:1px solid #193860;border-radius:10px;margin:1rem 0}label{display:block;margin:.7rem 0 .3rem;font-weight:600}input,select{width:100%;font:inherit;background:#05101f;color:#f5f3ee;border:1px solid #748da9;border-radius:5px;padding:.6rem}button,.button{display:inline-block;font:inherit;font-weight:700;padding:.7rem 1rem;background:#ffa800;color:#0c2340;border:0;border-radius:5px;cursor:pointer;text-decoration:none}button:disabled{opacity:.6;cursor:not-allowed}.coordinates{display:grid;grid-template-columns:1fr 1fr;gap:1rem}.actions{display:flex;flex-wrap:wrap;gap:.7rem;margin-top:1rem}summary{cursor:pointer;color:#a5ccff}details{margin:.8rem 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#05101f;padding:1rem;max-height:32rem;overflow:auto}#status{min-height:1.5rem}#status.error{color:#ffb3ac}[hidden]{display:none!important}:focus-visible{outline:3px solid #85b8ff;outline-offset:3px}li{margin:.4rem 0}@media(max-width:500px){.coordinates{grid-template-columns:1fr}}
#candidate-map{height:430px;border-radius:6px;margin:1rem 0;color:#17283d;isolation:isolate}.map-key{display:flex;gap:1rem;flex-wrap:wrap}.map-selected{color:#ffa800}.map-other{color:#85b8ff}.map-pin{background:#fff;border:2px solid #16324f;border-radius:50%;color:#16324f;text-align:center;font-weight:700;font-size:12px;line-height:20px}.map-arrow{color:#e87500;font-size:28px;text-shadow:0 0 2px white}.leaflet-control-attribution a{color:#174e7a}@media(max-width:500px){#candidate-map{height:340px}}
#streetmix-preview{display:block;width:100%;height:620px;margin:1rem 0;border:1px solid #748da9;border-radius:6px;background:#f5f3ee}@media(max-width:500px){#streetmix-preview{height:520px}}
</style></head><body><header><a href="/">Dallas Urbanists</a> · <a href="/docs">API docs</a></header>
<main><h1>Streetmix playground</h1><p>Reconstruct an approximate existing Texas road or street from coordinates, then open the design in Streetmix.</p>
<form id="form" class="card"><label for="coordinates">Coordinates</label><input id="coordinates" type="text" value="32.78014, -96.79701" autocomplete="off" spellcheck="false" aria-describedby="coordinate-help" required><small id="coordinate-help">Paste two numbers separated by a comma. Either order works; latitude and longitude are identified assuming a location in Texas.</small>
<p>Browser verification runs automatically. No API key, sign-in, or pasted token is needed.</p>
<p><strong>Generation creates a public anonymous Streetmix design.</strong> You can remix it into your Streetmix account. Widths and missing details may be estimated.</p>
<div class="actions"><button id="choose-map" type="button">Choose location on map</button><button id="generate" type="submit">Generate Streetmix design</button><button id="retry" type="button" hidden>Retry request</button></div></form>
<section id="location-map" class="card" hidden><h2>Choose a location</h2><p>Click the map background to move the coordinate and load nearby streets. Click a road or numbered marker to select that carriageway.</p><p class="map-key"><span class="map-selected">Orange: selected carriageway</span><span class="map-other">Blue: other candidates</span><span style="color:#b58cff">Purple: paired opposite carriageway</span><span>Red dot: your coordinate</span></p><div id="candidate-map" role="region" aria-label="Street candidate map"></div><p id="map-status" role="status"></p><p id="selected-road"></p></section>
<section id="selection" class="card" hidden><h2>Confirm the intended street</h2><p id="selection-point"></p><p>Several roads or different levels may be nearby. Check the OSM way, direction, bridge or tunnel, and distance before publishing.</p><label for="road-choice">Street or carriageway</label><select id="road-choice"></select><div class="actions"><button id="confirm" type="button">Confirm street and generate</button></div></section>
<p id="status" role="status" aria-live="polite"></p>
<section id="result" class="card" hidden><h2 id="street-name"></h2><p id="location"></p><a id="open" class="button" target="_blank" rel="noopener noreferrer">Open in Streetmix</a>
<iframe id="streetmix-preview" title="Generated Streetmix design" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads" allowfullscreen></iframe>
<p id="coverage-note"></p><p id="cache-note"></p><h2>Data quality</h2><p id="quality"></p><h2>Unknown details</h2><ul id="unknown"></ul><h2>Warnings</h2><ul id="warnings"></ul><h2>Estimates</h2><ul id="estimates"></ul><details><summary>Mapped and derived evidence</summary><ul id="evidence"></ul></details></section>
<details id="raw" hidden><summary>Complete JSON response</summary><div class="actions"><button id="copy" type="button">Copy JSON</button></div><pre id="json"></pre></details>
</main><script>
const el = id => document.getElementById(id);
const appCheckConfig = /* STREETMIX_APPCHECK_CONFIG */null;
let appCheckSetup = null;
let previous = null, responseText = '', busy = false;
function loadFirebaseScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = src; script.async = true;
    script.onload = resolve; script.onerror = () => { script.remove(); reject(new Error('Firebase could not load.')); };
    document.head.appendChild(script);
  });
}
async function automaticAppCheck() {
  if (!appCheckConfig || !appCheckConfig.firebase.apiKey || !appCheckConfig.siteKey || !appCheckConfig.firebase.appId) {
    if (appCheckConfig && appCheckConfig.required) throw new Error('Browser verification is not configured on the server.');
    return null;
  }
  if (!appCheckSetup) {
    appCheckSetup = (async () => {
      if (!['recaptcha-v3', 'recaptcha-enterprise'].includes(appCheckConfig.provider)) throw new Error('Invalid App Check provider configuration.');
      if (appCheckConfig.debugToken) window.FIREBASE_APPCHECK_DEBUG_TOKEN = appCheckConfig.debugToken;
      if (!window.firebase) await loadFirebaseScript('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-compat.js');
      if (!window.firebase.appCheck) await loadFirebaseScript('https://www.gstatic.com/firebasejs/10.14.1/firebase-app-check-compat.js');
      const firebase = window.firebase;
      const app = firebase.apps.find(item => item.name === 'streetmix-playground') || firebase.initializeApp(appCheckConfig.firebase, 'streetmix-playground');
      const provider = appCheckConfig.provider === 'recaptcha-enterprise'
        ? new firebase.appCheck.ReCaptchaEnterpriseProvider(appCheckConfig.siteKey)
        : new firebase.appCheck.ReCaptchaV3Provider(appCheckConfig.siteKey);
      const appCheck = firebase.appCheck(app);
      appCheck.activate(provider, true);
      return appCheck;
    })().catch(error => { appCheckSetup = null; throw error; });
  }
  const appCheck = await appCheckSetup;
  const result = await appCheck.getToken(false);
  if (!result || typeof result.token !== 'string' || !result.token) throw new Error('No App Check token was returned.');
  return result.token;
}
async function boundedAppCheck() {
  let timer;
  try { return await Promise.race([automaticAppCheck(), new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Browser verification timed out.')), 10000); })]); }
  finally { clearTimeout(timer); }
}
function list(id, values) { el(id).replaceChildren(); for (const value of values) { const item = document.createElement('li'); item.textContent = value; el(id).append(item); } }
function validStreetmixUrl(value) { try { const url = new URL(value); return url.origin === 'https://streetmix.net' && !url.username && !url.password && /^\\/-\\/\\d+$/.test(url.pathname) && !url.search && !url.hash; } catch { return false; } }
function parseCoordinates(value) {
  const parts = value.split(',').map(part => part.trim());
  if (parts.length !== 2 || parts.some(part => !/^[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)$/.test(part))) throw new Error('Paste two decimal numbers separated by a comma, for example 32.78014, -96.79701.');
  const values = parts.map(Number);
  // A coarse Texas envelope identifies the order; the API still checks actual
  // Texas state membership. This rectangle is not a jurisdiction polygon.
  const inTexasEnvelope = (latitude, longitude) => latitude >= 25 && latitude <= 37 && longitude >= -107 && longitude <= -93;
  if (inTexasEnvelope(values[0], values[1])) return { latitude: values[0], longitude: values[1] };
  if (inTexasEnvelope(values[1], values[0])) return { latitude: values[1], longitude: values[0] };
  throw new Error('Enter a Texas coordinate pair separated by a comma. Either latitude/longitude order is accepted.');
}
async function run(retry, preview = false) {
  if (busy) return;
  if (!retry) {
    if (!el('form').reportValidity()) return;
    let body;
    try { body = parseCoordinates(el('coordinates').value); }
    catch (error) { el('status').className = 'error'; el('status').textContent = error.message; el('coordinates').focus(); return; }
    previous = { key: crypto.randomUUID(), body, preview };
  }
  if (!previous) return;
  const headers = { 'Content-Type': 'application/json', 'Idempotency-Key': previous.key };
  el('selection').hidden = true;
  busy = true; el('choose-map').disabled = el('generate').disabled = el('retry').disabled = el('confirm').disabled = true;
  el('streetmix-preview').src = 'about:blank';
  el('result').hidden = el('raw').hidden = true; el('status').className = '';
  let requestSent = false;
  const start = Date.now(); const progress = () => { el('status').textContent = (requestSent ? (previous.preview ? 'Loading streets… ' : 'Generating… ') : 'Verifying browser… ') + Math.floor((Date.now() - start) / 1000) + 's'; }; progress(); const timer = setInterval(progress, 1000);
  try {
    const appCheckToken = await boundedAppCheck();
    if (appCheckToken) headers['X-Firebase-AppCheck'] = appCheckToken;
    requestSent = true; progress();
    const response = await fetch(previous.preview ? '/api/streetmix/playground/candidates' : '/api/streetmix/playground/designs', { method: 'POST', headers, body: JSON.stringify(previous.body), signal: AbortSignal.timeout(65000) });
    const data = await response.json();
    responseText = JSON.stringify(data, null, 2); el('json').textContent = responseText; el('raw').hidden = false;
    if ((data.error === 'STREET_SELECTION_REQUIRED' || response.ok && previous.preview) && Array.isArray(data.candidates)) {
      el('road-choice').replaceChildren();
      for (const [index, candidate] of data.candidates.entries()) {
        const option = document.createElement('option'); option.value = String(candidate.osmWayId);
        option.textContent = (index + 1) + '. ' + candidate.name + ' · OSM ' + candidate.osmWayId + ' · ' + candidate.highway + ' · ' + candidate.distanceMeters + ' m · bearing ' + candidate.bearingDegrees + '° · layer ' + candidate.layer + (candidate.bridge ? ' · bridge' : '') + (candidate.tunnel ? ' · tunnel' : '');
        el('road-choice').append(option);
      }
      el('selection-point').textContent = 'For coordinates: ' + previous.body.latitude + ', ' + previous.body.longitude;
      el('selection').hidden = data.candidates.length === 0; el('location-map').hidden = false; el('retry').hidden = true;
      void renderCandidateMap(data.candidates, previous.body);
      el('status').textContent = data.candidates.length ? 'Choose the intended street. No design has been published.' : 'No supported public roads were found within 100 meters. Click another spot on the map.'; return;
    }
    if (!response.ok) { el('status').className = 'error'; el('status').textContent = 'HTTP ' + response.status + ' · ' + (data.message || data.error || 'Generation failed.') + (data.error === 'PUBLICATION_UNCERTAIN' ? ' Do not start another generation for this request.' : ''); el('retry').hidden = false; return; }
    if (!validStreetmixUrl(data.streetmixUrl)) throw new Error('The service returned an invalid Streetmix link. Retry the same request.');
    el('street-name').textContent = data.selectedStreet.name;
    el('location').textContent = 'Snapped coordinate: ' + data.snappedCoordinate.latitude.toFixed(6) + ', ' + data.snappedCoordinate.longitude.toFixed(6) + ' · Bearing: ' + data.viewingDirection.bearingDegrees + '°';
    el('open').href = data.streetmixUrl;
    el('streetmix-preview').src = data.streetmixUrl;
    el('coverage-note').textContent = data.dividedRoad ? 'Both carriageways included: OSM ' + data.selectedStreet.osmWayId + ' and ' + data.dividedRoad.oppositeOsmWayId + '. Median: ' + data.dividedRoad.medianWidthMeters.toFixed(2) + ' m (' + data.dividedRoad.medianWidthBasis + ').' : (data.selectedStreet.carriagewayOnly ? 'This design covers only the selected carriageway. Review the pairing warnings.' : 'Single mapped road cross-section.');
    el('cache-note').textContent = data.cache ? (data.cache.hit ? 'Shared cached design' : 'New shared design') + ' · generated ' + data.cache.generatedAt + ' · cache expires ' + data.cache.expiresAt : '';
    el('quality').textContent = data.quality ? data.quality.summary + ' Mapped: ' + data.quality.mappedCount + '; derived: ' + data.quality.derivedCount + '; estimated: ' + data.quality.estimatedCount + '.' : 'Approximate mapped conditions; review all estimates.';
    list('unknown', data.quality ? data.quality.unknownDetails : []);
    list('evidence', (data.evidence || []).filter(item => item.basis !== 'estimated').map(item => item.field + ': ' + item.value + ' [' + item.basis + '] · ' + item.source));
    list('warnings', data.warnings); list('estimates', data.estimates.map(item => item.field + ': ' + item.value));
    el('result').hidden = false; el('retry').hidden = true;
    el('result').scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    el('status').textContent = 'Design ready · ' + ((Date.now() - start) / 1000).toFixed(1) + 's';
  } catch (error) {
    el('status').className = 'error'; el('status').textContent = requestSent && previous.preview ? 'Candidate lookup could not complete. No design was published. Retry the request or choose another spot.' : requestSent
      ? 'Request could not complete. Publication may have succeeded; use Retry request to keep the same request key.'
      : 'Browser verification could not complete. Check your connection or content blocker, then use Retry request. If it persists, check the server’s Firebase App Check configuration.';
    el('retry').hidden = false;
  } finally { clearInterval(timer); busy = false; el('choose-map').disabled = el('generate').disabled = el('retry').disabled = el('confirm').disabled = false; }
}
function confirmSelection() {
  if (busy || !previous || el('selection').hidden) return;
  const osmWayId = Number(el('road-choice').value);
  if (!Number.isSafeInteger(osmWayId) || osmWayId <= 0) return;
  previous = { key: crypto.randomUUID(), body: { latitude: previous.body.latitude, longitude: previous.body.longitude, osmWayId } };
  return run(true);
}
let candidateMap = null, candidateLayers = [], mapCandidates = [], directionMarker = null, mapLoad = null, mapRevision = 0;
function highlightCandidate() {
  const id = Number(el('road-choice').value), selected = mapCandidates.find(item => item.osmWayId === id);
  if (!selected) return;
  el('selected-road').textContent = 'Selected: ' + selected.name + ' · OSM ' + id + ' · bearing ' + selected.bearingDegrees + '°' + (selected.bridge ? ' · bridge' : '') + (selected.tunnel ? ' · tunnel' : '') + (selected.oppositeOsmWayId ? ' · paired opposite way ' + selected.oppositeOsmWayId + ' (both directions will be modeled)' : '') + '. Arrow follows mapped way direction; it does not imply a legal travel direction.';
  for (const item of candidateLayers) {
    const active = item.id === id, paired = item.id === selected.oppositeOsmWayId;
    item.line.setStyle({ color: active ? '#f08000' : paired ? '#9755d6' : '#2373bb', weight: active ? 7 : paired ? 6 : 4, opacity: active || paired ? 1 : 0.65 });
    if (active) item.line.bringToFront();
  }
  if (directionMarker) { candidateMap.removeLayer(directionMarker); directionMarker = null; }
  if (candidateMap && selected.snappedCoordinate) {
    const arrow = document.createElement('div'); arrow.textContent = '↑'; arrow.style.transform = 'rotate(' + Number(selected.bearingDegrees) + 'deg)';
    directionMarker = window.L.marker([selected.snappedCoordinate.latitude, selected.snappedCoordinate.longitude], { interactive: false, icon: window.L.divIcon({ className: 'map-arrow', html: arrow, iconSize: [28, 28], iconAnchor: [14, 14] }) }).addTo(candidateMap);
  }
}
async function renderCandidateMap(candidates, point) {
  if (typeof window === 'undefined') return;
  const revision = ++mapRevision;
  mapCandidates = candidates; if (!candidates.length) el('selected-road').textContent = ''; el('map-status').textContent = 'Loading map…';
  try {
    if (!window.L) {
      if (!mapLoad) mapLoad = loadFirebaseScript('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js').catch(error => { mapLoad = null; throw error; });
      await mapLoad;
    }
    if (revision !== mapRevision || el('location-map').hidden) return;
    const L = window.L;
    const zoom = candidateMap && candidateMap.getZoom ? candidateMap.getZoom() : 18;
    if (candidateMap) candidateMap.remove();
    candidateMap = L.map('candidate-map', { scrollWheelZoom: false }).on('click', event => chooseMapLocation(event.latlng)); candidateLayers = []; directionMarker = null;
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(candidateMap).on('tileerror', () => { el('map-status').textContent = 'Basemap unavailable. Candidate lines and the coordinate remain visible.'; });
    L.circleMarker([point.latitude, point.longitude], { interactive: false, radius: 6, color: '#fff', weight: 2, fillColor: '#cf2535', fillOpacity: 1 }).addTo(candidateMap);
    for (const [index, candidate] of candidates.entries()) {
      const lines = (candidate.geometry || []).map(line => line.map(p => [p.latitude, p.longitude]));
      if (!lines.length) continue;
      const line = L.polyline(lines, { bubblingMouseEvents: false }).addTo(candidateMap);
      const label = document.createElement('span'); label.textContent = (index + 1) + '. ' + candidate.name + ' · OSM ' + candidate.osmWayId;
      line.bindTooltip(label).on('click', () => { if (busy) return; el('road-choice').value = String(candidate.osmWayId); highlightCandidate(); });
      candidateLayers.push({ id: candidate.osmWayId, line });
      if (candidate.snappedCoordinate) {
        const marker = L.marker([candidate.snappedCoordinate.latitude, candidate.snappedCoordinate.longitude], { bubblingMouseEvents: false, icon: L.divIcon({ className: 'map-pin', html: String(index + 1), iconSize: [24, 24] }) }).addTo(candidateMap);
        marker.on('click', () => { if (busy) return; el('road-choice').value = String(candidate.osmWayId); highlightCandidate(); });
      }
    }
    // Keep the view centered on the requested junction rather than long OSM ways.
    candidateMap.setView([point.latitude, point.longitude], zoom);
    el('map-status').textContent = candidateLayers.length ? 'Click the background to choose a new location; click a road or marker to select it. Zoom in to separate close carriageways.' : 'Click anywhere on the map background to load the streets at that location.';
    highlightCandidate();
  } catch { if (revision === mapRevision) el('map-status').textContent = 'Map could not load. You can still choose a road using the dropdown.'; }
}
async function chooseMapLocation(latlng) {
  if (busy || !latlng || !Number.isFinite(latlng.lat) || !Number.isFinite(latlng.lng)) return;
  el('coordinates').value = latlng.lat.toFixed(6) + ', ' + latlng.lng.toFixed(6);
  el('selection').hidden = true; el('selected-road').textContent = '';
  void renderCandidateMap([], { latitude: latlng.lat, longitude: latlng.lng });
  return run(false, true);
}
async function openLocationMap() {
  if (busy) return;
  try { const point = parseCoordinates(el('coordinates').value); el('location-map').hidden = false; await renderCandidateMap([], point); }
  catch (error) { el('status').className = 'error'; el('status').textContent = error.message; }
}
el('choose-map').addEventListener('click', openLocationMap);
el('road-choice').addEventListener('change', highlightCandidate);
el('confirm').addEventListener('click', confirmSelection);
el('coordinates').addEventListener('input', () => { el('selection').hidden = true; });
el('form').addEventListener('submit', event => { event.preventDefault(); run(false); });
el('retry').addEventListener('click', () => run(true));
el('copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(responseText); el('status').textContent = 'JSON copied.'; } catch { el('status').textContent = 'Copy unavailable. Select the JSON text to copy it.'; } });
</script></body></html>`;
