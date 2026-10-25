import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import { Firestore } from '@google-cloud/firestore';
import { WebSocket } from 'ws';
import { corsErrorHandler, corsMiddleware } from '../src/middleware/cors.js';
import { PresentationWebSocketServer } from '../src/presentationWebSocket.js';
import { createPresentationRouter } from '../src/routes/presentationRoutes.js';
import { PresentationService } from '../src/services/presentationService.js';
import { FirestorePresentationStore } from '../src/services/presentationStore.js';
import { attachIdeaWebSocket } from '../src/ideaWebSocket.js';
import { IdeaNoticeService } from '../src/services/ideaNoticeService.js';
import { participant, writableState } from './helpers/presentationFixture.js';

const optInSkip = process.env.PRESENTATION_WEBSOCKET_SOAK === '1'
  ? undefined
  : 'Set PRESENTATION_WEBSOCKET_SOAK=1 to run the explicit ten-minute no-polling soak.';

async function ensureLoopbackEmulator(): Promise<void> {
  const raw = process.env.FIRESTORE_EMULATOR_HOST;
  if (!raw) throw new Error('FIRESTORE_EMULATOR_HOST is required for this opt-in soak.');
  const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error('The presentation soak refuses non-loopback Firestore.');
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port: Number(url.port || 80) });
    socket.once('connect', () => { socket.destroy(); resolve(); });
    socket.once('error', reject);
    socket.setTimeout(1500, () => { socket.destroy(); reject(new Error('Firestore emulator connection timed out.')); });
  });
}

function waitFor(ws: WebSocket, predicate: (frame: any) => boolean, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { ws.off('message', receive); reject(new Error('Timed out waiting for presentation soak frame.')); }, timeoutMs);
    const receive = (data: Buffer) => {
      let frame: any;
      try { frame = JSON.parse(data.toString()); } catch { return; }
      if (frame.type === 'error') { clearTimeout(timeout); ws.off('message', receive); reject(new Error(`Presentation socket returned ${frame.error}.`)); return; }
      if (predicate(frame)) { clearTimeout(timeout); ws.off('message', receive); resolve(frame); }
    };
    ws.on('message', receive);
  });
}

