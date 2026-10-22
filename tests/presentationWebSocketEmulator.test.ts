import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import { Firestore } from '@google-cloud/firestore';
import { WebSocket } from 'ws';
import { corsErrorHandler, corsMiddleware } from '../src/middleware/cors.js';
import { PresentationWebSocketServer } from '../src/presentationWebSocket.js';
import { createPresentationRouter } from '../src/routes/presentationRoutes.js';
import { PresentationService } from '../src/services/presentationService.js';
import { FirestorePresentationStore } from '../src/services/presentationStore.js';
import { mapDocToSuggestion } from '../src/services/suggestionService.js';
import { attachSuggestionWebSocket } from '../src/suggestionWebSocket.js';
import { SuggestionNoticeService, type SuggestionSnapshot } from '../src/services/suggestionNoticeService.js';
import { participant, writableState } from './helpers/presentationFixture.js';

const skipReason = !process.env.FIRESTORE_EMULATOR_HOST && 'Set FIRESTORE_EMULATOR_HOST to a reachable loopback emulator to run the two-instance integration test.';

function parseEmulator(): { host: string; port: number } {
  const raw = process.env.FIRESTORE_EMULATOR_HOST!;
  const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error('FIRESTORE_EMULATOR_HOST must be loopback only.');
  return { host, port: Number(url.port || 80) };
}

async function assertEmulatorReachable(): Promise<void> {
  const { host, port } = parseEmulator();
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port });
    socket.once('connect', () => { socket.destroy(); resolve(); });
    socket.once('error', reject);
    socket.setTimeout(1500, () => { socket.destroy(); reject(new Error('Firestore emulator connection timed out.')); });
  });
}

function nextFrame(ws: WebSocket, predicate: (frame: any) => boolean, timeoutMs = 6000, label = 'frame'): Promise<any> {
  return new Promise((resolve, reject) => {
    const observed: string[] = [];
    const timeout = setTimeout(() => { ws.off('message', receive); reject(new Error(`Timed out waiting for emulator WebSocket ${label}; observed ${observed.join(',') || 'no frames'}.`)); }, timeoutMs);
    const receive = (data: Buffer) => {
      let frame: any;
      try { frame = JSON.parse(data.toString()); } catch { return; }
      observed.push(`${frame.type}:${frame.envelope?.session?.revision ?? frame.error ?? ''}`);
      if (frame.type === 'error') { clearTimeout(timeout); ws.off('message', receive); reject(new Error(`Received presentation error frame ${frame.error}.`)); return; }
      if (predicate(frame)) { clearTimeout(timeout); ws.off('message', receive); resolve(frame); }
    };
    ws.on('message', receive);
  });
}

