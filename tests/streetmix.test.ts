import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Script } from 'node:vm';
import { getFirestoreDb } from '../src/config/firestore.js';
import { createApp } from '../src/app.js';
import { streetmixPoint, streetmixRequest, streetmixKey, StreetmixError, type StreetmixRoad } from '../src/models/streetmix.js';
import { findOppositeCarriageway, buildDividedStreetmix } from '../src/services/streetmixDivided.js';
import { buildStreetmix, osmWidth } from '../src/services/streetmixBuilder.js';
import { selectRoad, clipCandidateRoad, streetmixCandidates, requireTexas, dallasStreetNames, nearbyRoads, streetmixJson, streetmixOverpassEndpoint } from '../src/services/streetmixSources.js';
import { FirestoreStreetmixStore, streetmixHash, type StreetmixRecord, type StreetmixStore } from '../src/services/streetmixStore.js';
import { FirestoreStreetmixCache, type StreetmixCache, type StreetmixCacheRecord } from '../src/services/streetmixCache.js';
import { generateStreetmix, findStreetmixCandidates, type StreetmixDependencies } from '../src/services/streetmixService.js';
import { publishStreetmix, verifyStreetmix } from '../src/services/streetmixPublisher.js';
import { streetmixPlaygroundHtml } from '../src/controllers/streetmixPlaygroundController.js';
import { swaggerDocument } from '../src/docs/swagger.js';
import compatibility from '../src/data/streetmixCompatibility.json' with { type: 'json' };

const point = { latitude: 32.78014, longitude: -96.79701 };
const key = 'request-key-123456789';
const road = (tags: Record<string, string> = {}, id = 10): StreetmixRoad => ({ id, tags: { highway: 'residential', name: 'Test Street', urban: 'yes', ...tags }, geometry: [{ latitude: point.latitude - 0.001, longitude: point.longitude }, { latitude: point.latitude + 0.001, longitude: point.longitude }] });
const receipt = { id: 'bd3442b7-d10f-4810-9126-844cc04bba77', namespacedId: 123 };
const signal = () => AbortSignal.timeout(10000);
function env(t: any, name: string, value: string) {
  const previous = process.env[name]; process.env[name] = value;
  t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
}

test('coordinates and request keys reject malformed input before I/O', () => {
  assert.deepEqual(streetmixPoint(point), point);
  for (const value of [null, [], {}, { ...point, latitude: '32' }, { ...point, latitude: NaN }, { ...point, longitude: 181 }, { ...point, latitude: 91 }, { ...point, extra: true }]) assert.throws(() => streetmixPoint(value), { code: 'INVALID_COORDINATES' });
  for (const value of [undefined, '', 'a'.repeat(129), 'a'.repeat(15), 'unsafe/key-123456789']) assert.throws(() => streetmixKey(value));
  assert.equal(streetmixKey(key), key);
});

test('nearest street selection handles intersections, ties, distance and reversed geometry', () => {
  const r = road();
  assert.equal(selectRoad(point, [road({}, 20), r]).road.id, 10);
  assert.equal(selectRoad(point, [r, road({}, 20)]).ambiguous, true);
  assert.equal(selectRoad(point, [r]).bearing, 0);
  assert.equal(selectRoad(point, [{ ...r, geometry: r.geometry.toReversed() }]).bearing, 180);
  assert.throws(() => selectRoad({ latitude: 33, longitude: -96 }, [r]), { code: 'NO_SUITABLE_STREET' });
});

test('residential cross-section has explicit estimates, pinned variants and metric widths', () => {
  const result = buildStreetmix(road(), point);
  const street = result.design.street;
  assert.equal(street.schemaVersion, 35); assert.equal(street.units, 1);
  assert.deepEqual(street.segments.map(s => s.type), ['sidewalk', 'drive-lane', 'drive-lane', 'sidewalk']);
  assert.deepEqual(street.segments.map(s => s.width), [1.524, 3.048, 3.048, 1.524]);
  assert.ok(Math.abs(street.segments.reduce((sum, s) => sum + s.width, 0) - street.width) < 0.0001);
  assert.equal(result.estimates.find(item => item.field === 'lanes')?.value, 2);
  for (const segment of street.segments) assert.ok((compatibility.variants as Record<string, string[]>)[segment.type].includes(segment.variantString));
  assert.equal(osmWidth("10'"), 3.048); assert.equal(osmWidth('3.5 m'), 3.5);
  assert.throws(() => osmWidth('10;12'), { code: 'INCONSISTENT_STREET' });
});

test('one-way, reverse one-way and directional counts preserve lane orientation', () => {
  for (const [oneway, direction] of [['yes', 'outbound'], ['-1', 'inbound']]) {
    const built = buildStreetmix(road({ oneway, lanes: '3', sidewalk: 'no' }), point);
    assert.equal(built.design.street.segments.length, 3);
    assert.ok(built.design.street.segments.every(segment => segment.variantString === `${direction}|car`));
  }
  assert.throws(() => buildStreetmix(road({ lanes: '2', 'lanes:forward': '2', 'lanes:backward': '1' }), point), { code: 'INCONSISTENT_STREET' });
  assert.throws(() => buildStreetmix(road({ oneway: 'yes', 'lanes:backward': '1' }), point), { code: 'INCONSISTENT_STREET' });
  const partial = buildStreetmix(road({ 'lanes:forward': '3' }), point);
  assert.equal(partial.design.street.segments.filter(segment => segment.variantString === 'inbound|car').length, 1);
});

test('mapped parking, bike lanes, median, sidewalks and shared turn lane are represented', () => {
  const built = buildStreetmix(road({ lanes: '3', 'lanes:both_ways': '1', 'cycleway:both': 'lane', 'parking:both': 'lane', 'parking:both:orientation': 'parallel', median: 'yes' }), point);
  assert.equal(built.design.street.segments.filter(s => s.type === 'parking-lane').length, 2);
  assert.equal(built.design.street.segments.filter(s => s.type === 'bike-lane').length, 2);
  assert.equal(built.design.street.segments.find(s => s.type === 'divider')?.width, 1.2192);
  assert.equal(built.design.street.segments.find(s => s.type === 'turn-lane')?.variantString, 'outbound|shared');
  assert.equal(buildStreetmix(road({ sidewalk: 'no', 'parking:both': 'no', 'cycleway:both': 'no' }), point).design.street.segments.length, 2);
  assert.equal(buildStreetmix(road({ sidewalk: 'right' }), point).design.street.segments.filter(s => s.type === 'sidewalk').length, 1);
});

