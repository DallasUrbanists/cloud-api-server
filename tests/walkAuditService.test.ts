import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { WalkAuditStore } from '../src/services/walkAuditStore.js';
import { calculateProgress } from '../src/services/walkAuditWorkflows.js';

test('coverage ignores duplicates and unknown IDs and handles an empty denominator', () => {
  const feature = (id: string) => ({ type: 'Feature', properties: { id }, geometry: { type: 'Point', coordinates: [0, 0] } });
  const study = { intersections: { type: 'FeatureCollection', features: [feature('node/1')] }, segments: { type: 'FeatureCollection', features: [feature('way/1')] } };
  const progress = calculateProgress(study, [{ type: 'intersection', feature_id: 'node/1' }, { type: 'intersection', feature_id: 'node/1' }, { type: 'intersection', feature_id: 'node/unknown' }]);
  assert.deepEqual(progress.overall, { audited: 1, total: 2, ratio: 0.5, coverageApplicable: true });
  assert.deepEqual(calculateProgress({ intersections: { features: [] }, segments: { features: [] } }, []).overall, { audited: 0, total: 0, ratio: 0, coverageApplicable: false });
});

test('route coverage unions overlapping intervals and never counts points or passed junctions', () => {
  const feature = (id: string) => ({ type: 'Feature', properties: { id }, geometry: { type: 'Point', coordinates: [0, 0] } });
  const study = { allowedAuditTypes: ['intersection', 'street-segment', 'point'], intersections: { features: [feature('node/1')] }, segments: { features: [feature('edge-a'), feature('edge-b')] } };
  const progress = calculateProgress(study, [
    { type: 'street-segment', route_selection: { edges: [{ featureId: 'edge-a', fromFraction: 1, toFraction: 0 }, { featureId: 'edge-b', fromFraction: 0, toFraction: 0.6 }] } },
    { type: 'street-segment', route_selection: { edges: [{ featureId: 'edge-b', fromFraction: 0.4, toFraction: 0.8 }] } },
    { type: 'point', feature_id: 'edge-b' }
  ]);
  assert.equal(progress.streets.audited, 1);
  assert.equal(progress.streets.partial, 1);
  assert.equal(progress.intersections.audited, 0);
  assert.equal(progress.points.observations, 1);
  const completed = calculateProgress(study, [{ type: 'street-segment', route_selection: { edges: [{ featureId: 'edge-b', fromFraction: 0, toFraction: 0.5 }, { featureId: 'edge-b', fromFraction: 1, toFraction: 0.5 }] } }]);
  assert.equal(completed.streets.audited, 1);
  const pointOnly = calculateProgress({ ...study, allowedAuditTypes: ['point'] }, [{ type: 'point', feature_id: 'edge-a' }]);
  assert.equal(pointOnly.overall.coverageApplicable, false);
  assert.equal(pointOnly.points.observations, 1);
});

test('transaction boundary rolls back all work and releases its client on failure', async () => {
  const db = new PGlite(); let releases = 0;
  const query = (sql: string, params?: unknown[]) => db.query(sql, params);
  const adapter = { query, connect: async () => ({ query, release() { releases++; } }) } as unknown as Pool;
  try {
    await db.exec('CREATE TABLE example (value integer)');
    const store = new WalkAuditStore(adapter);
    await assert.rejects(store.transaction(async client => { await client.query('INSERT INTO example VALUES (1)'); throw new Error('rollback'); }), /rollback/);
    assert.equal((await db.query('SELECT * FROM example')).rows.length, 0);
    assert.equal(releases, 1);
  } finally { await db.close(); }
});
