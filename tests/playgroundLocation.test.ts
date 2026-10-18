import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaygroundLocationController as Controller } from '../src/controllers/playgroundLocationController.js';

const sessionToken = 'test-session-token-1234';
function setup(t: any) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  process.env.GOOGLE_MAPS_API_KEY = 'server-secret';
  t.after(() => { if (key === undefined) delete process.env.GOOGLE_MAPS_API_KEY; else process.env.GOOGLE_MAPS_API_KEY = key; });
}
async function request(query: any) {
  let data: any, error: any;
  const res = { on() {}, off() {}, set(name: string, value: string) { assert.deepEqual([name, value], ['Cache-Control', 'no-store']); }, json(value: any) { data = value; } };
  await Controller.search({ query } as any, res as any, e => { error = e; });
  return { data, error };
}
test('address autocomplete validates input, limits fields and suggestions, keeps credentials server-side', async t => {
  setup(t);
  const fetch = t.mock.method(globalThis, 'fetch', async (url: any, init: any) => {
    assert.equal(url, 'https://places.googleapis.com/v1/places:autocomplete');
    assert.equal(init.headers['X-Goog-Api-Key'], 'server-secret');
    const body = JSON.parse(init.body); assert.equal(body.input, '1500 Marilla'); assert.equal(body.sessionToken, sessionToken);
    assert.deepEqual(body.locationBias.circle.center, { latitude: 32.7767, longitude: -96.797 });
    return new Response(JSON.stringify({ suggestions: [{ queryPrediction: {} }, ...Array.from({ length: 7 }, (_, i) => ({ placePrediction: { placeId: 'place-' + i, text: { text: 'Address ' + i } } }))] }));
  });
  for (const query of [{}, { input: 'ab', sessionToken }, { input: ['bad'], sessionToken }, { input: 'a'.repeat(201), sessionToken }, { input: 'abc', sessionToken: 'bad' }, { placeId: '../bad', sessionToken }]) assert.equal((await request(query)).error.status, 400);
  assert.equal(fetch.mock.callCount(), 0);
  const { data, error } = await request({ input: '1500 Marilla', sessionToken });
  assert.equal(error, undefined); assert.equal(data.suggestions.length, 5);
  assert.deepEqual(data.suggestions[0], { placeId: 'place-0', text: 'Address 0' });
  assert.ok(!JSON.stringify(data).includes('server-secret'));
});
test('place details resolve numeric coordinates with the same session and validate provider output', async t => {
  setup(t); let invalid = false;
  t.mock.method(globalThis, 'fetch', async (url: any, init: any) => {
    const parsed = new URL(url); assert.equal(parsed.pathname, '/v1/places/place-123');
    assert.equal(parsed.searchParams.get('sessionToken'), sessionToken); assert.equal(init.headers['X-Goog-FieldMask'], 'location,formattedAddress');
    return new Response(JSON.stringify({ formattedAddress: 'Dallas City Hall', location: { latitude: invalid ? 91 : 32.7767, longitude: -96.797 } }));
  });
  assert.deepEqual((await request({ placeId: 'place-123', sessionToken })).data, { latitude: 32.7767, longitude: -96.797, address: 'Dallas City Hall' });
  invalid = true; assert.equal((await request({ placeId: 'place-123', sessionToken })).error.status, 503);
});
test('address errors are actionable and sanitize provider secrets; empty predictions succeed', async t => {
  setup(t);
  delete process.env.GOOGLE_MAPS_API_KEY;
  assert.match((await request({ input: 'Dallas', sessionToken })).error.message, /GOOGLE_MAPS_API_KEY/);
  process.env.GOOGLE_MAPS_API_KEY = 'server-secret';
  for (const response of [new Response('server-secret provider error', { status: 403 }), new Response('invalid JSON'), new Response('{"suggestions":42}')]) {
    const fetch = t.mock.method(globalThis, 'fetch', async () => response);
    const { error } = await request({ input: 'Dallas', sessionToken });
    assert.equal(error.status, 503); assert.ok(!error.message.includes('server-secret')); fetch.mock.restore();
  }
  t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
  assert.deepEqual((await request({ input: 'Dallas', sessionToken })).data, { suggestions: [] });
});
test('address requests cancel provider work on disconnect', async t => {
  setup(t); let close!: () => void; let nextCalled = false; let signal: AbortSignal | undefined;
  const res = { writableEnded: false, on(_name: string, fn: () => void) { close = fn; }, off() {}, set() {}, json() { throw new Error('Unexpected result'); } };
  t.mock.method(globalThis, 'fetch', async (_url, init: any) => {
    signal = init.signal; close(); throw signal!.reason;
  });
  await Controller.search({ query: { input: 'Dallas', sessionToken } } as any, res as any, () => { nextCalled = true; });
  assert.equal(signal?.aborted, true); assert.equal(nextCalled, false);
});
