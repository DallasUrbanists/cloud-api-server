/** Isolated presentation-only HTTP/WebSocket smoke server for a loopback Firestore emulator. */
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import express from 'express';
import { getPublicImprovementsDb } from '../config/firestore.js';
import { corsErrorHandler, corsMiddleware } from '../middleware/cors.js';
import { PresentationWebSocketServer } from '../presentationWebSocket.js';
import { createPresentationRouter } from '../routes/presentationRoutes.js';
import { PresentationService } from '../services/presentationService.js';
import { FirestorePresentationStore } from '../services/presentationStore.js';
import { attachSuggestionWebSocket } from '../suggestionWebSocket.js';

function emulatorAddress(): { host: string; port: number } {
  const raw = process.env.FIRESTORE_EMULATOR_HOST;
  if (!raw) throw new Error('FIRESTORE_EMULATOR_HOST is required.');
  const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error('Only a loopback Firestore emulator is permitted.');
  return { host, port: Number(url.port || 80) };
}

async function assertEmulatorReachable(): Promise<void> {
  const { host, port } = emulatorAddress();
  await new Promise<void>((resolve, reject) => {
    const connection = createConnection({ host, port });
    connection.once('connect', () => { connection.destroy(); resolve(); });
    connection.once('error', reject);
    connection.setTimeout(2000, () => { connection.destroy(); reject(new Error('Firestore emulator connection timed out.')); });
  });
}

function assertIsolatedEnvironment(): void {
  if (!process.env.GOOGLE_CLOUD_PROJECT?.startsWith('demo-presentation-ws-')
    || process.env.PUBLIC_IMPROVEMENTS_DB !== '(default)'
    || !process.env.PRESENTATION_HARNESS_NAMESPACE?.startsWith('presentation-ws-smoke-')
    || process.env.PRESENTATION_ENABLED !== 'true'
    || process.env.PRESENTATION_WEBSOCKET_ENABLED !== 'true'
    || process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error('Harness isolation variables are missing or unsafe; start with scripts/presentationWebSocketLocal.ps1.');
  }
}

async function main(): Promise<void> {
  assertIsolatedEnvironment();
  await assertEmulatorReachable();
  const syntheticIdeaId = '987654321';
  const host = process.env.PRESENTATION_HARNESS_HOST!;
  const port = Number(process.env.PRESENTATION_HARNESS_PORT);
  if (host !== '127.0.0.1' || port !== 8187) throw new Error('The harness HTTP listener must bind to 127.0.0.1:8187.');
  const db = getPublicImprovementsDb();
  const suggestion = db.collection('suggestion').doc(syntheticIdeaId);
  const server = createServer();
  let closeSockets: (() => Promise<void>) | undefined;
  let suggestionSeeded = false;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => {
    cleanupPromise ??= (async () => {
      await closeSockets?.().catch(() => undefined);
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      await db.recursiveDelete(db.collection('presentationSessions')).catch(() => undefined);
      await db.recursiveDelete(db.collection('presentationBootstrapReceipts')).catch(() => undefined);
      await db.recursiveDelete(db.collection('presentationCodeLookups')).catch(() => undefined);
      await db.recursiveDelete(db.collection('presentationRateLimits')).catch(() => undefined);
      if (suggestionSeeded) await suggestion.delete().catch(() => undefined);
      await db.terminate().catch(() => undefined);
    })();
    return cleanupPromise;
  };
  try {
    await suggestion.set({
      id: Number(syntheticIdeaId), creationDate: new Date().toISOString(), modificationDate: new Date().toISOString(), status: 'new',
      author: { email: 'smoke@example.invalid', name: 'Synthetic smoke fixture' },
      content: { summary: 'Synthetic WebSocket smoke idea', details: 'Fixture content for local presentation socket testing.', photos: [] },
      location: { latitude: 32.7767, longitude: -96.797, address: 'Synthetic local fixture', description: 'Emulator-only test data.' },
    });
    suggestionSeeded = true;

    const service = new PresentationService(new FirestorePresentationStore(db));
    const app = express();
    app.use(express.json({ limit: '32kb', strict: true }));
    app.use(corsMiddleware);
    app.use(corsErrorHandler);
    app.use('/api/public-improvements/presentation', createPresentationRouter(service));
    app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'presentation-websocket-local-harness' }));
    server.on('request', app);
    const presentationSockets = new PresentationWebSocketServer(service);
    closeSockets = attachSuggestionWebSocket(server, { presentation: presentationSockets, suggestionsEnabled: false });

    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void cleanup().finally(() => process.exit(0));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
      server.listen(port, host);
    });
    console.info(JSON.stringify({
      event: 'presentation_websocket_harness_ready',
      apiBaseUrl: `http://${host}:${port}`,
      firestoreEmulator: emulatorAddress(),
      projectId: process.env.GOOGLE_CLOUD_PROJECT,
      databaseId: process.env.PUBLIC_IMPROVEMENTS_DB,
      namespace: process.env.PRESENTATION_HARNESS_NAMESPACE,
      syntheticIdeaId,
    }));
  } catch (error) {
    await cleanup();
    throw error;
  }
}

void main().catch(error => {
  console.error('Presentation WebSocket harness could not start safely:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
});
