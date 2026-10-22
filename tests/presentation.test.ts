import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PresentationError, initialPresentationState } from '../src/models/presentation.js';
import { PresentationService } from '../src/services/presentationService.js';
import { makeFixture, participant, writableState } from './helpers/presentationFixture.js';

async function roomWithController() {
  const fixture = makeFixture();
  const receiver = participant(), createKey = randomUUID();
  const created = await fixture.service.createSession(receiver, createKey, 'create-ip');
  const controller = participant(), pairKey = randomUUID();
  const paired = await fixture.service.pair({ ...controller, code: created.body.presenterCode }, pairKey, 'pair-ip');
  const receiverContext = await fixture.service.authorize(created.body.sessionId, receiver.participantId, receiver.participantToken);
  const controllerContext = await fixture.service.authorize(created.body.sessionId, controller.participantId, controller.participantToken);
  return { fixture, receiver, controller, created, createKey, pairKey, controllerContext, receiverContext, paired };
}
function writable(state: any) { const { revision: _revision, ideaEpoch: _ideaEpoch, ...value } = state; return structuredClone(value); }

test('create, pair, audience join, and lost-response retries return stable safe enrollments', async () => {
  const fixture = makeFixture(), receiver = participant(), createKey = randomUUID();
  const created = await fixture.service.createSession(receiver, createKey, 'create-ip');
  const replay = await fixture.service.createSession(receiver, createKey, 'create-ip');
  assert.equal(created.status, 201); assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, created.body);
  assert.equal(created.body.protocolVersion, 1); assert.equal(created.body.role, 'receiver');
  assert.match(created.body.presenterCode, /^\d{5}$/);
  assert.match(created.body.audienceCode, /^\d{5}$/);
  assert.equal(created.body.state.revision, 0);
  const controller = participant(), pairKey = randomUUID(), pairRequest = { ...controller, code: created.body.presenterCode };
  const paired = await fixture.service.pair(pairRequest, pairKey, 'pair-ip');
  const recoveredPair = await fixture.service.pair(pairRequest, pairKey, 'pair-ip');
  assert.equal(paired.status, 200); assert.deepEqual(recoveredPair.body, paired.body);
  assert.equal(paired.body.role, 'controller'); assert.equal(paired.body.audienceCode, created.body.audienceCode);
  const viewer = participant(), joinKey = randomUUID(), joinRequest = { ...viewer, code: created.body.audienceCode };
  const joined = await fixture.service.joinAudience(joinRequest, joinKey, 'viewer-ip');
  const replayJoin = await fixture.service.joinAudience(joinRequest, joinKey, 'viewer-ip');
  assert.equal(joined.body.role, 'audience'); assert.match(joined.body.displayName, /^Viewer \d{4}$/);
  assert.deepEqual(replayJoin.body, joined.body);
  assert.equal('presenterCode' in joined.body, false); assert.equal('participants' in joined.body, false);
  const persisted = JSON.stringify([...fixture.store.documents.entries()]);
  assert.equal(persisted.includes(receiver.participantToken), false);
  assert.equal(persisted.includes(controller.participantToken), false);
  assert.equal(persisted.includes(viewer.participantToken), false);
});

test('simultaneous unrelated presenter claims yield one controller and one PAIRING_CLAIMED', async () => {
  const fixture = makeFixture(), receiver = participant();
  const created = await fixture.service.createSession(receiver, randomUUID(), 'create-ip');
  const first = participant(), second = participant();
  const claims = await Promise.allSettled([
    fixture.service.pair({ ...first, code: created.body.presenterCode }, randomUUID(), 'pair-a'),
    fixture.service.pair({ ...second, code: created.body.presenterCode }, randomUUID(), 'pair-b'),
  ]);
  assert.equal(claims.filter(item => item.status === 'fulfilled').length, 1);
  const rejected = claims.find(item => item.status === 'rejected') as PromiseRejectedResult;
  assert.equal((rejected.reason as PresentationError).code, 'PAIRING_CLAIMED');
});

