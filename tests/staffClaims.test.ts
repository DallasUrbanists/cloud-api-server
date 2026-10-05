import { test, before, beforeEach, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { Request, Response } from 'express';
import { getAuth, type DecodedIdToken, type UserRecord } from 'firebase-admin/auth';
import { getAppCheck } from 'firebase-admin/app-check';
import { firebaseApp } from '../src/config/firebase.js';
import { createApp } from '../src/app.js';
import { userAuth } from '../src/middleware/auth.js';
import { withStaffClaim } from '../src/models/staffClaims.js';
import { swaggerDocument } from '../src/docs/swagger.js';
import { StaffClaimController } from '../src/controllers/staffClaimController.js';

let server: Server;
let base: string;
const users = new Map<string, Record<string, unknown>>();
const writes: Array<{ uid: string; claims: Record<string, unknown> }> = [];
const revocations: string[] = [];
const verified: Array<{ token: string; revoked: boolean | undefined }> = [];
const audits: Array<Record<string, unknown>> = [];
const authWarnings: string[] = [];
let fail: 'get' | 'set' | 'revoke' | undefined;
const originalEnv = { apiKeys: process.env.API_KEYS_JSON, nodeEnv: process.env.NODE_ENV };
const tokens: Record<string, Record<string, unknown>> = {
  staff: { uid: 'actor', staff: true },
  system: { uid: 'system-actor', system: true, roles: ['system'] },
  ordinary: { uid: 'ordinary' },
  'legacy-role': { uid: 'legacy', role: 'staff' },
  'legacy-roles': { uid: 'legacy', roles: ['staff', 'member'] },
  'legacy-string': { uid: 'legacy', roles: 'staff' },
  'false-staff': { uid: 'legacy', staff: 'true', role: 'staff' },
  'all-roles': { uid: 'actor', staff: true, roles: ['staff', 'member', 'system'], role: 'editor', system: true },
};
function internalError() { return Object.assign(new Error('SECRET INTERNAL DETAILS'), { code: 'auth/internal-error' }); }

before(async () => {
  const app = firebaseApp();
  const auth = getAuth(app);
  mock.method(auth, 'verifyIdToken', async (token: string, revoked?: boolean) => {
    verified.push({ token, revoked });
    if (!tokens[token]) throw Object.assign(new Error('SECRET TOKEN'), { code: 'auth/id-token-revoked' });
    return tokens[token] as DecodedIdToken;
  });
  mock.method(auth, 'getUser', async (uid: string) => {
    if (fail === 'get') throw internalError();
    if (!users.has(uid)) throw Object.assign(new Error('SECRET EMAIL'), { code: 'auth/user-not-found' });
    return { uid, customClaims: users.get(uid) } as UserRecord;
  });
  mock.method(auth, 'setCustomUserClaims', async (uid: string, claims: Record<string, unknown>) => {
    if (fail === 'set') throw internalError();
    writes.push({ uid, claims }); users.set(uid, claims);
  });
  mock.method(auth, 'revokeRefreshTokens', async (uid: string) => {
    revocations.push(uid);
    if (fail === 'revoke') throw internalError();
  });
  mock.method(getAppCheck(app), 'verifyToken', async (token: string) => {
    if (token !== 'app-check') throw new Error('SECRET APP CHECK');
    return { appId: 'test' };
  });
  mock.method(console, 'info', (message: string) => {
    if (message.startsWith('{')) audits.push(JSON.parse(message));
  });
  mock.method(console, 'warn', (message: string) => { authWarnings.push(message); });
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
beforeEach(() => {
  process.env.API_KEYS_JSON = JSON.stringify([{ key: 'test-key', name: 'test' }]);
  process.env.NODE_ENV = 'test';
  users.clear(); users.set('target-not-a-uuid', {}); users.set('actor', { staff: true });
  writes.length = revocations.length = verified.length = audits.length = authWarnings.length = 0;
  fail = undefined;
});
after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  mock.restoreAll();
  for (const [key, value] of [['API_KEYS_JSON', originalEnv.apiKeys], ['NODE_ENV', originalEnv.nodeEnv]]) {
    if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
  }
});

async function request(method = 'PUT', uid = 'target-not-a-uuid', token: string | null = 'staff', key: string | null = 'test-key', appCheck?: string) {
  const headers: Record<string, string> = {};
  if (key !== null) headers['X-API-Key'] = key;
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  if (appCheck) headers['X-Firebase-AppCheck'] = appCheck;
  return fetch(`${base}/api/users/${encodeURIComponent(uid)}/claims/staff`, { method, headers });
}

test('PUT uses Firebase string UID, canonicalizes legacy staff, preserves all unrelated claims and returns empty 204', async () => {
  const original = { staff: false, role: 'staff', roles: ['staff', 'member', 'system', 'staff'], system: true, nested: { tenant: 'one' } };
  users.set('target-not-a-uuid', original);
  const response = await request();
  assert.equal(response.status, 204); assert.equal(await response.text(), '');
  assert.deepEqual(writes, [{ uid: 'target-not-a-uuid', claims: { staff: true, roles: ['member', 'system'], system: true, nested: { tenant: 'one' } } }]);
  assert.equal(original.role, 'staff'); assert.deepEqual(revocations, []);
  assert.deepEqual(verified, [{ token: 'staff', revoked: true }]);
  assert.deepEqual(audits, [{ event: 'staff_claim_administration', actor: 'actor', target: 'target-not-a-uuid', action: 'assign_staff', outcome: 'success', status: 204 }]);
});

test('DELETE removes canonical and legacy staff and revokes on every deletion, including already absent', async () => {
  users.set('target-not-a-uuid', { staff: true, role: 'staff', roles: ['staff', 'member'], system: true, other: 42 });
  for (let i = 0; i < 2; i++) {
    const response = await request('DELETE');
    assert.equal(response.status, 204); assert.equal(await response.text(), '');
  }
  assert.deepEqual(users.get('target-not-a-uuid'), { roles: ['member'], system: true, other: 42 });
  assert.deepEqual(revocations, ['target-not-a-uuid', 'target-not-a-uuid']);
  assert.equal(audits[1].action, 'remove_staff');
});

test('legacy scalar and array staff normalization preserves nonstaff roles and other claim types', () => {
  for (const staff of [true, false]) {
    assert.deepEqual(withStaffClaim({ roles: 'staff', role: 'editor', extra: [1] }, staff), { role: 'editor', extra: [1], ...(staff ? { staff: true } : {}) });
    assert.deepEqual(withStaffClaim({ roles: ['staff'], role: 'system' }, staff), { roles: [], role: 'system', ...(staff ? { staff: true } : {}) });
    assert.deepEqual(withStaffClaim({ roles: 'system', staff: 'true' }, staff), { roles: 'system', ...(staff ? { staff: true } : {}) });
  }
});

test('both endpoints require valid API key and private non-revoked credentials', async () => {
  for (const method of ['PUT', 'DELETE']) {
    for (const key of [null, 'bad-key']) assert.equal((await request(method, undefined, 'staff', key)).status, 401);
    for (const token of [null, 'invalid', 'revoked', 'disabled']) assert.equal((await request(method, undefined, token)).status, 401);
  }
  assert.equal(writes.length, 0); assert.equal(revocations.length, 0);
  assert.ok(verified.every(call => call.revoked === true));
  assert.ok(audits.every(entry => entry.outcome === 'failure' && entry.actor === null));
});

test('canonical staff only: nonstaff, system-only and every legacy staff form are forbidden', async () => {
  for (const method of ['PUT', 'DELETE']) {
    for (const token of ['ordinary', 'system', 'legacy-role', 'legacy-roles', 'legacy-string', 'false-staff']) {
      assert.equal((await request(method, undefined, token)).status, 403);
    }
  }
  assert.equal(writes.length, 0); assert.equal(revocations.length, 0);
});

test('self-targeting is forbidden for both operations, including no-op assignment/deletion', async () => {
  for (const claims of [{ staff: true }, {}]) {
    users.set('actor', claims);
    for (const method of ['PUT', 'DELETE']) assert.equal((await request(method, 'actor')).status, 403);
  }
  assert.equal(writes.length, 0); assert.equal(revocations.length, 0);
});

test('UID bounds accept 1 and 128 characters without UUID validation, reject 129', async () => {
  for (const uid of ['x', 'x'.repeat(128), ' spaced uid ']) {
    users.set(uid, {}); assert.equal((await request('PUT', uid)).status, 204);
  }
  assert.equal((await request('PUT', 'x'.repeat(129))).status, 400);
  assert.equal(writes.length, 3);
});

test('controller rejects empty or non-string UIDs before Firebase access', async () => {
  const controller = new StaffClaimController();
  for (const uid of ['', undefined, ['target']]) {
    let status: number | undefined;
    const req = { params: { uid }, method: 'PUT' } as unknown as Request;
    const res = { status(code: number) { status = code; return this; }, json() {} } as unknown as Response;
    await controller.update(req, res);
    assert.equal(status, 400);
  }
  assert.equal(writes.length, 0);
});

test('unknown targets are 404 and internal get/set/revocation failures are sanitized 500', async () => {
  for (const method of ['PUT', 'DELETE']) assert.equal((await request(method, 'missing')).status, 404);
  for (const failure of ['get', 'set', 'revoke'] as const) {
    fail = failure;
    const response = await request(failure === 'revoke' ? 'DELETE' : 'PUT');
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'InternalServerError', message: 'Staff claim update failed.' });
  }
  assert.ok(!JSON.stringify(audits).includes('SECRET'));
  fail = undefined;
  assert.equal((await request('DELETE')).status, 204); // retry completes revocation
});

