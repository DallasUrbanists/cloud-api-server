import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { deploymentConfig, firestoreDatabase, STAGING } from '../src/config/deployment.js';
import { fixturePlan, runFixtures } from '../src/scripts/stagingFixtures.js';
import { stagingEnv } from './helpers/stagingEnvironment.js';
import { deploymentArgs, assertHealth, validateManifest } from '../scripts/deploy-staging.mjs';
import { getFirestoreDb } from '../src/config/firestore.js';
import { getStorage, getIdeaPhotosBucketName } from '../src/config/storage.js';
import { getAuthorizedOrigins, isOriginAllowed, corsOptions } from '../src/middleware/cors.js';
import { readFileSync } from 'node:fs';
import { IdeaService } from '../src/services/ideaService.js';
import { IdeaNoticeService } from '../src/services/ideaNoticeService.js';
import { FirestoreStreetmixCache } from '../src/services/streetmixCache.js';
import { FirestoreStreetmixStore } from '../src/services/streetmixStore.js';
import { FirestorePresentationStore } from '../src/services/presentationStore.js';
import { AssistService } from '../src/services/assistService.js';
import { StorageService } from '../src/services/storageService.js';

const original = { ...process.env };
afterEach(() => { process.env = { ...original }; mock.restoreAll(); });

test('staging rejects every missing, blank, or incorrect required identifier without echoing values', () => {
  assert.equal(deploymentConfig(stagingEnv).staging, true);
  for (const key of Object.keys(stagingEnv)) {
    if (key === 'DEPLOY_ENV') continue; // reserved K_SERVICE covers omission below
    for (const value of key === 'DB_PASSWORD' ? [undefined, '', ' '] : [undefined, '', ' ', 'private-invalid-value']) {
      assert.throws(() => deploymentConfig({ ...stagingEnv, [key]: value }), error => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes('private-invalid-value'));
        return true;
      }, `${key}=${String(value)}`);
    }
  }
  for (const key of ['PUBLIC_IMPROVEMENTS_DB', 'ASSIST_QUOTA_DB']) assert.throws(() => deploymentConfig({ ...stagingEnv, [key]: 'public-improvements' }));
  assert.throws(() => deploymentConfig({ ...stagingEnv, IDEA_PHOTOS_BUCKET: 'urbanists-idea-photos' }));
  for (const key of ['DB_USER', 'DB_NAME']) assert.throws(() => deploymentConfig({ ...stagingEnv, [key]: 'postgres' }));
});

test('reserved service cannot bypass validation, and staging cannot run in the production service', () => {
  for (const DEPLOY_ENV of [undefined, '', 'production', 'Staging']) assert.throws(() => deploymentConfig({ ...stagingEnv, K_SERVICE: STAGING.service, DEPLOY_ENV }));
  assert.throws(() => deploymentConfig({ ...stagingEnv, K_SERVICE: 'urbanists-cloud-api-server' }));
  for (const key of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'GOOGLE_APPLICATION_CREDENTIALS']) {
    assert.throws(() => deploymentConfig({ ...stagingEnv, K_SERVICE: STAGING.service, [key]: 'override' }));
  }
});

test('non-staging defaults remain compatible with optional build metadata', () => {
  assert.deepEqual(deploymentConfig({}), { staging: false, ideasLayout: 'ideas', environment: 'unknown', database: 'public-improvements', bucket: 'urbanists-idea-photos', buildCommit: null });
  assert.equal(deploymentConfig({ IDEAS_DATA_LAYOUT: 'legacy' }).bucket, 'urbanists-suggestion-photos');
  assert.equal(deploymentConfig({ IDEAS_DATA_LAYOUT: 'ideas' }).bucket, 'urbanists-idea-photos');
  assert.throws(() => deploymentConfig({ NODE_ENV: 'production' }), /IDEAS_DATA_LAYOUT is required/);
  assert.equal(deploymentConfig({ NODE_ENV: 'production', IDEAS_DATA_LAYOUT: 'ideas' }).environment, 'production');
  assert.throws(() => deploymentConfig({ IDEAS_DATA_LAYOUT: 'ideas', IDEA_PHOTOS_BUCKET: 'new', SUGGESTION_PHOTOS_BUCKET: 'old' }), /conflicts/);
  assert.equal(firestoreDatabase('custom-db', {}), 'custom-db');
});

