import { before, after, afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';
import { getAppCheck } from 'firebase-admin/app-check';
import { firebaseApp } from '../src/config/firebase.js';
import { createApp } from '../src/app.js';
import { createUserRoutes } from '../src/routes/userRoutes.js';
import { StaffClaimService } from '../src/services/staffClaimService.js';
import { migrateStaffClaims } from '../src/services/staffClaimMigration.js';
import { stagingEnv } from './helpers/stagingEnvironment.js';
import { STAGING } from '../src/config/deployment.js';
import { attachSuggestionWebSocket } from '../src/suggestionWebSocket.js';
import { PresentationWebSocketServer } from '../src/presentationWebSocket.js';
import WebSocket from 'ws';

let server: Server;
let base: string;
let closeSockets: () => Promise<void>;
let calls = 0;
const original = { ...process.env };

before(async () => {
  const auth = getAuth(firebaseApp());
  mock.method(auth, 'verifyIdToken', async (token: string) => {
    if (token !== 'staff') throw new Error('Invalid test token');
    return { uid: 'actor', staff: true } as unknown as DecodedIdToken;
  });
  mock.method(getAppCheck(firebaseApp()), 'verifyToken', async (token: string) => {
    if (token !== 'app-check') throw new Error('Invalid test attestation');
    return { appId: 'test' };
  });
  const service = new StaffClaimService();
  mock.method(service, 'setStaff', async () => { calls++; });
  const app = express();
  app.use('/api/users', createUserRoutes(service));
  app.use(createApp());
  server = app.listen(0, '127.0.0.1');
  // Rejected origins must never reach either store or socket authentication.
  const presentation = { handleUpgrade() { throw new Error('Unexpected presentation upgrade'); }, close: async () => {} } as unknown as PresentationWebSocketServer;
  closeSockets = attachSuggestionWebSocket(server, { presentation });
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(() => { process.env = { ...original }; calls = 0; });
after(async () => { await closeSockets(); await new Promise<void>(resolve => server.close(() => resolve())); mock.restoreAll(); });

test('staging staff PUT/DELETE retain authentication and App Check but never invoke the mutation service', async () => {
  process.env = { ...stagingEnv };
  for (const method of ['PUT', 'DELETE']) {
    const headers = { 'X-API-Key': 'test-only-key', Authorization: 'Bearer staff', 'X-Firebase-AppCheck': 'app-check' };
    const response = await fetch(`${base}/api/users/target/claims/staff`, { method, headers });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'Forbidden', message: 'Shared user administration is disabled in staging.' });
    for (const omitted of Object.keys(headers)) {
      const incomplete = { ...headers }; delete incomplete[omitted as keyof typeof incomplete];
      assert.equal((await fetch(`${base}/api/users/target/claims/staff`, { method, headers: incomplete })).status, 401);
    }
  }
  assert.equal(calls, 0);
});

test('direct service and apply migration refuse staging before accessing shared Auth', async () => {
  process.env = { ...stagingEnv };
  const service = new StaffClaimService(() => { throw new Error('Auth must not be touched'); });
  for (const staff of [true, false]) await assert.rejects(service.setStaff('target', staff), /disabled in staging/);
  await assert.rejects(migrateStaffClaims({} as never, { projectId: STAGING.project, apply: true }), /disabled in staging/);
});

test('health reports actual configured database, deployment commit and optional revision without secrets', async () => {
  process.env = { ...stagingEnv, K_SERVICE: STAGING.service, K_REVISION: 'staging-revision' };
  const response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'ok'); assert.ok(body.timestamp);
  assert.equal(body.environment, 'staging'); assert.equal(body.buildCommit, stagingEnv.BUILD_COMMIT);
  assert.equal(body.revision, 'staging-revision'); assert.deepEqual(body.databases, [STAGING.database]);
  assert.ok(!JSON.stringify(body).includes('test-only'));
  process.env = {};
  const compatible = await (await fetch(`${base}/api/health`)).json();
  assert.equal(compatible.buildCommit, null); assert.equal(compatible.revision, undefined);
  assert.deepEqual(compatible.databases, ['public-improvements']);
});

test('staging browser preflight preserves request and exposed response headers', async () => {
  process.env = { ...stagingEnv };
  const response = await fetch(`${base}/api/health`, { method: 'OPTIONS', headers: {
    Origin: STAGING.origin, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'X-Firebase-AppCheck,If-Match',
  } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), STAGING.origin);
  assert.match(response.headers.get('access-control-allow-headers')!, /If-Match/);
  const health = await fetch(`${base}/api/health`, { headers: { Origin: STAGING.origin } });
  assert.equal(health.headers.get('access-control-expose-headers'), 'ETag,Retry-After');
  assert.equal((await fetch(`${base}/api/health`, { headers: { Origin: 'https://map.dallasurbanists.org' } })).status, 403);
});

test('suggestion and presentation socket upgrades reject production and local origins before handlers', async () => {
  process.env = { ...stagingEnv };
  for (const path of ['/api/suggestions/ws', '/api/public-improvements/suggestions/ws', '/api/public-improvements/presentation/ws']) {
    for (const origin of ['https://map.dallasurbanists.org', 'http://localhost:5173']) {
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(`${base.replace('http:', 'ws:')}${path}`, { origin });
        socket.on('unexpected-response', (_req, response) => { try { assert.equal(response.statusCode, 403); response.resume(); resolve(); } catch (error) { reject(error); } });
        socket.on('open', () => { socket.close(); reject(new Error('Unexpected accepted socket')); });
        socket.on('error', reject);
      });
    }
  }
});
