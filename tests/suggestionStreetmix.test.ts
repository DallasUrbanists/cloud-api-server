import test from 'node:test';
import assert from 'node:assert/strict';
import { FieldValue, type Firestore } from '@google-cloud/firestore';
import { SuggestionStreetmixService, type SuggestionStreetmixCommand } from '../src/services/suggestionStreetmixService.js';
import { suggestionStreetmixETag } from '../src/models/suggestionStreetmix.js';
import { StreetmixError, type StreetmixResult } from '../src/models/streetmix.js';
import { buildStreetmix } from '../src/services/streetmixBuilder.js';
import { SuggestionService } from '../src/services/suggestionService.js';
import { getPublicImprovementsDb } from '../src/config/firestore.js';
import { swaggerDocument } from '../src/docs/swagger.js';
import { createApp } from '../src/app.js';
import { once } from 'node:events';

const point = { latitude: 32.78014, longitude: -96.79701 };
const base = () => ({ id: 41, location: point, author: { email: 'resident@example.com', name: 'Resident' }, content: { summary: 'Safer crossing', details: '' } });
const user = (email = 'resident@example.com', roles: string[] = []): any => ({ uid: email, email, emails: [email], roles });
const command = (changes: Partial<SuggestionStreetmixCommand> = {}): SuggestionStreetmixCommand => ({ id: '41', application: 'test-application', key: 'request-key-000000001', mode: 'initial', ...changes });
const signal = () => AbortSignal.timeout(10000);
const result = (): StreetmixResult => ({ ...buildStreetmix({ id: 10, tags: { name: 'Test Street', highway: 'residential' }, geometry: [point, { ...point, latitude: point.latitude + .001 }] }, point), streetmixId: 'design-one', streetmixUrl: 'https://streetmix.net/-/123', selectedStreet: { osmWayId: 10, name: 'Test Street', highway: 'residential', distanceMeters: 0, carriagewayOnly: false }, snappedCoordinate: point, viewingDirection: { bearingDegrees: 0, description: 'OSM direction' }, generatedAt: new Date().toISOString() });
const candidate: any = { osmWayId: 10, name: 'Test Street', geometry: [[point]], snappedCoordinate: point };

// Serialize transactions and buffer mutations, including failed-commit rollback.
class MemoryDb {
  data = new Map<string, any>([['suggestion/41', base()]]);
  queue = Promise.resolve();
  failSave = false;
  ref(path: string): any { return { path, id: path.split('/').at(-1), collection: (name: string) => this.collection(`${path}/${name}`) }; }
  collection(path: string): any { return { doc: (id: string) => this.ref(`${path}/${id}`) }; }
  runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const task = this.queue.then(async () => {
      const writes: Array<() => void> = [];
      const tx = {
        get: async (ref: any) => ({ exists: this.data.has(ref.path), id: ref.id, data: () => structuredClone(this.data.get(ref.path)), get: (key: string) => this.data.get(ref.path)?.[key] }),
        set: (ref: any, value: any) => { writes.push(() => this.data.set(ref.path, structuredClone(value))); },
        update: (ref: any, value: any) => {
          if (this.failSave && ref.path === 'suggestion/41' && value.streetmix) { this.failSave = false; throw new Error('Injected attachment failure'); }
          writes.push(() => {
            const data = { ...this.data.get(ref.path) };
            for (const [key, val] of Object.entries(value)) {
              if (val instanceof FieldValue && val.isEqual(FieldValue.delete())) delete data[key];
              else data[key] = structuredClone(val);
            }
            this.data.set(ref.path, data);
          });
        },
      };
      const answer = await fn(tx); writes.forEach(write => write()); return answer;
    });
    this.queue = task.then(() => {}, () => {});
    return task;
  }
  workflow(): any { return [...this.data.entries()].find(([path]) => path.includes('/streetmixRequests/'))?.[1]; }
}
function setup(generate?: any) {
  const db = new MemoryDb();
  let publications = 0;
  const scopes: Array<string | undefined> = [];
  const service = new SuggestionStreetmixService(db as unknown as Firestore, generate || (async (_p, _k, _a, _s, _d, options) => {
    scopes.push(options?.refreshScope); await options?.beforePublish?.(); publications++; return result();
  }), async () => {});
  return { db, service, scopes, publications: () => publications };
}