test('presenter and audience code namespaces do not admit the other role', async () => {
  const fixture = makeFixture(), receiver = participant();
  const created = await fixture.service.createSession(receiver, randomUUID(), 'create-ip');
  await assert.rejects(fixture.service.pair({ ...participant(), code: created.body.audienceCode }, randomUUID(), 'pair-ip'), { code: 'PAIRING_EXPIRED', status: 410 });
  await assert.rejects(fixture.service.joinAudience({ ...participant(), code: created.body.presenterCode }, randomUUID(), 'audience-ip'), { code: 'SESSION_EXPIRED', status: 410 });
});

test('expiry is checked before bootstrap receipt replay and invalidates existing capabilities', async () => {
  const fixture = makeFixture(), receiver = participant(), key = randomUUID();
  const created = await fixture.service.createSession(receiver, key, 'create-ip');
  fixture.setNow(fixture.now() + 10 * 60_000);
  await assert.rejects(fixture.service.createSession(receiver, key, 'create-ip'), { code: 'SESSION_EXPIRED', status: 410 });
  await assert.rejects(fixture.service.authorize(created.body.sessionId, receiver.participantId, receiver.participantToken), { code: 'SESSION_EXPIRED', status: 410 });
});

test('controller rotation revokes the old token and re-pairing preserves the four-hour deadline', async () => {
  const { fixture, receiver, controller, created, createKey, pairKey, receiverContext, controllerContext, paired } = await roomWithController();
  const originalExpiry = paired.body.expiresAt;
  const rotated = await fixture.service.rotatePairing(receiverContext, 1, randomUUID());
  await assert.rejects(fixture.service.authorize(created.body.sessionId, controller.participantId, controller.participantToken), { code: 'INVALID_SESSION_CREDENTIAL', status: 401 });
  await assert.rejects(fixture.service.endSession(created.body.sessionId, controller.participantId, controller.participantToken), { code: 'INVALID_SESSION_CREDENTIAL', status: 401 });
  const replacement = participant();
  const pairedAgain = await fixture.service.pair({ ...replacement, code: rotated.presenterCode }, randomUUID(), 'pair-ip-2');
  assert.equal(pairedAgain.body.expiresAt, originalExpiry);
  await assert.rejects(fixture.service.pair({ ...participant(), code: created.body.presenterCode }, randomUUID(), 'pair-ip-3'), { code: 'PAIRING_EXPIRED', status: 410 });
  await assert.rejects(fixture.service.pair({ ...controller, code: created.body.presenterCode }, pairKey, 'pair-ip'), { code: 'PAIRING_EXPIRED', status: 410 });
  fixture.setNow(fixture.now() + 11 * 60_000);
  assert.deepEqual((await fixture.service.createSession(receiver, createKey, 'create-ip')).body, created.body);
  assert.equal((await fixture.service.authorize(created.body.sessionId, receiver.participantId, receiver.participantToken)).role, 'receiver');
  assert.equal((await fixture.service.authorize(created.body.sessionId, replacement.participantId, replacement.participantToken)).role, 'controller');
  assert.equal(controllerContext.role, 'controller');
});

test('revision writes are optimistic, idempotent, and increment ideaEpoch only when selection changes', async () => {
  const { fixture, created, controllerContext } = await roomWithController();
  const firstState = writable(initialPresentationState());
  firstState.selectedIdeaId = '41'; firstState.mode = 'photo';
  const firstKey = randomUUID();
  const first = await fixture.service.updateState(controllerContext, { protocolVersion: 1, baseRevision: 0, state: firstState }, firstKey);
  const replay = await fixture.service.updateState(controllerContext, { protocolVersion: 1, baseRevision: 0, state: firstState }, firstKey);
  assert.deepEqual(replay, first); assert.equal(first.state.revision, 1); assert.equal(first.state.ideaEpoch, 1);
  const next = writable(first.state); next.theme = 'light';
  const updated = await fixture.service.updateState(controllerContext, { protocolVersion: 1, baseRevision: 1, state: next }, randomUUID());
  assert.equal(updated.state.revision, 2); assert.equal(updated.state.ideaEpoch, 1);
  await assert.rejects(fixture.service.updateState(controllerContext, { protocolVersion: 1, baseRevision: 0, state: next }, randomUUID()), error => {
    assert.equal((error as PresentationError).code, 'REVISION_CONFLICT');
    assert.equal((error as PresentationError).current.state.revision, 2);
    return true;
  });
  const session = await fixture.store.get(`presentationSessions/${created.body.sessionId}`);
  assert.equal(session?.state.ideaEpoch, 1);
});

