import test from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/config/db.js';
import { BoundaryService } from '../src/services/boundaryService.js';

const row = (id = 1) => ({ id, entity_name: 'Dallas', body_name: null, district_name: null,
  shape: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] },
  shape_pending: false, cities: [], counties: [], states: [], zips: [], description: 'Original', when_to_contact: '',
  effective_date: null, expiration_date: null, shape_service: null, research_service: null,
  last_shape_sync: null, last_research_sync: null, shape_sync_ttl: 1, research_sync_ttl: 1 });
const location = { latitude: 1, longitude: 1 };
function setup(t: any, impl: (...args: any[]) => any = async () => ({ rows: [row()] })) {
  BoundaryService.clearSearchCache();
  t.after(() => BoundaryService.clearSearchCache());
  return t.mock.method(pool, 'query', impl);
}

test('spatial searches cache rounded coordinates and return independent results across pagination', async t => {
  const query = setup(t, async () => ({ rows: [row(1), row(2), row(3)] }));
  const first = await BoundaryService.findAll({ ...location, limit: 1 });
  first[0].description = 'Changed'; first[0].shape!.coordinates[0][0][0] = 99;
  const next = await BoundaryService.findAll({ ...location, limit: 2, offset: 1 });
  assert.deepEqual(next.map(b => b.id), [2, 3]);
  const again = await BoundaryService.findAll(location);
  assert.equal(again[0].description, 'Original');
  assert.equal(again[0].shape!.coordinates[0][0][0], 0);
  assert.equal(query.mock.callCount(), 1);
  await BoundaryService.findAll({ ...location, latitude: 1.0000001, longitude: 1.00002 });
  assert.equal(query.mock.callCount(), 1);
  await BoundaryService.findAll({ ...location, latitude: 1.00006 });
  assert.equal(query.mock.callCount(), 2);
  assert.equal(query.mock.calls[1].arguments[1][1], 1.0001);
});

test('filters remain isolated while effective dates share candidates; metadata-only searches bypass cache', async t => {
  const query = setup(t);
  for (const filter of [{}, { entity: 'Dallas' }, { body: 'Council' }, { district: '1' }, { city: 'Dallas' }, { county: 'Dallas' }, { state: 'TX' }, { zip: '75201' }, { address: '123 Main' }, { asOf: '2025-01-01' }]) {
    await BoundaryService.findAll({ ...location, ...filter });
    await BoundaryService.findAll({ ...location, ...filter });
  }
  assert.equal(query.mock.callCount(), 9);
  await BoundaryService.findAll({}); await BoundaryService.findAll({});
  assert.equal(query.mock.callCount(), 11);
});

test('concurrent identical lookups share one read; failures are retried and empty results cached', async t => {
  let finish!: (value: any) => void;
  const query = setup(t, () => new Promise(resolve => { finish = resolve; }));
  const first = BoundaryService.findAll(location);
  const second = BoundaryService.findAll({ ...location, limit: 1 });
  finish({ rows: [] });
  assert.deepEqual(await first, []); assert.deepEqual(await second, []);
  await BoundaryService.findAll(location); assert.equal(query.mock.callCount(), 1);
  BoundaryService.clearSearchCache();
  query.mock.restore();
  let attempts = 0;
  t.mock.method(pool, 'query', async () => { if (++attempts === 1) throw new Error('offline'); return { rows: [] }; });
  await assert.rejects(BoundaryService.findAll(location), /offline/);
  await BoundaryService.findAll(location); await BoundaryService.findAll(location);
  assert.equal(attempts, 2);
});

test('30-day expiry uses time since completion, not last access', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const query = setup(t);
  await BoundaryService.findAll(location);
  now += 30 * 24 * 60 * 60 * 1000 - 1; await BoundaryService.findAll(location);
  assert.equal(query.mock.callCount(), 1);
  now++; await BoundaryService.findAll(location);
  assert.equal(query.mock.callCount(), 2);
});

test('Dallas date rollover updates validity and scheduled membership without requerying', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-18T04:59:00Z') });
  const query = setup(t, async () => ({ rows: [
    { ...row(1), expiration_date: '2026-10-18' },
    { ...row(2), effective_date: '2026-10-18' },
  ] }));
  assert.deepEqual((await BoundaryService.findAll(location)).map(b => b.id), [1]);
  assert.equal((await BoundaryService.findAll({ ...location, asOf: '2025-01-01' }))[0].isInEffect, true);
  t.mock.timers.tick(120000);
  assert.deepEqual((await BoundaryService.findAll(location)).map(b => b.id), [2]);
  const historical = await BoundaryService.findAll({ ...location, asOf: '2025-01-01' });
  assert.deepEqual(historical.map(b => b.id), [1]);
  assert.equal(historical[0].isInEffect, false);
  assert.equal(query.mock.callCount(), 1);
});

test('database and exact geometry checks use the rounded point, regardless of first caller', async t => {
  const edge = { ...row(), shape: { type: 'Polygon', coordinates: [[[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]]] } };
  const query = setup(t, async () => ({ rows: [edge] }));
  // Both points round to 1.0000; the canonical point lies on the included boundary edge.
  assert.equal((await BoundaryService.findAll({ latitude: .99998, longitude: 1.5 })).length, 1);
  assert.equal((await BoundaryService.findAll({ latitude: 1.00002, longitude: 1.5 })).length, 1);
  assert.equal(query.mock.callCount(), 1);
  assert.deepEqual(query.mock.calls[0].arguments[1], [1.5, 1]);
});

test('LRU capacity is bounded and explicit invalidation discards stored results', async t => {
  const query = setup(t);
  for (let i = 0; i < 128; i++) await BoundaryService.findAll({ latitude: 1, longitude: i / 100 });
  await BoundaryService.findAll({ latitude: 1, longitude: 0 }); // refresh LRU
  await BoundaryService.findAll({ latitude: 1, longitude: 2 });
  await BoundaryService.findAll({ latitude: 1, longitude: 0 });
  assert.equal(query.mock.callCount(), 129);
  await BoundaryService.findAll({ latitude: 1, longitude: .01 });
  assert.equal(query.mock.callCount(), 130);
  BoundaryService.clearSearchCache();
  await BoundaryService.findAll({ latitude: 1, longitude: 0 });
  assert.equal(query.mock.callCount(), 131);
});

test('an in-flight read cannot repopulate cache after invalidation', async t => {
  let finish!: (value: any) => void;
  const query = setup(t, () => new Promise(resolve => { finish = resolve; }));
  const pending = BoundaryService.findAll(location);
  BoundaryService.clearSearchCache();
  finish({ rows: [row()] }); await pending;
  const fresh = BoundaryService.findAll(location);
  assert.equal(query.mock.callCount(), 2);
  finish({ rows: [] }); assert.deepEqual(await fresh, []);
  assert.deepEqual(await BoundaryService.findAll(location), []);
});
