import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { initialPresentationState } from '../src/models/presentation.js';
import { makeFixture, participant, writableState as writable } from './helpers/presentationFixture.js';

function token() { return randomBytes(32).toString('base64url'); }
async function appServer(t: any, feature = true) {
  const previous = process.env.PRESENTATION_ENABLED;
  process.env.PRESENTATION_ENABLED = feature ? 'true' : 'false';
  t.after(() => { if (previous === undefined) delete process.env.PRESENTATION_ENABLED; else process.env.PRESENTATION_ENABLED = previous; });
  const fixture = makeFixture();
  const server = createApp({ presentationService: fixture.service }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { fixture, base: `http://127.0.0.1:${(server.address() as any).port}` };
}
const jsonHeaders = { 'Content-Type': 'application/json' };

test('accountless bootstrap, capability headers, no-store, CORS, and strict protocol fields', async t => {
  const { base } = await appServer(t);
  const receiver = participant(), createKey = randomUUID();
  const response = await fetch(`${base}/api/public-improvements/presentation/sessions`, {
    method: 'POST', headers: { ...jsonHeaders, 'Idempotency-Key': createKey }, body: JSON.stringify(receiver),
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const created = await response.json() as any;
  assert.equal(created.role, 'receiver'); assert.equal(created.protocolVersion, 1);
  const preflight = await fetch(`${base}/api/public-improvements/presentation/sessions`, {
    method: 'OPTIONS', headers: { Origin: 'https://map.dallasurbanists.org', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type,idempotency-key,x-presentation-participant' },
  });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /X-Presentation-Participant/i);
  const unknown = await fetch(`${base}/api/public-improvements/presentation/sessions`, {
    method: 'POST', headers: { ...jsonHeaders, 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ ...participant(), extra: true }),
  });
  assert.equal(unknown.status, 422); assert.equal((await unknown.json() as any).error, 'INVALID_PRESENTATION_REQUEST');
  const wrongProtocol = await fetch(`${base}/api/public-improvements/presentation/sessions`, {
    method: 'POST', headers: { ...jsonHeaders, 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ ...participant(), protocolVersion: 2 }),
  });
  assert.equal(wrongProtocol.status, 426);
  const tooLarge = await fetch(`${base}/api/public-improvements/presentation/sessions`, {
    method: 'POST', headers: { ...jsonHeaders, 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ ...participant(), extra: 'x'.repeat(40_000) }),
  });
  assert.equal(tooLarge.status, 413); assert.equal(tooLarge.headers.get('cache-control'), 'no-store');
});

test('session capabilities never accept Firebase tokens and enforce roles on every route', async t => {
  const { fixture, base } = await appServer(t);
  const receiver = participant();
  const createdResponse = await fetch(`${base}/api/public-improvements/presentation/sessions`, { method: 'POST', headers: { ...jsonHeaders, 'Idempotency-Key': randomUUID() }, body: JSON.stringify(receiver) });
  const created = await createdResponse.json() as any;
  const controller = participant();
  const pairResponse = await fetch(`${base}/api/public-improvements/presentation/pair`, { method: 'POST', headers: { ...jsonHeaders, 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ ...controller, code: created.presenterCode }) });
  assert.equal(pairResponse.status, 200);
  const audience = participant();
  const joinResponse = await fetch(`${base}/api/public-improvements/presentation/audience/join`, { method: 'POST', headers: { ...jsonHeaders, 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ ...audience, code: created.audienceCode }) });
  assert.equal(joinResponse.status, 200);
  const unauthorized = await fetch(`${base}/api/public-improvements/presentation/sessions/${created.sessionId}/sync`, {
    method: 'POST', headers: { ...jsonHeaders, Authorization: 'Bearer ey.firebase.id.token', 'X-Presentation-Participant': receiver.participantId }, body: JSON.stringify({ protocolVersion: 1, lastRevision: -1, lastContentVersion: null }),
  });
  assert.equal(unauthorized.status, 401);
  const receiverHeaders = { ...jsonHeaders, Authorization: `Bearer ${receiver.participantToken}`, 'X-Presentation-Participant': receiver.participantId };
  const sync = await fetch(`${base}/api/public-improvements/presentation/sessions/${created.sessionId}/sync`, { method: 'POST', headers: receiverHeaders, body: JSON.stringify({ protocolVersion: 1, lastRevision: -1, lastContentVersion: null, presence: { appliedRevision: 0, viewport: { width: 1920, height: 1080 }, renderStatus: 'ready' } }) });
  assert.equal(sync.status, 200); assert.equal((await sync.json() as any).receiver.renderStatus, 'ready');
  const receiverWrite = await fetch(`${base}/api/public-improvements/presentation/sessions/${created.sessionId}/state`, { method: 'PUT', headers: { ...receiverHeaders, 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ protocolVersion: 1, baseRevision: 0, state: writable(initialPresentationState()) }) });
  assert.equal(receiverWrite.status, 403);
  const controllerHeaders = { ...jsonHeaders, Authorization: `Bearer ${controller.participantToken}`, 'X-Presentation-Participant': controller.participantId };
  const audienceHeaders = { ...jsonHeaders, Authorization: `Bearer ${audience.participantToken}`, 'X-Presentation-Participant': audience.participantId };
  const selectedState = writable(initialPresentationState()); selectedState.selectedIdeaId = '41'; selectedState.mode = 'photo';
  const write = await fetch(`${base}/api/public-improvements/presentation/sessions/${created.sessionId}/state`, { method: 'PUT', headers: { ...controllerHeaders, 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ protocolVersion: 1, baseRevision: 0, state: selectedState }) });
  assert.equal(write.status, 200);
  const writeBody = await write.json() as any;
  assert.equal(writeBody.state.revision, 1);
  for (const secret of ['private@example.com', 'private-uid', 'generationRequest', 'private workflow data']) assert.equal(JSON.stringify(writeBody).includes(secret), false);
  const catalog = await fetch(`${base}/api/public-improvements/presentation/sessions/${created.sessionId}/ideas`, { headers: controllerHeaders });
  assert.equal(catalog.status, 200);
  assert.equal(JSON.stringify(await catalog.json()).includes('private@example.com'), false);
  const detail = await fetch(`${base}/api/public-improvements/presentation/sessions/${created.sessionId}/ideas/41`, { headers: controllerHeaders });
  assert.equal(detail.status, 200);
  assert.equal(JSON.stringify(await detail.json()).includes('private@example.com'), false);
  const audienceSync = await fetch(`${base}/api/public-improvements/presentation/sessions/${created.sessionId}/sync`, { method: 'POST', headers: audienceHeaders, body: JSON.stringify({ protocolVersion: 1, lastRevision: -1, lastContentVersion: null }) });
  const audienceEnvelope = await audienceSync.json() as any;
  assert.equal(audienceEnvelope.participants, null); assert.equal('audienceCode' in audienceEnvelope, false);
  assert.equal(JSON.stringify(audienceEnvelope).includes('private@example.com'), false);
  const audienceCatalog = await fetch(`${base}/api/public-improvements/presentation/sessions/${created.sessionId}/ideas`, { headers: audienceHeaders });
  assert.equal(audienceCatalog.status, 403);
  const disabled = await fetch(`${base}/api/public-improvements/presentation/sessions/${created.sessionId}/pairing`, { method: 'POST', headers: { ...receiverHeaders, 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ protocolVersion: 1 }) });
  assert.equal(disabled.status, 200);
  assert.equal(fixture.store.documents.size > 0, true);
});

