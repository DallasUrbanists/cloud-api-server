import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { connectSuggestionNotices } from '../examples/suggestion-notices.js';

class Socket {
  readyState = 1;
  sent: any[] = [];
  listeners = new Map<string, Array<(event: any) => unknown>>();
  addEventListener(type: string, callback: (event: any) => unknown) {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], callback]);
  }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close(code = 1000) { this.readyState = 3; this.emit('close', { code }); }
  emit(type: string, event: any = {}) { return Promise.all((this.listeners.get(type) ?? []).map(callback => callback(event))); }
  message(value: unknown) { return this.emit('message', { data: JSON.stringify(value) }); }
}

test('browser buffers and deduplicates notices during full refresh and during affected-record refresh', async () => {
  const ws = new Socket();
  let finishAll!: () => void, finishRecords!: () => void;
  const calls: number[][] = [];
  const client = connectSuggestionNotices({ url: 'wss://example/api/suggestions/ws', createSocket: () => ws,
    getCredentials: async () => ({ apiKey: 'valid', appCheckToken: 'fresh' }),
    refreshAll: () => new Promise<void>(resolve => { finishAll = resolve; }),
    refreshSuggestions: async (ids: number[]) => { calls.push(ids); if (calls.length === 1) await new Promise<void>(resolve => { finishRecords = resolve; }); },
  });
  try {
    await ws.emit('open');
    assert.deepEqual(ws.sent, [{ type: 'authenticate', apiKey: 'valid', appCheckToken: 'fresh' }]);
    const full = ws.message({ type: 'ready', protocolVersion: 1 });
    await ws.message({ type: 'suggestion.created', suggestionId: 41 });
    await ws.message({ type: 'suggestion.updated', suggestionId: 41 });
    await ws.message({ type: 'suggestion.deleted', suggestionId: 42 });
    assert.deepEqual(calls, []);
    finishAll(); await full; await delay(140);
    assert.deepEqual(calls, [[41, 42]]);
    await ws.message({ type: 'suggestion.updated', suggestionId: 41 });
    finishRecords(); await delay(140);
    assert.deepEqual(calls, [[41, 42], [41]]);
  } finally { client.stop(); }
});

test('browser aborts stale refreshes and stops retries after rejected authentication', async () => {
  const ws = new Socket();
  let signal!: AbortSignal;
  let release!: () => void;
  const failures: number[] = [];
  const client = connectSuggestionNotices({ url: 'wss://example', createSocket: () => ws,
    getCredentials: async () => ({}), refreshAll: (s: AbortSignal) => { signal = s; return new Promise<void>(r => { release = r; }); },
    refreshSuggestions: () => assert.fail('stale refresh'), onAuthenticationRequired: (code: number) => failures.push(code),
  });
  const full = ws.message({ type: 'ready', protocolVersion: 1 });
  await ws.message({ type: 'suggestion.updated', suggestionId: 1 });
  ws.close(4001);
  assert.equal(signal.aborted, true);
  assert.deepEqual(failures, [4001]);
  release(); await full; await delay(120);
  client.stop();
});

test('browser reacquires credentials and refreshes on reconnect', async () => {
  const sockets: Socket[] = [];
  let credentials = 0, refreshes = 0;
  const client = connectSuggestionNotices({ url: 'wss://example', createSocket: () => {
    const ws = new Socket(); sockets.push(ws); return ws;
  }, getCredentials: async () => ({ apiKey: 'valid', appCheckToken: `token-${++credentials}` }),
  refreshAll: async () => { refreshes++; }, refreshSuggestions: async () => {},
  });
  try {
    await sockets[0].emit('open'); await sockets[0].message({ type: 'ready' });
    sockets[0].close(1013);
    await delay(2100);
    assert.equal(sockets.length, 2);
    await sockets[1].emit('open'); await sockets[1].message({ type: 'ready' });
    assert.equal(credentials, 2); assert.equal(refreshes, 2);
    assert.equal(sockets[1].sent[0].appCheckToken, 'token-2');
  } finally { client.stop(); }
});