test('role boundaries prevent audience mutation, roster access, and cross-session token reuse', async () => {
  const { fixture, receiver, created, controllerContext } = await roomWithController();
  const viewer = participant(); await fixture.service.joinAudience({ ...viewer, code: created.body.audienceCode }, randomUUID(), 'audience-ip');
  const audienceContext = await fixture.service.authorize(created.body.sessionId, viewer.participantId, viewer.participantToken);
  await assert.rejects(fixture.service.catalog(audienceContext, 100, undefined), { code: 'ROLE_FORBIDDEN', status: 403 });
  await assert.rejects(fixture.service.updateState(audienceContext, { protocolVersion: 1, baseRevision: 0, state: writable(initialPresentationState()) }, randomUUID()), { code: 'ROLE_FORBIDDEN', status: 403 });
  await assert.rejects(fixture.service.rotatePairing(audienceContext, 1, randomUUID()), { code: 'ROLE_FORBIDDEN', status: 403 });
  await assert.rejects(fixture.service.endSession(created.body.sessionId, viewer.participantId, viewer.participantToken), { code: 'ROLE_FORBIDDEN', status: 403 });
  await assert.rejects(fixture.service.leave(await fixture.service.authorize(created.body.sessionId, receiver.participantId, receiver.participantToken), receiver.participantToken), { code: 'ROLE_FORBIDDEN', status: 403 });
  await assert.rejects(fixture.service.authorize('22222222-2222-4222-8222-222222222222', receiver.participantId, receiver.participantToken), { code: 'INVALID_SESSION_CREDENTIAL', status: 401 });
  assert.equal(controllerContext.role, 'controller');
});

test('one hundred independent audience enrollments have no product cap or shared local view', async () => {
  const fixture = makeFixture(), receiver = participant();
  const created = await fixture.service.createSession(receiver, randomUUID(), 'create-ip');
  const viewers = Array.from({ length: 100 }, participant);
  const joined = await Promise.all(viewers.map((viewer, index) => fixture.service.joinAudience({ ...viewer, code: created.body.audienceCode }, randomUUID(), `audience-ip-${index}`)));
  assert.equal(joined.length, 100);
  const controller = participant(); await fixture.service.pair({ ...controller, code: created.body.presenterCode }, randomUUID(), 'pair-ip');
  const presenter = await fixture.service.authorize(created.body.sessionId, controller.participantId, controller.participantToken);
  const before = await fixture.service.sync(presenter, { protocolVersion: 1, lastRevision: -1, lastContentVersion: null });
  assert.equal(before.participants.length, 100);
  const first = viewers[0];
  const audience = await fixture.service.authorize(created.body.sessionId, first.participantId, first.participantToken);
  await fixture.service.sync(audience, { protocolVersion: 1, lastRevision: -1, lastContentVersion: null, presence: { localView: 'photo' } });
  const after = await fixture.service.sync(presenter, { protocolVersion: 1, lastRevision: -1, lastContentVersion: null });
  assert.equal(after.participants.find((p: any) => p.id === first.participantId).localView, 'photo');
  assert.equal(after.participants[1].localView, null);
  assert.equal(after.state.revision, 0);
});

test('delete is idempotent and makes every role terminal', async () => {
  const { fixture, receiver, controller, created } = await roomWithController();
  await fixture.service.endSession(created.body.sessionId, receiver.participantId, receiver.participantToken);
  await fixture.service.endSession(created.body.sessionId, receiver.participantId, receiver.participantToken);
  await assert.rejects(fixture.service.authorize(created.body.sessionId, controller.participantId, controller.participantToken), { code: 'SESSION_ENDED', status: 410 });
});