test('roadway width excludes sidewalks and never silently overrides mapped lane widths', () => {
  const built = buildStreetmix(road({ width: '7', lanes: '2' }), point);
  assert.equal(built.design.street.segments[1].width, 3.5);
  assert.equal(built.design.street.width, 10.048);
  assert.ok(!built.estimates.some(item => item.field.startsWith('lanes:') && item.field.endsWith('.width')));
  assert.throws(() => buildStreetmix(road({ width: '2' }), point), { code: 'INCONSISTENT_STREET' });
  assert.throws(() => buildStreetmix(road({ width: '7', 'width:lanes:forward': '3', 'width:lanes:backward': '3' }), point), { code: 'INCONSISTENT_STREET' });
});

test('bike direction follows one-way streets and mapped buffers occupy the correct side', () => {
  const forward = buildStreetmix(road({ oneway: 'yes', 'cycleway:left': 'lane', 'cycleway:left:buffer': '0.6' }), point);
  assert.equal(forward.design.street.segments[1].variantString, 'outbound|regular|road');
  assert.equal(forward.design.street.segments[2].type, 'divider');
  assert.equal(forward.design.street.segments[2].width, 0.6);
  const opposite = buildStreetmix(road({ oneway: 'yes', cycleway: 'opposite_lane' }), point);
  assert.equal(opposite.design.street.segments[1].variantString, 'inbound|regular|road');
  const backward = buildStreetmix(road({ lanes: '3', 'lanes:backward': '2', 'width:lanes:backward': '3|4' }), point);
  assert.deepEqual(backward.design.street.segments.filter(segment => segment.variantString === 'inbound|car').map(s => s.width), [4, 3]);
});

test('Texas membership distinguishes outside coverage from provider outage', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('{"features":[]}'));
  await assert.rejects(requireTexas(point, signal()), { code: 'OUTSIDE_TEXAS' });
  fetch.mock.mockImplementation(async () => new Response('{"error":{"message":"provider-secret"}}'));
  await assert.rejects(requireTexas(point, signal()), error => error instanceof StreetmixError && error.status === 502 && !error.message.includes('provider-secret'));
});

test('Overpass validates data and excludes private roads; provider failures retry reads once', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ elements: [{ type: 'way', id: 1, tags: { highway: 'residential' }, geometry: [{ lat: 32.78, lon: -96.79 }, { lat: 32.781, lon: -96.79 }] }, { type: 'way', id: 2, tags: { highway: 'residential', access: 'private' }, geometry: [{ lat: 32.78, lon: -96.79 }, { lat: 32.781, lon: -96.79 }] }] })));
  assert.equal((await nearbyRoads(point, signal())).length, 1);
  fetch.mock.mockImplementation(async () => new Response('secret', { status: 503 }));
  await assert.rejects(streetmixJson('https://overpass-api.de/api/interpreter', signal()), { code: 'SOURCE_UNAVAILABLE' });
  assert.equal(fetch.mock.callCount(), 3);
  const cancelled = AbortSignal.abort();
  await assert.rejects(streetmixJson('https://overpass-api.de/api/interpreter', cancelled), { code: 'GENERATION_TIMEOUT' });
});

test('Overpass endpoint is server-configurable and rejects malformed URL configuration', async t => {
  env(t, 'STREETMIX_OVERPASS_URL', 'https://overpass.private.coffee/api/interpreter');
  assert.equal(streetmixOverpassEndpoint(), 'https://overpass.private.coffee/api/interpreter');
  const fetch = t.mock.method(globalThis, 'fetch', async (url: string) => {
    assert.equal(url, 'https://overpass.private.coffee/api/interpreter');
    return new Response('{"elements":[]}');
  });
  await nearbyRoads(point, signal());
  assert.equal(fetch.mock.callCount(), 1);
  for (const value of ['http://example.com/api/interpreter', 'https://user:password@example.com/api/interpreter', 'https://example.com/api/interpreter?secret=value', 'not-a-url']) {
    process.env.STREETMIX_OVERPASS_URL = value;
    assert.throws(streetmixOverpassEndpoint, { code: 'STREETMIX_UNAVAILABLE' });
  }
});

test('explicitly enabled OSM fallback reconstructs complete ways and marks its source', async t => {
  env(t, 'STREETMIX_OSM_FALLBACK_ENABLED', 'true');
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    urls.push(url);
    if (!url.startsWith('https://api.openstreetmap.org/')) {
      assert.match(String(init.body), /data=/);
      assert.ok(!decodeURIComponent(String(init.body)).includes('around:'));
      return new Response('unavailable', { status: 502 });
    }
    const box = new URL(url).searchParams.get('bbox')!.split(',').map(Number);
    assert.ok(box[2] - box[0] < 0.004); assert.ok(box[3] - box[1] < 0.003);
    return new Response(JSON.stringify({ elements: [
      { type: 'node', id: 1, lat: 32.78, lon: -96.797 }, { type: 'node', id: 2, lat: 32.781, lon: -96.797 },
      { type: 'way', id: 10, nodes: [1, 2], tags: { highway: 'residential', name: 'Fallback Street' } },
      { type: 'way', id: 11, nodes: [1, 999], tags: { highway: 'residential' } },
    ] }));
  });
  const roads = await nearbyRoads(point, signal());
  assert.equal(urls.length, 2); assert.equal(roads.length, 1);
  assert.equal(roads[0].source, 'osm-api'); assert.equal(roads[0].geometry.length, 2);
});

test('OSM fallback stays disabled unless enabled and does not start after cancellation', async t => {
  env(t, 'STREETMIX_OSM_FALLBACK_ENABLED', 'false');
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('unavailable', { status: 502 }));
  await assert.rejects(nearbyRoads(point, signal()), { code: 'SOURCE_UNAVAILABLE' });
  assert.equal(fetch.mock.callCount(), 1);
  process.env.STREETMIX_OSM_FALLBACK_ENABLED = 'true';
  await assert.rejects(nearbyRoads(point, AbortSignal.abort()), { code: 'GENERATION_TIMEOUT' });
  assert.equal(fetch.mock.callCount(), 1);
});