test('anonymous first generation saves permanently, embeds, and subsequent requests reuse', async () => {
  const { db, service, publications } = setup();
  assert.equal((await service.read('41', signal())).body.streetmix, null);
  const first = await service.run(command(), signal());
  assert.equal(first.status, 201); assert.equal(first.body.status, 'completed');
  assert.equal((first.body.result as any).streetmixUrl, 'https://streetmix.net/-/123');
  assert.equal(first.etag, '"streetmix-41-1"');
  assert.equal(db.data.get('suggestion/41')._streetmixActive, undefined);
  assert.equal((await service.run(command({ key: 'request-key-000000002' }), signal())).status, 200);
  assert.equal(publications(), 1);
  const request = db.workflow(); request.expiresAtMs = Date.now() - 1;
  assert.equal((await service.read('41', signal())).body.result?.streetmixId, 'design-one');
  await assert.rejects(service.readRequest('41', request.requestId, signal()), { code: 'REQUEST_NOT_FOUND' });
});

test('regeneration requires author or staff, existing attachment, and current ETag', async () => {
  const { service, publications, scopes } = setup();
  await assert.rejects(service.run(command({ mode: 'regenerate', user: user() }), signal()), { code: 'ATTACHMENT_REQUIRED' });
  await service.run(command(), signal());
  const regen = command({ mode: 'regenerate', key: 'regenerate-key-00001' });
  await assert.rejects(service.run(regen, signal()), { status: 401 });
  await assert.rejects(service.run({ ...regen, user: user('other@example.com') }, signal()), { status: 403 });
  await assert.rejects(service.run({ ...regen, user: user() }, signal()), { status: 428 });
  await assert.rejects(service.run({ ...regen, user: user(), ifMatch: '"old"' }, signal()), { status: 412 });
  const saved = await service.run({ ...regen, user: user('RESIDENT@example.com'), ifMatch: suggestionStreetmixETag('41', 1) }, signal());
  assert.equal(saved.status, 200); assert.equal(saved.etag, '"streetmix-41-2"'); assert.ok(scopes[1]);
  const replay = await service.run({ ...regen, user: user(), ifMatch: suggestionStreetmixETag('41', 1) }, signal());
  assert.equal(replay.status, 200); assert.equal(publications(), 2);
  await service.run({ ...regen, key: 'regenerate-key-00002', user: user('staff@example.com', ['staff']), ifMatch: saved.etag }, signal());
  assert.equal(publications(), 3);
});

test('ambiguous roads wait for offered selection; wrong, expired, and conflicting choices fail', async () => {
  let calls = 0;
  const { service, db } = setup(async (p: any, _k: any, _a: any, _s: any, _d: any, options: any) => {
    if (!p.osmWayId) throw new StreetmixError(409, 'STREET_SELECTION_REQUIRED', 'Choose', undefined, { candidates: [candidate, { ...candidate, osmWayId: 20 }] });
    await options.beforePublish(); calls++; return result();
  });
  const pending = await service.run(command(), signal()); assert.equal(pending.status, 409); assert.equal(calls, 0);
  const select = command({ mode: 'selection', requestId: pending.body.requestId as string, key: 'selection-key-0000001', osmWayId: 10 });
  await assert.rejects(service.run({ ...select, osmWayId: 30 }, signal()), { code: 'INVALID_STREET_SELECTION' });
  assert.equal((await service.run(select, signal())).status, 201);
  assert.equal((await service.run(select, signal())).status, 200); assert.equal(calls, 1);
  await assert.rejects(service.run({ ...select, osmWayId: 20 }, signal()), { code: 'IDEMPOTENCY_CONFLICT' });
  // A separate pending workflow expires without publication.
  db.data.set('suggestion/41', base()); db.data.clear(); db.data.set('suggestion/41', base());
  const next = await service.run(command(), signal()); db.workflow().selectionExpiresAt = new Date(0).toISOString();
  await assert.rejects(service.run({ ...select, requestId: next.body.requestId as string }, signal()), { code: 'SELECTION_EXPIRED' });
});