test('audience leave revokes its receipt and controller leave relinquishes authority', async () => {
  const fixture = makeFixture(), receiver = participant(), createKey = randomUUID();
  const created = await fixture.service.createSession(receiver, createKey, 'create-ip');
  const controller = participant(), pairKey = randomUUID(), pairRequest = { ...controller, code: created.body.presenterCode };
  await fixture.service.pair(pairRequest, pairKey, 'pair-ip');
  const viewer = participant(), joinKey = randomUUID(), joinRequest = { ...viewer, code: created.body.audienceCode };
  await fixture.service.joinAudience(joinRequest, joinKey, 'audience-ip');
  const audience = await fixture.service.authorize(created.body.sessionId, viewer.participantId, viewer.participantToken);
  await fixture.service.leave(audience, viewer.participantToken);
  await assert.rejects(fixture.service.joinAudience(joinRequest, joinKey, 'audience-ip'), { code: 'SESSION_ENDED', status: 410 });
  await assert.rejects(fixture.service.authorize(created.body.sessionId, viewer.participantId, viewer.participantToken), { code: 'INVALID_SESSION_CREDENTIAL', status: 401 });
  const presenter = await fixture.service.authorize(created.body.sessionId, controller.participantId, controller.participantToken);
  await fixture.service.leave(presenter, controller.participantToken);
  await assert.rejects(fixture.service.pair(pairRequest, pairKey, 'pair-ip'), { code: 'PAIRING_EXPIRED', status: 410 });
  await assert.rejects(fixture.service.authorize(created.body.sessionId, controller.participantId, controller.participantToken), { code: 'INVALID_SESSION_CREDENTIAL', status: 401 });
  assert.equal(await fixture.service.rotatePairing(await fixture.service.authorize(created.body.sessionId, receiver.participantId, receiver.participantToken), 1, randomUUID()).then(value => value.protocolVersion), 1);
});

test('active content refresh preserves stable album selection and clears a deleted idea atomically', async () => {
  const { fixture, created, controllerContext } = await roomWithController();
  const next = writable(initialPresentationState()); next.selectedIdeaId = '41'; next.mode = 'photo';
  const selected = await fixture.service.updateState(controllerContext, { protocolVersion: 1, baseRevision: 0, state: next }, randomUUID());
  const originalMediaId = selected.content.album[0].id;
  fixture.suggestions.set(41, {
    ...fixture.suggestions.get(41), content: { summary: 'Updated crossing', details: 'Updated details', photos: [
      { url: 'https://images.example/new-photo.jpg', caption: 'New first image' },
      { url: 'https://images.example/crossing.jpg?changed=ignored', caption: 'Current conditions' },
    ] },
  });
  fixture.setNow(fixture.now() + 5001);
  const refreshed = await fixture.service.sync(controllerContext, { protocolVersion: 1, lastRevision: 1, lastContentVersion: selected.content.contentVersion });
  assert.equal(refreshed.state.revision, 2);
  assert.equal(refreshed.state.ideaEpoch, 1);
  assert.equal(refreshed.state.albumItemId, originalMediaId);
  assert.equal(refreshed.content.summary, 'Updated crossing');
  fixture.suggestions.delete(41);
  fixture.setNow(fixture.now() + 5001);
  const cleared = await fixture.service.sync(controllerContext, { protocolVersion: 1, lastRevision: 2, lastContentVersion: refreshed.content.contentVersion });
  assert.equal(cleared.state.selectedIdeaId, null);
  assert.equal(cleared.state.mode, 'map');
  assert.equal(cleared.state.ideaEpoch, 2);
  assert.equal(cleared.content, null);
});

test('presence writes coalesce to fifteen seconds and report disconnect after forty-five seconds', async () => {
  const fixture = makeFixture(), receiver = participant();
  const created = await fixture.service.createSession(receiver, randomUUID(), 'create-ip');
  const controller = participant(); await fixture.service.pair({ ...controller, code: created.body.presenterCode }, randomUUID(), 'pair-ip');
  const viewer = participant(); await fixture.service.joinAudience({ ...viewer, code: created.body.audienceCode }, randomUUID(), 'audience-ip');
  const audience = await fixture.service.authorize(created.body.sessionId, viewer.participantId, viewer.participantToken);
  const participantPath = `presentationSessions/${created.body.sessionId}/participants/${viewer.participantId}`;
  const before = await fixture.store.get(participantPath);
  await fixture.service.sync(audience, { protocolVersion: 1, lastRevision: 0, lastContentVersion: null, presence: { localView: 'description' } });
  assert.equal((await fixture.store.get(participantPath))?.lastSeenAtMs, before?.lastSeenAtMs);
  assert.equal((await fixture.store.get(participantPath))?.localView, 'description');
  fixture.setNow(fixture.now() + 15_001);
  await fixture.service.sync(audience, { protocolVersion: 1, lastRevision: 0, lastContentVersion: null, presence: { localView: 'description' } });
  const persisted = await fixture.store.get(participantPath);
  assert.equal(persisted?.lastSeenAtMs, fixture.now());
  fixture.setNow(fixture.now() + 45_001);
  const presenter = await fixture.service.authorize(created.body.sessionId, controller.participantId, controller.participantToken);
  const roster = await fixture.service.sync(presenter, { protocolVersion: 1, lastRevision: -1, lastContentVersion: null });
  assert.equal(roster.participants.find((item: any) => item.id === viewer.participantId).connected, false);
  assert.equal(roster.state.revision, 0);
});

