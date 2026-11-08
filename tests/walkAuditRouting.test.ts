import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectOnLine, routeForStudy } from '../src/services/walkAuditRouting.js';
import type { Position } from '../src/models/walkAudit.js';

const point = (id: number, coordinates: Position) => ({ type: 'Feature', properties: { id: `node/${id}`, name: null }, geometry: { type: 'Point', coordinates } });
const edge = (way: number, from: number, to: number, coordinates: Position[]) => ({ type: 'Feature', properties: { id: `way/${way}/${from}/${to}/0/0`, name: null }, geometry: { type: 'LineString', coordinates } });
const a: Position = [0.001, 0.001], b: Position = [0.002, 0.001], c: Position = [0.003, 0.001], d: Position = [0.003, 0.002];
const area = { geometry: { coordinates: [[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]] } };
const study = (segments: ReturnType<typeof edge>[]) => ({ area, intersections: { type: 'FeatureCollection', features: [point(1, a), point(3, c)] }, segments: { type: 'FeatureCollection', features: segments } });
const intent = { startIntersectionId: 'node/1', end: { featureId: 'way/30/3/4/0/0', locationGps: { longitude: 0.003, latitude: 0.0015 } } };

test('physical distance wins over fewer hops, with reverse orientation and a midblock end', () => {
  const input = study([
    edge(1, 1, 3, [a, [0.001, 0.004], c]),
    edge(10, 2, 1, [b, a]), edge(20, 2, 3, [b, c]), edge(30, 3, 4, [c, d])
  ]);
  const result = routeForStudy(input, intent);
  assert.deepEqual(result.routeSelection.edges.map((item: any) => item.featureId), ['way/10/2/1/0/0', 'way/20/2/3/0/0', 'way/30/3/4/0/0']);
  assert.deepEqual([result.routeSelection.edges[0].fromFraction, result.routeSelection.edges[0].toFraction], [1, 0]);
  assert.ok(Math.abs(result.routeSelection.edges[2].toFraction - 0.5) < 1e-8);
  assert.deepEqual(result.geojson.geometry.coordinates[0], a);
  assert.ok(Math.abs(result.geojson.geometry.coordinates.at(-1)[1] - 0.0015) < 1e-10);
  assert.ok(result.routeSelection.lengthMeters > 250 && result.routeSelection.lengthMeters < 300);
});

test('parallel equal routes are deterministic after network reorder', () => {
  const segments = [edge(12, 1, 2, [a, b]), edge(11, 1, 2, [a, b]), edge(20, 2, 3, [b, c]), edge(30, 3, 4, [c, d])];
  const one = routeForStudy(study(segments), intent), two = routeForStudy(study([...segments].reverse()), intent);
  assert.deepEqual(one.routeSelection, two.routeSelection);
  assert.equal(one.routeSelection.edges[0].featureId, 'way/11/1/2/0/0');
});

test('crossings without shared OSM nodes and clipped outside nodes do not create connections', () => {
  const crossing = study([edge(10, 1, 2, [a, c]), edge(30, 3, 4, [[0.002, 0.0005], [0.002, 0.002]])]);
  assert.throws(() => routeForStudy(crossing, { startIntersectionId: 'node/1', end: { featureId: 'way/30/3/4/0/0', locationGps: { longitude: 0.002, latitude: 0.0015 } } }), /disconnected/);
  const clipped = study([edge(10, 1, 9, [a, b]), edge(30, 9, 4, [c, d])]);
  assert.throws(() => routeForStudy(clipped, { ...intent, end: { ...intent.end, featureId: 'way/30/9/4/0/0' } }), /disconnected/);
});

test('rejects same endpoint and off-edge positions and projects a nearby point', () => {
  const input = study([edge(10, 1, 2, [a, b]), edge(20, 2, 3, [b, c]), edge(30, 3, 4, [c, d])]);
  assert.throws(() => routeForStudy(input, { startIntersectionId: 'node/1', end: { featureId: 'way/10/1/2/0/0', locationGps: { longitude: a[0], latitude: a[1] } } }), /different/);
  assert.throws(() => routeForStudy(input, { ...intent, end: { ...intent.end, locationGps: { longitude: 0.0031, latitude: 0.0015 } } }), /one meter/);
  const projected = projectOnLine([c, d], [0.003000001, 0.0015]);
  assert.ok(projected.distanceMeters < 1);
  assert.ok(Math.abs(projected.fraction - 0.5) < 1e-8);
});
