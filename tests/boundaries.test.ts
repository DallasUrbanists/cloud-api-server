import { before, after, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { PGlite } from '@electric-sql/pglite';
import { getAuth } from 'firebase-admin/auth';
import { getAppCheck } from 'firebase-admin/app-check';
import { firebaseApp } from '../src/config/firebase.js';
import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { boundaryFromRow, dallasDate } from '../src/models/boundary.js';
import { matchesLocation } from '../src/services/boundaryService.js';
import { BoundarySyncService, isDue } from '../src/services/boundarySyncService.js';
import { validateAdapter } from '../src/services/boundaryAdapters.js';
import { swaggerDocument } from '../src/docs/swagger.js';
import { OfficialResearchProvider } from '../src/services/research/official.js';

let db: PGlite;
let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let origin: string;
const originalFetch = globalThis.fetch;
const environment = new Map(['BOUNDARY_SYNC_ENABLED', 'CONGRESS_GOV_API_KEY', 'OPEN_STATES_API_KEY', 'GEMINI_API_KEY', 'API_KEYS_JSON', 'NODE_ENV', 'BOUNDARY_SYNC_GLOBAL_PER_MINUTE', 'BOUNDARY_SYNC_CLIENT_PER_MINUTE'].map(key => [key, process.env[key]]));
const polygon = { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]] };
const secondPolygon = [[[20, 20], [21, 20], [21, 21], [20, 20]]];
let boundaryId: number;
let senateId: number;
let externalCalls = 0;
let failSource = false;
let completeMembers = true;

before(async () => {
  db = new PGlite();
  await db.exec(await readFile(new URL('../migrations/004_representatives.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../migrations/006_boundaries.sql', import.meta.url), 'utf8'));
  mock.method(pool, 'query', (text: string, values?: unknown[]) => db.query(text, values));
  let previous = Promise.resolve();
  mock.method(pool, 'connect', async () => {
    const pending = previous;
    let release!: () => void;
    previous = new Promise<void>(resolve => { release = resolve; });
    await pending;
    return { query: (text: string, values?: unknown[]) => db.query(text, values), release };
  });
  const shapeService = { file: 'arcgis.js', function: 'fetchShape', params: { source: 'council', key: 1 } };
  boundaryId = (await db.query<any>('INSERT INTO boundaries(entity_name, body_name, district_name, shape, states, shape_service, shape_pending) VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, true) RETURNING id', ['City of Dallas', 'City Council', 'District 1', JSON.stringify(polygon), ['TX'], JSON.stringify(shapeService)])).rows[0].id;
  senateId = (await db.query<any>('INSERT INTO boundaries(entity_name, body_name, district_name, states, research_service) VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id', ['United States', 'Senate', 'Texas', ['TX'], JSON.stringify({ file: 'congress.js', function: 'researchMembers', params: { chamber: 'Senate' } })])).rows[0].id;
  await db.query('INSERT INTO boundaries(entity_name, cities, states) VALUES ($1, $2, $3)', ['City association', ['Dallas', 'Plano'], ['TX']]);
  await db.query('INSERT INTO boundaries(entity_name) VALUES ($1)', ['No rules']);
  await db.query('INSERT INTO boundaries(entity_name, shape) VALUES ($1, $2::jsonb)', ['MultiPolygon office', JSON.stringify({ type: 'MultiPolygon', coordinates: [polygon.coordinates, secondPolygon] })]);
  process.env.BOUNDARY_SYNC_ENABLED = 'true';
  process.env.CONGRESS_GOV_API_KEY = 'fixture-congress-key';
  process.env.API_KEYS_JSON = JSON.stringify([{ key: 'fixture-api-key' }]);
  process.env.NODE_ENV = 'test';
  process.env.BOUNDARY_SYNC_GLOBAL_PER_MINUTE = '100';
  delete process.env.BOUNDARY_SYNC_CLIENT_PER_MINUTE;
  mock.method(getAuth(firebaseApp()), 'verifyIdToken', async (token: string) => ({ uid: token, staff: token === 'staff', roles: token === 'legacy' ? ['staff'] : [] }));
  mock.method(getAppCheck(firebaseApp()), 'verifyToken', async (token: string) => { if (token !== 'app-check') throw new Error('private-error'); return { appId: 'fixture' }; });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === '127.0.0.1') return originalFetch(input, init);
    externalCalls++;
    if (failSource) return Response.json({ private: 'provider-secret' }, { status: 500 });
    if (url.hostname.endsWith('arcgis.com')) {
      if (url.pathname.endsWith('/query')) return Response.json({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { DISTRICT: 1 }, geometry: polygon }] });
      return Response.json({ geometryType: 'esriGeometryPolygon', objectIdField: 'OBJECTID' });
    }
    if (url.hostname === 'api.congress.gov') {
      assert.equal((init?.headers as Record<string, string>)['X-Api-Key'], 'fixture-congress-key');
      if (url.pathname.endsWith('/TX')) return Response.json({ members: (completeMembers ? ['A000001', 'B000002'] : ['A000001']).map(bioguideId => ({ bioguideId, terms: { item: [{ chamber: 'Senate' }] } })) });
      const id = url.pathname.split('/').at(-1);
      return Response.json({ member: { currentMember: true, directOrderName: id === 'A000001' ? 'First Senator' : 'Second Senator', addressInformation: { phoneNumber: '202-555-0100' }, officialWebsiteUrl: 'https://www.senate.gov/' } });
    }
    throw new Error(`Unexpected external fixture request: ${url.hostname}`);
  };
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  globalThis.fetch = originalFetch;
  mock.restoreAll();
  for (const [key, value] of environment) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await db.close();
});
async function get(path: string, init?: RequestInit) { return originalFetch(`${origin}${path}`, init); }