test('receiver render status does not rewrite the session document on every poll', async () => {
  const fixture = makeFixture(), receiver = participant();
  const created = await fixture.service.createSession(receiver, randomUUID(), 'create-ip');
  const context = await fixture.service.authorize(created.body.sessionId, receiver.participantId, receiver.participantToken);
  const report = { appliedRevision: 0, viewport: { width: 1920, height: 1080 }, renderStatus: 'ready' as const, renderError: null };
  await fixture.service.sync(context, { protocolVersion: 1, lastRevision: -1, lastContentVersion: null, presence: report });
  const firstSeen = (await fixture.store.get(`presentationSessions/${created.body.sessionId}`))?.receiverStatus.lastSeenAtMs;
  fixture.setNow(fixture.now() + 1000);
  await fixture.service.sync(context, { protocolVersion: 1, lastRevision: 0, lastContentVersion: null, presence: report });
  const secondSeen = (await fixture.store.get(`presentationSessions/${created.body.sessionId}`))?.receiverStatus.lastSeenAtMs;
  assert.equal(secondSeen, firstSeen);
  fixture.setNow(fixture.now() + 14_001);
  await fixture.service.sync(context, { protocolVersion: 1, lastRevision: 0, lastContentVersion: null, presence: report });
  const thirdSeen = (await fixture.store.get(`presentationSessions/${created.body.sessionId}`))?.receiverStatus.lastSeenAtMs;
  assert.equal(thirdSeen, fixture.now());
});

test('missing, malformed, and cross-session capabilities are rejected', async () => {
  const fixture = makeFixture(), receiver = participant();
  const created = await fixture.service.createSession(receiver, randomUUID(), 'create-ip');
  await assert.rejects(fixture.service.authorize(created.body.sessionId, receiver.participantId, undefined), { code: 'INVALID_SESSION_CREDENTIAL', status: 401 });
  await assert.rejects(fixture.service.authorize(created.body.sessionId, receiver.participantId, 'firebase-token'), { code: 'INVALID_SESSION_CREDENTIAL', status: 401 });
  await assert.rejects(fixture.service.authorize(created.body.sessionId, undefined, receiver.participantToken), { code: 'INVALID_PRESENTATION_REQUEST', status: 422 });
  await assert.rejects(fixture.service.authorize('22222222-2222-4222-8222-222222222222', receiver.participantId, receiver.participantToken), { code: 'INVALID_SESSION_CREDENTIAL', status: 401 });
});

test('admission quotas are shared through the injected durable store and include Retry-After', async () => {
  const fixture = makeFixture();
  for (let i = 0; i < 5; i++) await fixture.service.createSession(participant(), randomUUID(), 'same-ip');
  await assert.rejects(fixture.service.createSession(participant(), randomUUID(), 'same-ip'), error => {
    assert.equal((error as PresentationError).status, 429); assert.equal((error as PresentationError).code, 'RATE_LIMITED');
    assert.ok((error as PresentationError).retryAfter! > 0); return true;
  });
});

test('admission limits stay shared when a second service instance uses the same durable store', async () => {
  const fixture = makeFixture();
  const secondInstance = new PresentationService(fixture.store, { now: fixture.now });
  for (let i = 0; i < 4; i++) await fixture.service.createSession(participant(), randomUUID(), 'shared-instance-ip');
  await secondInstance.createSession(participant(), randomUUID(), 'shared-instance-ip');
  await assert.rejects(fixture.service.createSession(participant(), randomUUID(), 'shared-instance-ip'), { code: 'RATE_LIMITED', status: 429 });
});
