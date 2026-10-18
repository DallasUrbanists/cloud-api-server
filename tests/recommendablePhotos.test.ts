import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateRecommendableInput, validateRecommendablePhotos } from '../src/models/recommendableAction.js';
import { captured311Photos } from '../src/scripts/dallas311Photos.js';
import { backfillPhotos, planPhotoBackfill } from '../src/scripts/backfillRecommendablePhotos.js';
import { getPublicImprovementsDb } from '../src/config/firestore.js';
import { RecommendableActionService } from '../src/services/recommendableActionService.js';
import { RecommendableActionController } from '../src/controllers/recommendableActionController.js';
import { buildManifest, readSeedSources, validateManifest, type SeedSources } from '../src/scripts/dallas311Manifest.js';
import { swaggerDocument } from '../src/docs/swagger.js';

const image = 'https://images.example.org/pothole.JPG';
const extra = 'https://images.example.org/alley.png';
const base = { summary: 'Report pothole', instructions: 'Call 311', why: 'Hazardous pothole', whyNot: 'Unrelated concerns', boundaries: [285], sourceUrl: 'https://dallascrm.my.site.com/public/s/', sourceEvidence: 'Call 311', sourceDescription: 'Captured 311', confidence: null };
const record = { ...base, sourceType: 'dallas311', sourceKey: 'dallas311:inventory:pothole', status: 'approved', version: 3, createdAt: '2026-10-18T00:00:00.000Z', updatedAt: '2026-10-18T00:01:00.000Z', fingerprint: 'preserved' };
const sources: SeedSources = { records: {
  'pothole.json': { title: 'Pothole', sourcePortalUrl: base.sourceUrl, photoUrls: [image] },
  'alley.json': { title: 'Alley', sourcePortalUrl: base.sourceUrl, photoUrls: [image, extra] },
  'empty.json': { title: 'No images', sourcePortalUrl: base.sourceUrl, photoUrls: [] },
}, mapping: { schemaVersion: 1, groups: [{ key: 'pothole', decision: 'Equivalent source actions', primaryMemberId: 'p', members: [{ id: 'p', file: 'pothole.json', actionHash: '', evidence: [] }, { id: 'a', file: 'alley.json', actionHash: '', evidence: [] }] }] }, questions: '' };

test('photos default to an empty array and validate, normalize and deduplicate supplied URLs', () => {
  assert.deepEqual(validateRecommendableInput(base).data?.photos, []);
  assert.deepEqual(validateRecommendableInput({ ...base, photos: [] }).data?.photos, []);
  assert.deepEqual(validateRecommendableInput({ ...base, photos: [` ${image} `, image] }).data?.photos, [image]);
  assert.deepEqual(validateRecommendablePhotos(['http://images.example.org/photo.jpg']).photos, ['http://images.example.org/photo.jpg']);
  for (const photos of [null, 'image.jpg', {}, [null], [1], [''], ['relative.jpg'], ['data:image/png;base64,x'], ['javascript:alert(1)'], ['https://user:password@example.org/photo.jpg']]) {
    assert.ok(validateRecommendableInput({ ...base, photos }).error, JSON.stringify(photos));
  }
});

test('captured photos are the deduplicated union of source records; absent captures stay empty', () => {
  assert.deepEqual(captured311Photos(['pothole.json', 'alley.json', 'pothole.json'], sources.records), [image, extra]);
  assert.deepEqual(captured311Photos(['empty.json'], sources.records), []);
  assert.deepEqual(captured311Photos([], sources.records), []);
  assert.throws(() => captured311Photos(['missing.json'], sources.records), /Missing saved/);
  assert.throws(() => captured311Photos(['bad.json'], { 'bad.json': { photoUrls: ['not a URL'] } }), /photos/);
});

test('generated 311 manifests carry captured photos and reject invented photo URLs', async () => {
  const saved = await readSeedSources(); const manifest = buildManifest(saved);
  validateManifest(manifest, saved);
  for (const entry of manifest.entries) {
    assert.deepEqual(entry.input.photos, captured311Photos(entry.members.map(member => member.file), saved.records));
  }
  manifest.entries[0].input.photos = ['https://example.org/invented.jpg'];
  assert.throws(() => validateManifest(manifest, saved), /Photos differ/);
});

test('API reads expose stored photos and default legacy records to []', async t => {
  let current: any = { ...record, photos: [image] };
  t.mock.method(getPublicImprovementsDb(), 'collection', (name: string) => {
    assert.equal(name, 'recommendableActions');
    return { doc: () => ({ get: async () => ({ exists: true, data: () => current }) }) } as any;
  });
  assert.deepEqual((await RecommendableActionService.getApproved('pothole'))?.photos, [image]);
  current = record;
  assert.deepEqual((await RecommendableActionService.getApproved('pothole'))?.photos, []);
});