test('disabled presentation namespace returns no-store 404 without opening a session', async t => {
  const { base } = await appServer(t, false);
  const response = await fetch(`${base}/api/public-improvements/presentation/sessions`, { method: 'POST', headers: { ...jsonHeaders, 'Idempotency-Key': randomUUID() }, body: JSON.stringify(participant()) });
  assert.equal(response.status, 404); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json() as any).error, 'PRESENTATION_DISABLED');
});

test('thumbnail route uses only the saved assignment and applies selected-idea access checks', async t => {
  const { fixture, base } = await appServer(t);
  const streetmixId = 'c13a6af0-8888-4444-8888-0bbee0cc1122';
  fixture.suggestions.set(41, { ...fixture.suggestions.get(41), streetmix: { streetmixId, streetmixUrl: 'https://streetmix.net/-/123', stale: true } });
  fixture.suggestions.set(42, { ...fixture.suggestions.get(41), id: 42, content: { summary: 'Other', details: '', photos: [] }, streetmix: { streetmixId: 'd13a6af0-8888-4444-8888-0bbee0cc1122', streetmixUrl: 'https://streetmix.net/-/456', stale: false } });
  const receiver = participant();
  const created = await (await fetch(`${base}/api/public-improvements/presentation/sessions`, { method: 'POST', headers: { ...jsonHeaders, 'Idempotency-Key': randomUUID() }, body: JSON.stringify(receiver) })).json() as any;
  const controller = participant();
  await fetch(`${base}/api/public-improvements/presentation/pair`, { method: 'POST', headers: { ...jsonHeaders, 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ ...controller, code: created.presenterCode }) });
  const controllerHeaders = { ...jsonHeaders, Authorization: `Bearer ${controller.participantToken}`, 'X-Presentation-Participant': controller.participantId };
  const selected = writable(initialPresentationState()); selected.selectedIdeaId = '41'; selected.mode = 'photo';
  await fetch(`${base}/api/public-improvements/presentation/sessions/${created.sessionId}/state`, { method: 'PUT', headers: { ...controllerHeaders, 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ protocolVersion: 1, baseRevision: 0, state: selected }) });
  const viewer = participant();
  await fetch(`${base}/api/public-improvements/presentation/audience/join`, { method: 'POST', headers: { ...jsonHeaders, 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ ...viewer, code: created.audienceCode }) });
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  t.mock.method(globalThis, 'fetch', async (input: any, init?: RequestInit) => {
    if (String(input).startsWith('https://streetmix.net/')) {
      upstreamCalls++;
      assert.equal(String(input), `https://streetmix.net/api/v1/streets/${streetmixId}/image`);
      assert.deepEqual(init?.headers, { Accept: 'image/png' });
      return new Response(png, { headers: { 'Content-Type': 'image/png' } });
    }
    return originalFetch(input, init);
  });
  const image = await fetch(`${base}/api/public-improvements/presentation/sessions/${created.sessionId}/ideas/41/streetmix-thumbnail?url=https%3A%2F%2Fevil.example`, { headers: controllerHeaders });
  assert.equal(image.status, 200); assert.equal(image.headers.get('cache-control'), 'no-store'); assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png); assert.equal(upstreamCalls, 1);
  const unavailable = await fetch(`${base}/api/public-improvements/presentation/sessions/${created.sessionId}/ideas/42/streetmix-thumbnail`, { headers: { ...jsonHeaders, Authorization: `Bearer ${viewer.participantToken}`, 'X-Presentation-Participant': viewer.participantId } });
  assert.equal(unavailable.status, 404); assert.equal(upstreamCalls, 1);
});
