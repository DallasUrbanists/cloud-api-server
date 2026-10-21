import test from 'node:test';
import assert from 'node:assert/strict';
import { SuggestionNoticeService, type SuggestionSnapshot, type SuggestionNotice, type SuggestionWatch } from '../src/services/suggestionNoticeService.js';
import { verifyApplicationAccess, apiAccess } from '../src/middleware/auth.js';

export function fakeWatch() {
  let next: (snapshot: SuggestionSnapshot) => void;
  let error: (error: unknown) => void;
  let starts = 0, stops = 0;
  const watch: SuggestionWatch = (n, e) => { starts++; next = n; error = e; return () => { stops++; }; };
  return { watch, starts: () => starts, stops: () => stops,
    emit(changes: Array<{ type: 'added' | 'modified' | 'removed'; id: string; data?: unknown }> = []) {
      next({ docChanges: () => changes.map(c => ({ type: c.type, doc: { id: c.id, data: () => c.data } })) });
    }, fail() { error(new Error('private provider details')); },
  };
}

test('one listener suppresses baseline, compares public fields, and cleans up on last unsubscribe', () => {
  const source = fakeWatch();
  const notices = new SuggestionNoticeService(source.watch);
  const received: SuggestionNotice[] = [];
  let ready = 0;
  const subscriber = () => ({ ready() { ready++; }, notice(n: SuggestionNotice) { received.push(n); }, failed() { assert.fail('unexpected failure'); } });
  const first = notices.subscribe(subscriber());
  const second = notices.subscribe(subscriber());
  assert.equal(source.starts(), 1);
  const data = { id: 41, content: { summary: 'Shade' }, location: { latitude: 32, longitude: -96 } };
  source.emit([{ type: 'added', id: '41', data }]);
  assert.equal(ready, 2);
  assert.deepEqual(received, []);
  source.emit([{ type: 'modified', id: '41', data: { ...data, _deleting: true } }]);
  assert.deepEqual(received, []);
  source.emit([{ type: 'modified', id: '41', data: { ...data, emoji: '🌳' } }]);
  assert.equal(received.length, 2);
  source.emit([{ type: 'modified', id: '41', data: { ...data, emoji: '🌳', streetmix: { coordinate: data.location, revision: 1 } } }]);
  assert.equal(received.length, 4);
  source.emit([{ type: 'added', id: '42', data: { ...data, id: 42 } }]);
  assert.equal(received[4].type, 'suggestion.created');
  source.emit([{ type: 'removed', id: '41' }]);
  assert.deepEqual(received[6], { type: 'suggestion.deleted', suggestionId: 41 });
  const third = notices.subscribe(subscriber());
  assert.equal(ready, 3);
  first(); second();
  assert.equal(source.stops(), 0);
  third();
  assert.equal(source.stops(), 1);
});

test('listener failure resets its baseline and fences callbacks from old listeners', () => {
  const callbacks: Array<(s: SuggestionSnapshot) => void> = [];
  const errors: Array<(error: unknown) => void> = [];
  let failures = 0, ready = 0, notices = 0, stops = 0;
  const service = new SuggestionNoticeService((n, e) => { callbacks.push(n); errors.push(e); return () => { stops++; }; });
  const subscriber = { ready() { ready++; }, notice() { notices++; }, failed() { failures++; } };
  service.subscribe(subscriber);
  callbacks[0]({ docChanges: () => [] });
  errors[0](new Error());
  assert.equal(failures, 1);
  assert.equal(stops, 1);
  const unsubscribe = service.subscribe(subscriber);
  callbacks[0]({ docChanges: () => { assert.fail('stale snapshot'); } });
  callbacks[1]({ docChanges: () => [{ type: 'added', doc: { id: '1', data: () => ({ id: 1 }) } }] });
  assert.equal(ready, 2);
  assert.equal(notices, 0);
  unsubscribe();
});

test('shared verifier preserves API-key and production App Check policy', async t => {
  const previous = { keys: process.env.API_KEYS_JSON, mode: process.env.NODE_ENV };
  t.after(() => {
    for (const [name, value] of [['API_KEYS_JSON', previous.keys], ['NODE_ENV', previous.mode]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
    }
  });
  process.env.API_KEYS_JSON = '[{"key":"valid","name":"map"}]';
  process.env.NODE_ENV = 'production';
  let checks = 0;
  const verifyToken = async (token?: string) => { checks++; if (token !== 'attestation') throw new Error('invalid'); };
  await assert.rejects(verifyApplicationAccess({}, 'required', verifyToken));
  await assert.rejects(verifyApplicationAccess({ apiKey: 'invalid' }, 'optional', verifyToken));
  assert.equal(checks, 0);
  await assert.rejects(verifyApplicationAccess({ apiKey: 'valid' }, 'required', verifyToken));
  assert.deepEqual(await verifyApplicationAccess({ apiKey: 'valid', appCheckToken: 'attestation' }, 'required', verifyToken), { name: 'map' });
  assert.equal(checks, 2);
  await verifyApplicationAccess({}, 'optional', verifyToken);
  process.env.NODE_ENV = 'development';
  await verifyApplicationAccess({ apiKey: 'valid' }, 'required', verifyToken);
  assert.equal(checks, 2);
  const req = { header: (name: string) => name === 'X-API-Key' ? 'valid' : undefined } as any;
  let advanced = false;
  await apiAccess({ apiKey: 'required' })(req, {} as any, () => { advanced = true; });
  assert.equal(advanced, true);
  assert.deepEqual(req.apiClient, { name: 'map' });
  process.env.NODE_ENV = 'production';
  let status = 0;
  await apiAccess({ apiKey: 'required' })(req, { status(s: number) { status = s; return this; }, json() {} } as any, () => assert.fail());
  assert.equal(status, 401);
});
