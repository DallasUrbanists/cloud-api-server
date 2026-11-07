import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { getFirestoreDb } from '../src/config/firestore.js';
import { BoundaryError } from '../src/models/boundary.js';
import { EmailDraftError, EmailDraftService, emailRecipients } from '../src/services/emailDraftService.js';
import { SuggestionService } from '../src/services/suggestionService.js';
import { RepresentativesService } from '../src/services/representativesService.js';
import { swaggerDocument } from '../src/docs/swagger.js';

const suggestion: any = {
  id: 12, emoji: '🌳', status: 'completed', creationDate: '2026-10-01T00:00:00.000Z', boundaryIds: [4],
  author: { name: 'Morgan Example', email: 'morgan@example.org' },
  content: { summary: 'Shade on Elm Street', details: 'Morgan Example suggested shade on Elm Street. Contact morgan@example.org.' },
  location: { address: 'Elm Street', description: 'Near the bus stop' },
};
const representative: any = {
  id: 77, name: 'Council Member Avery', title: 'Council Member', emails: [{ email: 'office@example.org' }, { email: 'staff@example.org' }],
  boundary: { entityName: 'Dallas', bodyName: 'Council', districtName: 'District 2' },
};
const validDraft = { subject_line: 'Shade near the bus stop', email_body: 'Dear Council Member,\n\nPlease consider more shade.' };
function providerResponse(value: unknown = validDraft): any {
  return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }] };
}
function setupService(t: any, response: unknown = providerResponse()) {
  const mapsKey = process.env.GOOGLE_MAPS_API_KEY;
  delete process.env.GOOGLE_MAPS_API_KEY;
  t.after(() => { if (mapsKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY; else process.env.GOOGLE_MAPS_API_KEY = mapsKey; });
  const lookup = t.mock.method(SuggestionService, 'getForPresentation', async () => suggestion);
  const rep = t.mock.method(RepresentativesService, 'findById', async () => representative);
  const quota = t.mock.method(EmailDraftService, 'consumeQuota', async () => {});
  let parameters: any;
  const client = { models: { generateContent: async (params: any) => { parameters = params; return response; } } };
  const create = t.mock.method(EmailDraftService, 'createClient', () => client as any);
  return { lookup, rep, quota, create, parameters: () => parameters };
}

function assertDirectOpeningInstruction(instruction: string) {
  assert.match(instruction, /After the greeting, begin directly with the main concern or request in natural, plain language\./);
  assert.match(instruction, /Avoid generic introductory phrases/);
  assert.match(instruction, /Preserve relevant facts, uncertainty, intent, and a respectful tone; do not invent details\./);
}

function assertAddressIntentInstruction(instruction: string) {
  assert.match(instruction, /Decide whether a street address would help the representative understand or act on the writer's intent/);
  assert.match(instruction, /when in doubt, assume it would be useful/);
  assert.match(instruction, /particular home, building, facility, business, street, or other specific place/);
  assert.match(instruction, /include the literal placeholder \[ADDRESS\] in email_body/);
  assert.match(instruction, /even when the writer did not supply an address/);
  assert.match(instruction, /general policy or citywide idea where a specific location would not help, the placeholder may be omitted/);
  assert.match(instruction, /Never infer or invent a neighborhood, district, street address, or coordinates from the representative's identity or outside knowledge/);
  assert.match(instruction, /Other than \[ADDRESS\], mention geographic details only when explicitly supplied in the free text/);
}

test('recipient extraction retains all usable stored addresses without header injection', () => {
  assert.equal(emailRecipients(null), '');
  assert.equal(emailRecipients([{ email: ' first@example.org ' }, { email: 'staff+desk@example.org' }, { email: 'first@example.org' }, { email: 'not an email' }, { email: 'x@example.org\r\nBcc:evil@example.org' }, null]), 'first@example.org,staff+desk@example.org,first@example.org');
});

test('service builds a redacted, structured draft and accepts an unrelated representative', async t => {
  const setup = setupService(t);
  const result = await EmailDraftService.generate(12, 77);
  assert.deepEqual(result, { ...validDraft, recipient_email_string: 'office@example.org,staff@example.org' });
  assert.equal(setup.rep.mock.calls[0].arguments[0], 77);
  assert.equal(setup.quota.mock.callCount(), 1);
  const params = setup.parameters();
  const source = params.contents[0].parts[0].text;
  assert.ok(!JSON.stringify(params).toLowerCase().includes('morgan example'));
  assert.ok(!source.includes('morgan@example.org'));
  assert.ok(source.includes('Elm Street'));
  assert.deepEqual(params.config.tools, []);
  assert.equal(params.config.automaticFunctionCalling.disable, true);
  assert.equal(params.config.responseMimeType, 'application/json');
  assert.match(params.config.systemInstruction, /untrusted source data/);
  assertDirectOpeningInstruction(params.config.systemInstruction);
  assertAddressIntentInstruction(params.config.systemInstruction);
  assert.match(params.config.systemInstruction, /greeting on its own line/);
  assert.match(params.config.systemInstruction, /separate short body paragraphs with a blank line/);
  assert.match(params.config.systemInstruction, /closing on its own line after a blank line/);
  assert.match(params.config.systemInstruction, /real newline characters/);
});

test('unsaved suggestions use the same provider and quota without reading or writing a suggestion', async t => {
  const setup = setupService(t);
  const input = { description: '  Shade near the bus stop  ', latitude: 32.78, longitude: -96.79, representativeId: 77 };
  assert.deepEqual(await EmailDraftService.generateUnsaved(input), { ...validDraft, recipient_email_string: 'office@example.org,staff@example.org' });
  assert.equal(setup.lookup.mock.callCount(), 0);
  assert.equal(setup.quota.mock.callCount(), 1);
  assertDirectOpeningInstruction(setup.parameters().config.systemInstruction);
  assertAddressIntentInstruction(setup.parameters().config.systemInstruction);
  const source = JSON.parse(setup.parameters().contents[0].parts[0].text);
  assert.equal(source.summary, 'Shade near the bus stop');
  assert.deepEqual(source.location, { description: '', address: '[ADDRESS]' });
  assert.equal(setup.rep.mock.calls[0].arguments[0], 77);
  for (const invalid of [
    { ...input, description: ' ' }, { ...input, description: 'x'.repeat(10001) },
    { ...input, latitude: 91 }, { ...input, longitude: -181 }, { ...input, latitude: NaN },
    { ...input, representativeId: 0 }, { ...input, extra: 'no' },
  ]) await assert.rejects(EmailDraftService.generateUnsaved(invalid), (error: any) => error.status === 400);
  assert.equal(setup.quota.mock.callCount(), 1);
});

test('a general request may return a draft without an address placeholder', async t => {
  const template = { subject_line: 'Citywide tree policy', email_body: 'Please consider a citywide tree policy.' };
  setupService(t, providerResponse(template));
  const draft = await EmailDraftService.generateUnsaved({ description: 'Please consider a citywide tree policy.', latitude: 32.78, longitude: -96.79, representativeId: 77 });
  assert.deepEqual(draft, { ...template, recipient_email_string: 'office@example.org,staff@example.org' });
});

test('changing the selected coordinates or stored address does not change either Gemini request', async t => {
  const setup = setupService(t);
  const snapshots: string[] = [];
  for (const [latitude, longitude] of [[32.78, -96.79], [35.12, -101.42]]) {
    await EmailDraftService.generateUnsaved({ description: 'A residence needs maintenance.', latitude, longitude, representativeId: 77 });
    snapshots.push(JSON.stringify(setup.parameters()));
  }
  assert.equal(snapshots[0], snapshots[1]);
  for (const coordinate of ['32.78', '-96.79', '35.12', '-101.42']) assert.ok(!snapshots[0].includes(coordinate));

  const saved: string[] = [];
  for (const location of [
    { address: '123 Example Street', latitude: 32.78, longitude: -96.79, description: 'Near the entrance' },
    { address: '456 Example Road', latitude: 35.12, longitude: -101.42, description: 'Near the entrance' },
  ]) {
    setup.lookup.mock.mockImplementation(async () => ({ ...suggestion, content: { summary: 'A residence needs maintenance.', details: '' }, location }));
    await EmailDraftService.generate(12, 77);
    saved.push(JSON.stringify(setup.parameters()));
  }
  assert.equal(saved[0], saved[1]);
  for (const value of ['32.78', '-96.79', '35.12', '-101.42', '123 Example Street', '456 Example Road']) assert.ok(!saved[0].includes(value));
});

test('saved addresses are withheld from Gemini and replace every literal placeholder', async t => {
  const template = { subject_line: 'Location [ADDRESS] and [ADDRESS]', email_body: 'Please improve [ADDRESS].\n\nVisit [ADDRESS]; leave [address] unchanged.' };
  const setup = setupService(t, providerResponse(template));
  setup.lookup.mock.mockImplementation(async () => ({ ...suggestion, content: { summary: 'Shade at 22 Oak Road', details: 'Near the bus stop' }, location: { address: ' 123 Main $& Street,\nDallas ', latitude: 32.78, longitude: -96.79, description: 'Near the bus stop' } }));
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected geocoding'); });
  const draft = await EmailDraftService.generate(12, 77);
  assert.equal(draft.subject_line, 'Location 123 Main $& Street, Dallas and 123 Main $& Street, Dallas');
  assert.equal(draft.email_body, 'Please improve 123 Main $& Street, Dallas.\n\nVisit 123 Main $& Street, Dallas; leave [address] unchanged.');
  assert.equal(fetchMock.mock.callCount(), 0);
  const parameters = setup.parameters(), source = JSON.parse(parameters.contents[0].parts[0].text);
  assert.deepEqual(source.location, { description: 'Near the bus stop', address: '[ADDRESS]' });
  assert.equal(source.summary, 'Shade at 22 Oak Road');
  assert.ok(!JSON.stringify(parameters).includes('123 Main $& Street'));
  assert.ok(!JSON.stringify(parameters).includes('32.78')); assert.ok(!JSON.stringify(parameters).includes('-96.79'));
  assert.match(parameters.config.systemInstruction, /literal placeholder \[ADDRESS\]/);
  assert.equal(setup.quota.mock.callCount(), 1);
});

test('only a trailing USA country suffix is removed from saved addresses', async t => {
  const setup = setupService(t, providerResponse({ subject_line: 'At [ADDRESS]', email_body: 'Visit [ADDRESS].' }));
  for (const [address, expected] of [
    ['123 Main St, Dallas, TX, USA', '123 Main St, Dallas, TX'],
    ['123 Main St, Dallas, TX, usa ', '123 Main St, Dallas, TX'],
    ['123 USA Plaza, Dallas, TX', '123 USA Plaza, Dallas, TX'],
    ['123 Main St, USA, Suite 2', '123 Main St, USA, Suite 2'],
    ['123 Main St, Toronto, Canada', '123 Main St, Toronto, Canada'],
    [', USA', '32.78, -96.79'],
  ]) {
    setup.lookup.mock.mockImplementation(async () => ({ ...suggestion, location: { address, latitude: 32.78, longitude: -96.79, description: '' } }));
    const draft = await EmailDraftService.generate(12, 77);
    assert.equal(draft.subject_line, 'At ' + expected);
    assert.equal(draft.email_body, 'Visit ' + expected + '.');
  }
});

test('unsaved coordinates are reverse-geocoded without being sent to Gemini', async t => {
  const template = { subject_line: 'Changes at [ADDRESS]', email_body: 'Please improve [ADDRESS].' };
  const setup = setupService(t, providerResponse(template));
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  const quotaCounts: number[] = [];
  const fetchMock = t.mock.method(globalThis, 'fetch', async (input: any, init: any) => {
    quotaCounts.push(setup.quota.mock.callCount());
    const url = new URL(String(input));
    assert.equal(url.origin + url.pathname, 'https://maps.googleapis.com/maps/api/geocode/json');
    assert.equal(url.searchParams.get('latlng'), '32.78,-96.79');
    assert.equal(url.searchParams.get('result_type'), 'street_address');
    assert.equal(url.searchParams.get('key'), 'test-key');
    assert.ok(init.signal);
    return Response.json({ status: 'OK', results: [
      { types: ['route'], formatted_address: 'A road' },
      { types: ['street_address'], formatted_address: '1902 Main St, Dallas, TX 75201, USA' },
    ] });
  });
  const draft = await EmailDraftService.generateUnsaved({ description: 'Shade at 22 Oak Road', latitude: 32.78, longitude: -96.79, representativeId: 77 });
  assert.equal(draft.subject_line, 'Changes at 1902 Main St, Dallas, TX 75201');
  assert.equal(draft.email_body, 'Please improve 1902 Main St, Dallas, TX 75201.');
  assert.equal(fetchMock.mock.callCount(), 1); assert.equal(setup.lookup.mock.callCount(), 0);
  const source = JSON.parse(setup.parameters().contents[0].parts[0].text);
  assert.equal(source.summary, 'Shade at 22 Oak Road');
  assert.deepEqual(source.location, { description: '', address: '[ADDRESS]' });
  assert.ok(!JSON.stringify(source).includes('1902 Main St'));
  assert.ok(!JSON.stringify(source).includes('32.78')); assert.ok(!JSON.stringify(source).includes('-96.79'));
  setup.lookup.mock.mockImplementation(async () => ({ ...suggestion, location: { address: ' ', description: '', latitude: 32.78, longitude: -96.79 } }));
  const savedDraft = await EmailDraftService.generate(12, 77);
  assert.equal(savedDraft.subject_line, 'Changes at 1902 Main St, Dallas, TX 75201');
  assert.equal(savedDraft.email_body, 'Please improve 1902 Main St, Dallas, TX 75201.');
  assert.equal(fetchMock.mock.callCount(), 2); assert.equal(setup.quota.mock.callCount(), 2);
  assert.deepEqual(quotaCounts, [1, 2]);
});

test('missing, failed, and non-street geocoding use coordinates, including when the key is absent', async t => {
  const template = { subject_line: 'At [ADDRESS]', email_body: 'Consider [ADDRESS].' };
  const setup = setupService(t, providerResponse(template));
  const input = { description: 'More shade', latitude: 32.78, longitude: -96.79, representativeId: 77 };
  const responses: Array<() => Promise<Response>> = [
    async () => new Response('unavailable', { status: 503 }),
    async () => Response.json({ status: 'ZERO_RESULTS', results: [] }),
    async () => Response.json({ status: 'OK', results: [{ types: ['route'], formatted_address: 'A road' }] }),
    async () => Response.json({ status: 'OK', results: null }),
    async () => new Response('not json', { status: 200 }),
    async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); },
  ];
  let next = 0;
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => responses[next++]());
  const expected = { subject_line: 'At 32.78, -96.79', email_body: 'Consider 32.78, -96.79.', recipient_email_string: 'office@example.org,staff@example.org' };
  assert.deepEqual(await EmailDraftService.generateUnsaved(input), expected);
  assert.equal(fetchMock.mock.callCount(), 0);
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  for (const _response of responses) assert.deepEqual(await EmailDraftService.generateUnsaved(input), expected);
  assert.equal(fetchMock.mock.callCount(), responses.length);
  assert.equal(setup.quota.mock.callCount(), responses.length + 1);
  setup.lookup.mock.mockImplementation(async () => ({ ...suggestion, location: { address: '', description: '' } }));
  const withoutLocation = await EmailDraftService.generate(12, 77);
  assert.equal(withoutLocation.subject_line, 'At an unspecified location');
  assert.equal(withoutLocation.email_body, 'Consider an unspecified location.');
  assert.equal(fetchMock.mock.callCount(), responses.length);
});