test('GeoJSON constraints, service descriptors, required foreign keys and TTL defaults', async () => {
  const row = (await db.query<any>('SELECT * FROM boundaries WHERE id = $1', [boundaryId])).rows[0];
  assert.equal(row.shape_sync_ttl, 365); assert.equal(row.research_sync_ttl, 60);
  for (const descriptor of [{}, { file: '../evil.js', function: 'run', params: {} }, { file: 'a.js', function: 'run', params: [], extra: true }]) await assert.rejects(db.query('UPDATE boundaries SET research_service = $1::jsonb WHERE id = $2', [JSON.stringify(descriptor), boundaryId]));
  for (const shape of [[], { type: 'Point', coordinates: [0, 0] }, { type: 'Polygon', coordinates: [[[181, 0], [1, 0], [1, 1], [181, 0]]] }]) await assert.rejects(db.query('UPDATE boundaries SET shape = $1::jsonb WHERE id = $2', [JSON.stringify(shape), boundaryId]));
  await assert.rejects(db.query('UPDATE boundaries SET shape_sync_ttl = 0 WHERE id = $1', [boundaryId]));
  await assert.rejects(db.query("UPDATE boundaries SET effective_date = 'infinity' WHERE id = $1", [boundaryId]));
  const largeTTL = await db.query<any>("SELECT CURRENT_TIMESTAMP - CURRENT_TIMESTAMP >= 2147483647 * INTERVAL '1 day' AS due");
  assert.equal(largeTTL.rows[0].due, false);
  assert.ok(row.shape_box);
  await assert.rejects(db.exec('INSERT INTO representatives DEFAULT VALUES'));
  assert.throws(() => validateAdapter({ file: '../evil.js', function: 'run', params: {} }, 'research'));
});

test('Dallas dates, exclusive expiration, and successful-sync TTL are independent of attempts', () => {
  assert.equal(dallasDate(new Date('2026-10-14T04:30:00Z')), '2026-10-13');
  const row = { id: 1, effective_date: '2026-10-13', expiration_date: '2026-10-14' };
  assert.equal(boundaryFromRow(row, '2026-10-13').isInEffect, true);
  assert.equal(boundaryFromRow(row, '2026-10-14').isInEffect, false);
  const now = Date.now();
  assert.equal(isDue({ last_shape_sync: new Date(now), last_shape_success: null, shape_sync_ttl: 365 }, 'shape', now), true);
  assert.equal(isDue({ last_shape_success: new Date(now - 86400000), shape_sync_ttl: 1 }, 'shape', now), true);
});

test('null shape matches AND across rules and OR within arrays, never missing/empty rules', async () => {
  const row = (await db.query<any>('SELECT * FROM boundaries WHERE entity_name = $1', ['City association'])).rows[0];
  const boundary = boundaryFromRow(row);
  assert.equal(matchesLocation(boundary, { city: 'dallas', state: 'Texas' }), true);
  assert.equal(matchesLocation(boundary, { city: 'Plano', state: 'TX' }), true);
  assert.equal(matchesLocation(boundary, { city: 'Dallas' }), false);
  assert.equal(matchesLocation(boundary, { city: 'Dallas', state: 'OK' }), false);
  assert.equal(matchesLocation({ ...boundary, cities: [], states: [] }, { city: 'Dallas' }), false);
  assert.equal(matchesLocation({ ...boundary, shapePending: true }, { city: 'Dallas', state: 'TX' }), false);
});

