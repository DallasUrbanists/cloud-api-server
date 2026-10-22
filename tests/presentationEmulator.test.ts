import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { FirestorePresentationStore } from '../src/services/presentationStore.js';
import { PresentationService } from '../src/services/presentationService.js';
import { participant } from './helpers/presentationFixture.js';

test('two independent Firestore-backed services serialize presenter claims in the emulator', {
  skip: !process.env.FIRESTORE_EMULATOR_HOST && 'Set FIRESTORE_EMULATOR_HOST to run the real Firestore two-instance concurrency test.',
  timeout: 30_000,
}, async t => {
  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST!;
  const emulatorUrl = new URL(emulatorHost.includes('://') ? emulatorHost : `http://${emulatorHost}`);
  const emulatorHostname = emulatorUrl.hostname.replace(/^\[|\]$/g, '');
  if (!['localhost', '127.0.0.1', '::1'].includes(emulatorHostname)) throw new Error('FIRESTORE_EMULATOR_HOST must point to a local emulator.');
  const projectId = `demo-presentation-${randomUUID().slice(0, 8)}`;
  // The local Firestore emulator currently supports only its default database.
  // The unique demo project above supplies isolation for this test run.
  const databaseId = '(default)';
  const firstDb = new Firestore({ projectId, databaseId });
  const secondDb = new Firestore({ projectId, databaseId });
  t.after(async () => {
    await firstDb.recursiveDelete(firstDb.collection('presentationSessions')).catch(() => undefined);
    await firstDb.recursiveDelete(firstDb.collection('presentationBootstrapReceipts')).catch(() => undefined);
    await firstDb.recursiveDelete(firstDb.collection('presentationCodeLookups')).catch(() => undefined);
    await firstDb.recursiveDelete(firstDb.collection('presentationRateLimits')).catch(() => undefined);
    await Promise.all([firstDb.terminate(), secondDb.terminate()]);
  });
  const one = new PresentationService(new FirestorePresentationStore(firstDb));
  const two = new PresentationService(new FirestorePresentationStore(secondDb));
  const receiver = participant();
  const created = await one.createSession(receiver, randomUUID(), 'emulator-create-ip');
  const a = participant(), b = participant();
  const claims = await Promise.allSettled([
    one.pair({ ...a, code: created.body.presenterCode }, randomUUID(), 'emulator-pair-a'),
    two.pair({ ...b, code: created.body.presenterCode }, randomUUID(), 'emulator-pair-b'),
  ]);
  const success = claims.filter(item => item.status === 'fulfilled');
  const failures = claims.filter(item => item.status === 'rejected') as PromiseRejectedResult[];
  assert.equal(success.length, 1);
  assert.equal(failures.length, 1);
  assert.equal((failures[0].reason as any).code, 'PAIRING_CLAIMED');
  const winner = success[0].status === 'fulfilled' ? success[0].value.body : undefined;
  const winnerParticipant = winner?.participantId === a.participantId ? a : b;
  const observed = await two.authorize(created.body.sessionId, winnerParticipant.participantId, winnerParticipant.participantToken);
  assert.equal(observed.role, 'controller');
});
