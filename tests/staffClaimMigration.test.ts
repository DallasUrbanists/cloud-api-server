import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Auth, UserRecord } from 'firebase-admin/auth';
import { migrateStaffClaims, type StaffMigrationCheckpoint } from '../src/services/staffClaimMigration.js';
import { reportMigrationFailure, runStaffClaimMigration } from '../src/scripts/migrateStaffClaims.js';

test('CLI failure reports the underlying code and message without dumping credential or response objects', t => {
  const messages: string[] = [];
  t.mock.method(console, 'error', (message: string) => messages.push(message));
  const error = Object.assign(new Error('Permission denied.'), { code: 'auth/insufficient-permission', credential: 'must-not-log' });
  reportMigrationFailure(error);
  assert.match(messages[0], /auth\/insufficient-permission/);
  assert.match(messages[0], /Permission denied/);
  assert.ok(!messages.join('\n').includes('must-not-log'));
  reportMigrationFailure(new Error('Explicit --project is required.'));
  assert.match(messages[2], /Explicit --project is required/);
  reportMigrationFailure(null);
  assert.match(messages[4], /Unknown error/);
});

function harness() {
  const users = new Map<string, Record<string, unknown>>([
    ['array', { roles: ['member', 'staff', 'system'], role: 'editor', tenant: { id: 1 } }],
    ['scalar', { roles: 'staff', flag: true }],
    ['role', { role: 'staff', staff: false, roles: ['member'] }],
    ['canonical-legacy', { staff: true, role: 'staff', roles: ['staff', 'member'] }],
    ['canonical', { staff: true, roles: ['member'], system: true }],
    ['nonstaff', { staff: 'true', role: 'member', roles: ['system'] }],
  ]);
  const calls: Array<string | undefined> = [];
  const writes: string[] = [];
  let failure: string | undefined;
  const auth = {
    async listUsers(size: number, cursor?: string) {
      assert.equal(size, 1000); calls.push(cursor);
      const keys = cursor === 'page-2' ? ['role', 'canonical-legacy', 'canonical', 'nonstaff'] : ['array', 'scalar'];
      return { users: keys.map(uid => ({ uid, customClaims: structuredClone(users.get(uid)) } as UserRecord)), pageToken: cursor === 'page-2' ? undefined : 'page-2' };
    },
    async getUser(uid: string) { return { uid, customClaims: structuredClone(users.get(uid)) } as UserRecord; },
    async setCustomUserClaims(uid: string, claims: Record<string, unknown>) {
      if (uid === failure) throw new Error('mock write failure');
      writes.push(uid); users.set(uid, claims);
    },
  } as Pick<Auth, 'listUsers' | 'getUser' | 'setCustomUserClaims'>;
  return { users, calls, writes, auth, fail(uid?: string) { failure = uid; } };
}

test('migration is dry-run by default, scans all pages and recognizes all legacy forms without writes', async () => {
  const h = harness();
  const audit: unknown[] = [];
  const result = await migrateStaffClaims(h.auth, { projectId: 'mock', audit: entry => audit.push(entry), saveCheckpoint: async () => { assert.fail('dry run saved checkpoint'); } });
  assert.deepEqual(result, { scanned: 6, changed: 4, applied: false });
  assert.deepEqual(h.calls, [undefined, 'page-2']); assert.deepEqual(h.writes, []);
  assert.deepEqual(h.users.get('scalar'), { roles: 'staff', flag: true });
  assert.equal(audit.length, 4);
  assert.deepEqual(audit[0], { actor: 'staff-claims-migration', target: 'array', action: 'normalize_staff', outcome: 'would_change' });
});