test('public boundary reads support metadata, MultiPolygons, holes, validation and pagination', async () => {
  const statewide = await get('/api/boundaries?state=Texas&entity=United%20States');
  assert.equal(statewide.status, 200); assert.equal((await statewide.json())[0].id, senateId);
  const inside = await get('/api/boundaries?lat=20.5&lon=20.5');
  assert.deepEqual((await inside.json()).map((item: any) => item.entityName), ['MultiPolygon office']);
  const hole = await get('/api/boundaries?lat=5&lon=5'); assert.deepEqual(await hole.json(), []);
  const holeEdge = await get('/api/boundaries?lat=5&lon=4'); assert.deepEqual(await holeEdge.json(), []);
  assert.equal((await get('/api/boundaries?lat=2')).status, 400);
  assert.equal((await get('/api/boundaries?limit=501')).status, 400);
  assert.equal((await get('/api/boundary/0')).status, 400);
  assert.equal((await get('/api/boundary/9999')).status, 404);
  assert.equal((await (await get('/api/boundaries?limit=1')).json()).length, 1);
});

test('SQL shortlists normalize county, state and ZIP+4 while retaining exact null-shape rules', async () => {
  const { rows } = await db.query<any>('INSERT INTO boundaries(entity_name, counties, states, zips) VALUES ($1, $2, $3, $4) RETURNING id', ['County office', ['Dallas County'], ['Texas'], ['75208']]);
  const response = await get('/api/boundaries?entity=County%20office&county=Dallas&state=TX&zip=75208-1234');
  assert.equal(response.status, 200); assert.equal((await response.json())[0].id, rows[0].id);
  assert.deepEqual(await (await get('/api/boundaries?entity=County%20office&county=Dallas&state=TX')).json(), []);
});

test('DATE serialization preserves calendar days across local timezone conversion', async () => {
  const { rows } = await db.query<any>("INSERT INTO boundaries(entity_name, effective_date, expiration_date) VALUES ('Dated fixture', '2027-01-03', '2029-01-03') RETURNING id");
  const response = await get(`/api/boundary/${rows[0].id}`);
  const boundary = await response.json();
  assert.equal(boundary.effectiveDate, '2027-01-03'); assert.equal(boundary.expirationDate, '2029-01-03');
  assert.deepEqual(await (await get('/api/boundaries?entity=Dated%20fixture&asOf=2027-01-02')).json(), []);
  assert.equal((await (await get('/api/boundaries?entity=Dated%20fixture&asOf=2027-01-03')).json())[0].effectiveDate, '2027-01-03');
  assert.deepEqual(await (await get('/api/boundaries?entity=Dated%20fixture&asOf=2029-01-03')).json(), []);
});

test('shape tick completes synchronously, timestamps success, and subsequent ticks do no work', async () => {
  const response = await get('/api/tick/boundaries/shape');
  assert.equal(response.status, 200);
  const boundary = await response.json(); assert.equal(boundary.id, boundaryId); assert.equal(boundary.shapePending, false); assert.ok(boundary.lastShapeSync);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const calls = externalCalls;
  assert.deepEqual(await (await get('/api/tick/boundaries/shape')).json(), { syncCount: 0 });
  assert.equal(externalCalls, calls);
  assert.equal((await get(`/api/tick/boundary/${boundaryId}`)).status, 200);
  assert.equal((await get('/api/tick/boundaries/shape', { method: 'HEAD' })).status, 405);
});