test('staging permits only the deprecated bucket variable as a non-conflicting bridge fallback', () => {
  const { IDEA_PHOTOS_BUCKET: _ignored, ...legacyFallback } = stagingEnv;
  assert.equal(deploymentConfig({ ...legacyFallback, SUGGESTION_PHOTOS_BUCKET: STAGING.bucket }).bucket, STAGING.bucket);
  assert.throws(() => deploymentConfig({ ...legacyFallback, SUGGESTION_PHOTOS_BUCKET: 'urbanists-idea-photos-staging-143738155808' }), /Unsafe staging configuration/);
});

test('auxiliary Firestore overrides cannot escape staging, including cached clients', async () => {
  process.env = { ...stagingEnv };
  const primary = getFirestoreDb(); // constructs only; no RPC or ADC lookup
  assert.equal(primary.databaseId, STAGING.database);
  assert.equal(primary.projectId, STAGING.project);
  assert.equal(getFirestoreDb(process.env.ASSIST_QUOTA_DB), primary);
  const collections: string[] = [];
  const reference = (path: string) => ({ path, get: async () => ({ exists: false }), data: () => undefined });
  mock.method(primary, 'collection', ((name: string) => {
    assert.equal(primary.databaseId, STAGING.database);
    collections.push(name);
    return { doc: (id: string) => reference(`${name}/${id}`), onSnapshot: (next: (value: unknown) => void) => { next({ docChanges: () => [] }); return () => {}; } };
  }) as never);
  mock.method(primary, 'doc', reference as never);
  mock.method(primary, 'runTransaction', (async (operation: (transaction: unknown) => Promise<unknown>) => operation({
    get: async () => ({ data: () => undefined }), getAll: async (...refs: unknown[]) => refs.map(() => ({ data: () => undefined })),
    set() {}, update() {},
  })) as never);
  assert.equal(await IdeaService.getForPresentation(1), null);
  const notices = new IdeaNoticeService();
  const unsubscribe = notices.subscribe({ ready() {}, notice() {}, failed() { assert.fail('Unexpected listener failure'); } });
  unsubscribe();
  await new FirestoreStreetmixCache().claim('fixture', new AbortController().signal);
  await new FirestoreStreetmixStore().reserve('fixture', 'fingerprint', 'app', new AbortController().signal);
  await AssistService.consumeQuota('test-key');
  assert.equal(await new FirestorePresentationStore(primary).get('presentationSessions/fixture'), undefined);
  for (const collection of ['suggestion', 'streetmix-location-cache', 'streetmix-requests', 'streetmix-quotas', 'assist-grammar-quotas']) assert.ok(collections.includes(collection));
  const storage = getStorage();
  mock.method(storage, 'bucket', ((bucket: string) => {
    assert.equal(bucket, STAGING.bucket);
    return { file: () => ({ getSignedUrl: async () => ['https://example.invalid/signed-upload'] }) };
  }) as never);
  const upload = await StorageService.generateUploadUrl({ contentType: 'image/jpeg' });
  assert.ok(upload.publicUrl.startsWith(`https://storage.googleapis.com/${STAGING.bucket}/`));
  for (const db of ['public-improvements', '(default)', 'another-db']) {
    assert.throws(() => getFirestoreDb(db));
    assert.throws(() => firestoreDatabase(db, stagingEnv));
  }
  assert.equal(getIdeaPhotosBucketName(), STAGING.bucket);
  delete process.env.DB_NAME;
  assert.throws(() => getFirestoreDb());
  assert.throws(() => getStorage());
  await primary.terminate();
});

test('staging CORS and both socket paths share exclusive canonical origins and existing headers', () => {
  process.env = { ...stagingEnv };
  assert.deepEqual(getAuthorizedOrigins(), [STAGING.origin]);
  assert.equal(isOriginAllowed(STAGING.origin), true);
  assert.equal(isOriginAllowed(undefined), true);
  for (const origin of ['https://map.dallasurbanists.org', 'http://localhost:5173', 'https://other.web.app', 'https://map-staging-143738155808.web.app.evil.test']) assert.equal(isOriginAllowed(origin), false);
  assert.deepEqual(corsOptions.exposedHeaders, ['ETag', 'Retry-After']);
  assert.ok((corsOptions.allowedHeaders as string[]).includes('X-Firebase-AppCheck'));
  const sockets = readFileSync(new URL('../src/ideaWebSocket.ts', import.meta.url), 'utf8');
  assert.match(sockets, /isOriginAllowed\(req.headers.origin\)/);
  assert.ok(sockets.indexOf('isOriginAllowed(req.headers.origin)') < sockets.indexOf('presentation.handleUpgrade'));
  process.env = {};
  assert.equal(isOriginAllowed('http://localhost:5173'), true);
  assert.equal(isOriginAllowed('https://map.dallasurbanists.org'), true);
});

