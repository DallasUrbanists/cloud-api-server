import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { WebSocket } from 'ws';
import { IdeaNoticeService } from '../src/services/ideaNoticeService.js';
import { attachIdeaWebSocket } from '../src/ideaWebSocket.js';
import { ideasCollectionName } from '../src/config/ideas.js';

test('Firestore emulator broadcasts external writes to browsers on two server instances', {
  skip: !process.env.FIRESTORE_EMULATOR_HOST && 'Set FIRESTORE_EMULATOR_HOST to run the two-instance integration test.', timeout: 30000,
}, async t => {
  // Unique demo project; never use the application's production database.
  const projectId = `demo-ws-${randomUUID().slice(0, 8)}`;
  const db = new Firestore({ projectId, databaseId: '(default)' });
  const ref = db.collection(ideasCollectionName()).doc('41');
  await ref.set({ id: 41, content: { summary: 'Initial' } });
  const clients: WebSocket[] = [];
  const cleanups: Array<() => Promise<void>> = [];
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    await db.terminate();
  });
  for (let i = 0; i < 2; i++) {
    const server = createServer();
    const instanceDb = new Firestore({ projectId, databaseId: '(default)' });
    const notices = new IdeaNoticeService((next, error) => instanceDb.collection(ideasCollectionName()).onSnapshot(next, error));
    const close = attachIdeaWebSocket(server, { notices, verify: async () => ({}) });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    let ws: WebSocket | undefined;
    cleanups.push(async () => {
      ws?.terminate();
      await close();
      await new Promise<void>(r => server.close(() => r()));
      await instanceDb.terminate();
    });
    ws = new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}/api/ideas/ws`);
    clients.push(ws);
    await once(ws, 'open');
    const ready = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'authenticate', apiKey: 'test' }));
    assert.deepEqual(JSON.parse((await ready)[0].toString()), { type: 'ready', protocolVersion: 2 });
  }
  async function expectNotice(write: () => Promise<unknown>, type: string, id: number) {
    const messages = clients.map(ws => once(ws, 'message'));
    await write();
    for (const message of await Promise.all(messages)) assert.deepEqual(JSON.parse(message[0].toString()), { type, ideaId: id });
  }
  await expectNotice(() => ref.update({ emoji: '🌳' }), 'idea.updated', 41);
  const created = db.collection(ideasCollectionName()).doc('42');
  await expectNotice(() => created.set({ id: 42 }), 'idea.created', 42);
  await expectNotice(() => ref.delete(), 'idea.deleted', 41);
  await created.delete();
});
