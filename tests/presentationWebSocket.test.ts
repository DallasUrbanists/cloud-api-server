import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';
import { PresentationWebSocketServer, type PresentationWebSocketOptions } from '../src/presentationWebSocket.js';
import { attachSuggestionWebSocket } from '../src/suggestionWebSocket.js';
import { PresentationError } from '../src/models/presentation.js';
import { SuggestionNoticeService, type SuggestionSnapshot } from '../src/services/suggestionNoticeService.js';
import { validatePresentationPresence } from '../src/services/presentationPresence.js';
import type { PresentationService } from '../src/services/presentationService.js';
import { createRoom, makeFixture, participant, writableState } from './helpers/presentationFixture.js';

type Client = { ws: WebSocket; next: (predicate: (frame: any) => boolean, timeoutMs?: number) => Promise<any>; frames: any[] };

async function socketFixture(t: any, options: PresentationWebSocketOptions = {}) {
  const oldPresentation = process.env.PRESENTATION_ENABLED;
  const oldSocket = process.env.PRESENTATION_WEBSOCKET_ENABLED;
  process.env.PRESENTATION_ENABLED = 'true';
  process.env.PRESENTATION_WEBSOCKET_ENABLED = 'true';
  t.after(() => {
    if (oldPresentation === undefined) delete process.env.PRESENTATION_ENABLED; else process.env.PRESENTATION_ENABLED = oldPresentation;
    if (oldSocket === undefined) delete process.env.PRESENTATION_WEBSOCKET_ENABLED; else process.env.PRESENTATION_WEBSOCKET_ENABLED = oldSocket;
  });

  const fixture = makeFixture();
  const app = createApp({ presentationService: fixture.service });
  const server = createServer(app);
  let noticeNext: ((snapshot: SuggestionSnapshot) => void) | undefined;
  const notices = new SuggestionNoticeService((next, _error) => {
    noticeNext = next;
    queueMicrotask(() => next({ docChanges: () => [] }));
    return () => { noticeNext = undefined; };
  });
  const presentation = new PresentationWebSocketServer(fixture.service, options);
  const closeSockets = attachSuggestionWebSocket(server, {
    presentation, notices, verify: async ({ apiKey }) => {
      if (apiKey !== 'suggestion-test-key') throw new Error('private credential');
      return { name: 'test' };
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const clients = new Set<WebSocket>();
  t.after(async () => {
    for (const ws of clients) ws.terminate();
    await closeSockets();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  function open(path = '/api/public-improvements/presentation/ws'): Promise<Client> {
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}${path}`);
    clients.add(ws);
    const frames: any[] = [];
    ws.on('message', data => { try { frames.push(JSON.parse(data.toString())); } catch { /* malformed server frames remain visible as missing test frames */ } });
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve({ ws, frames, next: (predicate, timeoutMs = 1500) => nextFrame(ws, frames, predicate, timeoutMs) }));
      ws.once('unexpected-response', (_request, response) => reject(new Error(`Unexpected upgrade response ${response.statusCode}.`)));
      ws.once('error', reject);
    });
  }

  async function authenticate(credentials: { sessionId: string; participantId: string; participantToken: string }): Promise<Client> {
    const client = await open();
    client.ws.send(JSON.stringify({ type: 'authenticate', socketProtocolVersion: 1, protocolVersion: 1, ...credentials }));
    await client.next(frame => frame.type === 'ready');
    return client;
  }

  return { fixture, server, base, open, authenticate, clients, closeSockets, presentation, noticeNext: () => noticeNext };
}

async function nextFrame(ws: WebSocket, frames: any[], predicate: (frame: any) => boolean, timeoutMs = 1500): Promise<any> {
  const existing = frames.find(predicate);
  if (existing) return existing;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { ws.off('message', onMessage); reject(new Error('Timed out waiting for a presentation socket frame.')); }, timeoutMs);
    const onMessage = (data: Buffer) => {
      let frame: any;
      try { frame = JSON.parse(data.toString()); } catch { return; }
      if (predicate(frame)) { clearTimeout(timeout); ws.off('message', onMessage); resolve(frame); }
    };
    ws.on('message', onMessage);
  });
}

async function roomWithAllRoles(service: PresentationService) {
  const receiver = participant();
  const created = await service.createSession(receiver, randomUUID(), 'ws-test-create');
  const controller = participant();
  await service.pair({ ...controller, code: created.body.presenterCode }, randomUUID(), 'ws-test-pair');
  const audience = participant();
  await service.joinAudience({ ...audience, code: created.body.audienceCode }, randomUUID(), 'ws-test-audience');
  return { receiver, controller, audience, sessionId: created.body.sessionId, presenterCode: created.body.presenterCode, audienceCode: created.body.audienceCode };
}

test('enabled endpoint requires upgrade and dispatches beside both suggestion aliases', async t => {
  const h = await socketFixture(t);
  const ordinary = await fetch(`${h.base}/api/public-improvements/presentation/ws`);
  assert.equal(ordinary.status, 426);
  assert.equal(ordinary.headers.get('upgrade'), 'websocket');
  assert.equal((await ordinary.json() as any).error, 'UPGRADE_REQUIRED');

  const room = await roomWithAllRoles(h.fixture.service);
  const tv = await h.authenticate({ sessionId: room.sessionId, participantId: room.receiver.participantId, participantToken: room.receiver.participantToken });
  assert.equal(tv.frames[0].type, 'ready');
  assert.equal(tv.frames[0].socketProtocolVersion, 1);

  for (const path of ['/api/suggestions/ws', '/api/public-improvements/suggestions/ws']) {
    const client = await h.open(path);
    const ready = client.next(frame => frame.type === 'ready');
    client.ws.send(JSON.stringify({ type: 'authenticate', apiKey: 'suggestion-test-key' }));
    await ready;
  }
});

test('ready snapshots are complete and role projections exclude private fields', async t => {
  const h = await socketFixture(t);
  const room = await roomWithAllRoles(h.fixture.service);
  const [receiver, controller, audience] = await Promise.all([
    h.authenticate({ sessionId: room.sessionId, participantId: room.receiver.participantId, participantToken: room.receiver.participantToken }),
    h.authenticate({ sessionId: room.sessionId, participantId: room.controller.participantId, participantToken: room.controller.participantToken }),
    h.authenticate({ sessionId: room.sessionId, participantId: room.audience.participantId, participantToken: room.audience.participantToken }),
  ]);
  const receiverEnvelope = receiver.frames.find(frame => frame.type === 'ready').envelope;
  const controllerEnvelope = controller.frames.find(frame => frame.type === 'ready').envelope;
  const audienceEnvelope = audience.frames.find(frame => frame.type === 'ready').envelope;
  assert.equal(receiverEnvelope.state.revision, receiverEnvelope.session.revision);
  assert.equal(controllerEnvelope.state.revision, controllerEnvelope.session.revision);
  assert.ok(Array.isArray(controllerEnvelope.participants));
  assert.equal(controllerEnvelope.audienceCode, room.audienceCode);
  assert.equal(receiverEnvelope.participants, null);
  assert.equal(audienceEnvelope.participants, null);
  assert.equal(audienceEnvelope.audienceCode, undefined);
  assert.equal(JSON.stringify(audienceEnvelope).includes(room.presenterCode), false);
  assert.equal(JSON.stringify(receiverEnvelope).includes(room.receiver.participantToken), false);
  const participantDoc = await h.fixture.store.get(`presentationSessions/${room.sessionId}/participants/${room.receiver.participantId}`);
  assert.equal(JSON.stringify(receiverEnvelope).includes(participantDoc!.tokenDigest), false);
  assert.equal(audienceEnvelope.content, null);
  assert.deepEqual(Object.keys(receiver.frames[0]).sort(), ['envelope', 'sequence', 'socketProtocolVersion', 'type']);
});

test('durable state and selected content changes produce ordered full snapshots without sync polling', async t => {
  const h = await socketFixture(t);
  const room = await roomWithAllRoles(h.fixture.service);
  const controller = await h.authenticate({ sessionId: room.sessionId, participantId: room.controller.participantId, participantToken: room.controller.participantToken });
  const context = await h.fixture.service.authorize(room.sessionId, room.controller.participantId, room.controller.participantToken);
  const state = writableState(context.session.state);
  state.selectedIdeaId = '41';
  const receipt = await h.fixture.service.updateState(context, { protocolVersion: 1, baseRevision: 0, state }, randomUUID());
  const snapshot = await controller.next(frame => frame.type === 'snapshot' && frame.envelope.session.revision === 1);
  assert.equal(snapshot.sequence, 2);
  assert.equal(snapshot.envelope.state.revision, 1);
  assert.equal(snapshot.envelope.content.id, '41');
  assert.equal(receipt.session.revision, 1);
  assert.equal(controller.frames.some(frame => frame.type === 'snapshot' && frame.sequence <= 1), false);
});

test('presence validation accepts the frontend error union over REST and sockets without revision changes', async t => {
  const renderErrors = ['MAP_UNAVAILABLE', 'IMAGE_UNAVAILABLE', 'STREETMIX_UNAVAILABLE', 'CONTENT_UNAVAILABLE', 'TILE_UNAVAILABLE', 'RENDER_FAILED', 'NETWORK_ERROR', 'TIMEOUT', 'UNKNOWN'];
  for (const renderError of renderErrors) assert.equal(validatePresentationPresence({ renderError }, 'receiver')?.renderError, renderError);
  assert.throws(() => validatePresentationPresence({ renderError: 'PRIVATE_ERROR' }, 'receiver'), PresentationError);

  const h = await socketFixture(t);
  const room = await roomWithAllRoles(h.fixture.service);
  const receiver = await h.authenticate({ sessionId: room.sessionId, participantId: room.receiver.participantId, participantToken: room.receiver.participantToken });
  const restHeaders = {
    Origin: 'https://map.dallasurbanists.org', 'Content-Type': 'application/json',
    Authorization: `Bearer ${room.receiver.participantToken}`, 'X-Presentation-Participant': room.receiver.participantId,
  };
  for (const renderError of renderErrors) {
    const next = receiver.next(frame => frame.type === 'snapshot' && frame.envelope.receiver?.renderError === renderError);
    receiver.ws.send(JSON.stringify({ type: 'presence', socketProtocolVersion: 1, heartbeatId: null, presence: { appliedRevision: 0, viewport: { width: 1920, height: 1080 }, renderStatus: 'error', renderError } }));
    await next;
    const response = await fetch(`${h.base}/api/public-improvements/presentation/sessions/${room.sessionId}/sync`, {
      method: 'POST', headers: restHeaders,
      body: JSON.stringify({ protocolVersion: 1, lastRevision: -1, lastContentVersion: null, presence: { renderError } }),
    });
    assert.equal(response.status, 200);
  }
  const stored = await h.fixture.store.get(`presentationSessions/${room.sessionId}`);
  assert.equal(stored!.state.revision, 0);
  assert.equal(stored!.receiverStatus.renderError, 'UNKNOWN');
  const frameCount = receiver.frames.length;
  h.fixture.setNow(h.fixture.now() + 15_000);
  receiver.ws.send(JSON.stringify({ type: 'presence', socketProtocolVersion: 1, heartbeatId: null,
    presence: { appliedRevision: 0, viewport: { width: 1920, height: 1080 }, renderStatus: 'error', renderError: 'UNKNOWN' } }));
  await delay(250);
  assert.equal(receiver.frames.length, frameCount, 'hidden receiver lastSeen refreshes do not send identical snapshots');
});

test('browser CORS exposes Retry-After on real presentation 429 and 503 responses while retaining ETag', async t => {
  const h = await socketFixture(t);
  const origin = 'https://map.dallasurbanists.org';
  let limited: Response | undefined;
  for (let index = 0; index < 6; index++) {
    const receiver = participant();
    limited = await fetch(`${h.base}/api/public-improvements/presentation/sessions`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(receiver),
    });
  }
  assert.equal(limited!.status, 429);
  assert.ok(limited!.headers.get('retry-after'));
  const exposed = limited!.headers.get('access-control-expose-headers')!.toLowerCase();
  assert.match(exposed, /etag/);
  assert.match(exposed, /retry-after/);

  const failing = makeFixture();
  failing.store.runTransaction = async () => { throw new Error('synthetic store failure'); };
  const failureServer = createServer(createApp({ presentationService: failing.service }));
  failureServer.listen(0, '127.0.0.1'); await once(failureServer, 'listening');
  t.after(() => new Promise<void>(resolve => failureServer.close(() => resolve())));
  const unavailable = await fetch(`http://127.0.0.1:${(failureServer.address() as any).port}/api/public-improvements/presentation/sessions`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(participant()),
  });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get('retry-after'), '5');
  const unavailableExposure = unavailable.headers.get('access-control-expose-headers')!.toLowerCase();
  assert.match(unavailableExposure, /etag/);
  assert.match(unavailableExposure, /retry-after/);
});

test('valid heartbeat acknowledgments preserve liveness and a missing application acknowledgment closes retryably', async t => {
  const h = await socketFixture(t, { heartbeatMs: 40, heartbeatTimeoutMs: 90 });
  const room = await roomWithAllRoles(h.fixture.service);
  const responsive = await h.authenticate({ sessionId: room.sessionId, participantId: room.receiver.participantId, participantToken: room.receiver.participantToken });
  const beat = await responsive.next(frame => frame.type === 'heartbeat');
  responsive.ws.send(JSON.stringify({ type: 'presence', socketProtocolVersion: 1, heartbeatId: beat.id, presence: {} }));
  await delay(25);
  assert.equal(responsive.ws.readyState, WebSocket.OPEN);

  const silent = await h.authenticate({ sessionId: room.sessionId, participantId: room.controller.participantId, participantToken: room.controller.participantToken });
  const error = await silent.next(frame => frame.type === 'error' && frame.error === 'PRESENTATION_UNAVAILABLE', 600);
  assert.equal(error.retryAfterMs, 5000);
  const [closeCode] = await once(silent.ws, 'close') as [number];
  assert.equal(closeCode, 1013);
});

test('presence writes serialize across same-participant sockets and retain the newest telemetry', async t => {
  const h = await socketFixture(t);
  const room = await roomWithAllRoles(h.fixture.service);
  const credentials = { sessionId: room.sessionId, participantId: room.receiver.participantId, participantToken: room.receiver.participantToken };
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  let bothWritten!: () => void;
  const firstBlocked = new Promise<void>(resolve => { firstStarted = resolve; });
  const release = new Promise<void>(resolve => { releaseFirst = resolve; });
  const completed = new Promise<void>(resolve => { bothWritten = resolve; });
  const writes: unknown[] = [];
  h.fixture.service.recordSocketPresence = async (_sessionId, _participantId, _token, presence) => {
    writes.push(presence.renderError);
    if (writes.length === 1) { firstStarted(); await release; }
    if (writes.length === 2) bothWritten();
  };
  const older = await h.authenticate(credentials);
  const newer = await h.authenticate(credentials);
  older.ws.send(JSON.stringify({ type: 'presence', socketProtocolVersion: 1, heartbeatId: null, presence: { renderError: 'MAP_UNAVAILABLE' } }));
  await firstBlocked;
  newer.ws.send(JSON.stringify({ type: 'presence', socketProtocolVersion: 1, heartbeatId: null, presence: { renderError: 'TIMEOUT' } }));
  releaseFirst();
  await Promise.race([completed, delay(500).then(() => { throw new Error('Serialized presence write did not drain.'); })]);
  assert.deepEqual(writes, ['MAP_UNAVAILABLE', 'TIMEOUT']);
});

test('slow presence persistence does not delay valid application heartbeat acknowledgments', async t => {
  const h = await socketFixture(t, { heartbeatMs: 30, heartbeatTimeoutMs: 100 });
  const room = await roomWithAllRoles(h.fixture.service);
  let unblock!: () => void;
  let started!: () => void;
  const hold = new Promise<void>(resolve => { unblock = resolve; });
  const writeStarted = new Promise<void>(resolve => { started = resolve; });
  h.fixture.service.recordSocketPresence = async () => { started(); await hold; };
  const client = await h.authenticate({ sessionId: room.sessionId, participantId: room.receiver.participantId, participantToken: room.receiver.participantToken });
  let heartbeatCount = 0;
  client.ws.on('message', data => {
    let frame: any;
    try { frame = JSON.parse(data.toString()); } catch { return; }
    if (frame.type === 'heartbeat') {
      heartbeatCount++;
      client.ws.send(JSON.stringify({ type: 'presence', socketProtocolVersion: 1, heartbeatId: frame.id, presence: {} }));
    }
  });
  client.ws.send(JSON.stringify({ type: 'presence', socketProtocolVersion: 1, heartbeatId: null, presence: {} }));
  await writeStarted;
  await delay(230);
  assert.ok(heartbeatCount >= 4);
  assert.equal(client.ws.readyState, WebSocket.OPEN);
  unblock();
});

test('revocation closes the affected controller but reconnecting with the current capability remains allowed', async t => {
  const h = await socketFixture(t);
  const room = await roomWithAllRoles(h.fixture.service);
  const controller = await h.authenticate({ sessionId: room.sessionId, participantId: room.controller.participantId, participantToken: room.controller.participantToken });
  const closed = once(controller.ws, 'close');
  const receiverContext = await h.fixture.service.authorize(room.sessionId, room.receiver.participantId, room.receiver.participantToken);
  await h.fixture.service.rotatePairing(receiverContext, 1, randomUUID());
  const [code] = await closed as [number];
  assert.equal(code, 4001);
  assert.equal(controller.frames.some(frame => frame.type === 'error' && frame.error === 'INVALID_SESSION_CREDENTIAL'), true);
});

test('socket flags are independent from the REST feature and disabled upgrades return 404', async t => {
  const previousPresentation = process.env.PRESENTATION_ENABLED;
  const previous = process.env.PRESENTATION_WEBSOCKET_ENABLED;
  process.env.PRESENTATION_ENABLED = 'true';
  process.env.PRESENTATION_WEBSOCKET_ENABLED = 'false';
  t.after(() => {
    if (previousPresentation === undefined) delete process.env.PRESENTATION_ENABLED; else process.env.PRESENTATION_ENABLED = previousPresentation;
    if (previous === undefined) delete process.env.PRESENTATION_WEBSOCKET_ENABLED; else process.env.PRESENTATION_WEBSOCKET_ENABLED = previous;
  });
  const fixture = makeFixture();
  const server = createServer(createApp({ presentationService: fixture.service }));
  const closeSockets = attachSuggestionWebSocket(server, { presentation: new PresentationWebSocketServer(fixture.service) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await closeSockets(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const response = await fetch(`${base}/api/public-improvements/presentation/ws`);
  assert.equal(response.status, 404);
  assert.equal((await response.json() as any).error, 'PRESENTATION_DISABLED');
  process.env.PRESENTATION_ENABLED = 'false';
  process.env.PRESENTATION_WEBSOCKET_ENABLED = 'true';
  const presentationOff = await fetch(`${base}/api/public-improvements/presentation/ws`);
  assert.equal(presentationOff.status, 404);
  assert.equal((await presentationOff.json() as any).error, 'PRESENTATION_DISABLED');
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/api/public-improvements/presentation/ws');
  const [_, rejected] = await Promise.race([
    once(ws, 'open').then(value => [value, false] as const),
    once(ws, 'unexpected-response').then(value => [value, true] as const),
  ]);
  assert.equal(rejected, true);
});

test('malformed and duplicate authentication frames do not subscribe or disclose participant data', async t => {
  const h = await socketFixture(t);
  const room = await roomWithAllRoles(h.fixture.service);
  const ws = await h.open();
  ws.ws.send(JSON.stringify({ type: 'authenticate', socketProtocolVersion: 1, protocolVersion: 1, sessionId: room.sessionId, participantId: room.controller.participantId, participantToken: 'wrong' }));
  const error = await ws.next(frame => frame.type === 'error');
  assert.equal(error.error, 'INVALID_SESSION_CREDENTIAL');
  const [code] = await once(ws.ws, 'close') as [number];
  assert.equal(code, 4001);
  assert.equal((h.fixture.store as any).documentWatchers.size, 0);
});

test('socket and shared protocol incompatibility are distinguished', async t => {
  const h = await socketFixture(t);
  const room = await roomWithAllRoles(h.fixture.service);
  const frames = [
    [{ type: 'authenticate', socketProtocolVersion: 2, protocolVersion: 1, sessionId: room.sessionId, participantId: room.receiver.participantId, participantToken: room.receiver.participantToken }, 'SOCKET_PROTOCOL_UNSUPPORTED'],
    [{ type: 'authenticate', socketProtocolVersion: 1, protocolVersion: 2, sessionId: room.sessionId, participantId: room.receiver.participantId, participantToken: room.receiver.participantToken }, 'PROTOCOL_UNSUPPORTED'],
  ] as const;
  for (const [frame, expected] of frames) {
    const client = await h.open();
    client.ws.send(JSON.stringify(frame));
    const error = await client.next(value => value.type === 'error');
    assert.equal(error.error, expected);
    const [code] = await once(client.ws, 'close') as [number];
    assert.equal(code, 4004);
  }
  assert.equal((h.fixture.store as any).documentWatchers.size, 0);
});

test('authentication finishing after its timeout cannot subscribe or send ready', async t => {
  const h = await socketFixture(t, { authTimeoutMs: 25 });
  const room = await roomWithAllRoles(h.fixture.service);
  const authorize = h.fixture.service.authorize.bind(h.fixture.service);
  h.fixture.service.authorize = async (...args: Parameters<PresentationService['authorize']>) => {
    await delay(100);
    return authorize(...args);
  };
  const client = await h.open();
  client.ws.send(JSON.stringify({ type: 'authenticate', socketProtocolVersion: 1, protocolVersion: 1, sessionId: room.sessionId, participantId: room.receiver.participantId, participantToken: room.receiver.participantToken }));
  const error = await client.next(frame => frame.type === 'error');
  assert.equal(error.error, 'AUTHENTICATION_TIMEOUT');
  const [code] = await once(client.ws, 'close') as [number];
  assert.equal(code, 4000);
  await delay(150);
  assert.equal(client.frames.some(frame => frame.type === 'ready'), false);
  assert.equal((h.fixture.store as any).documentWatchers.size, 0);
});

test('server shutdown closes active sockets and releases the session watcher', async t => {
  const h = await socketFixture(t);
  const room = await roomWithAllRoles(h.fixture.service);
  const client = await h.authenticate({ sessionId: room.sessionId, participantId: room.receiver.participantId, participantToken: room.receiver.participantToken });
  const closed = once(client.ws, 'close');
  await h.closeSockets();
  const [code] = await closed as [number];
  assert.equal(code, 1001);
  assert.equal((h.fixture.store as any).documentWatchers.size, 0);
  assert.equal((h.fixture.store as any).collectionWatchers.size, 0);
});

test('a capability may reconnect on a new socket but repeated authentication on one socket is a policy fault', async t => {
  const h = await socketFixture(t);
  const room = await roomWithAllRoles(h.fixture.service);
  const credentials = { sessionId: room.sessionId, participantId: room.receiver.participantId, participantToken: room.receiver.participantToken };
  const first = await h.authenticate(credentials);
  const second = await h.authenticate(credentials);
  assert.equal(first.frames[0].type, 'ready');
  assert.equal(second.frames[0].type, 'ready');

  const duplicate = JSON.stringify({ type: 'authenticate', socketProtocolVersion: 1, protocolVersion: 1, ...credentials });
  const closed = once(first.ws, 'close');
  first.ws.send(duplicate);
  const [code] = await closed as [number];
  assert.equal(code, 1008);
  assert.equal(first.frames.some(frame => frame.type === 'error' && frame.error === 'INVALID_SOCKET_FRAME'), true);
});

test('socket capacity, frame size, and message rate limits fail closed', async t => {
  const h = await socketFixture(t, { maxPerParticipant: 1, now: () => 1000 });
  const room = await roomWithAllRoles(h.fixture.service);
  const receiverAuth = { sessionId: room.sessionId, participantId: room.receiver.participantId, participantToken: room.receiver.participantToken };
  const receiver = await h.authenticate(receiverAuth);

  const duplicate = await h.open();
  const duplicateClosed = once(duplicate.ws, 'close');
  duplicate.ws.send(JSON.stringify({ type: 'authenticate', socketProtocolVersion: 1, protocolVersion: 1, ...receiverAuth }));
  const capacityError = await duplicate.next(frame => frame.type === 'error');
  assert.equal(capacityError.error, 'PRESENTATION_UNAVAILABLE');
  assert.equal((await duplicateClosed as [number])[0], 1013);

  const oversized = await h.open();
  const oversizedClosed = once(oversized.ws, 'close');
  oversized.ws.send('x'.repeat(33 * 1024));
  assert.equal((await oversizedClosed as [number])[0], 1009);

  const rateLimited = once(receiver.ws, 'close');
  for (let index = 0; index < 20; index++) {
    receiver.ws.send(JSON.stringify({ type: 'presence', socketProtocolVersion: 1, heartbeatId: null, presence: {} }));
  }
  assert.equal((await rateLimited as [number])[0], 1008);
  assert.equal(receiver.frames.some(frame => frame.type === 'error' && frame.error === 'MESSAGE_RATE_LIMITED'), true);

  const bounded = await socketFixture(t, { maxBufferedAmount: 1 });
  const boundedRoom = await roomWithAllRoles(bounded.fixture.service);
  const slow = await bounded.open();
  const slowClosed = once(slow.ws, 'close');
  slow.ws.send(JSON.stringify({
    type: 'authenticate', socketProtocolVersion: 1, protocolVersion: 1,
    sessionId: boundedRoom.sessionId, participantId: boundedRoom.receiver.participantId, participantToken: boundedRoom.receiver.participantToken,
  }));
  const slowError = await slow.next(frame => frame.type === 'error');
  assert.equal(slowError.error, 'PRESENTATION_UNAVAILABLE');
  assert.equal((await slowClosed as [number])[0], 1013);
  assert.equal(slow.frames.some(frame => frame.type === 'ready'), false);

  const pending = await socketFixture(t, { maxPending: 0 });
  const rejected = new WebSocket(`${pending.base.replace(/^http/, 'ws')}/api/public-improvements/presentation/ws`);
  const response = await new Promise<import('node:http').IncomingMessage>(resolve => rejected.once('unexpected-response', (_request, value) => resolve(value)));
  assert.equal(response.statusCode, 503);
  assert.equal(response.headers['retry-after'], '5');
});
