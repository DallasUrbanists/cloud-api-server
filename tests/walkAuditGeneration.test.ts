import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { validateArea, validateAnswers, validatePrompts } from '../src/utils/walkAuditValidation.js';
import { extractWalkAuditNetwork, generationConfig, WalkAuditGenerator } from '../src/services/walkAuditGeospatial.js';
import { renderWalkAuditThumbnail } from '../src/services/walkAuditThumbnail.js';

const polygon = (ring: number[][]) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } });
const area = validateArea(polygon([[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]));
const fixture = { elements: [
  { type: 'node', id: 1, lon: -0.005, lat: 0.005 }, { type: 'node', id: 2, lon: 0.005, lat: 0.005 },
  { type: 'node', id: 3, lon: 0.015, lat: 0.005 }, { type: 'node', id: 4, lon: 0.005, lat: 0 },
  { type: 'node', id: 5, lon: 0.005, lat: 0.01 },
  { type: 'way', id: 10, nodes: [1, 2, 3], tags: { highway: 'residential' } },
  { type: 'way', id: 20, nodes: [4, 2, 5], tags: { highway: 'service', name: 'Main' } },
  { type: 'way', id: 30, nodes: [1, 3] },
] };

test('boundary and worksheet validation reject unsafe or inconsistent content', () => {
  assert.throws(() => validateArea(polygon([[0, 0], [0.01, 0.01], [0, 0.01], [0.01, 0], [0, 0]])), /intersect/);
  assert.throws(() => validateArea(polygon([[0, 0], [0.01, 0], [0.005, 0], [0.01, 0.01], [0, 0.01], [0, 0]])), /overlap/);
  assert.throws(() => validateArea({ ...area, geometry: { ...area.geometry, coordinates: [...area.geometry.coordinates, area.geometry.coordinates[0]] } }), /holes/);
  assert.throws(() => validateArea(polygon([[179, 0], [-179, 0], [-179, 1], [179, 1], [179, 0]])), /antimeridian/);
  const prompts = validatePrompts([{ id: 'comfort', type: 'choice', label: 'Comfort?', required: true, options: ['yes', 'no'] }]);
  assert.deepEqual(validateAnswers({}, prompts, false), {});
  assert.throws(() => validateAnswers({}, prompts, true), /required/);
  assert.throws(() => validateAnswers({ comfort: 'maybe' }, prompts, true), /worksheet/);
  assert.throws(() => validatePrompts([...prompts, ...prompts]), /unique/);
});

test('OSM topology uses stable IDs and clips crossing roads while keeping boundary nodes', () => {
  const network = extractWalkAuditNetwork(area, fixture);
  assert.deepEqual(network.intersections.features.map(f => f.properties.id), ['node/2']);
  assert.deepEqual(network.segments.features.map(f => f.properties.id), ['way/10/1/2/0/0', 'way/10/2/3/0/0', 'way/20/4/2/0/0', 'way/20/2/5/0/0']);
  assert.equal(network.segments.features[0].properties.fromNodeKey, 'node/1@0.000000000,0.005000000');
  assert.equal(network.segments.features[0].properties.toNodeKey, network.segments.features[1].properties.fromNodeKey);
  assert.equal(network.segments.features[0].properties.toNodeKey, network.segments.features[2].properties.toNodeKey);
  const first = network.segments.features[0].geometry;
  assert.equal(first.type, 'LineString');
  if (first.type === 'LineString') assert.ok(Math.abs(first.coordinates[0][0]) < 1e-10);
  assert.deepEqual(extractWalkAuditNetwork(area, { elements: [] }).segments.features, []);
  assert.throws(() => extractWalkAuditNetwork(area, { elements: [fixture.elements[5]] }), /Incomplete/);
  assert.throws(() => extractWalkAuditNetwork(area, { elements: [], remark: 'runtime error' }), /partial/);
  assert.throws(() => extractWalkAuditNetwork(area, fixture, { deadlineAt: Date.now() - 1 }), /deadline/);
});

test('thumbnail is a decoded nonblank PNG even for an empty network', () => {
  const png = renderWalkAuditThumbnail(area, { type: 'FeatureCollection', features: [] });
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 384); assert.equal(png.readUInt32BE(20), 384);
  const length = png.readUInt32BE(33), pixels = inflateSync(png.subarray(41, 41 + length));
  assert.equal(pixels.length, (384 * 4 + 1) * 384);
  assert.ok(pixels.includes(12));
});

test('generator falls back within its budget, and rejects bad configuration and provider failure', async () => {
  assert.throws(() => generationConfig({ WALK_AUDIT_OVERPASS_URLS: 'http://example.com' }), /HTTPS/);
  let attempts = 0;
  const generator = new WalkAuditGenerator({ urls: ['https://one.example/api', 'https://two.example/api'], timeoutMs: 1000, concurrency: 1, intervalMs: 60000 }, async (url, options) => {
    assert.equal(options?.redirect, 'error');
    assert.equal(options?.method, 'GET');
    assert.match(String((options?.headers as Record<string, string>)['User-Agent']), /DallasUrbanistsWalkAudit/);
    assert.ok(new URL(String(url)).searchParams.has('data'));
    attempts++;
    return attempts === 1 ? new Response('busy', { status: 429 }) : Response.json(fixture);
  }, () => new Date('2026-01-01T00:00:00Z'));
  const generated = await generator.generate(area, 'Example');
  assert.equal(attempts, 2); assert.equal(generated.sourceMetadata.endpoint, 'https://two.example/api');
  assert.equal(generated.sourceMetadata.fetchedAt, '2026-01-01T00:00:00.000Z');
  const failed = new WalkAuditGenerator({ urls: ['https://one.example/api'], timeoutMs: 1000, concurrency: 1, intervalMs: 60000 }, async () => new Response('not-json'));
  await assert.rejects(failed.generate(area, 'Example'), { status: 503 });
});

test('generation enforces payload, deadline and process capacity bounds', async () => {
  const config = { urls: ['https://one.example/api'], timeoutMs: 1000, concurrency: 1, intervalMs: 60000 };
  const huge = new WalkAuditGenerator(config, async () => new Response('{}', { headers: { 'content-length': String(11 * 1024 * 1024) } }));
  await assert.rejects(huge.generate(area, 'Example'), { status: 503 });
  const truncated = new WalkAuditGenerator(config, async () => new Response('{}', { headers: { 'content-length': '10' } }));
  await assert.rejects(truncated.generate(area, 'Example'), { status: 503 });
  const timed = new WalkAuditGenerator({ ...config, timeoutMs: 30 }, async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  await assert.rejects(timed.generate(area, 'Example'), { status: 503 });
  let release!: (response: Response) => void;
  const blocked = new WalkAuditGenerator(config, async () => new Promise<Response>(resolve => { release = resolve; }));
  const first = blocked.generate(area, 'Example');
  await assert.rejects(blocked.generate(area, 'Example'), { status: 429 });
  release(Response.json({ elements: [] }));
  assert.equal((await first).segments.features.length, 0);
  assert.equal((await blocked.generate(area, 'Example', AbortSignal.abort()).catch(error => error)).status, 503);
});

test('feature limits reject oversized networks without truncating them', () => {
  const elements: unknown[] = [
    { type: 'node', id: 1, lon: 0.001, lat: 0.005 }, { type: 'node', id: 2, lon: 0.009, lat: 0.005 },
    ...Array.from({ length: 10001 }, (_, index) => ({ type: 'way', id: index + 1, nodes: [1, 2], tags: { highway: 'residential' } })),
  ];
  assert.throws(() => extractWalkAuditNetwork(area, { elements }), /feature limit/);
});
