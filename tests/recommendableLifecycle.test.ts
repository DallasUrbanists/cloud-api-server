import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getPublicImprovementsDb } from '../src/config/firestore.js';
import { RecommendableActionService as Service } from '../src/services/recommendableActionService.js';
import { migrateActions, planActionMigration } from '../src/scripts/migrateRecommendableActions.js';

const input = { summary: 'Report a pothole.', instructions: 'Call 311.', why: 'Hazardous pothole.', whyNot: 'Unrelated issues.', sourceUrl: 'https://dallascrm.my.site.com/public/s/', sourceEvidence: 'Call 311.', sourceDescription: 'Saved source.', boundaries: [], confidence: null };
const stored = { ...input, sourceKey: 'pothole', status: 'candidate', version: 1, createdAt: '2026-10-18T00:00:00.000Z', updatedAt: '2026-10-18T00:00:00.000Z', fingerprint: 'first' };

function memory(initial: Record<string, any> = {}) {
  const rows = new Map(Object.entries(initial));
  let hook: (() => void) | undefined;
  const ref = (path: string): any => ({ path, id: path.split('/').at(-1),
    get: async () => snap(path), listCollections: async () => [],
    collection: (name: string) => collection(`${path}/${name}`),
  });
  const snap = (path: string): any => ({ ref: ref(path), id: path.split('/').at(-1), exists: rows.has(path), data: () => structuredClone(rows.get(path)), get: (field: string) => rows.get(path)?.[field] });
  const collection = (path: string): any => {
    const query = { doc: (id = 'generated') => ref(`${path}/${id}`), orderBy: () => query, limit: () => query,
      get: async () => { const docs = [...rows.keys()].filter(key => key.startsWith(`${path}/`) && key.split('/').length === path.split('/').length + 1).map(snap); return { docs, size: docs.length, empty: docs.length === 0 }; } };
    return query;
  };
  const db: any = { collection, doc: ref, databaseId: 'test', runTransaction: async (fn: any) => {
    hook?.(); const writes: (() => void)[] = [];
    const result = await fn({ get: async (r: any) => snap(r.path), getAll: async (...refs: any[]) => refs.map(r => snap(r.path)),
      set: (r: any, data: any) => writes.push(() => { rows.set(r.path, structuredClone(data)); }),
      delete: (r: any) => writes.push(() => { rows.delete(r.path); }),
    });
    writes.forEach(write => write()); return result;
  } };
  return { db, rows, beforeTransaction: (fn: () => void) => { hook = fn; } };
}

test('approval and rejection update one action in place, keep its ID, and snapshot versions', async t => {
  const state = memory({ 'recommendableActions/pothole': stored });
  const db = getPublicImprovementsDb();
  t.mock.method(db, 'collection', state.db.collection); t.mock.method(db, 'runTransaction', state.db.runTransaction);
  const approved = await Service.reviewCandidate('pothole', 'approve');
  assert.equal(approved?.id, 'pothole'); assert.equal(approved?.status, 'approved'); assert.equal(approved?.version, 2);
  assert.equal(state.rows.get('recommendableActions/pothole/versions/1').status, 'candidate');
  assert.equal(state.rows.get('recommendableActions/pothole/versions/2').status, 'approved');
  assert.equal((await Service.reviewCandidate('pothole', 'approve'))?.version, 2);
  const rejected = await Service.reviewCandidate('pothole', 'reject');
  assert.equal(rejected?.id, 'pothole'); assert.equal(rejected?.status, 'rejected'); assert.equal(rejected?.version, 3);
  assert.equal([...state.rows.keys()].filter(path => path.split('/').length === 2).length, 1);
  assert.equal(await Service.getApproved('pothole'), null);
});

test('source updates reuse stable action ID and return approved content to review', async t => {
  const state = memory(); const db = getPublicImprovementsDb();
  t.mock.method(db, 'collection', state.db.collection); t.mock.method(db, 'runTransaction', state.db.runTransaction);
  const first = await Service.createCandidate(input, 'revision-one', { sourceKey: 'pothole', sourceFingerprint: 'one' });
  assert.equal(first.id, 'pothole');
  await Service.reviewCandidate('pothole', 'approve');
  const same = await Service.createCandidate(input, 'revision-one', { sourceKey: 'pothole', sourceFingerprint: 'one' });
  assert.equal(same.status, 'approved');
  const changed = await Service.createCandidate({ ...input, summary: 'New guidance.' }, 'revision-two', { sourceKey: 'pothole', sourceFingerprint: 'two' });
  assert.equal(changed.id, 'pothole'); assert.equal(changed.status, 'candidate'); assert.equal(changed.version, 3);
  assert.equal([...state.rows.keys()].filter(path => path.split('/').length === 2).length, 1);
});

test('review refuses content that changes during the operation', async t => {
  const state = memory({ 'recommendableActions/pothole': stored }); const db = getPublicImprovementsDb();
  t.mock.method(db, 'collection', state.db.collection); t.mock.method(db, 'runTransaction', state.db.runTransaction);
  state.beforeTransaction(() => state.rows.set('recommendableActions/pothole', { ...stored, summary: 'A concurrent edit.' }));
  await assert.rejects(Service.reviewCandidate('pothole', 'approve'), /changed during review/);
  assert.equal(state.rows.get('recommendableActions/pothole').status, 'candidate');
});

test('migration planning retains all data, uses source keys, and rejects conflicting target records', () => {
  const source = { path: 'recommendableActionCandidates/revision-one', data: stored };
  assert.deepEqual(planActionMigration([source], [])[0], { ...source, targetPath: 'recommendableActions/pothole' });
  assert.throws(() => planActionMigration([source], [{ path: 'recommendableActions/pothole', data: { ...stored, status: 'approved' } }]), /Conflicting/);
  assert.equal(planActionMigration([source], [{ path: 'recommendableActions/pothole', data: stored }]).length, 1);
  assert.throws(() => planActionMigration([{ ...source, path: 'unrelated/id' }], []), /Unexpected legacy/);
});

test('migration previews without writes, backs up data, moves atomically and reruns cleanly', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'recommendables-migration-'));
  try {
    const state = memory({ 'recommendableActionCandidates/revision-one': stored });
    const preview = await migrateActions(state.db, false, join(folder, 'preview.json'));
    assert.equal(preview.planned, 1); assert.equal(preview.migrated, 0); assert.equal(state.rows.size, 1);
    const backup = join(folder, 'backup.json');
    const result = await migrateActions(state.db, true, backup);
    assert.equal(result.migrated, 1); assert.equal(result.remainingLegacy, 0); assert.ok(result.verification.every(row => row.verified));
    assert.deepEqual(state.rows.get('recommendableActions/pothole'), stored);
    assert.deepEqual(JSON.parse(await readFile(backup, 'utf8')).moves[0].data, stored);
    assert.equal((await migrateActions(state.db, true, join(folder, 'again.json'))).migrated, 0);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('migration stops before deleting anything if source data changes after preflight', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'recommendables-migration-'));
  try {
    const state = memory({ 'recommendableActionCandidates/revision-one': stored });
    state.beforeTransaction(() => state.rows.set('recommendableActionCandidates/revision-one', { ...stored, summary: 'New data.' }));
    await assert.rejects(migrateActions(state.db, true, join(folder, 'backup.json')), /Source changed/);
    assert.equal(state.rows.has('recommendableActionCandidates/revision-one'), true);
    assert.equal(state.rows.has('recommendableActions/pothole'), false);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