test('quota rejection prevents both geocoding and Gemini calls', async t => {
  const setup = setupService(t);
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  setup.quota.mock.mockImplementation(async () => { throw new EmailDraftError(429, 'EMAIL_RATE_LIMITED', 'Limit reached.'); });
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected geocoding'); });
  await assert.rejects(EmailDraftService.generateUnsaved({ description: 'Shade', latitude: 32.78, longitude: -96.79, representativeId: 77 }), (error: any) => error.status === 429);
  assert.equal(fetchMock.mock.callCount(), 0); assert.equal(setup.parameters(), undefined);
});

test('reverse geocoding has a bounded timeout and falls back to coordinates', async t => {
  setupService(t, providerResponse({ subject_line: 'At [ADDRESS]', email_body: 'Consider [ADDRESS].' }));
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  const timeout = t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => milliseconds === 5000 ? AbortSignal.abort() : originalTimeout(milliseconds));
  t.mock.method(globalThis, 'fetch', async (_input: any, init: any) => {
    assert.equal(init.signal.aborted, true);
    throw new Error('aborted');
  });
  const result = await EmailDraftService.generateUnsaved({ description: 'Shade', latitude: 32.78, longitude: -96.79, representativeId: 77 });
  assert.equal(result.subject_line, 'At 32.78, -96.79');
  assert.equal(result.email_body, 'Consider 32.78, -96.79.');
  assert.ok(timeout.mock.calls.some(call => call.arguments[0] === 5000));
});