test('submission rejects invalid photos before extracting or persisting content', async t => {
  const extract = t.mock.method(RecommendableActionService, 'extractCandidate', async () => { throw new Error('Must not extract'); });
  let code = 0; let response: any;
  const res = { status: (value: number) => { code = value; return res; }, json: (body: any) => { response = body; } };
  await RecommendableActionController.submit({ body: { sourceUrl: base.sourceUrl, description: 'Source', photos: ['invalid'] } } as any, res as any, () => {});
  assert.equal(code, 400); assert.match(response.message, /photos/); assert.equal(extract.mock.callCount(), 0);
});

test('backfill preserves attached images, rejects unmapped imports and ignores non-review statuses', () => {
  const plans = planPhotoBackfill([{ id: 'pothole', data: { ...record, photos: ['https://example.org/attached.jpg'] } }, { id: 'closed', data: { ...record, status: 'closed' } }], sources);
  assert.deepEqual(plans[0].photos, ['https://example.org/attached.jpg', image, extra]); assert.equal(plans.length, 1);
  assert.throws(() => planPhotoBackfill([{ id: 'unknown', data: { ...record, sourceKey: 'missing' } }], sources), /Unknown imported/);
  assert.deepEqual(planPhotoBackfill([{ id: 'plain', data: { status: 'candidate' } }], sources)[0].photos, []);
});

function memory(data = record) {
  const rows = new Map<string, any>([['recommendableActions/pothole', structuredClone(data)], ['recommendableActions/pothole/versions/3', { immutable: true }]]);
  const snapshot = (path: string): any => ({ id: path.split('/').at(-1), exists: rows.has(path), data: () => structuredClone(rows.get(path)) });
  const ref = (path: string): any => ({ path, collection: (name: string) => collection(`${path}/${name}`) });
  const collection = (path: string): any => ({ doc: (id: string) => ref(`${path}/${id}`), get: async () => ({ docs: [...rows.keys()].filter(key => key.split('/').length === 2).map(snapshot) }) });
  let hook: (() => void) | undefined;
  const db: any = { databaseId: 'test', collection, runTransaction: async (fn: any) => {
    hook?.(); const writes: (() => void)[] = [];
    await fn({ get: async (r: any) => snapshot(r.path), set: (r: any, value: any) => writes.push(() => { rows.set(r.path, structuredClone(value)); }),
      update: (r: any, value: any) => writes.push(() => { rows.set(r.path, { ...rows.get(r.path), ...value }); }) });
    writes.forEach(write => write());
  } };
  return { db, rows, beforeTransaction: (fn: () => void) => { hook = fn; } };
}

test('backfill previews, backs up, preserves approval/text/history, increments versions and reruns without changes', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'recommendable-photos-'));
  try {
    const state = memory();
    const preview = await backfillPhotos(state.db, sources, false, join(folder, 'preview.json'));
    assert.equal(preview.updated, 0); assert.equal(preview.plannedUpdates, 1);
    assert.deepEqual(state.rows.get('recommendableActions/pothole'), record);
    const reportPath = join(folder, 'apply.json');
    const result = await backfillPhotos(state.db, sources, true, reportPath);
    assert.equal(result.updated, 1); assert.equal(result.failed.length, 0);
    const after = state.rows.get('recommendableActions/pothole');
    assert.equal(after.status, 'approved'); assert.equal(after.version, 4); assert.equal(after.fingerprint, record.fingerprint);
    assert.deepEqual(after.photos, [image, extra]);
    const { photos: _photos, version: _version, updatedAt: _updatedAt, ...content } = after;
    const { version: _beforeVersion, updatedAt: _beforeTime, ...beforeContent } = record;
    assert.deepEqual(content, beforeContent);
    assert.deepEqual(state.rows.get('recommendableActions/pothole/versions/3'), { immutable: true });
    assert.equal(state.rows.get('recommendableActions/pothole/versions/4').status, 'approved');
    assert.deepEqual(JSON.parse(await readFile(reportPath, 'utf8')).plans[0].data, record);
    const again = await backfillPhotos(state.db, sources, true, join(folder, 'again.json'));
    assert.equal(again.updated, 0); assert.equal(again.retained, 1); assert.equal(state.rows.get('recommendableActions/pothole').version, 4);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('backfill does not overwrite concurrent content changes', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'recommendable-photos-'));
  try {
    const state = memory();
    state.beforeTransaction(() => state.rows.set('recommendableActions/pothole', { ...record, instructions: 'A newer edit' }));
    const result = await backfillPhotos(state.db, sources, true, join(folder, 'apply.json'));
    assert.equal(result.failed.length, 1); assert.equal(result.updated, 0);
    assert.equal(state.rows.get('recommendableActions/pothole').instructions, 'A newer edit');
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('OpenAPI exposes an array of URI strings and documents optional submission photos', () => {
  const doc = swaggerDocument as any;
  assert.ok(doc.components.schemas.RecommendableAction.required.includes('photos'));
  assert.equal(doc.components.schemas.RecommendableAction.properties.photos.type, 'array');
  assert.equal(doc.components.schemas.RecommendableAction.properties.photos.items.format, 'uri');
  assert.deepEqual(doc.paths['/api/recommendables/candidates'].post.requestBody.content['application/json'].schema.properties.photos.default, []);
});
