import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createApp } from '../src/app.js';
import { EmailDraftService } from '../src/services/emailDraftService.js';
import { SuggestionService } from '../src/services/suggestionService.js';
import { RepresentativesService } from '../src/services/representativesService.js';
import { PlaygroundLocationController } from '../src/controllers/playgroundLocationController.js';
import { recommendableMockDescriptions } from '../src/data/recommendableMockDescriptions.js';

const browserPath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const enabled = process.env.RUN_EMAIL_BROWSER_TESTS === 'true' && existsSync(browserPath);

test('browser playground searches pages, edits mailto and handles missing recipients', { skip: !enabled, timeout: 45000 }, async t => {
  const dates: Record<number, string> = {
    10: '2026-09-01T00:00:00.000Z', 11: '2026-12-04T00:00:00.000Z', 12: '2026-10-01T00:00:00.000Z',
    13: '2026-10-01T00:00:00.000Z', 14: 'not-a-date', 15: '', 16: '2026-11-02T01:00:00.000Z', 17: '2026-12-03T23:30:00-02:00',
  };
  const makeSuggestion = (id: number) => ({ id, emoji: '🌳', status: 'completed', creationDate: dates[id], boundaryIds: [4], author: { name: 'Morgan Example', email: 'private@example.org' }, content: { summary: (id === 16 ? 'Garden ' : 'Shade on Elm ') + id, details: '' }, location: { address: 'Elm', description: '' } });
  let catalogAttempts = 0;
  t.mock.method(SuggestionService, 'getPresentationPage', async cursor => {
    if (cursor === null) {
      catalogAttempts++;
      if (catalogAttempts === 1) throw new Error('Database unavailable');
      if (catalogAttempts === 2) return { items: [], nextCursor: null };
      return { items: [10, 11, 12].map(makeSuggestion) as any, nextCursor: '12' };
    }
    return { items: [13, 14, 15, 16, 17].map(makeSuggestion) as any, nextCursor: null };
  });
  const savedLookup = t.mock.method(SuggestionService, 'getForPresentation', async id => id === 10 ? null : makeSuggestion(id) as any);
  let releaseOldReps!: () => void;
  const oldReps = new Promise<void>(resolve => { releaseOldReps = resolve; });
  const reps = t.mock.method(RepresentativesService, 'findAll', async search => {
    if (search.latitude === 32.4) return [];
    if (search.latitude === 32.5) await oldReps;
    return [{ id: search.latitude === 32.5 ? 88 : 77, name: 'Avery', title: 'Council Member', boundary: { entityName: 'Dallas', bodyName: 'Council', districtName: 'District 2' } } as any];
  });
  const places = t.mock.method(PlaygroundLocationController, 'search', async (req, res) => {
    if (req.query.placeId) res.json({ latitude: 32.84, longitude: -96.84, address: 'Main Street' });
    else res.json({ suggestions: [{ placeId: 'place-1', text: 'Main Street' }] });
  });
  let unsavedCalls = 0, releaseNewStale!: () => void;
  const newStale = new Promise<void>(resolve => { releaseNewStale = resolve; });
  const unsaved = t.mock.method(EmailDraftService, 'generateUnsaved', async () => {
    if (++unsavedCalls === 2) await newStale;
    return { subject_line: 'New idea', email_body: 'Please add shade.', recipient_email_string: 'office@example.org' };
  });
  let calls = 0;
  let releaseStale!: () => void;
  const stale = new Promise<void>(resolve => { releaseStale = resolve; });
  t.mock.method(EmailDraftService, 'generate', async () => {
    const call = ++calls;
    if (call === 3) await stale;
    return { subject_line: 'A subject', email_body: 'Dear Council Member,\n\nPlease consider shade.\n\nThank you.', recipient_email_string: call === 1 ? 'office@example.org,staff@example.org' : '' };
  });
  const server = createApp().listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + (server.address() as any).port;
  const apiServer = createApp().listen(0, '127.0.0.1'); await once(apiServer, 'listening');
  const apiOrigin = 'http://127.0.0.1:' + (apiServer.address() as any).port;
  const originalBaseUrl = process.env.EMAIL_PLAYGROUND_API_BASE_URL;
  process.env.EMAIL_PLAYGROUND_API_BASE_URL = apiOrigin;
  const apiRequests: string[] = [], localRequests: string[] = [];
  apiServer.on('request', req => { const url = (req as any).originalUrl ?? req.url; if (url?.startsWith('/api/email/')) apiRequests.push(req.method + ' ' + url); });
  server.on('request', req => { const url = (req as any).originalUrl ?? req.url; if (url?.startsWith('/api/email/')) localRequests.push(url); });
  t.after(async () => {
    releaseStale(); releaseOldReps(); releaseNewStale();
    if (originalBaseUrl === undefined) delete process.env.EMAIL_PLAYGROUND_API_BASE_URL;
    else process.env.EMAIL_PLAYGROUND_API_BASE_URL = originalBaseUrl;
    await new Promise<void>(resolve => apiServer.close(() => resolve()));
  });
  const profile = await mkdtemp(join(tmpdir(), 'email-playground-'));
  const chrome = spawn(browserPath, ['--headless=new', '--disable-gpu', '--disable-extensions', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let browserSocket: WebSocket | undefined;
  let socket: WebSocket | undefined;
  t.after(async () => {
    releaseStale();
    socket?.close();
    if (browserSocket?.readyState === WebSocket.OPEN) browserSocket.send(JSON.stringify({ id: 999, method: 'Browser.close' }));
    if (chrome.exitCode === null) await Promise.race([once(chrome, 'exit').catch(() => {}), delay(5000)]);
    browserSocket?.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  let activePort = '';
  for (let i = 0; i < 100 && !activePort; i++) {
    try { activePort = await readFile(join(profile, 'DevToolsActivePort'), 'utf8'); } catch { await delay(100); }
  }
  assert.ok(activePort, 'Chrome did not start');
  const [port, browserPathname] = activePort.trim().split(/\r?\n/);
  browserSocket = new WebSocket('ws://127.0.0.1:' + port + browserPathname); await once(browserSocket, 'open');
  const tab = await (await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(origin + '/playground/email'), { method: 'PUT' })).json() as any;
  socket = new WebSocket(tab.webSocketDebuggerUrl); await once(socket, 'open');
  let id = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  socket.on('message', message => {
    const result = JSON.parse(message.toString());
    const callback = pending.get(result.id); if (!callback) return;
    pending.delete(result.id); if (result.error) callback.reject(new Error(result.error.message)); else callback.resolve(result.result);
  });
  function command(method: string, params: any = {}): Promise<any> {
    const requestId = ++id;
    return new Promise((resolve, reject) => { pending.set(requestId, { resolve, reject }); socket!.send(JSON.stringify({ id: requestId, method, params })); });
  }
  async function evaluate(expression: string): Promise<any> {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + result.exceptionDetails.exception?.description);
    return result.result.value;
  }
  await command('Runtime.enable');
  const failure = await evaluate(`(async () => { for (let i=0;i<100;i++) { const retry=document.getElementById('retry-suggestions'); if (retry && !retry.hidden) return { status: document.getElementById('status').textContent, placeholder: document.getElementById('suggestion').placeholder }; await new Promise(r=>setTimeout(r,50)); } throw new Error('retry was not offered'); })()`);
  assert.match(failure.status, /API base URL and connection/); assert.equal(failure.placeholder, 'Ideas unavailable');
  const empty = await evaluate(`(async () => { document.getElementById('retry-suggestions').click(); for (let i=0;i<100;i++) { if (!document.getElementById('retry-suggestions').hidden) return document.getElementById('status').textContent; await new Promise(r=>setTimeout(r,50)); } throw new Error('empty state did not load'); })()`);
  assert.match(empty, /No ideas are available/);
  await evaluate(`(async () => { document.getElementById('retry-suggestions').click(); for (let i=0;i<100;i++) { if (!document.getElementById('suggestion').disabled) return; await new Promise(r=>setTimeout(r,50)); } throw new Error('suggestions did not load'); })()`);
  const wording = await evaluate(`({
    legend: document.querySelector('.suggestion-mode legend').textContent,
    saved: document.getElementById('mode-saved').parentElement.textContent.trim(),
    newIdea: document.getElementById('mode-new').parentElement.textContent.trim(),
    label: document.querySelector('label[for="suggestion"]').textContent,
    placeholder: document.getElementById('suggestion').placeholder,
    listLabel: document.getElementById('suggestion-options').getAttribute('aria-label'),
    description: document.querySelector('label[for="new-description"]').textContent,
    privacy: document.querySelector('.privacy-note').textContent,
    addressLabel: document.getElementById('address-options').getAttribute('aria-label'),
    retry: document.getElementById('retry-suggestions').textContent.trim()
  })`);
  assert.deepEqual(wording, { legend: 'Choose an idea', saved: 'Choose a previously submitted idea', newIdea: 'Write a new idea', label: 'Idea', placeholder: 'Search ideas', listLabel: 'Ideas', description: 'Describe your idea', privacy: 'Your idea is not saved. Text you enter, including any personal information, is sent to Gemini. Google Maps may receive the selected coordinates to look up a street address.', addressLabel: 'Address results', retry: 'Retry loading ideas' });
  const reopened = await evaluate(`(() => {
    const s=document.getElementById('suggestion'), options=document.getElementById('suggestion-options');
    s.focus(); s.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); s.click();
    const expanded=s.getAttribute('aria-expanded'), order=Array.from(options.children, option => option.id);
    s.value='Shade on Elm'; s.dispatchEvent(new Event('input',{bubbles:true}));
    const filtered=Array.from(options.children, option => option.id);
    return { expanded, order, filtered };
  })()`);
  assert.deepEqual(reopened, {
    expanded: 'true',
    order: [17, 11, 16, 12, 13, 10, 14, 15].map(id => 'suggestion-option-' + id),
    filtered: [17, 11, 12, 13, 10, 14, 15].map(id => 'suggestion-option-' + id),
  });
  const choice = await evaluate(`(async () => {
    const s = document.getElementById('suggestion'); s.focus(); s.value='Shade on Elm 13'; s.dispatchEvent(new Event('input', {bubbles:true}));
    const option = document.querySelector('#suggestion-options li'); const label = option.textContent;
    s.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown', bubbles:true})); s.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
    for (let i=0;i<100;i++) { if (document.getElementById('representative').options.length > 1) return label; await new Promise(r=>setTimeout(r,50)); }
    throw new Error('representatives did not load');
  })()`);
  assert.equal(choice, '🌳 Shade on Elm 13 (Morgan Example on 2026-10-01)');
  assert.equal(await evaluate(`(() => { document.getElementById('suggestion').click(); const count=document.getElementById('suggestion-options').children.length; document.getElementById('suggestion').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); return count; })()`), 8);
  const mailto = await evaluate(`(async () => {
    const rep=document.getElementById('representative'); rep.value='77'; rep.dispatchEvent(new Event('change', {bubbles:true})); document.getElementById('generate').click();
    for (let i=0;i<100;i++) { if (!document.getElementById('draft').hidden) break; await new Promise(r=>setTimeout(r,50)); }
    const subject=document.getElementById('subject'), body=document.getElementById('body');
    const initialBody=body.value, initialHref=document.getElementById('send').getAttribute('href');
    subject.value='New & 🚌'; subject.dispatchEvent(new Event('input', {bubbles:true}));
    body.value='Hello\\nDallas'; body.dispatchEvent(new Event('input', {bubbles:true}));
    return { initialBody, initialHref, href: document.getElementById('send').getAttribute('href'), height: body.style.height, hidden: document.getElementById('send').hidden };
  })()`);
  assert.equal(mailto.initialBody, 'Dear Council Member,\n\nPlease consider shade.\n\nThank you.');
  assert.equal(new URL(mailto.initialHref).searchParams.get('body'), 'Dear Council Member,\r\n\r\nPlease consider shade.\r\n\r\nThank you.');
  assert.ok(mailto.href.startsWith('mailto:office@example.org,staff@example.org?'));
  const uri = new URL(mailto.href);
  assert.equal(decodeURIComponent(uri.pathname), 'office@example.org,staff@example.org');
  assert.equal(uri.searchParams.get('subject'), 'New & 🚌'); assert.equal(uri.searchParams.get('body'), 'Hello\r\nDallas');
  assert.ok(parseFloat(mailto.height) > 0); assert.equal(mailto.hidden, false);
  const missing = await evaluate(`(async () => {
    document.getElementById('generate').click();
    for (let i=0;i<100;i++) { if (!document.getElementById('draft').hidden && !document.getElementById('unavailable').hidden) return { disabled: document.getElementById('unavailable').disabled, text: document.getElementById('unavailable').textContent.trim(), sendHidden: document.getElementById('send').hidden, subject: document.getElementById('subject').value }; await new Promise(r=>setTimeout(r,50)); }
    throw new Error('missing recipient state did not load');
  })()`);
  assert.deepEqual(missing, { disabled: true, text: 'Recipient email unavailable', sendHidden: true, subject: 'A subject' });
  assert.equal(await evaluate(`(() => { const s = document.getElementById('subject'); s.value = 'Edited'; s.dispatchEvent(new Event('input', {bubbles:true})); return document.getElementById('send').hasAttribute('href'); })()`), false);
  await evaluate(`(() => { document.getElementById('generate').click(); const s = document.getElementById('suggestion'); s.value = 'Different'; s.dispatchEvent(new Event('input', { bubbles:true })); })()`);
  for (let i = 0; i < 100 && calls < 3; i++) await delay(20);
  assert.equal(calls, 3);
  releaseStale(); await delay(100);
  assert.equal(await evaluate(`document.getElementById('draft').hidden`), true);
  assert.equal(localRequests.length, 0);
  assert.ok(apiRequests.some(request => request.startsWith('GET /api/email/suggestions?cursor=')));
  assert.ok(apiRequests.some(request => request.startsWith('GET /api/email/representatives?') && request.includes('suggestionId=13')));
  assert.ok(apiRequests.some(request => request.startsWith('POST /api/email/generate?') && request.includes('suggestionId=13')));
  const missingIdea = await evaluate(`(async () => {
    const input=document.getElementById('suggestion'); input.value='Shade on Elm 10'; input.dispatchEvent(new Event('input', {bubbles:true}));
    document.querySelector('#suggestion-options li').click();
    for (let i=0;i<100;i++) { const text=document.getElementById('status').textContent; if (text === 'Idea not found.') return text; await new Promise(r=>setTimeout(r,30)); }
    throw new Error('missing idea error was not shown');
  })()`);
  assert.equal(missingIdea, 'Idea not found.');

  await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const initial = await evaluate(`(async () => {
    window.__pin = null;
    window.L = {
      map() {
        const map = { center: null, zoom: 13, handlers: {},
          setView(value, zoom) { this.center = { lat: value[0], lng: value[1] }; this.zoom = zoom; return this; },
          getCenter() { return this.center; }, getZoom() { return this.zoom; }, invalidateSize() {},
          on(name, fn) { this.handlers[name] = fn; return this; }, removeLayer() { window.__pin = null; },
          click(lat, lng) { this.handlers.click({latlng: {lat, lng}}); }
        };
        window.__map = map; return map;
      },
      control: { zoom: () => ({ addTo() {} }) },
      tileLayer: () => ({ addTo() { return this; }, on() { return this; } }),
      divIcon: options => options,
      marker: coords => ({ addTo() { window.__pin = coords; return this; }, setLatLng(value) { window.__pin = value; } })
    };
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: { getCurrentPosition(success, error) { window.__geoSuccess = success; window.__geoError = error; } } });
    const wasSaved = document.getElementById('mode-saved').checked;
    const samplesHidden = document.getElementById('random-description').getClientRects().length === 0;
    document.getElementById('mode-new').click(); await new Promise(r => setTimeout(r, 0));
    return { wasSaved, samplesHidden, savedHidden: document.getElementById('saved-suggestion').hidden, newHidden: document.getElementById('new-suggestion').hidden,
      center: window.__map.center, pin: window.__pin, representativeHidden: document.getElementById('representative-field').hidden };
  })()`);
  assert.deepEqual(initial, { wasSaved: true, samplesHidden: true, savedHidden: true, newHidden: false, center: { lat: 32.781162, lng: -96.794861 }, pin: null, representativeHidden: true });
  await evaluate(`(async () => { document.getElementById('map-center').click(); for (let i=0;i<100;i++) { if (document.getElementById('representative').options.length > 1) return; await new Promise(r=>setTimeout(r,30)); } throw new Error('map center did not load representatives'); })()`);
  assert.deepEqual(await evaluate(`window.__pin`), [32.781162, -96.794861]);
  await evaluate(`(async () => { window.__map.click(32.4, -96.4); for (let i=0;i<100;i++) { if (document.getElementById('status').textContent.includes('No current representatives')) return; await new Promise(r=>setTimeout(r,30)); } throw new Error('empty representatives were not shown'); })()`);
  assert.equal(await evaluate(`document.getElementById('representative').disabled`), true);
  const height = await evaluate(`(() => {
    const input = document.getElementById('new-description');
    input.value = 'Shade'; input.dispatchEvent(new Event('input', { bubbles: true })); const before = input.scrollHeight;
    input.value = Array(20).fill('More shade near the bus stop').join('\\n'); input.dispatchEvent(new Event('input', { bubbles: true }));
    return { before, after: input.scrollHeight, height: parseFloat(input.style.height) };
  })()`);
  assert.ok(height.after > height.before); assert.ok(height.height >= height.after - 2);
  await evaluate(`window.__map.click(32.5, -96.5)`);
  for (let i = 0; i < 100 && !reps.mock.calls.some(call => call.arguments[0].latitude === 32.5); i++) await delay(20);
  assert.ok(reps.mock.calls.some(call => call.arguments[0].latitude === 32.5));
  await evaluate(`(async () => {
    window.__map.click(32.6, -96.6);
    const input = document.getElementById('new-description'); input.value = 'Add more shade'; input.dispatchEvent(new Event('input', {bubbles:true}));
    for (let i=0;i<100;i++) { if (document.getElementById('representative').options.length > 1) return; await new Promise(r=>setTimeout(r,30)); }
    throw new Error('point representatives did not load');
  })()`);
  releaseOldReps(); await delay(100);
  assert.deepEqual(await evaluate(`({ pin: window.__pin, values: Array.from(document.getElementById('representative').options, o => o.value) })`), { pin: [32.6, -96.6], values: ['', '77'] });
  await evaluate(`(async () => {
    document.getElementById('current-location').click();
    window.__geoError({code:1});
    if (!document.getElementById('location-status').textContent.includes('denied')) throw new Error('permission denial not shown');
    document.getElementById('current-location').click(); window.__geoSuccess({ coords: { latitude: 32.8, longitude: -96.8 } });
    for (let i=0;i<100;i++) { if (document.getElementById('representative').options.length > 1) return; await new Promise(r=>setTimeout(r,30)); }
    throw new Error('current location representatives did not load');
  })()`);
  assert.deepEqual(await evaluate(`({ pin: window.__pin, center: window.__map.center })`), { pin: [32.8, -96.8], center: { lat: 32.8, lng: -96.8 } });
  await evaluate(`(async () => {
    const address = document.getElementById('map-address'); address.focus(); address.value = 'Main'; address.dispatchEvent(new Event('input', {bubbles:true}));
    for (let i=0;i<100;i++) { const option=document.querySelector('#address-options [role="option"]'); if (option) { address.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown', bubbles:true})); if (document.activeElement !== option) throw new Error('address option was not focused'); option.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true})); break; } await new Promise(r=>setTimeout(r,30)); }
    for (let i=0;i<100;i++) { if (window.__pin && window.__pin[0] === 32.84 && document.getElementById('representative').options.length > 1) return; await new Promise(r=>setTimeout(r,30)); }
    throw new Error('address location did not load');
  })()`);
  assert.equal(places.mock.callCount(), 2);
  assert.ok(reps.mock.calls.some(call => call.arguments[0].latitude === 32.84 && call.arguments[0].longitude === -96.84));
  const savedLookupsBefore = savedLookup.mock.callCount();
  const requestsBeforeSamples = apiRequests.length;
  const sample = await evaluate(`(() => {
    const rep=document.getElementById('representative'); rep.value='77'; rep.dispatchEvent(new Event('change', {bubbles:true}));
    document.getElementById('random-description').click();
    const input=document.getElementById('new-description'), random=input.value;
    const animations=input.getAnimations().length;
    document.getElementById('choose-sample').click();
    const dialog=document.getElementById('sample-dialog'), filter=document.getElementById('sample-filter');
    const total=document.querySelectorAll('#sample-list button').length;
    filter.value='xyzzy-no-matches'; filter.dispatchEvent(new Event('input', {bubbles:true}));
    const empty=document.getElementById('sample-count').textContent;
    filter.value='BuS StOp'; filter.dispatchEvent(new Event('input', {bubbles:true}));
    const option=document.querySelector('#sample-list button'), chosen=option.textContent;
    option.click();
    return { random, animations, total, empty, chosen, value:input.value, closed:!dialog.open, focus:document.activeElement.id, representative:rep.value, pin:window.__pin, disabled:document.getElementById('generate').disabled };
  })()`);
  assert.ok(recommendableMockDescriptions.includes(sample.random));
  assert.equal(sample.animations, 0); assert.ok(sample.total > 100); assert.equal(sample.empty, '0 scenarios');
  assert.equal(sample.chosen, recommendableMockDescriptions.find(text => text.toLowerCase().includes('bus stop')));
  assert.equal(sample.value, sample.chosen); assert.equal(sample.closed, true); assert.equal(sample.focus, 'new-description');
  assert.equal(sample.representative, '77'); assert.deepEqual(sample.pin, [32.84, -96.84]); assert.equal(sample.disabled, false);
  assert.equal(apiRequests.length, requestsBeforeSamples);
  await evaluate(`(async () => {
    document.getElementById('generate').click();
    for (let i=0;i<100;i++) { if (!document.getElementById('draft').hidden) return; await new Promise(r=>setTimeout(r,30)); }
    throw new Error('unsaved draft did not load');
  })()`);
  assert.deepEqual(unsaved.mock.calls[0].arguments[0], { description: sample.chosen, latitude: 32.84, longitude: -96.84, representativeId: 77 });
  assert.equal(savedLookup.mock.callCount(), savedLookupsBefore);
  assert.equal(await evaluate(`document.getElementById('subject').value`), 'New idea');
  assert.equal(await evaluate(`(() => { document.getElementById('choose-sample').click(); const dialog=document.getElementById('sample-dialog'); dialog.dispatchEvent(new Event('cancel', {cancelable:true})); return !dialog.open && !document.getElementById('draft').hidden; })()`), true);
  await evaluate(`(() => { document.getElementById('generate').click(); document.getElementById('random-description').click(); })()`);
  for (let i=0;i<100 && unsavedCalls < 2;i++) await delay(20);
  assert.equal(unsavedCalls, 2); releaseNewStale(); await delay(100);
  assert.equal(await evaluate(`document.getElementById('draft').hidden`), true);
  assert.equal(await evaluate(`(() => { document.getElementById('current-location').click(); document.getElementById('choose-sample').click(); const saved=document.getElementById('mode-saved'); saved.checked=true; saved.dispatchEvent(new Event('change', {bubbles:true})); window.__geoSuccess({coords:{latitude:32.9,longitude:-96.9}}); return !document.getElementById('sample-dialog').open && !document.getElementById('saved-suggestion').hidden && document.getElementById('new-suggestion').hidden && document.getElementById('representative-field').hidden; })()`), true);
  assert.ok(apiRequests.some(request => request.startsWith('POST /api/email/generate-unsaved')));
  assert.ok(apiRequests.some(request => request.startsWith('GET /api/email/locations?')));
  if (process.env.EMAIL_PLAYGROUND_LIVE_ORIGIN) {
    await command('Page.enable');
    const loaded = new Promise<void>(resolve => {
      const onLoad = (message: WebSocket.RawData) => { if (JSON.parse(message.toString()).method === 'Page.loadEventFired') { socket!.off('message', onLoad); resolve(); } };
      socket!.on('message', onLoad);
    });
    await command('Page.navigate', { url: new URL('/playground/email', process.env.EMAIL_PLAYGROUND_LIVE_ORIGIN).href });
    await loaded;
    const live = await evaluate(`(async () => { for (let i=0;i<600;i++) { const s=document.getElementById('suggestion'), status=document.getElementById('status'); if (s && status && (!s.disabled || status.textContent.startsWith('No ideas'))) { s.click(); return { disabled:s.disabled, status:status.textContent, expanded:s.getAttribute('aria-expanded') }; } await new Promise(r=>setTimeout(r,50)); } throw new Error('Live catalog did not become available'); })()`);
    if (live.disabled) assert.match(live.status, /No ideas/);
    else assert.equal(live.expanded, 'true');
    t.diagnostic('Live playground: ' + (live.status || 'suggestion dropdown opens'));
  }
});