test('production enforces existing apiAccess App Check even for nonbrowser requests', async () => {
  process.env.NODE_ENV = 'production';
  for (const method of ['PUT', 'DELETE']) {
    assert.equal((await request(method)).status, 401);
    assert.equal((await request(method, undefined, 'staff', 'test-key', 'invalid')).status, 401);
    assert.equal((await request(method, undefined, 'staff', 'test-key', 'app-check')).status, 204);
  }
});

async function authenticate(requirement: 'public' | 'partial' | 'private', token: string, roles: string[] = []) {
  const req = { header: () => `Bearer ${token}`, user: { uid: 'stale' } } as unknown as Request;
  let status: number | undefined;
  let nextCalls = 0;
  const res = { status(code: number) { status = code; return this; }, json() {} } as unknown as Response;
  await userAuth(requirement, roles)(req, res, () => { nextCalls++; });
  return { req, status, nextCalls };
}

test('revoked/disabled/invalid tokens never attach a user; public and partial retain fallback, private rejects', async () => {
  for (const requirement of ['public', 'partial', 'private'] as const) {
    for (const token of ['revoked', 'disabled', 'invalid']) {
      const result = await authenticate(requirement, token);
      assert.equal(result.req.user, undefined);
      assert.equal(result.status, requirement === 'private' ? 401 : undefined);
      assert.equal(result.nextCalls, requirement === 'private' ? 0 : 1);
    }
  }
  assert.ok(verified.every(call => call.revoked === true));
});