test('placeholder replacement preserves output limits and aborts unused geocoding', async t => {
  const template = { subject_line: 'At [ADDRESS]', email_body: 'Consider [ADDRESS].' };
  const setup = setupService(t, providerResponse(template));
  setup.lookup.mock.mockImplementation(async () => ({ ...suggestion, location: { address: 'x'.repeat(500), description: '' } }));
  await assert.rejects(EmailDraftService.generate(12, 77), (error: any) => error.code === 'EMAIL_INVALID_OUTPUT');
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  let lookupAborted = false;
  t.mock.method(globalThis, 'fetch', async (_input: any, init: any) => new Promise<Response>((_resolve, reject) => {
    init.signal.addEventListener('abort', () => { lookupAborted = true; reject(new Error('aborted')); }, { once: true });
  }));
  setup.create.mock.mockImplementation(() => ({ models: { generateContent: async () => { throw Object.assign(new Error('provider failure'), { status: 503 }); } } } as any));
  await assert.rejects(EmailDraftService.generateUnsaved({ description: 'Shade', latitude: 32.78, longitude: -96.79, representativeId: 77 }), (error: any) => error.status === 503);
  assert.equal(lookupAborted, true);
});

test('caller cancellation aborts reverse geocoding instead of returning a coordinate fallback', async t => {
  setupService(t, providerResponse({ subject_line: 'At [ADDRESS]', email_body: 'Consider [ADDRESS].' }));
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  let started!: () => void;
  const lookupStarted = new Promise<void>(resolve => { started = resolve; });
  t.mock.method(globalThis, 'fetch', async (_input: any, init: any) => new Promise<Response>((_resolve, reject) => {
    started();
    if (init.signal.aborted) reject(new Error('aborted'));
    else init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  const abort = new AbortController();
  const request = EmailDraftService.generateUnsaved({ description: 'Shade', latitude: 32.78, longitude: -96.79, representativeId: 77 }, abort.signal);
  await lookupStarted; abort.abort();
  await assert.rejects(request, (error: any) => error.status === 504 && error.code === 'EMAIL_TIMEOUT');
});

test('generated draft preserves email paragraph breaks in the returned body', async t => {
  const emailBody = 'Dear Council Member,\n\nPlease consider shade near the bus stop.\n\nIt would make waiting more comfortable.\n\nThank you.';
  setupService(t, providerResponse({ ...validDraft, email_body: emailBody }));
  assert.equal((await EmailDraftService.generate(12, 77)).email_body, emailBody);
});

test('draft generation still succeeds with no usable recipient', async t => {
  const setup = setupService(t);
  setup.rep.mock.mockImplementation(async () => ({ ...representative, emails: [{ email: 'invalid' }] }));
  assert.deepEqual(await EmailDraftService.generate(12, 77), { ...validDraft, recipient_email_string: '' });
});

test('validates IDs, missing records, privacy conflicts, and missing configuration before Gemini', async t => {
  const setup = setupService(t);
  for (const ids of [[0, 1], [-1, 1], [Number.MAX_SAFE_INTEGER + 1, 1]]) await assert.rejects(EmailDraftService.generate(ids[0], ids[1]), (error: any) => error.status === 400);
  assert.equal(setup.lookup.mock.callCount(), 0);
  setup.lookup.mock.mockImplementation(async () => null);
  await assert.rejects(EmailDraftService.generate(12, 77), (error: any) => error.status === 404 && error.code === 'SUGGESTION_NOT_FOUND');
  setup.lookup.mock.mockImplementation(async () => suggestion);
  setup.rep.mock.mockImplementation(async () => { throw new BoundaryError(404, 'NOT_FOUND', 'private error'); });
  await assert.rejects(EmailDraftService.generate(12, 77), (error: any) => error.code === 'REPRESENTATIVE_NOT_FOUND' && !error.message.includes('private'));
  setup.rep.mock.mockImplementation(async () => representative);
  setup.lookup.mock.mockImplementation(async () => ({ ...suggestion, author: { name: 'name', email: '' } }));
  await assert.rejects(EmailDraftService.generate(12, 77), (error: any) => error.code === 'EMAIL_PRIVACY_CONFLICT');
  assert.equal(setup.quota.mock.callCount(), 0);
});

test('provider failure, safety refusal and malformed results are safely rejected', async t => {
  const setup = setupService(t, providerResponse({ subject_line: 'One\nBcc: injected', email_body: 'body' }));
  await assert.rejects(EmailDraftService.generate(12, 77), (error: any) => error.code === 'EMAIL_INVALID_OUTPUT');
  assert.equal(setup.quota.mock.callCount(), 1);
  setup.create.mock.mockImplementation(() => ({ models: { generateContent: async () => { throw Object.assign(new Error('PRIVATE SECRET'), { status: 503 }); } } } as any));
  await assert.rejects(EmailDraftService.generate(12, 77), (error: any) => error.status === 503 && !error.message.includes('PRIVATE'));
  setup.create.mock.mockImplementation(() => ({ models: { generateContent: async () => ({ candidates: [{ finishReason: 'SAFETY' }] }) } } as any));
  await assert.rejects(EmailDraftService.generate(12, 77), (error: any) => error.code === 'EMAIL_CONTENT_REJECTED');
});

test('shared quota is atomic, bounded and fails closed', async t => {
  const db = getFirestoreDb(process.env.EMAIL_QUOTA_DB);
  const oldLimit = process.env.EMAIL_GLOBAL_REQUESTS_PER_MINUTE;
  delete process.env.EMAIL_GLOBAL_REQUESTS_PER_MINUTE;
  t.after(() => { if (oldLimit === undefined) delete process.env.EMAIL_GLOBAL_REQUESTS_PER_MINUTE; else process.env.EMAIL_GLOBAL_REQUESTS_PER_MINUTE = oldLimit; });
  let saved: any;
  const transaction = t.mock.method(db, 'runTransaction', async (fn: any) => fn({ get: async () => ({ data: () => saved }), set: (_ref: any, value: any) => { saved = value; } }));
  process.env.EMAIL_GLOBAL_REQUESTS_PER_MINUTE = '1';
  await EmailDraftService.consumeQuota();
  assert.equal(saved.count, 1);
  await assert.rejects(EmailDraftService.consumeQuota(), (error: any) => error.status === 429 && error.retryAfter > 0);
  saved = { window: Math.floor(Date.now() / 60000) + 1, count: 1 };
  await assert.rejects(EmailDraftService.consumeQuota(), (error: any) => error.status === 503);
  process.env.EMAIL_GLOBAL_REQUESTS_PER_MINUTE = 'bad';
  await assert.rejects(EmailDraftService.consumeQuota(), (error: any) => error.status === 503);
  process.env.EMAIL_GLOBAL_REQUESTS_PER_MINUTE = '1';
  transaction.mock.mockImplementation(async () => { throw new Error('PRIVATE DATABASE'); });
  await assert.rejects(EmailDraftService.consumeQuota(), (error: any) => error.status === 503 && !error.message.includes('PRIVATE'));
});

test('anonymous HTTP routes provide minimal choices and protect existing suggestion routes', async t => {
  t.mock.method(SuggestionService, 'getPresentationPage', async () => ({ items: [suggestion], nextCursor: null }));
  t.mock.method(SuggestionService, 'getForPresentation', async () => suggestion);
  const findAll = t.mock.method(RepresentativesService, 'findAll', async () => [representative]);
  const generate = t.mock.method(EmailDraftService, 'generate', async () => ({ ...validDraft, recipient_email_string: '' }));
  const server = createApp().listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const origin = 'http://127.0.0.1:' + (server.address() as any).port;
  const list = await fetch(origin + '/api/email/suggestions', { headers: { Origin: 'https://external.example.org' } });
  assert.equal(list.status, 200); assert.equal(list.headers.get('access-control-allow-origin'), '*'); assert.equal(list.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await list.json(), { data: [{ id: 12, emoji: '🌳', summary: 'Shade on Elm Street', author: 'Morgan Example', date: '2026-10-01T00:00:00.000Z' }], nextCursor: null });
  const reps = await fetch(origin + '/api/email/representatives?suggestionId=12');
  assert.equal(reps.status, 200); assert.deepEqual(await reps.json(), { data: [{ id: 77, name: 'Council Member Avery', title: 'Council Member', boundary: 'Dallas / Council / District 2' }], nextOffset: null });
  assert.deepEqual(findAll.mock.calls[0].arguments[0], { boundaryIds: [4], limit: 101, offset: 0 });
  findAll.mock.mockImplementation(async () => Array.from({ length: 101 }, (_, index) => ({ ...representative, id: index + 1 })));
  const page = await (await fetch(origin + '/api/email/representatives?suggestionId=12&offset=100')).json() as any;
  assert.equal(page.data.length, 100); assert.equal(page.nextOffset, 200);
  for (const path of ['/api/email/generate?suggestionId=0&representativeId=2', '/api/email/generate?suggestionId=12&representativeId=2&representativeId=3']) {
    assert.equal((await fetch(origin + path, { method: 'POST' })).status, 400);
  }
  assert.equal(generate.mock.callCount(), 0);
  const draft = await fetch(origin + '/api/email/generate?suggestionId=12&representativeId=77', { method: 'POST' });
  assert.equal(draft.status, 200); assert.deepEqual(await draft.json(), { ...validDraft, recipient_email_string: '' });
  assert.equal((await fetch(origin + '/api/email/generate?suggestionId=12&representativeId=77', { method: 'HEAD' })).status, 404);
  assert.equal(generate.mock.callCount(), 1);
  assert.equal((await fetch(origin + '/api/suggestions')).status, 401);
  assert.equal((await fetch(origin + '/playground/email')).status, 200);
  assert.deepEqual((swaggerDocument.paths as any)['/api/email/generate'].post.security, []);
});

test('anonymous HTTP generation runs the real service with a mocked provider', async t => {
  const setup = setupService(t, providerResponse({ subject_line: 'At [ADDRESS]', email_body: 'Please improve [ADDRESS].' }));
  const server = createApp().listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = 'http://127.0.0.1:' + (server.address() as any).port + '/api/email/generate?suggestionId=12&representativeId=77';
  const response = await fetch(url, { method: 'POST', headers: { Origin: 'https://external.example.org' } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await response.json(), { subject_line: 'At Elm Street', email_body: 'Please improve Elm Street.', recipient_email_string: 'office@example.org,staff@example.org' });
  assert.equal(setup.quota.mock.callCount(), 1);
  assert.ok(!JSON.stringify(setup.parameters()).toLowerCase().includes('morgan example'));
  assert.equal(JSON.parse(setup.parameters().contents[0].parts[0].text).location.address, '[ADDRESS]');
});

test('unsaved HTTP drafts and point-based representative lookups validate and remain anonymous', async t => {
  const setup = setupService(t, providerResponse({ subject_line: 'At [ADDRESS]', email_body: 'Please improve [ADDRESS].' }));
  const findAll = t.mock.method(RepresentativesService, 'findAll', async () => [representative]);
  const server = createApp().listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const origin = 'http://127.0.0.1:' + (server.address() as any).port;
  const choices = await fetch(origin + '/api/email/representatives?latitude=32.78&longitude=-96.79', { headers: { Origin: 'https://external.example.org' } });
  assert.equal(choices.status, 200); assert.equal(choices.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(findAll.mock.calls[0].arguments[0], { latitude: 32.78, longitude: -96.79, limit: 101, offset: 0 });
  assert.equal(((await choices.json()) as any).data[0].id, 77);
  for (const query of ['', '?latitude=32', '?latitude=&longitude=0', '?latitude=91&longitude=0', '?latitude=0&longitude=181', '?latitude=1&latitude=2&longitude=0', '?suggestionId=12&latitude=1&longitude=2']) {
    assert.equal((await fetch(origin + '/api/email/representatives' + query)).status, 400, query);
  }
  const url = origin + '/api/email/generate-unsaved';
  assert.equal((await fetch(url, { method: 'POST', body: 'x' })).status, 415);
  const request = (body: string) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://external.example.org' }, body });
  assert.equal((await request('{')).status, 400);
  assert.equal((await request(JSON.stringify({ description: 'x'.repeat(10001), latitude: 0, longitude: 0, representativeId: 77 }))).status, 400);
  assert.equal((await request(JSON.stringify({ description: 'x'.repeat(66000), latitude: 0, longitude: 0, representativeId: 77 }))).status, 413);
  assert.equal((await request(JSON.stringify({ description: 'Shade', latitude: 0, longitude: 0, representativeId: 77, suggestionId: 12 }))).status, 400);
  assert.equal(setup.quota.mock.callCount(), 0);
  const response = await request(JSON.stringify({ description: 'Shade near the bus stop', latitude: 32.78, longitude: -96.79, representativeId: 77 }));
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { subject_line: 'At 32.78, -96.79', email_body: 'Please improve 32.78, -96.79.', recipient_email_string: 'office@example.org,staff@example.org' });
  assert.equal(setup.lookup.mock.callCount(), 0); assert.equal(setup.quota.mock.callCount(), 1);
  assert.deepEqual(JSON.parse(setup.parameters().contents[0].parts[0].text).location, { description: '', address: '[ADDRESS]' });
  assert.ok((swaggerDocument.paths as any)['/api/email/generate-unsaved'].post.requestBody);
});

test('email address proxy uses the existing Places integration with public CORS', async t => {
  const previous = process.env.GOOGLE_MAPS_API_KEY; process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  t.after(() => { if (previous === undefined) delete process.env.GOOGLE_MAPS_API_KEY; else process.env.GOOGLE_MAPS_API_KEY = previous; });
  const nativeFetch = globalThis.fetch;
  const upstream: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: any, init?: any) => {
    const url = String(input);
    if (!url.startsWith('https://places.googleapis.com/')) return nativeFetch(input, init);
    upstream.push(url);
    if (url.includes('autocomplete')) {
      if (JSON.parse(init.body).input === 'Failure') return new Response('private provider failure', { status: 503 });
      return new Response(JSON.stringify({ suggestions: [{ placePrediction: { placeId: 'place-1', text: { text: 'Main Street' } } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ location: { latitude: 32.78, longitude: -96.79 }, formattedAddress: 'Main Street' }), { status: 200 });
  });
  const server = createApp().listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const origin = 'http://127.0.0.1:' + (server.address() as any).port;
  const token = 'test-session-token-1234';
  const predictions = await fetch(origin + '/api/email/locations?input=Main&sessionToken=' + token, { headers: { Origin: 'https://external.example.org' } });
  assert.equal(predictions.status, 200); assert.equal(predictions.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await predictions.json(), { suggestions: [{ placeId: 'place-1', text: 'Main Street' }] });
  const details = await fetch(origin + '/api/email/locations?placeId=place-1&sessionToken=' + token);
  assert.deepEqual(await details.json(), { latitude: 32.78, longitude: -96.79, address: 'Main Street' });
  assert.equal((await fetch(origin + '/api/email/locations?input=ab&sessionToken=' + token)).status, 400);
  const failed = await fetch(origin + '/api/email/locations?input=Failure&sessionToken=' + token);
  assert.equal(failed.status, 503); assert.ok(!(await failed.text()).includes('private provider failure'));
  assert.equal(upstream.length, 3);
});

test('author-name redaction handles Unicode, regex metacharacters and representative name collisions', async t => {
  const setup = setupService(t);
  setup.lookup.mock.mockImplementation(async () => ({ ...suggestion, author: { name: 'Zoë (Smith)', email: 'private@example.org' }, content: { summary: 'Zoë (Smith) on Main Street', details: 'ZOË (SMITH) near Main Street.' } }));
  setup.rep.mock.mockImplementation(async () => ({ ...representative, name: 'Zoë (Smith)', title: 'Council Member' }));
  await EmailDraftService.generate(12, 77);
  const params = setup.parameters();
  const input = JSON.parse(params.contents[0].parts[0].text);
  assert.ok(!JSON.stringify(params).toLocaleLowerCase().includes('zoë (smith)'));
  assert.match(input.summary, /Main Street/); assert.match(input.details, /Main Street/);
  assert.equal(input.representative.name, ''); assert.equal(input.representative.title, 'Council Member');
});

test('missing configuration and non-complete or malformed provider responses fail safely', async t => {
  const oldKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  t.after(() => { if (oldKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldKey; });
  assert.throws(() => EmailDraftService.createClient(), (error: any) => error.code === 'EMAIL_UNAVAILABLE');
  const setup = setupService(t);
  const responses = [
    { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{}' }] } }] },
    { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'not json' }] } }] },
    providerResponse({ ...validDraft, extra: 'field' }),
    providerResponse({ subject_line: 'ok', email_body: '' }),
    { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(validDraft), thought: true }] } }] },
  ];
  for (const response of responses) {
    setup.create.mock.mockImplementation(() => ({ models: { generateContent: async () => response } } as any));
    await assert.rejects(EmailDraftService.generate(12, 77), (error: any) => error.code === 'EMAIL_INVALID_OUTPUT');
  }
  setup.create.mock.mockImplementation(() => ({ models: { generateContent: async () => { throw Object.assign(new Error('secret'), { name: 'TimeoutError' }); } } } as any));
  await assert.rejects(EmailDraftService.generate(12, 77), (error: any) => error.status === 504 && !error.message.includes('secret'));
});