test('explicit apply preserves unrelated claims, checkpoints completed pages and is idempotent', async () => {
  const h = harness();
  const checkpoints: StaffMigrationCheckpoint[] = [];
  const result = await migrateStaffClaims(h.auth, { projectId: 'mock', apply: true, saveCheckpoint: async entry => { checkpoints.push(entry); } });
  assert.deepEqual(result, { scanned: 6, changed: 4, applied: true });
  assert.deepEqual(checkpoints, [
    { projectId: 'mock', pageToken: 'page-2', completed: false },
    { projectId: 'mock', pageToken: undefined, completed: true },
  ]);
  assert.deepEqual(h.users.get('array'), { staff: true, roles: ['member', 'system'], role: 'editor', tenant: { id: 1 } });
  assert.deepEqual(h.users.get('scalar'), { staff: true, flag: true });
  assert.deepEqual(h.users.get('role'), { staff: true, roles: ['member'] });
  assert.deepEqual(h.users.get('canonical-legacy'), { staff: true, roles: ['member'] });
  assert.deepEqual(h.users.get('nonstaff'), { staff: 'true', role: 'member', roles: ['system'] });
  const again = await migrateStaffClaims(h.auth, { projectId: 'mock', apply: true, saveCheckpoint: async () => {} });
  assert.equal(again.changed, 0); assert.equal(h.writes.length, 4);
});

test('failed page never advances checkpoint, resumable cursor retries page safely', async () => {
  const h = harness();
  const checkpoints: StaffMigrationCheckpoint[] = [];
  const audit: Array<{ outcome: string }> = [];
  h.fail('canonical-legacy');
  await assert.rejects(migrateStaffClaims(h.auth, { projectId: 'mock', apply: true, saveCheckpoint: async entry => { checkpoints.push(entry); }, audit: entry => audit.push(entry) }));
  assert.deepEqual(checkpoints, [{ projectId: 'mock', pageToken: 'page-2', completed: false }]);
  assert.equal(audit.at(-1)?.outcome, 'failure');
  h.fail();
  const resumed = await migrateStaffClaims(h.auth, { projectId: 'mock', apply: true, cursor: checkpoints[0].pageToken, saveCheckpoint: async entry => { checkpoints.push(entry); } });
  assert.equal(resumed.scanned, 4); assert.equal(resumed.changed, 1);
  assert.equal(checkpoints.at(-1)?.completed, true);
  assert.deepEqual(h.writes, ['array', 'scalar', 'role', 'canonical-legacy']);
});

test('apply re-reads custom claims before updating to preserve newly added unrelated claims', async () => {
  const h = harness();
  const original = h.auth.getUser;
  h.auth.getUser = async uid => {
    h.users.set(uid, { ...h.users.get(uid), fresh: 'preserved' });
    return original(uid);
  };
  await migrateStaffClaims(h.auth, { projectId: 'mock', apply: true, saveCheckpoint: async () => {} });
  assert.equal(h.users.get('array')?.fresh, 'preserved');
});

test('CLI rejects project mismatch, invalid checkpoint and cursor conflict; completed checkpoint exits without Firebase access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'staff-migration-test-'));
  const file = join(directory, 'checkpoint.json');
  const args = ['--project', 'mock', '--apply', '--checkpoint', file];
  try {
    await writeFile(file, JSON.stringify({ projectId: 'different', completed: true }));
    await assert.rejects(runStaffClaimMigration(args), /project mismatch/);
    await writeFile(file, JSON.stringify({ projectId: 'mock', completed: false }));
    await assert.rejects(runStaffClaimMigration(args), /Invalid checkpoint/);
    await writeFile(file, JSON.stringify({ projectId: 'mock', completed: false, pageToken: 'page-2' }));
    await assert.rejects(runStaffClaimMigration([...args, '--cursor', 'page-2']), /either/);
    await writeFile(file, JSON.stringify({ projectId: 'mock', completed: true }));
    await runStaffClaimMigration(args);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('apply without checkpoint writer and CLI without explicit project/checkpoint refuse before Firebase access', async () => {
  const h = harness();
  await assert.rejects(migrateStaffClaims(h.auth, { projectId: 'mock', apply: true }), /checkpoint/);
  assert.deepEqual(h.calls, []);
  await assert.rejects(runStaffClaimMigration([]), /--project/);
  await assert.rejects(runStaffClaimMigration(['--project', 'mock', '--apply']), /--checkpoint/);
  await assert.rejects(runStaffClaimMigration(['--project', 'mock', '--checkpoint', 'unused']), /dry runs/);
});