test('research queues durably, concurrent calls deduplicate, and worker persists verified representatives', async () => {
  await db.query('INSERT INTO representatives(boundary_id, name, title) VALUES ($1, $2, $3)', [senateId, 'Former Senator', 'U.S. Senator']);
  const responses = await Promise.all([get(`/api/tick/boundary/${senateId}`), get(`/api/tick/boundary/${senateId}`)]);
  assert.ok(responses.every(response => response.status === 202));
  const accepted = await Promise.all(responses.map(response => response.json()));
  assert.equal(accepted[0].jobId, accepted[1].jobId);
  const before = await get(accepted[0].statusUrl); assert.equal((await before.json()).status, 'queued');
  const formerId = (await db.query<any>('SELECT id FROM representatives WHERE name = $1', ['Former Senator'])).rows[0].id;
  const busyRepresentative = await get(`/api/tick/representative/${formerId}`);
  assert.equal(busyRepresentative.status, 200); assert.equal((await busyRepresentative.json()).id, formerId);
  const job = await BoundarySyncService.claim(accepted[0].jobId); assert.ok(job);
  assert.equal(await BoundarySyncService.execute(job!), 'succeeded');
  const after = await get(accepted[0].statusUrl); const status = await after.json(); assert.equal(status.status, 'succeeded'); assert.equal(status.result.id, senateId);
  const stored = await db.query<any>('SELECT name, "start", "end" FROM representatives WHERE boundary_id = $1 ORDER BY id', [senateId]);
  assert.deepEqual(stored.rows.filter(person => person.end === null).map(person => person.name), ['First Senator', 'Second Senator']);
  const people = await (await get(`/api/representatives?boundaryId=${senateId}`)).json();
  assert.deepEqual(people.map((person: any) => person.name), ['First Senator', 'Second Senator']);
  assert.equal(people[0].boundary.id, senateId); assert.equal(people[0].phones[0].phone, '2025550100');
  assert.ok((await db.query<any>('SELECT "end" FROM representatives WHERE name = $1', ['Former Senator'])).rows[0].end);
  assert.equal((await db.query<any>('SELECT count(*)::integer AS count FROM boundary_research_evidence')).rows[0].count, 1);
  assert.equal((await get(`/api/tick/representative/${people[0].id}`)).status, 200);
});

test('forced sync requires API key, canonical staff and production App Check, and ignores TTL', async () => {
  const path = `/api/tick/boundary/${senateId}`;
  assert.equal((await get(path, { method: 'POST' })).status, 401);
  const headers = { 'X-API-Key': 'fixture-api-key', Authorization: 'Bearer legacy' };
  assert.equal((await get(path, { method: 'POST', headers })).status, 403);
  headers.Authorization = 'Bearer staff';
  process.env.NODE_ENV = 'production';
  assert.equal((await get(path, { method: 'POST', headers })).status, 401);
  process.env.NODE_ENV = 'test';
  const response = await get(path, { method: 'POST', headers }); assert.equal(response.status, 202);
  assert.equal((await get(path, { method: 'POST', headers })).status, 409);
  const job = await BoundarySyncService.claim((await response.json()).jobId); assert.ok(job?.force_sync);
  assert.equal(await BoundarySyncService.execute(job!), 'succeeded');
});

test('expired leases are reclaimable and stale workers cannot persist data', async () => {
  const queued = await BoundarySyncService.enqueue({ target: 'boundary', id: senateId, force: true, clientAddress: 'lease-test' }); assert.ok(queued);
  const first = await BoundarySyncService.claim(String(queued!.id)); assert.ok(first);
  await db.query("UPDATE boundary_sync_jobs SET lease_until = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id = $1", [queued!.id]);
  const second = await BoundarySyncService.claim(String(queued!.id)); assert.ok(second); assert.notEqual(first!.lease_token, second!.lease_token);
  assert.equal(await BoundarySyncService.execute(first!), 'failed');
  assert.equal((await BoundarySyncService.status(String(queued!.id))).status, 'running');
  assert.equal(await BoundarySyncService.execute(second!), 'succeeded');
});

test('failed sources retain good shape, record invocation, and apply backoff without consuming TTL', async () => {
  await db.query('UPDATE boundaries SET last_shape_success = NULL WHERE id = $1', [boundaryId]);
  failSource = true;
  const response = await get('/api/tick/boundaries/shape'); assert.equal(response.status, 502);
  assert.ok(!(await response.text()).includes('provider-secret'));
  failSource = false;
  const row = (await db.query<any>('SELECT * FROM boundaries WHERE id = $1', [boundaryId])).rows[0];
  assert.deepEqual(row.shape, polygon); assert.equal(row.last_shape_success, null); assert.ok(row.last_shape_sync); assert.ok(row.shape_retry_after);
  assert.deepEqual(await (await get('/api/tick/boundaries/shape')).json(), { syncCount: 0 });
});