test('authentication diagnostics distinguish absent credentials and Firebase rejection without logging tokens or messages', async () => {
  await authenticate('private', '');
  assert.deepEqual(JSON.parse(authWarnings[0]), {
    event: 'user_authentication_failed', requirement: 'private', reason: 'missing_or_malformed_bearer_token',
  });
  await authenticate('partial', 'sensitive-invalid-token');
  assert.deepEqual(JSON.parse(authWarnings[1]), {
    event: 'user_authentication_failed', requirement: 'partial', reason: 'authentication_processing_failed', error_code: 'auth/id-token-revoked',
  });
  assert.ok(!authWarnings.join('\n').includes('sensitive-invalid-token'));
  assert.ok(!authWarnings.join('\n').includes('SECRET TOKEN'));
});

test('successful staff authentication emits no failure diagnostics', async () => {
  const result = await authenticate('private', 'staff', ['staff']);
  assert.equal(result.nextCalls, 1);
  assert.deepEqual(authWarnings, []);
});

test('canonical role derivation excludes legacy staff but preserves unrelated and system roles', async () => {
  assert.deepEqual((await authenticate('private', 'all-roles', ['staff'])).req.user?.roles, ['member', 'system', 'editor', 'staff']);
  assert.deepEqual((await authenticate('partial', 'legacy-roles')).req.user?.roles, ['member']);
  assert.deepEqual((await authenticate('partial', 'legacy-role')).req.user?.roles, []);
  assert.deepEqual((await authenticate('partial', 'legacy-string')).req.user?.roles, []);
  const system = await authenticate('private', 'system', ['staff', 'system']);
  assert.equal(system.nextCalls, 1); assert.deepEqual(system.req.user?.roles, ['system']);
  for (const requirement of ['public', 'partial', 'private'] as const) assert.ok((await authenticate(requirement, 'staff')).req.user);
});

test('Swagger documents both bodyless staff administration endpoints and security/error contract', () => {
  const path = swaggerDocument.paths['/api/users/{uid}/claims/staff'];
  for (const method of ['put', 'delete']) {
    assert.equal(path[method].requestBody, undefined);
    assert.deepEqual(Object.keys(path[method].responses).sort(), ['204', '400', '401', '403', '404', '500']);
    assert.equal(path[method].parameters[0].schema.maxLength, 128);
    assert.equal(path[method].parameters[0].schema.format, undefined);
    assert.deepEqual(path[method].security, [{ ApiKeyAuth: [], BearerAuth: [], AppCheckAuth: [] }]);
  }
});
