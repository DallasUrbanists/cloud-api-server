import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readStreetmixThumbnail } from '../src/services/streetmixThumbnail.js';
import { StreetmixError } from '../src/models/streetmix.js';

const id = 'c13a6af0-8888-4444-8888-0bbee0cc1122';
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const signal = () => AbortSignal.timeout(1000);
test('reads only the saved UUID thumbnail, without credentials or redirects', async () => {
  let calls = 0;
  const image = await readStreetmixThumbnail(id, signal(), (async (url, options) => {
    calls++;
    assert.equal(url, `https://streetmix.net/api/v1/streets/${id}/image`);
    assert.equal(options?.redirect, 'error');
    assert.deepEqual(options?.headers, { Accept: 'image/png' });
    return new Response(png, { headers: { 'Content-Type': 'image/png', 'Cross-Origin-Resource-Policy': 'same-origin' } });
  }) as typeof fetch);
  assert.deepEqual(image, png); assert.equal(calls, 1);
});
test('invalid UUIDs cannot fetch arbitrary resources', async () => {
  for (const value of ['123', '../other', 'https://evil.test/x', id + '?x=y']) {
    await assert.rejects(readStreetmixThumbnail(value, signal(), (async () => { throw new Error('Must not fetch'); }) as typeof fetch), (e: unknown) => e instanceof StreetmixError && e.status === 404);
  }
});
for (const status of [204, 404, 500]) {
  test(`thumbnail HTTP ${status} becomes a safe unavailable response`, async () => {
    await assert.rejects(readStreetmixThumbnail(id, signal(), (async () => new Response(null, { status })) as typeof fetch), (e: unknown) => e instanceof StreetmixError && e.status === (status === 500 ? 503 : 404));
  });
}
test('rejects HTML, invalid PNG signatures, oversized streams, and provider failures', async () => {
  for (const response of [new Response('<html/>', { headers: { 'Content-Type': 'text/html' } }), new Response('not PNG', { headers: { 'Content-Type': 'image/png' } }), new Response(new Uint8Array(5 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'image/png' } })]) {
    await assert.rejects(readStreetmixThumbnail(id, signal(), (async () => response) as typeof fetch), (e: unknown) => e instanceof StreetmixError && e.status === 503);
  }
  await assert.rejects(readStreetmixThumbnail(id, signal(), (async () => { throw new Error('private upstream information'); }) as typeof fetch), (e: unknown) => e instanceof StreetmixError && e.message === 'Preview unavailable.');
});
