import { after, before, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { getAuth, type DecodedIdToken, type ListUsersResult, type UserRecord } from 'firebase-admin/auth';
import { getAppCheck } from 'firebase-admin/app-check';
import { firebaseApp } from '../src/config/firebase.js';
import { createApp } from '../src/app.js';
import { swaggerDocument } from '../src/docs/swagger.js';

let server: Server;
let base: string;
let pages: ListUsersResult[];
let failAt: number | undefined;
const calls: Array<{ maxResults: number | undefined; pageToken: string | undefined }> = [];
const verified: Array<{ token: string; revoked: boolean | undefined }> = [];
const originalEnv = { apiKeys: process.env.API_KEYS_JSON, nodeEnv: process.env.NODE_ENV };
const tokens: Record<string, Record<string, unknown>> = {
  ordinary: { uid: 'ordinary' },
  staff: { uid: 'staff', staff: true },
  system: { uid: 'system', system: true },
  legacy: { uid: 'legacy', role: 'staff' },
};

function user(uid: string, customClaims?: Record<string, unknown>, disabled = false): UserRecord {
  return { uid, customClaims, disabled } as UserRecord;
}

before(async () => {
  const app = firebaseApp();
  const auth = getAuth(app);
  mock.method(auth, 'verifyIdToken', async (token: string, revoked?: boolean) => {
    verified.push({ token, revoked });
    if (!tokens[token]) throw Object.assign(new Error('PRIVATE TOKEN DETAILS'), { code: 'auth/id-token-revoked' });
    return tokens[token] as DecodedIdToken;
  });
  mock.method(auth, 'listUsers', async (maxResults?: number, pageToken?: string) => {
    const index = calls.length;
    calls.push({ maxResults, pageToken });
    if (index === failAt) throw new Error('PRIVATE FIREBASE DETAILS');
    return pages[index] ?? { users: [] };
  });
  mock.method(getAppCheck(app), 'verifyToken', async (token: string) => {
    if (token !== 'app-check') throw new Error('PRIVATE APP CHECK DETAILS');
    return { appId: 'test' };
  });
  mock.method(console, 'warn', () => {});
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
beforeEach(() => {
  process.env.API_KEYS_JSON = JSON.stringify([{ key: 'test-key', name: 'test' }]);
  process.env.NODE_ENV = 'test';
  pages = [{ users: [] }];
  calls.length = verified.length = 0;
  failAt = undefined;
});
after(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  mock.restoreAll();
  for (const [key, value] of [['API_KEYS_JSON', originalEnv.apiKeys], ['NODE_ENV', originalEnv.nodeEnv]]) {
    if (value === undefined) delete process.env[key!];
    else process.env[key!] = value;
  }
});

async function request(token: string | null = 'ordinary', key: string | null = 'test-key', appCheck?: string) {
  const headers: Record<string, string> = {};
  if (key !== null) headers['X-API-Key'] = key;
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  if (appCheck) headers['X-Firebase-AppCheck'] = appCheck;
  return fetch(`${base}/api/users`, { headers });
}

test('lists all Firebase pages, including disabled accounts, with only safe directory fields', async () => {
  const firstPage = Array.from({ length: 1000 }, (_, i) => user(`user-${i}`));
  firstPage[0] = {
    ...user('canonical-staff', { staff: true, tenant: 'private' }),
    email: 'staff@example.com', displayName: 'Staff Member',
    passwordHash: 'private-hash', passwordSalt: 'private-salt',
    providerData: [{ uid: 'private-provider-id', providerId: 'password' }],
  } as UserRecord;
  pages = [
    { users: firstPage, pageToken: 'next-page' },
    { users: [user('disabled-staff', { staff: true }, true), user('last-user')] },
  ];
  const response = await request();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.length, 1002);
  assert.deepEqual(body[0], { uid: 'canonical-staff', email: 'staff@example.com', displayName: 'Staff Member', disabled: false, staff: true });
  assert.deepEqual(body[1000], { uid: 'disabled-staff', email: null, displayName: null, disabled: true, staff: true });
  assert.deepEqual(body[1001], { uid: 'last-user', email: null, displayName: null, disabled: false, staff: false });
  for (const record of body) assert.deepEqual(Object.keys(record).sort(), ['disabled', 'displayName', 'email', 'staff', 'uid']);
  assert.deepEqual(calls, [{ maxResults: 1000, pageToken: undefined }, { maxResults: 1000, pageToken: 'next-page' }]);
  assert.deepEqual(verified, [{ token: 'ordinary', revoked: true }]);
});

test('staff status uses only the stored canonical boolean claim, not legacy or truthy values', async () => {
  pages = [{ users: [
    user('canonical', { staff: true }), user('absent'), user('false', { staff: false }),
    user('string', { staff: 'true' }), user('number', { staff: 1 }),
    user('role', { role: 'staff' }), user('roles-array', { roles: ['staff'] }),
    user('roles-scalar', { roles: 'staff' }), user('system', { system: true }),
  ] }];
  const response = await request('staff');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.map((record: { staff: boolean }) => record.staff), [true, false, false, false, false, false, false, false, false]);
});

test('any authenticated caller can list an empty directory without a staff role', async () => {
  for (const token of Object.keys(tokens)) {
    const response = await request(token);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), []);
  }
  assert.equal(calls.length, 4);
  assert.ok(verified.every(call => call.revoked === true));
});

test('requires a valid API key and non-revoked Firebase user token before listing', async () => {
  for (const key of [null, 'invalid-key']) {
    const response = await request('ordinary', key);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, 'Unauthorized');
  }
  for (const token of [null, 'invalid', 'revoked', 'disabled']) {
    const response = await request(token);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, 'Unauthorized');
  }
  assert.deepEqual(calls, []);
  assert.ok(verified.every(call => call.revoked === true));
});

test('production requires App Check as well as API key and user authentication', async () => {
  process.env.NODE_ENV = 'production';
  for (const appCheck of [undefined, 'invalid']) assert.equal((await request('ordinary', 'test-key', appCheck)).status, 401);
  assert.deepEqual(calls, []);
  assert.equal((await request('ordinary', 'test-key', 'app-check')).status, 200);
  assert.equal(calls.length, 1);
});

test('listing failures on any page return a sanitized 500, never a partial directory', async () => {
  for (const page of [0, 1]) {
    calls.length = 0;
    pages = [{ users: [user('not-to-be-returned')], pageToken: 'next-page' }];
    failAt = page;
    const response = await request();
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'InternalServerError', message: 'User listing failed.' });
    assert.equal(calls.length, page + 1);
  }
});

test('Swagger describes the user array, canonical staff flag and authenticated access', () => {
  const get = swaggerDocument.paths['/api/users'].get;
  assert.deepEqual(get.security, [{ ApiKeyAuth: [], BearerAuth: [], AppCheckAuth: [] }]);
  assert.deepEqual(Object.keys(get.responses).sort(), ['200', '401', '500']);
  assert.deepEqual(get.responses[200].content['application/json'].schema, { type: 'array', items: { $ref: '#/components/schemas/User' } });
  assert.match(get.description, /Any authenticated user/);
  const schema = swaggerDocument.components.schemas.User;
  assert.deepEqual(schema.required, ['uid', 'email', 'displayName', 'disabled', 'staff']);
  assert.equal(schema.properties.staff.type, 'boolean');
  assert.equal(schema.properties.email.nullable, true);
  assert.equal(schema.properties.displayName.nullable, true);
});
