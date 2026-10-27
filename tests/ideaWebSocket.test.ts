import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { attachIdeaWebSocket, type IdeaSocketOptions } from '../src/ideaWebSocket.js';
import { IdeaNoticeService, type IdeaSnapshot } from '../src/services/ideaNoticeService.js';
import { createApp } from '../src/app.js';
import { swaggerDocument } from '../src/docs/swagger.js';

test('REST reserves both WebSocket paths before identifier routes', async t => {
  const server = createServer(createApp());
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const path of ['/api/ideas/ws', '/api/public-improvements/ideas/ws']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 426);
    assert.equal(response.headers.get('upgrade'), 'websocket');
    assert.equal((await response.json()).error, 'UPGRADE_REQUIRED');
  }
  assert.ok(swaggerDocument.paths['/api/ideas/ws'].get.responses['101']);
});

async function fixture(t: any, options: IdeaSocketOptions = {}) {
  let next: (snapshot: IdeaSnapshot) => void;
  let fail: (error: unknown) => void;
  let starts = 0, stops = 0;
  const service = new IdeaNoticeService((n, e) => {
    next = n; fail = e; starts++;
    queueMicrotask(() => n({ docChanges: () => [] }));
    return () => { stops++; };
  });
  const server = createServer((_req, res) => res.end());
  const close = attachIdeaWebSocket(server, { notices: service, verify: async ({ apiKey }) => {
    if (apiKey !== 'valid') throw new Error('private credential information');
    return { name: 'test' };
  }, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const clients: WebSocket[] = [];
  t.after(async () => {
    clients.forEach(ws => ws.terminate());
    await close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const url = `ws://127.0.0.1:${(server.address() as any).port}`;
  async function client(path = '/api/ideas/ws', config: any = {}) {
    const ws = new WebSocket(url + path, config);
    clients.push(ws);
    const frames: any[] = [];
    ws.on('message', data => frames.push(JSON.parse(data.toString())));
    await once(ws, 'open');
    return { ws, frames, async authenticate() {
      const ready = once(ws, 'message');
      ws.send(JSON.stringify({ type: 'authenticate', apiKey: 'valid' }));
      await ready;
    } };
  }
  return { server, close, url, client, starts: () => starts, stops: () => stops,
    emit() { next({ docChanges: () => [{ type: 'added', doc: { id: '41', data: () => ({ id: 41 }) } }] }); },
    fail() { fail(new Error('private firestore error')); },
  };
}

test('both aliases authenticate, share a listener, and deliver identifier-only notices', async t => {
  const f = await fixture(t);
  const a = await f.client();
  const b = await f.client('/api/public-improvements/ideas/ws');
  assert.equal(f.starts(), 0);
  await a.authenticate(); await b.authenticate();
  assert.deepEqual(a.frames, [{ type: 'ready', protocolVersion: 2 }]);
  assert.equal(f.starts(), 1);
  const messages = Promise.all([once(a.ws, 'message'), once(b.ws, 'message')]);
  f.emit(); await messages;
  assert.deepEqual(a.frames[1], { type: 'idea.created', ideaId: 41 });
  assert.deepEqual(a.frames, b.frames);
  const closed = Promise.all([once(a.ws, 'close'), once(b.ws, 'close')]);
  a.ws.close(); b.ws.close(); await closed;
  // Client close can precede the server close callback.
  await delay(10);
  assert.equal(f.stops(), 1);
});

test('legacy socket aliases keep protocol v1 frames without mixing them into Ideas connections', async t => {
  const f = await fixture(t);
  const ideas = await f.client('/api/ideas/ws');
  const legacy = await f.client('/api/suggestions/ws');
  await ideas.authenticate(); await legacy.authenticate();
  assert.deepEqual(ideas.frames, [{ type: 'ready', protocolVersion: 2 }]);
  assert.deepEqual(legacy.frames, [{ type: 'ready', protocolVersion: 1 }]);
  const messages = Promise.all([once(ideas.ws, 'message'), once(legacy.ws, 'message')]);
  f.emit(); await messages;
  assert.deepEqual(ideas.frames[1], { type: 'idea.created', ideaId: 41 });
  assert.deepEqual(legacy.frames[1], { type: 'suggestion.created', suggestionId: 41 });
  const closed = Promise.all([once(ideas.ws, 'close'), once(legacy.ws, 'close')]);
  ideas.ws.close(); legacy.ws.close(); await closed;
});

test('origin, unknown paths, and URL credentials are rejected before upgrade', async t => {
  const f = await fixture(t);
  for (const [path, origin, expected] of [
    ['/api/ideas/ws', 'https://evil.example', 403],
    ['/not-a-websocket', 'https://map.dallasurbanists.org', 404],
    ['/api/ideas/ws?apiKey=private', 'https://map.dallasurbanists.org', 400],
  ] as const) {
    const ws = new WebSocket(f.url + path, { origin });
    ws.on('error', () => {});
    const status = await new Promise<number>(resolve => ws.once('unexpected-response', (_req, res) => { resolve(res.statusCode!); res.resume(); ws.terminate(); }));
    assert.equal(status, expected);
  }
  const allowed = await f.client('/api/ideas/ws', { origin: 'https://map.dallasurbanists.org' });
  await allowed.authenticate();
});

test('invalid auth, malformed/binary frames, timeout, and oversized frames never start a listener', async t => {
  const f = await fixture(t, { authTimeoutMs: 100 });
  for (const [frame, expected] of [
    [JSON.stringify({ type: 'authenticate', apiKey: 'wrong' }), 4001],
    ['invalid JSON', 1008], [Buffer.from('{}'), 1008], ['x'.repeat(17000), 1009],
    [undefined, 4000],
  ] as const) {
    const { ws, frames } = await f.client();
    const closed = once(ws, 'close');
    if (frame !== undefined) ws.send(frame);
    const [code] = await closed;
    assert.equal(code, expected);
    assert.deepEqual(frames, []);
  }
  assert.equal(f.starts(), 0);
});

test('late authentication completion after timeout cannot subscribe', async t => {
  let release!: () => void;
  const f = await fixture(t, { authTimeoutMs: 40, verify: () => new Promise(resolve => { release = () => resolve({}); }) });
  const { ws } = await f.client();
  const closed = once(ws, 'close');
  ws.send(JSON.stringify({ type: 'authenticate', apiKey: 'valid' }));
  assert.equal((await closed)[0], 4000);
  release(); await delay(10);
  assert.equal(f.starts(), 0);
});

test('pending and authenticated capacity reject overload and listener failure is retryable', async t => {
  const f = await fixture(t, { maxPending: 1, maxAuthenticated: 1 });
  const first = await f.client();
  async function overloaded() {
    const ws = new WebSocket(f.url + '/api/ideas/ws');
    ws.on('error', () => {});
    const status = await new Promise(resolve => ws.once('unexpected-response', (_req, res) => { resolve(res.statusCode); res.resume(); ws.terminate(); }));
    assert.equal(status, 503);
  }
  await overloaded();
  await first.authenticate();
  await overloaded();
  const closed = once(first.ws, 'close');
  f.fail();
  assert.equal((await closed)[0], 1013);
  const recovered = await f.client();
  await recovered.authenticate();
  assert.equal(f.starts(), 2);
});

test('heartbeat terminates unresponsive connections, session renewal and shutdown close cleanly', async t => {
  const f = await fixture(t, { heartbeatMs: 30, sessionMs: 150 });
  const dead = await f.client('/api/ideas/ws', { autoPong: false });
  await dead.authenticate();
  assert.equal((await once(dead.ws, 'close'))[0], 1006);
  const live = await f.client();
  await live.authenticate();
  assert.equal((await once(live.ws, 'close'))[0], 4002);
  const last = await f.client();
  await last.authenticate();
  const closed = once(last.ws, 'close');
  await f.close();
  assert.equal((await closed)[0], 1001);
  await f.close();
});

test('outgoing buffer limit disconnects slow clients', async t => {
  const f = await fixture(t);
  const client = await f.client();
  await client.authenticate();
  const descriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'bufferedAmount')!;
  const closed = once(client.ws, 'close');
  try {
    Object.defineProperty(WebSocket.prototype, 'bufferedAmount', { configurable: true, get: () => 1024 * 1024 + 1 });
    f.emit();
    assert.equal((await closed)[0], 1013);
  } finally { Object.defineProperty(WebSocket.prototype, 'bufferedAmount', descriptor); }
});

test('listener initialization timeout closes authenticated connections without ready', async t => {
  const notices = new IdeaNoticeService(() => () => {});
  const f = await fixture(t, { notices, readyTimeoutMs: 40 });
  const { ws, frames } = await f.client();
  const closed = once(ws, 'close');
  ws.send(JSON.stringify({ type: 'authenticate', apiKey: 'valid' }));
  assert.equal((await closed)[0], 1013);
  assert.deepEqual(frames, []);
});