async function openSocket(base: string, auth: { sessionId: string; participantId: string; participantToken: string }): Promise<{ ws: WebSocket; ready: any; heartbeats: number }> {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/api/public-improvements/presentation/ws`);
  await once(ws, 'open');
  let heartbeats = 0;
  ws.on('message', data => {
    let frame: any;
    try { frame = JSON.parse(data.toString()); } catch { return; }
    if (frame.type === 'heartbeat') {
      heartbeats++;
      ws.send(JSON.stringify({ type: 'presence', socketProtocolVersion: 1, heartbeatId: frame.id, presence: {} }));
    }
  });
  const ready = waitFor(ws, frame => frame.type === 'ready');
  ws.send(JSON.stringify({ type: 'authenticate', socketProtocolVersion: 1, protocolVersion: 1, ...auth }));
  const readyFrame = await ready;
  ws.send(JSON.stringify({ type: 'presence', socketProtocolVersion: 1, heartbeatId: null, presence: {} }));
  return { ws, ready: readyFrame, get heartbeats() { return heartbeats; } } as any;
}

test('ten-minute idle/interaction soak keeps sockets live without client sync polling and recovers expiry/disconnect', {
  skip: optInSkip,
  timeout: 12 * 60_000,
}, async t => {
  await ensureLoopbackEmulator();
  const previousFlags = [process.env.PRESENTATION_ENABLED, process.env.PRESENTATION_WEBSOCKET_ENABLED];
  const previousProject = process.env.GOOGLE_CLOUD_PROJECT;
  const previousDatabase = process.env.PUBLIC_IMPROVEMENTS_DB;
  process.env.PRESENTATION_ENABLED = 'true';
  process.env.PRESENTATION_WEBSOCKET_ENABLED = 'true';
  const projectId = `demo-presentation-soak-${randomUUID().slice(0, 8)}`;
  const databaseId = '(default)';
  process.env.GOOGLE_CLOUD_PROJECT = projectId;
  process.env.PUBLIC_IMPROVEMENTS_DB = databaseId;
  t.after(() => {
    if (previousFlags[0] === undefined) delete process.env.PRESENTATION_ENABLED; else process.env.PRESENTATION_ENABLED = previousFlags[0];
    if (previousFlags[1] === undefined) delete process.env.PRESENTATION_WEBSOCKET_ENABLED; else process.env.PRESENTATION_WEBSOCKET_ENABLED = previousFlags[1];
    if (previousProject === undefined) delete process.env.GOOGLE_CLOUD_PROJECT; else process.env.GOOGLE_CLOUD_PROJECT = previousProject;
    if (previousDatabase === undefined) delete process.env.PUBLIC_IMPROVEMENTS_DB; else process.env.PUBLIC_IMPROVEMENTS_DB = previousDatabase;
  });

  const db = new Firestore({ projectId, databaseId });
  let serviceNow = Date.now();
  const service = new PresentationService(new FirestorePresentationStore(db), { now: () => serviceNow });
  const app = express();
  let syncRequests = 0;
  app.use((req, _res, next) => { if (req.path.endsWith('/sync')) syncRequests++; next(); });
  app.use(express.json({ limit: '32kb', strict: true }));
  app.use(corsMiddleware);
  app.use(corsErrorHandler);
  app.use('/api/public-improvements/presentation', createPresentationRouter(service));
  const server = createServer(app);
  const presentation = new PresentationWebSocketServer(service);
  const notices = new IdeaNoticeService(() => () => undefined);
  const closeSockets = attachIdeaWebSocket(server, { presentation, notices, ideasEnabled: false });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const sockets = new Set<WebSocket>();
  const cleanup = async () => {
    for (const socket of sockets) socket.terminate();
    await closeSockets();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.recursiveDelete(db.collection('presentationSessions'));
    await db.recursiveDelete(db.collection('presentationBootstrapReceipts'));
    await db.recursiveDelete(db.collection('presentationCodeLookups'));
    await db.recursiveDelete(db.collection('presentationRateLimits'));
    await db.terminate();
  };
  t.after(cleanup);

  const receiver = participant();
  const create = await fetch(`${base}/api/public-improvements/presentation/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(receiver),
  });
  assert.equal(create.status, 201);
  const created = await create.json() as any;
  const controller = participant();
  const pair = await fetch(`${base}/api/public-improvements/presentation/pair`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ ...controller, code: created.presenterCode }),
  });
  assert.equal(pair.status, 200);
  const paired = await pair.json() as any;
  const tv = await openSocket(base, { sessionId: created.sessionId, participantId: receiver.participantId, participantToken: receiver.participantToken });
  const remote = await openSocket(base, { sessionId: created.sessionId, participantId: controller.participantId, participantToken: controller.participantToken });
  sockets.add(tv.ws); sockets.add(remote.ws);
  const soakStarted = performance.now();

  await delay(20_000);
  const state = writableState(paired.state);
  state.theme = 'light';
  const stateSentAt = performance.now();
  const tvChange = waitFor(tv.ws, frame => frame.type === 'snapshot' && frame.envelope.session.revision === 1);
  const write = await fetch(`${base}/api/public-improvements/presentation/sessions/${created.sessionId}/state`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${controller.participantToken}`, 'X-Presentation-Participant': controller.participantId, 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ protocolVersion: 1, baseRevision: 0, state }),
  });
  assert.equal(write.status, 200);
  const changed = await tvChange;
  const propagationMs = Math.round(performance.now() - stateSentAt);
  assert.equal(changed.envelope.state.theme, 'light');
  console.info(JSON.stringify({ event: 'presentation_websocket_soak_interaction', propagationMs, revision: changed.envelope.session.revision, syncRequests }));

  const elapsedSegments = Array(10).fill(60_000);
  for (let index = 0; index < elapsedSegments.length; index++) {
    await delay(elapsedSegments[index]);
    const elapsedMs = Math.round(performance.now() - soakStarted);
    console.info(JSON.stringify({ event: 'presentation_websocket_soak_progress', elapsedMs, receiverHeartbeats: tv.heartbeats, controllerHeartbeats: remote.heartbeats, syncRequests }));
  }
  const soakDurationMs = Math.round(performance.now() - soakStarted);
  assert.ok(soakDurationMs >= 600_000, `soak ran ${soakDurationMs}ms, expected at least ten minutes`);
  assert.equal(syncRequests, 0);
  assert.ok(tv.heartbeats >= 39, `TV received ${tv.heartbeats} heartbeats`);
  assert.ok(remote.heartbeats >= 39, `controller received ${remote.heartbeats} heartbeats`);
  const sessionAfterSoak = (await db.doc(`presentationSessions/${created.sessionId}`).get()).data();
  assert.equal(sessionAfterSoak?.state?.revision, 1);

  const timeoutStarted = performance.now();
  const tvTimeout = once(tv.ws, 'close');
  tv.ws.terminate();
  const [abnormalCode] = await tvTimeout as [number];
  assert.equal(abnormalCode, 1006);
  const recovered = await openSocket(base, { sessionId: created.sessionId, participantId: receiver.participantId, participantToken: receiver.participantToken });
  sockets.add(recovered.ws);
  assert.equal(recovered.ready.envelope.state.revision, 1);
  const recoveryMs = Math.round(performance.now() - timeoutStarted);

  const beforeCleanup = { sockets: (presentation as any).connections.size, sessionWatchers: (presentation as any).hubs.size };
  serviceNow = Number(sessionAfterSoak!.expiresAtMs) + 1;
  const tvExpired = once(recovered.ws, 'close');
  const controllerExpired = once(remote.ws, 'close');
  await service.expireSocketSession(created.sessionId);
  assert.equal((await tvExpired as [number])[0], 4003);
  assert.equal((await controllerExpired as [number])[0], 4003);
  assert.equal(syncRequests, 0);
  await closeSockets();
  const afterCleanup = { sockets: (presentation as any).connections.size, sessionWatchers: (presentation as any).hubs.size };
  assert.deepEqual(afterCleanup, { sockets: 0, sessionWatchers: 0 });
  console.info(JSON.stringify({ event: 'presentation_websocket_soak_complete', soakDurationMs, propagationMs, recoveryMs, timeoutCloseCode: abnormalCode, expiry: 'SESSION_EXPIRED', beforeCleanup, afterCleanup, syncRequests }));
});