test('concurrent callers and duplicate confirmations join one execution', async () => {
  let release!: () => void, started!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const { service } = setup(async (_p: any, _k: any, _a: any, _s: any, _d: any, options: any) => { started(); await gate; await options.beforePublish(); calls++; return result(); });
  const first = service.run(command(), signal()); await ready;
  const joined = await service.run(command({ key: 'request-key-000000002' }), signal());
  assert.equal(joined.status, 202); release();
  const done = await first; assert.equal(joined.body.requestId, done.body.requestId); assert.equal(calls, 1);
});

test('attachment save failure recovers verified result without republishing', async () => {
  const { service, db, publications } = setup(); db.failSave = true;
  const pending = await service.run(command(), signal());
  assert.equal(pending.status, 202); assert.equal(pending.body.status, 'save_pending');
  const done = await service.run(command(), signal());
  assert.equal(done.status, 201); assert.equal(publications(), 1); assert.equal(done.body.error, undefined);
});

test('location edits and deletion fence publication; attachment staleness is computed', async () => {
  let db: MemoryDb;
  let calls = 0;
  const fixture = setup(async (_p: any, _k: any, _a: any, _s: any, _d: any, options: any) => {
    db.data.get('suggestion/41').location = { ...point, latitude: 33 };
    await options.beforePublish(); calls++; return result();
  }); db = fixture.db;
  await assert.rejects(fixture.service.run(command(), signal()), { code: 'SUGGESTION_CHANGED' }); assert.equal(calls, 0);
  const normal = setup(); await normal.service.run(command(), signal()); normal.db.data.get('suggestion/41').location = { ...point, longitude: -97 };
  assert.equal((await normal.service.read('41', signal())).body.streetmix?.stale, true);
  normal.db.data.get('suggestion/41')._deleting = true;
  await assert.rejects(normal.service.run(command(), signal()), { code: 'SUGGESTION_DELETING' });
});

test('uncertain publications retain active workflow and stable refresh across same-key recovery', async () => {
  let calls = 0;
  const scopes: any[] = [];
  const { service, db } = setup(async (_p: any, _k: any, _a: any, _s: any, _d: any, options: any) => {
    scopes.push(options.refreshScope); await options.beforePublish(); calls++;
    throw new StreetmixError(502, 'PUBLICATION_UNCERTAIN', 'Unknown');
  });
  await assert.rejects(service.run(command(), signal()), { code: 'PUBLICATION_UNCERTAIN' });
  assert.equal(db.workflow().status, 'publication_uncertain'); assert.equal(db.workflow().expiresAtMs, undefined);
  assert.equal((await service.run(command({ key: 'request-key-000000002' }), signal())).status, 202);
  assert.equal(calls, 1);
  await assert.rejects(service.run(command(), signal()), { code: 'PUBLICATION_UNCERTAIN' });
  assert.equal(db.workflow().status, 'publication_uncertain'); assert.equal(scopes.length, 2);
});

test('regeneration selection rechecks current ownership and concurrent revision', async () => {
  const { service, db } = setup(); await service.run(command(), signal());
  const pendingService = new SuggestionStreetmixService(db as any, async () => { throw new StreetmixError(409, 'STREET_SELECTION_REQUIRED', 'Choose', undefined, { candidates: [candidate] }); }, async () => {});
  const pending = await pendingService.run(command({ mode: 'regenerate', user: user(), ifMatch: '"streetmix-41-1"' }), signal());
  const select = command({ mode: 'selection', key: 'selection-key-000001', requestId: pending.body.requestId as string, osmWayId: 10 });
  await assert.rejects(pendingService.run(select, signal()), { status: 401 });
  db.data.get('suggestion/41').author.email = 'new@example.com';
  await assert.rejects(pendingService.run({ ...select, user: user() }, signal()), { status: 403 });
  db.data.get('suggestion/41').streetmix.revision = 2;
  await assert.rejects(pendingService.run({ ...select, user: user('new@example.com') }, signal()), { code: 'SUGGESTION_CHANGED' });
});