test('public concurrency limit releases its slot after a request', async t => {
  const oldLimit = process.env.EMAIL_MAX_CONCURRENT; process.env.EMAIL_MAX_CONCURRENT = '1';
  t.after(() => { if (oldLimit === undefined) delete process.env.EMAIL_MAX_CONCURRENT; else process.env.EMAIL_MAX_CONCURRENT = oldLimit; });
  let release!: () => void; let started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const generate = t.mock.method(EmailDraftService, 'generate', async () => { started(); await waiting; return { ...validDraft, recipient_email_string: '' }; });
  const unsaved = t.mock.method(EmailDraftService, 'generateUnsaved', async () => ({ ...validDraft, recipient_email_string: '' }));
  const server = createApp().listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { release(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const url = 'http://127.0.0.1:' + (server.address() as any).port + '/api/email/generate?suggestionId=12&representativeId=77';
  const first = fetch(url, { method: 'POST' }); await entered;
  const busy = await fetch(url, { method: 'POST' });
  assert.equal(busy.status, 429); assert.equal(busy.headers.get('retry-after'), '5'); assert.equal(generate.mock.callCount(), 1);
  const newUrl = 'http://127.0.0.1:' + (server.address() as any).port + '/api/email/generate-unsaved';
  const newRequest = () => fetch(newUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description: 'Shade', latitude: 32.78, longitude: -96.79, representativeId: 77 }) });
  assert.equal((await newRequest()).status, 429); assert.equal(unsaved.mock.callCount(), 0);
  release(); assert.equal((await first).status, 200);
  assert.equal((await newRequest()).status, 200); assert.equal(unsaved.mock.callCount(), 1);
  assert.equal((await fetch(url, { method: 'POST' })).status, 200); assert.equal(generate.mock.callCount(), 2);
});