test('incomplete research cannot end existing representatives, and provider configuration is explicit', async () => {
  completeMembers = false;
  const queued = await BoundarySyncService.enqueue({ target: 'boundary', id: senateId, force: true, clientAddress: 'incomplete-test' });
  const job = await BoundarySyncService.claim(String(queued!.id)); assert.equal(await BoundarySyncService.execute(job!), 'failed');
  completeMembers = true;
  assert.equal((await (await get(`/api/representatives?boundaryId=${senateId}`)).json()).length, 2);
  delete process.env.CONGRESS_GOV_API_KEY;
  assert.equal((await get(`/api/tick/boundary/${senateId}`, { method: 'POST', headers: { 'X-API-Key': 'fixture-api-key', Authorization: 'Bearer staff' } })).status, 503);
  process.env.CONGRESS_GOV_API_KEY = 'fixture-congress-key';
});

test('representative force research returns its model and can end a verified departed member', async () => {
  const descriptor = { file: 'congress.js', function: 'researchMembers', params: { chamber: 'Senate' } };
  const { rows } = await db.query<any>('INSERT INTO representatives(boundary_id, name, title, source_key, research_service, last_research_success) VALUES ($1, $2, $3, $4, $5::jsonb, CURRENT_TIMESTAMP) RETURNING id', [senateId, 'Departed Member', 'U.S. Senator', 'congress:C000003', JSON.stringify(descriptor)]);
  const response = await get(`/api/tick/representative/${rows[0].id}`, { method: 'POST', headers: { 'X-API-Key': 'fixture-api-key', Authorization: 'Bearer staff' } });
  assert.equal(response.status, 202);
  const accepted = await response.json();
  const job = await BoundarySyncService.claim(accepted.jobId); assert.equal(await BoundarySyncService.execute(job!), 'succeeded');
  const status = await (await get(accepted.statusUrl)).json();
  assert.equal(status.targetType, 'representative'); assert.equal(status.result.id, rows[0].id); assert.equal(status.result.boundaryId, senateId); assert.ok(status.result.end);
});

test('synchronous deadlines defer durable work without consuming crash attempts or successful TTL', async () => {
  await db.query('UPDATE boundaries SET last_shape_success = NULL, shape_retry_after = NULL WHERE id = $1', [boundaryId]);
  const queued = await BoundarySyncService.enqueue({ target: 'boundary', id: boundaryId, kind: 'shape', clientAddress: 'deadline-test' });
  const job = await BoundarySyncService.claim(String(queued!.id));
  const fixtureFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => { await new Promise(resolve => setTimeout(resolve, 20)); return fixtureFetch(input, init); };
  try { assert.equal(await BoundarySyncService.execute(job!, 1), 'queued'); }
  finally { globalThis.fetch = fixtureFetch; }
  assert.equal((await BoundarySyncService.status(String(queued!.id))).status, 'queued');
  const stored = (await db.query<any>('SELECT attempts FROM boundary_sync_jobs WHERE id = $1', [queued!.id])).rows[0]; assert.equal(stored.attempts, 0);
  assert.equal((await db.query<any>('SELECT last_shape_success FROM boundaries WHERE id = $1', [boundaryId])).rows[0].last_shape_success, null);
  const resumed = await BoundarySyncService.claim(String(queued!.id)); assert.equal(await BoundarySyncService.execute(resumed!), 'succeeded');
});