test('ordinary suggestion updates preserve server metadata and reject deletion', async t => {
  const { db, service } = setup(); await service.run(command(), signal());
  const real = getPublicImprovementsDb();
  t.mock.method(real, 'runTransaction', db.runTransaction.bind(db));
  const changed = await SuggestionService.update(41, { content: { details: 'Updated details' } });
  assert.equal(changed?.streetmix?.revision, 1); assert.equal(changed?.content.summary, 'Safer crossing');
  db.data.get('suggestion/41')._deleting = true;
  await assert.rejects(SuggestionService.update(41, { status: 'completed' }), { status: 409 });
});

test('OpenAPI exposes five endpoints under both aliases', () => {
  const paths = (swaggerDocument as any).paths;
  for (const prefix of ['/api/suggestions', '/api/public-improvements/suggestions']) {
    for (const suffix of ['/streetmix', '/streetmix/regenerate', '/streetmix/requests/{requestId}', '/streetmix/requests/{requestId}/selection']) assert.ok(paths[`${prefix}/{suggestionId}${suffix}`]);
  }
});

test('HTTP aliases require application access and reject coordinates, extra fields, and missing keys', async t => {
  const previousKeys = process.env.API_KEYS_JSON, previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test'; process.env.API_KEYS_JSON = JSON.stringify([{ key: 'test-application' }]);
  t.after(() => { if (previousKeys === undefined) delete process.env.API_KEYS_JSON; else process.env.API_KEYS_JSON = previousKeys; if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv; });
  t.mock.method(SuggestionStreetmixService.prototype, 'read', async () => ({ status: 200, etag: '"streetmix-41-0"', body: { streetmix: null, result: null, activeRequest: null } }));
  const server = createApp().listen(0); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const headers = { 'X-API-Key': 'test-application', 'Content-Type': 'application/json', 'Idempotency-Key': 'http-key-00000000001' };
  assert.equal((await fetch(`${base}/api/suggestions/41/streetmix`)).status, 401);
  for (const prefix of ['/api/suggestions', '/api/public-improvements/suggestions']) {
    const response = await fetch(`${base}${prefix}/41/streetmix`, { headers });
    assert.equal(response.status, 200); assert.equal(response.headers.get('etag'), '"streetmix-41-0"');
    assert.equal((await fetch(`${base}${prefix}/41/streetmix`, { method: 'POST', headers, body: JSON.stringify(point) })).status, 400);
    assert.equal((await fetch(`${base}${prefix}/41/streetmix`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': '' }, body: '{}' })).status, 400);
    assert.equal((await fetch(`${base}${prefix}/41/streetmix/regenerate`, { method: 'POST', headers, body: '{}' })).status, 401);
  }
});

test('invalid suggestion coordinates and out-of-Texas locations never publish', async () => {
  const { db, service, publications } = setup();
  db.data.get('suggestion/41').location = { latitude: NaN, longitude: -96 };
  await assert.rejects(service.run(command(), signal()), { code: 'INVALID_COORDINATES' });
  db.data.get('suggestion/41').location = { latitude: 40, longitude: -96 };
  const outside = new SuggestionStreetmixService(db as any, async () => { throw new Error('Must not generate'); }, async () => { throw new StreetmixError(422, 'OUTSIDE_TEXAS', 'Outside Texas'); });
  await assert.rejects(outside.run(command(), signal()), { code: 'OUTSIDE_TEXAS' });
  assert.equal(publications(), 0);
});

test('old completion retries never overwrite a newer attachment', async () => {
  const { service, db, publications } = setup();
  await service.run(command(), signal());
  await service.run(command({ mode: 'regenerate', key: 'regenerate-key-0001', ifMatch: '"streetmix-41-1"', user: user() }), signal());
  const old = await service.run(command(), signal());
  assert.equal((old.body.streetmix as any).revision, 1);
  assert.equal(db.data.get('suggestion/41').streetmix.revision, 2); assert.equal(publications(), 2);
});