function memory() {
  const records = new Map<string, StreetmixRecord>(), shared = new Map<string, StreetmixCacheRecord>();
  let record: StreetmixRecord | undefined, publications = 0, sequence = 0;
  const store: StreetmixStore = {
    async reserve(id, fingerprint) {
      record = records.get(id);
      if (record && record.fingerprint !== fingerprint) throw new StreetmixError(409, 'IDEMPOTENCY_CONFLICT', 'Conflict');
      if (record?.state === 'publishing') throw new StreetmixError(502, 'PUBLICATION_UNCERTAIN', 'Uncertain');
      if (record?.state === 'reserved') throw new StreetmixError(409, 'REQUEST_IN_PROGRESS', 'In progress');
      if (!record || record.state === 'failed') record = { fingerprint, state: 'reserved', attempt: `attempt-${++sequence}`, expiresAtMs: Date.now() + 86400000 };
      records.set(id, record);
      return structuredClone(record);
    },
    async update(id, attempt, patch) { const current = records.get(id)!; assert.equal(current.attempt, attempt); record = { ...current, ...structuredClone(patch) }; records.set(id, record); },
    async publicationBudget() {},
  };
  const cache: StreetmixCache = {
    async claim(id) {
      const current = shared.get(id);
      if (current && (['publishing', 'published'].includes(current.state) || current.state !== 'failed' && current.expiresAtMs > Date.now())) return { owner: false, record: structuredClone(current) };
      const next: StreetmixCacheRecord = { state: 'working', attempt: `shared-${++sequence}`, expiresAtMs: Date.now() + 90000 };
      shared.set(id, next); return { owner: true, record: structuredClone(next) };
    },
    async update(id, attempt, patch) { const current = shared.get(id)!; if (current.attempt !== attempt) throw new StreetmixError(409, 'RESERVATION_EXPIRED', 'Expired'); shared.set(id, { ...current, ...structuredClone(patch) }); },
  };
  const dependencies: StreetmixDependencies = { store, cache, async requireTexas() {}, async nearbyRoads() { return [road()]; }, async dallasStreetNames() { return []; }, async publish() { publications++; return receipt; }, async verify() {} };
  return { dependencies, shared, records, record: () => record, publications: () => publications };
}