async function connect(base: string, credentials: { sessionId: string; participantId: string; participantToken: string }, label: string): Promise<{ ws: WebSocket; ready: any }> {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/api/public-improvements/presentation/ws`);
  await once(ws, 'open');
  const ready = nextFrame(ws, frame => frame.type === 'ready', 6000, `${label} ready`);
  ws.send(JSON.stringify({ type: 'authenticate', socketProtocolVersion: 1, protocolVersion: 1, ...credentials }));
  return { ws, ready: await ready };
}

function apiHeaders(value: { participantId: string; participantToken: string }, json = false): Record<string, string> {
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    Authorization: `Bearer ${value.participantToken}`,
    'X-Presentation-Participant': value.participantId,
  };
}

test('two independent API instances share presentation snapshots, revocation, content, and reconnect through Firestore', {
  skip: skipReason,
  timeout: 90_000,
}, async t => {
  await assertEmulatorReachable();
  const oldPresentation = process.env.PRESENTATION_ENABLED;
  const oldSocket = process.env.PRESENTATION_WEBSOCKET_ENABLED;
  const oldProject = process.env.GOOGLE_CLOUD_PROJECT;
  const oldDatabase = process.env.PUBLIC_IMPROVEMENTS_DB;
  process.env.PRESENTATION_ENABLED = 'true';
  process.env.PRESENTATION_WEBSOCKET_ENABLED = 'true';
  const projectId = `demo-presentation-ws-${randomUUID().slice(0, 8)}`;
  // The Firestore emulator currently supports only its default database; each
  // run uses its own demo project so test data remains isolated.
  const databaseId = '(default)';
  process.env.GOOGLE_CLOUD_PROJECT = projectId;
  process.env.PUBLIC_IMPROVEMENTS_DB = databaseId;
  t.after(() => {
    for (const [key, value] of [['PRESENTATION_ENABLED', oldPresentation], ['PRESENTATION_WEBSOCKET_ENABLED', oldSocket], ['GOOGLE_CLOUD_PROJECT', oldProject], ['PUBLIC_IMPROVEMENTS_DB', oldDatabase]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  const dbOne = new Firestore({ projectId, databaseId });
  const dbTwo = new Firestore({ projectId, databaseId });
  const ideaId = '41';
  await dbOne.collection('suggestion').doc(ideaId).set({
    id: Number(ideaId), creationDate: '2026-10-22T12:00:00.000Z', modificationDate: '2026-10-22T12:00:00.000Z', status: 'new',
    author: { email: 'private@example.invalid', name: 'Synthetic author' },
    content: { summary: 'Synthetic cross-instance idea', details: 'Emulator-only integration fixture.', photos: [] },
    location: { latitude: 32.78, longitude: -96.79, address: 'Emulator fixture', description: 'Synthetic' },
    internal: { shouldNeverBeSerialized: 'private fixture content' },
  });
  const makeService = (db: Firestore) => new PresentationService(new FirestorePresentationStore(db), {
    getSuggestion: async id => {
      const document = await db.collection('suggestion').doc(String(id)).get();
      return document.exists ? mapDocToSuggestion(document.data(), document.id) : null;
    },
  });
  const serviceOne = makeService(dbOne);
  const serviceTwo = makeService(dbTwo);
  const createApi = (service: PresentationService) => {
    const app = express();
    app.use(express.json({ limit: '32kb', strict: true }));
    app.use(corsMiddleware);
    app.use(corsErrorHandler);
    app.use('/api/public-improvements/presentation', createPresentationRouter(service));
    return createServer(app);
  };
  const serverOne = createApi(serviceOne), serverTwo = createApi(serviceTwo);
  const listener = (next: (snapshot: SuggestionSnapshot) => void) => {
    queueMicrotask(() => next({ docChanges: () => [] }));
    return () => undefined;
  };
  const presentationOne = new PresentationWebSocketServer(serviceOne);
  const presentationTwo = new PresentationWebSocketServer(serviceTwo);
  const dispatcherOne = attachSuggestionWebSocket(serverOne, { presentation: presentationOne, notices: new SuggestionNoticeService(listener), verify: async () => ({ name: 'emulator-test' }) });
  const dispatcherTwo = attachSuggestionWebSocket(serverTwo, { presentation: presentationTwo, notices: new SuggestionNoticeService(listener), verify: async () => ({ name: 'emulator-test' }) });
  serverOne.listen(0, '127.0.0.1'); serverTwo.listen(0, '127.0.0.1');
  await Promise.all([once(serverOne, 'listening'), once(serverTwo, 'listening')]);
  const baseOne = `http://127.0.0.1:${(serverOne.address() as any).port}`;
  const baseTwo = `http://127.0.0.1:${(serverTwo.address() as any).port}`;
  const sockets = new Set<WebSocket>();
  const closeAll = async () => {
    for (const socket of sockets) socket.terminate();
    await Promise.all([dispatcherOne(), dispatcherTwo()]);
    await Promise.all([new Promise<void>(resolve => serverOne.close(() => resolve())), new Promise<void>(resolve => serverTwo.close(() => resolve()))]);
    await dbOne.recursiveDelete(dbOne.collection('presentationSessions'));
    await dbOne.recursiveDelete(dbOne.collection('presentationBootstrapReceipts'));
    await dbOne.recursiveDelete(dbOne.collection('presentationCodeLookups'));
    await dbOne.recursiveDelete(dbOne.collection('presentationRateLimits'));
    await dbOne.collection('suggestion').doc(ideaId).delete().catch(() => undefined);
    await delay(100);
    await Promise.all([dbOne.terminate(), dbTwo.terminate()]);
  };
  t.after(closeAll);

  const receiver = participant();
  const createResponse = await fetch(`${baseOne}/api/public-improvements/presentation/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(receiver),
  });
  assert.equal(createResponse.status, 201);
  const created = await createResponse.json() as any;
  const controller = participant();
  const pairResponse = await fetch(`${baseOne}/api/public-improvements/presentation/pair`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ ...controller, code: created.presenterCode, protocolVersion: 1 }),
  });
  assert.equal(pairResponse.status, 200);
  const paired = await pairResponse.json() as any;
  const audience = participant();
  const joinResponse = await fetch(`${baseOne}/api/public-improvements/presentation/audience/join`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ ...audience, code: created.audienceCode, protocolVersion: 1 }),
  });
  assert.equal(joinResponse.status, 200);

  const tv = await connect(baseTwo, { sessionId: created.sessionId, participantId: receiver.participantId, participantToken: receiver.participantToken }, 'TV');
  sockets.add(tv.ws);
  const controllerSocket = await connect(baseOne, { sessionId: created.sessionId, participantId: controller.participantId, participantToken: controller.participantToken }, 'controller');
  sockets.add(controllerSocket.ws);
  const audienceSocket = await connect(baseTwo, { sessionId: created.sessionId, participantId: audience.participantId, participantToken: audience.participantToken }, 'audience');
  sockets.add(audienceSocket.ws);
  assert.equal(audienceSocket.ready.envelope.participants, null);
  assert.equal(audienceSocket.ready.envelope.audienceCode, undefined);
  assert.equal(JSON.stringify(audienceSocket.ready).includes('shouldNeverBeSerialized'), false);

  const tvSnapshot = nextFrame(tv.ws, frame => frame.type === 'snapshot' && frame.envelope.session.revision === 1, 6000, 'REST-mutation snapshot');
  const state = writableState(paired.state);
  state.selectedIdeaId = ideaId;
  const writeResponse = await fetch(`${baseOne}/api/public-improvements/presentation/sessions/${created.sessionId}/state`, {
    method: 'PUT', headers: { ...apiHeaders(controller, true), 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ protocolVersion: 1, baseRevision: 0, state }),
  });
  assert.equal(writeResponse.status, 200);
  const committedOnSecondClient = (await dbTwo.doc(`presentationSessions/${created.sessionId}`).get()).data();
  assert.equal(committedOnSecondClient?.state?.revision, 1);
  const pushed = await tvSnapshot;
  assert.equal(pushed.envelope.content.id, ideaId);
  assert.equal(pushed.envelope.state.revision, 1);
  assert.equal(pushed.envelope.session.revision, 1);

  const latestSnapshot = nextFrame(tv.ws, frame => frame.type === 'snapshot' && frame.envelope.session.revision === 2, 6000, 'external-write snapshot');
  const storedSessionRef = dbTwo.doc(`presentationSessions/${created.sessionId}`);
  const storedSession = (await storedSessionRef.get()).data()!;
  await storedSessionRef.update({ state: { ...storedSession.state, revision: 2, camera: { ...storedSession.state.camera, zoom: 17 } }, revision: 2 });
  const external = await latestSnapshot;
  assert.equal(external.envelope.state.camera.zoom, 17);

  const refreshedContent = nextFrame(tv.ws, frame => frame.type === 'snapshot' && frame.envelope.session.revision === 3 && frame.envelope.content?.summary === 'Updated synthetic cross-instance idea', 12_000, 'selected-content refresh');
  const source = (await dbOne.collection('suggestion').doc(ideaId).get()).data()!;
  await dbOne.collection('suggestion').doc(ideaId).update({
    content: { ...source.content, summary: 'Updated synthetic cross-instance idea' },
  });
  const refreshed = await refreshedContent;
  assert.equal(refreshed.envelope.content.id, ideaId);
  assert.equal(refreshed.envelope.session.revision, 3);

  const audienceClosed = once(audienceSocket.ws, 'close');
  const leaveResponse = await fetch(`${baseOne}/api/public-improvements/presentation/sessions/${created.sessionId}/participants/me`, {
    method: 'DELETE', headers: apiHeaders(audience),
  });
  assert.equal(leaveResponse.status, 204);
  assert.equal((await audienceClosed as [number])[0], 4001);

  tv.ws.terminate();
  await once(tv.ws, 'close');
  const reconnected = await connect(baseOne, { sessionId: created.sessionId, participantId: receiver.participantId, participantToken: receiver.participantToken }, 'reconnected TV');
  sockets.add(reconnected.ws);
  assert.equal(reconnected.ready.sequence, 1);
  assert.equal(reconnected.ready.envelope.state.revision, 3);
  assert.equal(reconnected.ready.envelope.content.id, ideaId);

  const tvEnded = once(reconnected.ws, 'close');
  const controllerEnded = once(controllerSocket.ws, 'close');
  const endResponse = await fetch(`${baseOne}/api/public-improvements/presentation/sessions/${created.sessionId}`, {
    method: 'DELETE', headers: apiHeaders(receiver),
  });
  assert.equal(endResponse.status, 204);
  assert.equal((await tvEnded as [number])[0], 4003);
  assert.equal((await controllerEnded as [number])[0], 4003);

  for (const path of ['/api/suggestions/ws', '/api/public-improvements/suggestions/ws']) {
    const ws = new WebSocket(`${baseTwo.replace(/^http/, 'ws')}${path}`);
    sockets.add(ws);
    await once(ws, 'open');
    const ready = nextFrame(ws, frame => frame.type === 'ready', 6000, `suggestion alias ${path}`);
    ws.send(JSON.stringify({ type: 'authenticate', apiKey: 'emulator-test' }));
    assert.equal((await ready).type, 'ready');
  }
  await delay(20);
  console.info(JSON.stringify({ event: 'presentation_websocket_emulator_pass', projectId, databaseId, instances: 2, restMutationRevision: 1, externalWriteRevision: 2, selectedContentRefreshRevision: 3 }));
});