test('fixture tools are staging-only, default report makes no network calls, and reset is targeted', async () => {
  assert.throws(() => fixturePlan('seed', {}));
  assert.throws(() => fixturePlan('reset', { ...stagingEnv, DB_NAME: 'postgres' }));
  assert.throws(() => fixturePlan('wipe', stagingEnv));
  process.env = { ...stagingEnv };
  assert.equal(fixturePlan('reset').fixtures.sqlId, -910000001);
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Unexpected network'); };
  try { await runFixtures(['seed']); await runFixtures(['reset']); } finally { globalThis.fetch = priorFetch; }
});

test('deployment plan fixes target and identities, requires reviewed sizing, and checks candidate metadata', () => {
  const env = { STAGING_IDEAS_DATA_LAYOUT: 'legacy', STAGING_CPU: '1', STAGING_MEMORY: '512Mi', STAGING_CONCURRENCY: '80', STAGING_MIN_INSTANCES: '0', STAGING_MAX_INSTANCES: '2', STAGING_INGRESS: 'all', STAGING_CPU_THROTTLING: 'true' };
  const args = deploymentArgs(stagingEnv.BUILD_COMMIT, env);
  assert.equal(args[2], STAGING.service);
  assert.ok(args.includes('--no-traffic'));
  const bootstrap = deploymentArgs(stagingEnv.BUILD_COMMIT, env, false);
  assert.equal(bootstrap[2], STAGING.service);
  assert.ok(!bootstrap.includes('--no-traffic'));
  assert.ok(args.includes('API_KEYS_JSON=improvement-map-staging-api-keys:latest,DB_PASSWORD=urbanists-staging-db-password:latest'));
  assert.ok(!args.join(' ').includes('contacts-db-password'));
  assert.ok(args.join(' ').includes('IDEAS_DATA_LAYOUT=legacy,IDEA_PHOTOS_BUCKET=urbanists-suggestion-photos-staging-143738155808'));
  const ideas = deploymentArgs(stagingEnv.BUILD_COMMIT, { ...env, STAGING_IDEAS_DATA_LAYOUT: 'ideas' });
  assert.ok(ideas.join(' ').includes('IDEAS_DATA_LAYOUT=ideas,IDEA_PHOTOS_BUCKET=urbanists-idea-photos-staging-143738155808'));
  assert.throws(() => deploymentArgs(stagingEnv.BUILD_COMMIT, { ...env, STAGING_IDEAS_DATA_LAYOUT: '' }));
  for (const key of Object.keys(env)) assert.throws(() => deploymentArgs(stagingEnv.BUILD_COMMIT, { ...env, [key]: '' }));
  assert.throws(() => deploymentArgs('main', env));
  const health = { status: 'ok', service: 'urbanists-cloud-api-server', environment: 'staging', buildCommit: stagingEnv.BUILD_COMMIT, revision: 'revision', databases: [STAGING.database] };
  assert.doesNotThrow(() => assertHealth(health, stagingEnv.BUILD_COMMIT, 'revision'));
  for (const key of Object.keys(health)) assert.throws(() => assertHealth({ ...health, [key]: 'incorrect' }, stagingEnv.BUILD_COMMIT, 'revision'));
  assert.doesNotThrow(() => validateManifest(['src/index.ts', 'package.json'], ['src/index.ts', 'package.json']));
  for (const path of ['.env', 'gha-creds-test.json', 'src/.env', 'src/gha-creds-test.json', 'src/credential.key', 'data/private.json']) {
    assert.throws(() => validateManifest([path], [path]));
  }
  assert.throws(() => validateManifest(['src/ignored-untracked.ts'], []));
});

test('staging workflow forwards the reviewed Ideas data layout to its deploy helper', () => {
  const workflow = readFileSync(new URL('../.github/workflows/deploy-staging.yml', import.meta.url), 'utf8');
  assert.match(workflow, /STAGING_IDEAS_DATA_LAYOUT:\s*\$\{\{\s*vars\.STAGING_IDEAS_DATA_LAYOUT\s*\}\}/);
});