test('generation stores evidence and replays results without another publication', async t => {
  env(t, 'STREETMIX_ENABLED', 'true');
  const m = memory();
  const result = await generateStreetmix(point, key, 'test-app', signal(), m.dependencies);
  assert.equal(result.streetmixUrl, 'https://streetmix.net/-/123');
  assert.deepEqual(await generateStreetmix(point, key, 'test-app', signal(), m.dependencies), result);
  assert.equal(m.publications(), 1);
  await assert.rejects(generateStreetmix({ ...point, latitude: 32.8 }, key, 'test-app', signal(), m.dependencies), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('server refresh scopes fetch fresh sources once and publish once across retries', async t => {
  env(t, 'STREETMIX_ENABLED', 'true');
  const m = memory(); let reads = 0, intents = 0;
  m.dependencies.nearbyRoads = async () => { reads++; return [road()]; };
  await generateStreetmix(point, key, 'test-app', signal(), m.dependencies);
  const options = { refreshScope: 'server-owned-refresh-one', beforePublish: async () => { intents++; } };
  await generateStreetmix(point, 'fresh-request-000001', 'test-app', signal(), m.dependencies, options);
  await generateStreetmix(point, 'fresh-request-000001', 'test-app', signal(), m.dependencies, options);
  assert.equal(reads, 2); assert.equal(m.publications(), 2); assert.equal(intents, 1);
});

test('lost create response is never repeated, while known publications retry verification', async t => {
  env(t, 'STREETMIX_ENABLED', 'true');
  const m = memory(); let creates = 0;
  m.dependencies.publish = async () => { creates++; throw new StreetmixError(502, 'PUBLICATION_UNCERTAIN', 'Uncertain'); };
  await assert.rejects(generateStreetmix(point, key, 'test-app', signal(), m.dependencies), { code: 'PUBLICATION_UNCERTAIN' });
  for (const item of m.shared.values()) if (item.state === 'publishing') item.expiresAtMs = 0;
  await assert.rejects(generateStreetmix(point, key, 'test-app', signal(), m.dependencies), { code: 'PUBLICATION_UNCERTAIN' });
  assert.equal(creates, 1); assert.ok([...m.shared.values()].some(item => item.state === 'publishing'));
  const known = memory();
  known.dependencies.verify = async () => { throw new StreetmixError(502, 'PUBLICATION_VERIFICATION_FAILED', 'Retry'); };
  await assert.rejects(generateStreetmix(point, key, 'test-app', signal(), known.dependencies));
  assert.ok([...known.shared.values()].some(item => item.state === 'published'));
  known.dependencies.verify = async () => {};
  assert.equal((await generateStreetmix(point, key, 'test-app', signal(), known.dependencies)).streetmixId, receipt.id);
  assert.equal(known.publications(), 1);
});

test('provider failures before publication can be retried; GIS supplement failures become warnings', async t => {
  env(t, 'STREETMIX_ENABLED', 'true');
  const m = memory();
  m.dependencies.requireTexas = async () => { throw new StreetmixError(502, 'SOURCE_UNAVAILABLE', 'Unavailable'); };
  await assert.rejects(generateStreetmix(point, key, 'test-app', signal(), m.dependencies));
  assert.equal(m.record()?.state, 'failed'); assert.equal(m.publications(), 0);
  m.dependencies.requireTexas = async () => {};
  m.dependencies.dallasStreetNames = async () => { throw new Error('secret'); };
  const result = await generateStreetmix(point, key, 'test-app', signal(), m.dependencies);
  assert.ok(result.warnings.some(warning => warning.includes('unavailable')));
  assert.ok(!JSON.stringify(result).includes('secret'));
});

test('publisher never retries create and checks read-back for changed segments', async t => {
  const built = buildStreetmix(road(), point).design;
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('lost reply'); });
  await assert.rejects(publishStreetmix(built, signal()), { code: 'PUBLICATION_UNCERTAIN' });
  assert.equal(fetch.mock.callCount(), 1);
  fetch.mock.mockImplementation(async () => new Response(JSON.stringify({ ...receipt, creatorId: null, data: built })));
  await verifyStreetmix(receipt, built, signal());
  fetch.mock.mockImplementation(async () => new Response(JSON.stringify({ ...receipt, data: { street: { ...built.street, segments: [] } } })));
  await assert.rejects(verifyStreetmix(receipt, built, signal()), { code: 'PUBLICATION_VERIFICATION_FAILED' });
});

test('Firestore reservations enforce concurrent retries, conflicts, expiry and distributed quotas', async t => {
  const db = getFirestoreDb();
  const documents = new Map<string, any>();
  let queue = Promise.resolve();
  t.mock.method(db, 'runTransaction', (fn: any) => {
    const operation = queue.then(async () => {
      const writes: Array<() => void> = [];
      const snapshot = (ref: any) => ({ data: () => structuredClone(documents.get(ref.path)) });
      const result = await fn({ getAll: async (...refs: any[]) => refs.map(snapshot), get: async (ref: any) => snapshot(ref),
        set: (ref: any, data: any) => writes.push(() => documents.set(ref.path, structuredClone(data))),
        update: (ref: any, data: any) => writes.push(() => documents.set(ref.path, { ...documents.get(ref.path), ...structuredClone(data) })),
      });
      writes.forEach(write => write()); return result;
    });
    queue = operation.then(() => undefined, () => undefined);
    return operation;
  });
  env(t, 'STREETMIX_APP_REQUESTS_PER_MINUTE', '1');
  env(t, 'STREETMIX_GLOBAL_PUBLICATIONS_PER_DAY', '1');
  const store = new FirestoreStreetmixStore();
  const results = await Promise.allSettled([store.reserve('request', 'fingerprint', 'app', signal()), store.reserve('request', 'fingerprint', 'app', signal())]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  await assert.rejects(store.reserve('request', 'other-fingerprint', 'app', signal()), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(store.reserve('request2', 'fingerprint', 'app', signal()), { code: 'STREETMIX_RATE_LIMITED' });
  const record = documents.get('streetmix-requests/request');
  await store.update('request', record.attempt, { state: 'publishing' }, signal());
  await assert.rejects(store.reserve('request', 'fingerprint', 'app', signal()), { code: 'PUBLICATION_UNCERTAIN' });
  await assert.rejects(store.update('request', 'stale-attempt', { state: 'failed' }, signal()), { code: 'RESERVATION_EXPIRED' });
  await store.publicationBudget(signal());
  await assert.rejects(store.publicationBudget(signal()), { code: 'STREETMIX_DAILY_LIMIT' });
  record.expiresAtMs = Date.now() - 1; documents.set('streetmix-requests/request', record);
  const renewed = await store.reserve('request', 'new-fingerprint', 'other-app', signal());
  assert.notEqual(renewed.attempt, record.attempt);
  assert.equal(streetmixHash('key').length, 64);
});

test('HTTP route exposes public playground, requires credentials, validates JSON and stays disabled by default', async t => {
  env(t, 'NODE_ENV', 'test'); env(t, 'API_KEYS_JSON', JSON.stringify([{ key: 'streetmix-test-key', name: 'tests' }])); env(t, 'STREETMIX_ENABLED', 'false');
  const app = createApp(); const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address() as { port: number }; const base = `http://127.0.0.1:${address.port}`;
  const page = await fetch(base + '/playground/streetmix');
  assert.equal(page.status, 200); assert.match(await page.text(), /Generate Streetmix design/);
  const post = (body: string, headers: Record<string, string> = {}) => fetch(base + '/api/streetmix/designs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, ...headers }, body });
  assert.equal((await post(JSON.stringify(point))).status, 401);
  const headers = { 'X-API-Key': 'streetmix-test-key' };
  assert.equal((await post('not json', headers)).status, 400);
  assert.equal((await post(JSON.stringify({ ...point, latitude: 100 }), headers)).status, 400);
  const disabled = await post(JSON.stringify(point), headers);
  assert.equal(disabled.status, 503); assert.equal((await disabled.json() as any).error, 'STREETMIX_DISABLED');
  assert.equal(disabled.headers.get('cache-control'), 'no-store');
  assert.equal((await post(JSON.stringify(point), { ...headers, 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post(JSON.stringify({ text: 'x'.repeat(66000) }), headers)).status, 413);
  assert.ok(swaggerDocument.paths['/api/streetmix/designs']);
  const playgroundPost = (headers: Record<string, string> = {}) => fetch(base + '/api/streetmix/playground/designs', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, ...headers }, body: JSON.stringify(point),
  });
  const browserDisabled = await playgroundPost();
  assert.equal(browserDisabled.status, 503);
  assert.equal((await browserDisabled.json() as any).error, 'STREETMIX_DISABLED');
  process.env.NODE_ENV = 'production';
  for (const headers of [{}, { 'X-Firebase-AppCheck': 'invalid-app-check-token' }]) {
    const denied = await playgroundPost(headers);
    assert.equal(denied.status, 401);
    assert.equal((await denied.json() as any).message, 'Application verification failed.');
  }
  assert.equal((await post(JSON.stringify(point))).status, 401);
  assert.ok(swaggerDocument.paths['/api/streetmix/playground/designs']);
  assert.equal((await fetch(base + '/api/streetmix/playground/candidates', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(point) })).status, 401);
  assert.ok(swaggerDocument.paths['/api/streetmix/playground/candidates']);
});

test('playground script parses and keeps credential storage ephemeral', () => {
  const script = streetmixPlaygroundHtml.match(/<script>([\s\S]+)<\/script>/)![1];
  assert.doesNotThrow(() => new Script(script));
  assert.ok(!streetmixPlaygroundHtml.includes('id="api-key"'));
  assert.ok(!streetmixPlaygroundHtml.includes('id="bearer"'));
  assert.ok(!script.includes('X-API-Key'));
  assert.ok(!/localStorage|sessionStorage|innerHTML/.test(script));
  assert.match(script, /previous\.key/); assert.match(script, /previous\.body/);
  assert.match(script, /X-Firebase-AppCheck/); assert.match(streetmixPlaygroundHtml, /rel="noopener noreferrer"/);
});

test('playground needs no credentials, preserves the original retry payload, and renders results as text', async () => {
  const elements = new Map<string, any>();
  function element(id: string): any {
    if (!elements.has(id)) elements.set(id, { value: '', hidden: false, disabled: false, textContent: '', children: [], listeners: {},
      reportValidity: () => true, closest() { return this; }, focus() {},
      replaceChildren() { this.children = []; }, append(item: any) { this.children.push(item); },
      addEventListener(name: string, callback: any) { this.listeners[name] = callback; },
    });
    return elements.get(id);
  }
  element('coordinates').value = `${point.latitude}, ${point.longitude}`;

  const result = { ...buildStreetmix(road(), point), streetmixId: receipt.id, streetmixUrl: 'https://streetmix.net/-/123',
    selectedStreet: { name: '<img src=x onerror=alert(1)>' }, snappedCoordinate: point, viewingDirection: { bearingDegrees: 0 } };
  const calls: any[] = [];
  let nextResponse = new Response(JSON.stringify({ error: 'SOURCE_UNAVAILABLE', message: 'Try again' }), { status: 502 });
  let counter = 0;
  const context: any = { document: { getElementById: element, createElement: () => ({ textContent: '' }) }, crypto: { randomUUID: () => `test-request-key-${++counter}` },
    URL, Date, AbortSignal, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, navigator: { clipboard: { async writeText() {} } },
    fetch: async (url: string, init: any) => { calls.push({ url, ...init }); return nextResponse; },
  };
  new Script(streetmixPlaygroundHtml.match(/<script>([\s\S]+)<\/script>/)![1]).runInNewContext(context);
  await context.run(false);
  assert.equal(calls[0].url, '/api/streetmix/playground/designs');
  assert.equal(calls[0].headers['X-API-Key'], undefined);
  assert.equal(calls[0].headers['X-Firebase-AppCheck'], undefined);
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.match(element('status').textContent, /HTTP 502/); assert.equal(element('retry').hidden, false);
  element('coordinates').value = '32.8, -96.79701';
  nextResponse = new Response(JSON.stringify(result));
  await context.run(true);
  assert.equal(calls[0].headers['Idempotency-Key'], calls[1].headers['Idempotency-Key']);
  assert.equal(calls[0].body, calls[1].body);
  assert.equal(element('street-name').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(element('open').href, result.streetmixUrl); assert.equal(element('result').hidden, false);
  assert.equal(element('streetmix-preview').src, result.streetmixUrl);
  nextResponse = new Response(JSON.stringify({ ...result, streetmixUrl: 'https://attacker.example/design' }));
  await context.run(false);
  assert.notEqual(calls[1].headers['Idempotency-Key'], calls[2].headers['Idempotency-Key']);
  assert.equal(element('result').hidden, true);
  assert.equal(element('streetmix-preview').src, 'about:blank');
  assert.equal(element('generate').disabled, false);
  nextResponse = new Response(JSON.stringify({ error: 'STREET_SELECTION_REQUIRED', candidates: [{ osmWayId: 20, name: '<script>unsafe</script>', highway: 'secondary', distanceMeters: 5, bearingDegrees: 90, layer: '1', bridge: true, tunnel: false }] }), { status: 409 });
  await context.run(false);
  assert.equal(element('selection').hidden, false); assert.equal(element('retry').hidden, true);
  assert.equal(element('streetmix-preview').src, 'about:blank');
  assert.ok(element('road-choice').children.at(-1).textContent.includes('<script>unsafe</script>'));
  const previewKey = calls.at(-1).headers['Idempotency-Key'];
  element('road-choice').value = '20';
  nextResponse = new Response(JSON.stringify({ ...result, cache: { hit: true, generatedAt: '2026-10-19T12:00:00Z', expiresAt: '2026-10-20T12:00:00Z' }, quality: { summary: 'Review estimates.', mappedCount: 3, derivedCount: 2, estimatedCount: 1, unknownDetails: ['Shoulders unknown'] } }));
  await context.confirmSelection();
  assert.equal(JSON.parse(calls.at(-1).body).osmWayId, 20);
  assert.notEqual(calls.at(-1).headers['Idempotency-Key'], previewKey);
  assert.equal(element('selection').hidden, true);
  assert.match(element('cache-note').textContent, /Shared cached design/);
  assert.equal(element('streetmix-preview').src, result.streetmixUrl);
  assert.match(element('quality').textContent, /Mapped: 3/);
  assert.equal(element('unknown').children[0].textContent, 'Shoulders unknown');
});

test('Texas polygon membership and Dallas-only supplemental coverage fail safely', async t => {
  let calls = 0;
  const fetchMock = t.mock.method(globalThis, 'fetch', async (input: any) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.hostname, 'tigerweb.geo.census.gov');
    assert.equal(url.searchParams.get('where'), "STATE = '48'");
    return new Response('{"features":[{"attributes":{"STATE":"48"}}]}');
  });
  await requireTexas({ latitude: 30.2672, longitude: -97.7431 }, signal());
  assert.equal(calls, 1);
  await assert.rejects(requireTexas({ latitude: 40, longitude: -97 }, signal()), { code: 'OUTSIDE_TEXAS' });
  assert.equal(calls, 1);
  assert.deepEqual(await dallasStreetNames({ latitude: 30.2672, longitude: -97.7431 }, signal()), []);
  assert.equal(calls, 1);
  fetchMock.mock.mockImplementation(async () => new Response('{"features":[]}'));
  await assert.rejects(requireTexas({ latitude: 35, longitude: -105 }, signal()), { code: 'OUTSIDE_TEXAS' });
  assert.deepEqual(await dallasStreetNames(point, signal()), []);
});

test('rural defaults omit unknown sidewalks, represent mapped shoulders, and expose uncertainty', () => {
  const built = buildStreetmix(road({ highway: 'secondary', urban: 'no', shoulder: 'both', 'shoulder:width': '2', surface: 'gravel' }), { latitude: 30, longitude: -100 });
  assert.equal(built.design.street.segments.filter(s => s.type === 'drive-lane').length, 2);
  assert.equal(built.design.street.segments.filter(s => s.type === 'sidewalk').length, 0);
  assert.equal(built.design.street.segments.filter(s => s.type === 'divider').length, 2);
  assert.ok(built.evidence.some(e => e.field === 'shoulder:left:width' && e.value === 2 && e.basis === 'mapped'));
  assert.ok(built.estimates.some(e => e.field === 'sidewalk:left' && e.value === false));
  assert.ok(built.quality.unknownDetails.some(detail => detail.includes('presence unknown')));
  assert.ok(built.warnings.some(w => w.includes('gravel')));
  assert.equal(built.design.street.location.hierarchy.locality, '');
  assert.ok(!built.design.street.location.label.includes('Dallas'));
  const countryResidential = buildStreetmix(road({ urban: '', rural: 'yes' }), point);
  assert.equal(countryResidential.design.street.segments.filter(s => s.type === 'sidewalk').length, 0);
  const urban = buildStreetmix(road({ highway: 'primary', sidewalk: 'both', lanes: '4' }), point);
  assert.equal(urban.design.street.segments.filter(s => s.type === 'sidewalk').length, 2);
  assert.equal(urban.design.street.segments.filter(s => s.type === 'drive-lane').length, 4);
  assert.deepEqual(streetmixRequest({ ...point, osmWayId: 10 }), { ...point, osmWayId: 10 });
  for (const osmWayId of [0, -1, '10', 1.5]) assert.throws(() => streetmixRequest({ ...point, osmWayId }), { code: 'INVALID_STREET_SELECTION' });
});

test('shared requests across applications coalesce source reads and publish once', async t => {
  env(t, 'STREETMIX_ENABLED', 'true');
  const m = memory(); let sources = 0, boundaries = 0, supplements = 0, budgets = 0;
  m.dependencies.requireTexas = async () => { boundaries++; };
  m.dependencies.nearbyRoads = async () => { sources++; await new Promise(resolve => setTimeout(resolve, 30)); return [road()]; };
  m.dependencies.dallasStreetNames = async () => { supplements++; return []; };
  m.dependencies.store.publicationBudget = async () => { budgets++; };
  const result = await Promise.all([
    generateStreetmix(point, key, 'application-one', signal(), m.dependencies),
    generateStreetmix({ ...point, latitude: point.latitude + 0.000001 }, key + '-other', 'application-two', signal(), m.dependencies),
  ]);
  assert.equal(result[0].streetmixId, result[1].streetmixId);
  assert.equal(result[0].cache?.hit, false); assert.equal(result[1].cache?.hit, true);
  assert.equal(sources, 1); assert.equal(boundaries, 1); assert.equal(supplements, 1); assert.equal(budgets, 1); assert.equal(m.publications(), 1);
  const repeated = await generateStreetmix(point, key + '-third', 'application-three', signal(), m.dependencies);
  assert.equal(repeated.cache?.hit, true); assert.equal(sources, 1); assert.equal(m.publications(), 1);
  // Logical expiry, independent of asynchronous Firestore TTL deletion.
  for (const record of m.shared.values()) record.expiresAtMs = 0;
  await generateStreetmix(point, key + '-expired', 'application-one', signal(), m.dependencies);
  assert.equal(sources, 2); assert.equal(m.publications(), 2);
});

test('ambiguity and grade separation require a validated choice before any publication', async t => {
  env(t, 'STREETMIX_ENABLED', 'true');
  const m = memory(); let reads = 0;
  m.dependencies.nearbyRoads = async () => { reads++; return [road({}, 10), road({ name: 'Frontage Road', layer: '1', bridge: 'yes' }, 20)]; };
  await assert.rejects(generateStreetmix(point, key, 'app', signal(), m.dependencies), error => error instanceof StreetmixError && error.code === 'STREET_SELECTION_REQUIRED' && error.details?.candidates.length === 2);
  assert.equal(m.publications(), 0);
  await assert.rejects(generateStreetmix({ ...point, osmWayId: 999 }, key + '-invalid', 'app', signal(), m.dependencies), { code: 'INVALID_STREET_SELECTION' });
  assert.equal(m.publications(), 0);
  const confirmed = await generateStreetmix({ ...point, osmWayId: 20 }, key + '-confirmed', 'app', signal(), m.dependencies);
  assert.equal(confirmed.selectedStreet.osmWayId, 20); assert.equal(reads, 1); assert.equal(m.publications(), 1);
  const again = await generateStreetmix({ ...point, osmWayId: 20 }, key + '-new', 'other-app', signal(), m.dependencies);
  assert.equal(again.cache?.hit, true); assert.equal(m.publications(), 1);
  const elevated = memory(); elevated.dependencies.nearbyRoads = async () => [road({ bridge: 'yes' })];
  await assert.rejects(generateStreetmix(point, key, 'app', signal(), elevated.dependencies), { code: 'STREET_SELECTION_REQUIRED' });
  assert.equal(elevated.publications(), 0);
});

test('cancelled waiters do not cancel another application generating the shared location', async t => {
  env(t, 'STREETMIX_ENABLED', 'true');
  const m = memory(); let release: () => void = () => {};
  m.dependencies.nearbyRoads = async () => { await new Promise<void>(resolve => { release = resolve; }); return [road()]; };
  const owner = generateStreetmix(point, key, 'app-one', signal(), m.dependencies);
  await new Promise(resolve => setTimeout(resolve, 10));
  const waiting = generateStreetmix(point, key + '-wait', 'app-two', AbortSignal.timeout(30), m.dependencies);
  await assert.rejects(waiting, { code: 'GENERATION_TIMEOUT' });
  release(); await owner;
  assert.equal(m.publications(), 1);
});

test('Firestore shared leases fence stale workers and never take over uncertain publications', async t => {
  const db = getFirestoreDb(), documents = new Map<string, any>(); let queue = Promise.resolve();
  t.mock.method(db, 'runTransaction', (fn: any) => {
    const operation = queue.then(async () => {
      const writes: Array<() => void> = [];
      const result = await fn({ get: async (ref: any) => ({ data: () => structuredClone(documents.get(ref.path)) }),
        set: (ref: any, data: any) => writes.push(() => documents.set(ref.path, structuredClone(data))),
        update: (ref: any, data: any) => writes.push(() => documents.set(ref.path, { ...documents.get(ref.path), ...structuredClone(data) })),
      }); writes.forEach(write => write()); return result;
    }); queue = operation.then(() => undefined, () => undefined); return operation;
  });
  const first = new FirestoreStreetmixCache(), otherReplica = new FirestoreStreetmixCache();
  const claims = await Promise.all([first.claim('spot', signal()), otherReplica.claim('spot', signal())]);
  assert.equal(claims.filter(item => item.owner).length, 1);
  assert.equal(documents.get('streetmix-location-cache/spot').expiresAt, undefined);
  const old = claims[0].record;
  documents.get('streetmix-location-cache/spot').expiresAtMs = 0;
  const replacement = await otherReplica.claim('spot', signal());
  assert.equal(replacement.owner, true);
  await assert.rejects(first.update('spot', old.attempt, { state: 'publishing' }, signal()), { code: 'RESERVATION_EXPIRED' });
  await otherReplica.update('spot', replacement.record.attempt, { state: 'publishing', expiresAtMs: 0 }, signal());
  const uncertain = await first.claim('spot', signal()); assert.equal(uncertain.owner, false); assert.equal(uncertain.record.state, 'publishing');
  const ready = await first.claim('ready-spot', signal());
  await first.update('ready-spot', ready.record.attempt, { state: 'ready', value: { ok: true }, expiresAtMs: Date.now() + 60000 }, signal());
  assert.equal((await otherReplica.claim('ready-spot', signal())).owner, false);
  assert.ok(documents.get('streetmix-location-cache/ready-spot').expiresAt instanceof Date);
});

test('candidate geometry clips long ways around the request and preserves direction', () => {
  const long = { ...road(), geometry: [{ ...point, latitude: point.latitude - 0.02 }, { ...point, latitude: point.latitude + 0.02 }] };
  const clipped = clipCandidateRoad(point, long);
  assert.equal(clipped.length, 1);
  assert.ok(clipped[0][0].latitude < point.latitude && clipped[0][1].latitude > point.latitude);
  assert.ok(clipped[0][1].latitude - clipped[0][0].latitude < 0.005);
  assert.deepEqual(clipCandidateRoad(point, { ...long, geometry: long.geometry.toReversed() }), [clipped[0].toReversed()]);
  assert.equal(clipCandidateRoad(point, { ...long, geometry: long.geometry.map(p => ({ ...p, longitude: p.longitude + 1 })) }).length, 0);
  const candidate = streetmixCandidates(point, [long])[0];
  assert.deepEqual(candidate.geometry, clipped);
  assert.ok(Math.abs(candidate.snappedCoordinate.latitude - point.latitude) < 1e-8);
});

test('candidate map synchronizes road clicks and dropdown selection without publishing', async () => {
  const elements = new Map<string, any>(), lines: any[] = [], markers: any[] = [];
  const element = (id: string): any => {
    if (!elements.has(id)) elements.set(id, { hidden: false, value: '', textContent: '', style: {}, addEventListener() {}, reportValidity() { return true; }, replaceChildren() {}, append() {} });
    return elements.get(id);
  };
  const map = { events: {} as any, on(name: string, callback: any) { this.events[name] = callback; return this; }, setView() {}, remove() {}, removeLayer() {} };
  const layer = () => ({ events: {} as any, style: {} as any, addTo() { return this; }, on(name: string, callback: any) { this.events[name] = callback; return this; }, bindTooltip(label: any) { this.label = label; return this; }, setStyle(style: any) { this.style = style; }, bringToFront() {}, label: null as any });
  const L = { map: () => map, tileLayer: (url: string) => { assert.equal(url, 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'); return layer(); }, circleMarker: layer,
    polyline: (_lines: any, options: any) => { assert.equal(options.bubblingMouseEvents, false); const item = layer(); lines.push(item); return item; }, divIcon: (options: any) => options,
    marker: (_point: any, options: any) => { const item = { ...layer(), options }; markers.push(item); return item; },
  };
  const requests: any[] = []; let sequence = 0;
  const context: any = { window: { L }, document: { getElementById: element, createElement: () => ({ style: {}, textContent: '' }) }, URL, Date, AbortSignal, crypto: { randomUUID: () => `map-click-request-${++sequence}` }, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, async fetch(url: string, options: any) { requests.push({ url, ...options }); return new Response(JSON.stringify({ coordinate: JSON.parse(options.body), candidates: [] })); } };
  new Script(streetmixPlaygroundHtml.match(/<script>([\s\S]+)<\/script>/)![1]).runInNewContext(context);
  const candidates = streetmixCandidates(point, [road({}, 10), road({ name: '<img src=x>' }, 20)]);
  element('road-choice').value = '10';
  await context.renderCandidateMap(candidates, point);
  assert.equal(lines[0].style.color, '#f08000'); assert.equal(lines[1].style.color, '#2373bb');
  candidates[0].oppositeOsmWayId = 20; context.highlightCandidate();
  assert.equal(lines[1].style.color, '#9755d6'); assert.equal(lines[1].style.weight, 6);
  delete candidates[0].oppositeOsmWayId;
  element('road-choice').value = '20'; context.highlightCandidate();
  assert.equal(lines[1].style.weight, 7); assert.equal(lines[0].style.weight, 4);
  assert.match(element('selected-road').textContent, /OSM 20/);
  assert.ok(lines[1].label.textContent.includes('<img src=x>'));
  lines[0].events.click(); assert.equal(element('road-choice').value, '10'); assert.equal(lines[0].style.color, '#f08000');
  assert.ok(markers.some(item => item.options.icon.html === '1'));
  assert.equal(requests.length, 0);
  await map.events.click({ latlng: { lat: 32.8421, lng: -96.7702 } });
  assert.equal(element('coordinates').value, '32.842100, -96.770200');
  assert.equal(requests[0].url, '/api/streetmix/playground/candidates');
  assert.deepEqual(JSON.parse(requests[0].body), { latitude: 32.8421, longitude: -96.7702 });
  assert.equal(element('selection').hidden, true); assert.equal(element('location-map').hidden, false);
  await context.run(true);
  assert.equal(requests[1].url, '/api/streetmix/playground/candidates');
  assert.equal(requests[1].headers['Idempotency-Key'], requests[0].headers['Idempotency-Key']);
  assert.equal(requests[1].body, requests[0].body);
});

test('map previews share discovery and never publish even a single unambiguous road', async t => {
  env(t, 'STREETMIX_ENABLED', 'true');
  const m = memory(); let sources = 0;
  m.dependencies.nearbyRoads = async () => { sources++; return [road()]; };
  m.dependencies.publish = async () => { assert.fail('Preview must not publish'); };
  m.dependencies.store.publicationBudget = async () => { assert.fail('Preview must not reserve publication budget'); };
  const first = await findStreetmixCandidates(point, key, 'browser', signal(), m.dependencies);
  const second = await findStreetmixCandidates(point, key + '-again', 'other-app', signal(), m.dependencies);
  assert.equal(first.candidates.length, 1); assert.equal(second.candidates[0].osmWayId, first.candidates[0].osmWayId); assert.equal(sources, 1);
  m.dependencies.nearbyRoads = async () => [];
  const empty = await findStreetmixCandidates({ ...point, latitude: point.latitude + 0.01 }, key + '-empty', 'browser', signal(), m.dependencies);
  assert.deepEqual(empty.candidates, []); assert.equal(m.publications(), 0);
});

function dividedFixture() {
  const selected = road({ oneway: 'yes', lanes: '2', sidewalk: 'both', 'width:lanes:forward': '3|3.5' }, 10);
  const opposite = { ...road({ oneway: 'yes', lanes: '2', sidewalk: 'both', 'width:lanes:forward': '3.2|3.6' }, 20), geometry: selected.geometry.toReversed().map(p => ({ ...p, longitude: p.longitude - 0.00014 })) };
  return { selected, opposite };
}

test('divided corridors combine opposing lanes, one median, and only the two outer sidewalks', () => {
  const { selected, opposite } = dividedFixture();
  const match = findOppositeCarriageway(selected, point, [selected, opposite]);
  assert.equal(match.pair?.road.id, 20); assert.equal(match.pair?.reverseGeometry, true);
  const built = buildDividedStreetmix(selected, point, match.pair!);
  const segments = built.design.street.segments;
  assert.deepEqual(segments.map(s => s.type), ['sidewalk', 'drive-lane', 'drive-lane', 'divider', 'drive-lane', 'drive-lane', 'sidewalk']);
  assert.deepEqual(segments.filter(s => s.type === 'drive-lane').map(s => s.variantString), ['inbound|car', 'inbound|car', 'outbound|car', 'outbound|car']);
  assert.deepEqual(segments.filter(s => s.type === 'drive-lane').map(s => s.width), [3.6, 3.2, 3, 3.5]);
  assert.equal(built.dividedRoad.medianWidthBasis, 'estimated');
  assert.ok(built.estimates.some(item => item.field === 'median.width'));
  assert.ok(built.evidence.some(item => item.source.includes('/way/20')));
  assert.ok(Math.abs(segments.reduce((sum, s) => sum + s.width, 0) - built.design.street.width) < 0.0001);
  assert.equal(new Set(segments.map(s => s.id)).size, segments.length);
  // A reversed geometry with oneway=-1 has the same physical travel direction.
  const reversed = { ...selected, tags: { ...selected.tags, oneway: '-1', 'width:lanes:forward': undefined as any }, geometry: selected.geometry.toReversed() };
  const reversePair = findOppositeCarriageway(reversed, point, [reversed, opposite]).pair!;
  assert.ok(reversePair); assert.equal(reversePair.reverseGeometry, false);
  const flipped = buildDividedStreetmix(reversed, point, reversePair);
  assert.equal(flipped.design.street.segments.filter(s => s.type === 'drive-lane').length, 4);
});

test('divided matching rejects unrelated roads, grades, same-direction roads, endpoints, and ambiguous counterparts', () => {
  const { selected, opposite } = dividedFixture();
  for (const tags of [{ name: 'Another Road' }, { layer: '1' }, { bridge: 'yes' }, { tunnel: 'yes' }, { highway: 'primary' }, { oneway: 'no' }, { junction: 'roundabout' }]) {
    assert.equal(findOppositeCarriageway(selected, point, [selected, { ...opposite, tags: { ...opposite.tags, ...tags } }]).pair, undefined);
  }
  assert.equal(findOppositeCarriageway(selected, point, [selected, { ...opposite, geometry: opposite.geometry.toReversed() }]).pair, undefined);
  const distant = { ...opposite, geometry: opposite.geometry.map(p => ({ ...p, longitude: p.longitude - 0.001 })) };
  assert.equal(findOppositeCarriageway(selected, point, [selected, distant]).pair, undefined);
  const adjacent = { ...opposite, geometry: [{ ...point, longitude: point.longitude - 0.00014 }, { latitude: point.latitude - 0.001, longitude: point.longitude - 0.00014 }] };
  assert.equal(findOppositeCarriageway(selected, point, [selected, adjacent]).pair, undefined);
  const another = { ...opposite, id: 30, geometry: opposite.geometry.map(p => ({ ...p, longitude: p.longitude - 0.00001 })) };
  const ambiguous = findOppositeCarriageway(selected, point, [selected, opposite, another]);
  assert.equal(ambiguous.pair, undefined); assert.match(ambiguous.warning!, /Multiple/);
});

test('mapped median width takes precedence and contradictory or implausible widths fail safely', () => {
  const { selected, opposite } = dividedFixture();
  const mapped = { ...selected, tags: { ...selected.tags, 'median:width': '4' } };
  const pair = findOppositeCarriageway(mapped, point, [mapped, opposite]).pair!;
  const built = buildDividedStreetmix(mapped, point, pair);
  assert.equal(built.dividedRoad.medianWidthMeters, 4); assert.equal(built.dividedRoad.medianWidthBasis, 'mapped');
  assert.ok(!built.estimates.some(item => item.field === 'median.width'));
  assert.throws(() => buildDividedStreetmix(mapped, point, { ...pair, road: { ...opposite, tags: { ...opposite.tags, 'median:width': '6' } } }), { code: 'INCONSISTENT_STREET' });
  assert.throws(() => buildDividedStreetmix(selected, point, { ...pair, separationMeters: 4 }), { code: 'INCONSISTENT_STREET' });
});

test('generation stores full divided-road coverage and shares the combined design on subsequent requests', async t => {
  env(t, 'STREETMIX_ENABLED', 'true');
  const m = memory(), { selected, opposite } = dividedFixture();
  m.dependencies.nearbyRoads = async () => [selected, opposite];
  const result = await generateStreetmix({ ...point, osmWayId: 10 }, key, 'app', signal(), m.dependencies);
  assert.equal(result.selectedStreet.carriagewayOnly, false);
  assert.equal(result.dividedRoad?.oppositeOsmWayId, 20);
  assert.equal(result.design.street.segments.filter(s => s.type === 'drive-lane').length, 4);
  const cached = await generateStreetmix({ ...point, osmWayId: 10 }, key + '-shared', 'other-app', signal(), m.dependencies);
  assert.equal(cached.cache?.hit, true); assert.equal(cached.streetmixId, result.streetmixId); assert.equal(m.publications(), 1);
});
