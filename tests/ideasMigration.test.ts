import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Timestamp } from '@google-cloud/firestore';
import { argsFrom, dataEqual, presentationSnapshotRewrite, remapMediaUrl, rewriteMediaFields, targets } from '../src/scripts/migrateIdeas.js';
import { canonicalizeIdeaPhotoUrl } from '../src/services/ideaMediaService.js';

const staging = targets('staging');
const objectMap = new Map([['suggestions/uploads/photo one.jpg', 'ideas/uploads/photo one.jpg']]);
const oldUrl = `https://storage.googleapis.com/${staging.sourceBucket}/suggestions/uploads/photo%20one.jpg?shared=1`;
const newUrl = `https://storage.googleapis.com/${staging.destinationBucket}/ideas/uploads/photo%20one.jpg?shared=1`;

test('migration requires an explicit environment and a maintenance acknowledgement for writes', () => {
  assert.throws(() => argsFrom([]), /--environment/);
  assert.deepEqual(argsFrom(['--environment=staging']), { environment: 'staging', apply: false, maintenanceConfirmed: false });
  assert.throws(() => argsFrom(['--environment=production', '--apply']), /--maintenance-confirmed/);
  assert.equal(argsFrom(['--environment=staging', '--apply', '--maintenance-confirmed']).apply, true);
  assert.deepEqual(targets('production'), {
    project: 'urbanists-mixer-slides-helper', database: 'public-improvements',
    sourceBucket: 'urbanists-suggestion-photos', destinationBucket: 'urbanists-idea-photos',
  });
});

test('only owned media URLs in media-named fields are remapped; authored text remains untouched', () => {
  assert.equal(remapMediaUrl(oldUrl, objectMap, staging.sourceBucket, staging.destinationBucket), newUrl);
  const original = { content: { summary: `We discussed this URL: ${oldUrl}`, photos: [{ url: oldUrl, caption: 'Keep this prose unchanged.' }] } };
  const rewritten = rewriteMediaFields(original, objectMap, staging.sourceBucket, staging.destinationBucket);
  assert.equal(rewritten.changes, 1);
  assert.equal(rewritten.value.content.summary, original.content.summary);
  assert.equal(rewritten.value.content.photos[0].url, newUrl);
  assert.equal(original.content.photos[0].url, oldUrl);
});

test('presentation photo remap preserves the selected album item and advances the session revision', () => {
  const oldSafeUrl = `https://storage.googleapis.com/${staging.sourceBucket}/suggestions/uploads/photo%20one.jpg`;
  const oldPhotoId = `photo:${createHash('sha256').update(oldSafeUrl).digest('hex').slice(0, 24)}`;
  const original = {
    state: { selectedIdeaId: '17', albumItemId: oldPhotoId, revision: 9 }, revision: 9,
    contentVersion: 'old-version', contentSnapshot: { id: '17', album: [{ id: oldPhotoId, kind: 'photo', url: oldSafeUrl, caption: 'Photo' }], contentVersion: 'old-version' },
  };
  const rewritten = rewriteMediaFields(original, objectMap, staging.sourceBucket, staging.destinationBucket).value;
  assert.equal(presentationSnapshotRewrite(original, rewritten, objectMap, staging.sourceBucket, staging.destinationBucket), true);
  assert.equal(rewritten.state.selectedIdeaId, '17');
  assert.notEqual(rewritten.state.albumItemId, oldPhotoId);
  assert.equal(rewritten.state.albumItemId, rewritten.contentSnapshot.album[0].id);
  assert.equal(rewritten.revision, 10);
  assert.equal(rewritten.contentSnapshot.contentVersion, rewritten.contentVersion);
  assert.equal(original.state.albumItemId, oldPhotoId);
});

test('document equality compares Firestore timestamps by value', () => {
  assert.equal(dataEqual({ createdAt: Timestamp.fromMillis(1234), values: [1, 'two'] }, { createdAt: Timestamp.fromMillis(1234), values: [1, 'two'] }), true);
  assert.equal(dataEqual({ createdAt: Timestamp.fromMillis(1234) }, { createdAt: Timestamp.fromMillis(1235) }), false);
});

test('new Idea writes canonicalize old media only when the verified manifest contains it', async t => {
  const prior = { IDEAS_DATA_LAYOUT: process.env.IDEAS_DATA_LAYOUT, IDEA_PHOTOS_BUCKET: process.env.IDEA_PHOTOS_BUCKET,
    SUGGESTION_PHOTOS_BUCKET: process.env.SUGGESTION_PHOTOS_BUCKET, DEPLOY_ENV: process.env.DEPLOY_ENV,
    K_SERVICE: process.env.K_SERVICE, NODE_ENV: process.env.NODE_ENV };
  t.after(() => {
    for (const [key, value] of Object.entries(prior)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  delete process.env.DEPLOY_ENV; delete process.env.K_SERVICE; process.env.NODE_ENV = 'test';
  process.env.IDEAS_DATA_LAYOUT = 'ideas'; process.env.IDEA_PHOTOS_BUCKET = 'urbanists-idea-photos'; delete process.env.SUGGESTION_PHOTOS_BUCKET;
  let path = '';
  const prodOldBucket = 'urbanists-suggestion-photos';
  const prodOldUrl = `https://storage.googleapis.com/${prodOldBucket}/suggestions/uploads/photo%20one.jpg?shared=1`;
  const db = { doc(value: string) { path = value; return { get: async () => ({ data: () => ({
    sourceBucket: prodOldBucket, sourceObject: 'suggestions/uploads/photo one.jpg', destinationBucket: 'urbanists-idea-photos',
    destinationUrl: `https://storage.googleapis.com/urbanists-idea-photos/ideas/uploads/photo%20one.jpg`,
  }) }) }; } } as any;
  const canonical = await canonicalizeIdeaPhotoUrl(prodOldUrl, db);
  assert.equal(path, `_metadata/ideaMediaManifest/records/${createHash('sha256').update(`${prodOldBucket}/suggestions/uploads/photo one.jpg`).digest('hex')}`);
  assert.equal(canonical, `https://storage.googleapis.com/urbanists-idea-photos/ideas/uploads/photo%20one.jpg?shared=1`);
});