test('verified primary singleton research replaces incumbents without changing historical identities', async () => {
  const sourceUrl = 'https://dallascityhall.com/fixture-current-roster';
  const descriptor = { file: 'official.js', function: 'researchRoster', params: { urls: [sourceUrl], title: 'Council member', expectedMembers: 1, useSearch: false } };
  await db.query('UPDATE boundaries SET research_service = $2::jsonb WHERE id = $1', [boundaryId, JSON.stringify(descriptor)]);
  const previous = (await db.query<any>('INSERT INTO representatives(boundary_id, name, title) VALUES ($1, $2, $3) RETURNING id', [boundaryId, 'Previous Member', 'Council member'])).rows[0].id;
  let name = 'Current Member';
  const fixtureFetch = globalThis.fetch;
  const previousKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'fixture-only';
  globalThis.fetch = async (input, init) => new URL(String(input)).hostname === 'dallascityhall.com'
    ? new Response(`<main>Current City of Dallas City Council members. District 1 ${name}.</main>`, { headers: { 'content-type': 'text/html' } }) : fixtureFetch(input, init);
  const provider = mock.method(OfficialResearchProvider, 'createClient', () => ({ models: { generateContent: async () => ({ text: JSON.stringify({ people: [{ name, title: 'Council member', sourceUrl, scopeEvidence: `District 1 ${name}.`, email: null, emailEvidence: null, phone: null, phoneEvidence: null }], description: null, whenToContact: null, boundaryEvidence: null }) }) } }));
  try {
    const queued = await BoundarySyncService.enqueue({ target: 'boundary', id: boundaryId, kind: 'research', force: true, clientAddress: 'singleton-test' });
    const job = await BoundarySyncService.claim(String(queued!.id)); assert.equal(await BoundarySyncService.execute(job!), 'succeeded');
    const people = await (await get(`/api/representatives?boundaryId=${boundaryId}`)).json();
    assert.deepEqual(people.map((person: any) => person.name), ['Current Member']); assert.notEqual(people[0].id, previous);
    assert.ok((await db.query<any>('SELECT "end" FROM representatives WHERE id = $1', [previous])).rows[0].end);
    name = 'Next Member';
    const replacement = await BoundarySyncService.enqueue({ target: 'representative', id: people[0].id, force: true, clientAddress: 'singleton-representative-test' });
    const claim = await BoundarySyncService.claim(String(replacement!.id)); assert.equal(await BoundarySyncService.execute(claim!), 'succeeded');
    const current = await (await get(`/api/representatives?boundaryId=${boundaryId}`)).json();
    assert.deepEqual(current.map((person: any) => person.name), ['Next Member']); assert.notEqual(current[0].id, people[0].id);
    const status = await (await get(`/api/tick/jobs/${replacement!.id}`)).json();
    assert.equal(status.result.id, people[0].id); assert.equal(status.result.name, 'Current Member'); assert.ok(status.result.end);
  } finally {
    provider.mock.restore(); globalThis.fetch = fixtureFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = previousKey;
  }
});

test('client and global budgets are distributed and rolled back on rejection', async () => {
  process.env.BOUNDARY_SYNC_CLIENT_PER_MINUTE = '1';
  await BoundarySyncService.enqueue({ target: 'boundary', id: boundaryId, clientAddress: 'budget-test' });
  await assert.rejects(BoundarySyncService.enqueue({ target: 'boundary', id: boundaryId, clientAddress: 'budget-test' }), (error: any) => error.status === 429);
  await assert.rejects(BoundarySyncService.enqueue({ target: 'boundary', id: 2147483647, clientAddress: 'invalid-budget-test' }), (error: any) => error.status === 404);
  await assert.rejects(BoundarySyncService.enqueue({ target: 'boundary', id: boundaryId, clientAddress: 'invalid-budget-test' }), (error: any) => error.status === 429);
  delete process.env.BOUNDARY_SYNC_CLIENT_PER_MINUTE;
  process.env.BOUNDARY_SYNC_GLOBAL_PER_MINUTE = '1';
  await db.exec("DELETE FROM boundary_sync_budgets WHERE bucket = 'global-minute'");
  const queued = await BoundarySyncService.enqueue({ target: 'boundary', id: senateId, force: true, clientAddress: 'global-budget-test' });
  const job = await BoundarySyncService.claim(String(queued!.id)); assert.ok(job);
  assert.equal(await BoundarySyncService.execute(job!), 'succeeded');
  const next = await BoundarySyncService.enqueue({ target: 'boundary', id: senateId, force: true, clientAddress: 'next-budget-test' });
  await assert.rejects(BoundarySyncService.claim(String(next!.id)), (error: any) => error.status === 429);
  assert.equal((await BoundarySyncService.status(String(next!.id))).status, 'queued');
  delete process.env.BOUNDARY_SYNC_GLOBAL_PER_MINUTE;
});

test('OpenAPI accurately documents public endpoints, staff force endpoints and response changes', () => {
  for (const path of ['/api/boundaries', '/api/boundary/{id}', '/api/tick/boundaries/shape', '/api/tick/boundaries/research', '/api/tick/boundary/{id}', '/api/tick/representatives', '/api/tick/representative/{id}', '/api/tick/jobs/{id}']) assert.deepEqual(swaggerDocument.paths[path].get.security, []);
  for (const path of ['/api/tick/boundary/{id}', '/api/tick/representative/{id}']) assert.deepEqual(swaggerDocument.paths[path].post.security, [{ ApiKeyAuth: [], BearerAuth: [], AppCheckAuth: [] }]);
  assert.ok(swaggerDocument.components.schemas.Representative.properties.boundary);
  assert.equal(swaggerDocument.components.schemas.Representative.properties.district, undefined);
});
