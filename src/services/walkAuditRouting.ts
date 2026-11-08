/** Deterministic shortest walking routes over the study's saved OSM topology. @module */
import { FeatureCollection, NetworkFeature, Position, WalkAuditError } from '../models/walkAudit.js';
import { fields, invalid, pointInRing, text } from '../utils/walkAuditValidation.js';

type Row = Record<string, any>;
interface Edge { id: string; from: string; to: string; coordinates: Position[]; length: number; feature: NetworkFeature }
interface Traversal { featureId: string; fromFraction: number; toFraction: number }
interface Arc { edge: Edge; next: string; forward: boolean }

/** A source OSM node and its clipped position together identify a graph node. */
export function endpointKey(nodeId: string | number, point: Position): string {
  const normalize = (value: number): string => (Math.abs(value) < 0.0000000005 ? 0 : value).toFixed(9);
  return `node/${nodeId}@${normalize(point[0])},${normalize(point[1])}`;
}

function distance(a: Position, b: Position): number {
  const radians = Math.PI / 180, latitude = (b[1] - a[1]) * radians, longitude = (b[0] - a[0]) * radians;
  const h = Math.sin(latitude / 2) ** 2 + Math.cos(a[1] * radians) * Math.cos(b[1] * radians) * Math.sin(longitude / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(Math.min(1, h)));
}
function lengths(points: Position[]): number[] { return points.slice(1).map((point, i) => distance(points[i], point)); }

/** Project a point onto a saved polyline; fraction is measured by physical length. */
export function projectOnLine(points: Position[], point: Position): { position: Position; fraction: number; distanceMeters: number } {
  const segmentLengths = lengths(points), total = segmentLengths.reduce((sum, value) => sum + value, 0);
  if (points.length < 2 || !Number.isFinite(total) || total <= 0) invalid('The selected street edge has no usable length.');
  let walked = 0, bestDistance = Infinity, bestPosition: Position = points[0], bestFraction = 0;
  for (let i = 0; i < segmentLengths.length; i++) {
    const a = points[i], b = points[i + 1], sx = 111320 * Math.cos((a[1] + b[1] + point[1]) / 3 * Math.PI / 180), sy = 111320;
    const dx = (b[0] - a[0]) * sx, dy = (b[1] - a[1]) * sy;
    const denominator = dx * dx + dy * dy;
    const t = denominator ? Math.max(0, Math.min(1, ((point[0] - a[0]) * sx * dx + (point[1] - a[1]) * sy * dy) / denominator)) : 0;
    const position: Position = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const away = distance(position, point);
    if (away < bestDistance) { bestDistance = away; bestPosition = position; bestFraction = (walked + segmentLengths[i] * t) / total; }
    walked += segmentLengths[i];
  }
  return { position: bestPosition, fraction: bestFraction, distanceMeters: bestDistance };
}

function edgesFor(collection: FeatureCollection): Edge[] {
  const edges: Edge[] = [];
  for (const feature of collection.features) {
    if (feature.geometry.type !== 'LineString' || feature.geometry.coordinates.length < 2) continue;
    const coordinates = feature.geometry.coordinates, id = feature.properties.id;
    const match = /^way\/[^/]+\/([^/]+)\/([^/]+)\/[^/]+\/[^/]+$/.exec(id);
    // Unrecognized legacy IDs are isolated: proximity alone must never join roads.
    const from = feature.properties.fromNodeKey || (match ? endpointKey(match[1], coordinates[0]) : `edge/${id}/from`);
    const to = feature.properties.toNodeKey || (match ? endpointKey(match[2], coordinates[coordinates.length - 1]) : `edge/${id}/to`);
    const length = lengths(coordinates).reduce((sum, value) => sum + value, 0);
    if (Number.isFinite(length) && length > 0) edges.push({ id, from, to, coordinates, length, feature });
  }
  return edges.sort((a, b) => a.id.localeCompare(b.id));
}

class MinHeap {
  private values: Array<{ node: string; cost: number }> = [];
  private less(a: { node: string; cost: number }, b: { node: string; cost: number }): boolean {
    return a.cost < b.cost || (a.cost === b.cost && a.node < b.node);
  }
  push(value: { node: string; cost: number }): void {
    let index = this.values.push(value) - 1;
    while (index) {
      const parent = Math.floor((index - 1) / 2);
      if (!this.less(this.values[index], this.values[parent])) break;
      [this.values[index], this.values[parent]] = [this.values[parent], this.values[index]]; index = parent;
    }
  }
  pop(): { node: string; cost: number } | undefined {
    const first = this.values[0], last = this.values.pop();
    if (this.values.length && last) {
      this.values[0] = last; let index = 0;
      while (true) {
        const left = index * 2 + 1, right = left + 1;
        let next = index;
        if (left < this.values.length && this.less(this.values[left], this.values[next])) next = left;
        if (right < this.values.length && this.less(this.values[right], this.values[next])) next = right;
        if (next === index) break;
        [this.values[index], this.values[next]] = [this.values[next], this.values[index]]; index = next;
      }
    }
    return first;
  }
}

function sliceLine(points: Position[], from: number, to: number): Position[] {
  if (from > to) return sliceLine(points, to, from).reverse();
  const segments = lengths(points), total = segments.reduce((sum, value) => sum + value, 0), start = total * from, end = total * to;
  let walked = 0; const result: Position[] = [];
  for (let i = 0; i < segments.length; i++) {
    const len = segments[i], segmentEnd = walked + len;
    if (len > 0 && segmentEnd >= start - 1e-8 && walked <= end + 1e-8) {
      const interpolate = (at: number): Position => {
        const t = Math.max(0, Math.min(1, (at - walked) / len));
        return [points[i][0] + (points[i + 1][0] - points[i][0]) * t, points[i][1] + (points[i + 1][1] - points[i][1]) * t];
      };
      for (const point of [interpolate(Math.max(start, walked)), interpolate(Math.min(end, segmentEnd))]) {
        const last = result[result.length - 1];
        if (!last || distance(last, point) > 0.000001) result.push(point);
      }
    }
    walked = segmentEnd;
  }
  return result;
}

/** Validate endpoint intent and calculate the shortest path, never client-supplied edges. */
export function routeForStudy(study: Row, input: unknown): Row {
  const intent = fields(input, ['startIntersectionId', 'end'], 'routeSelection');
  const startId = text(intent.startIntersectionId, 'startIntersectionId', 255);
  const intersection = (study.intersections as FeatureCollection).features.find(item => item.properties.id === startId && item.geometry.type === 'Point');
  if (!intersection || intersection.geometry.type !== 'Point' || !/^node\/[^/]+$/.test(startId)) invalid('The route start must be a saved study intersection.');
  const end = fields(intent.end, ['featureId', 'locationGps'], 'route end');
  const endId = text(end.featureId, 'end featureId', 255), gps = fields(end.locationGps, ['longitude', 'latitude'], 'end locationGps');
  if (typeof gps.longitude !== 'number' || typeof gps.latitude !== 'number' || !Number.isFinite(gps.longitude) || !Number.isFinite(gps.latitude)) invalid('The route end must have finite coordinates.');
  const requested: Position = [gps.longitude, gps.latitude];
  if (!pointInRing(requested, study.area.geometry.coordinates[0])) invalid('The route end must be inside the study boundary.');
  const edges = edgesFor(study.segments), target = edges.find(edge => edge.id === endId);
  if (!target) invalid('The route end must identify a saved street edge.');
  const projected = projectOnLine(target.coordinates, requested);
  if (projected.distanceMeters > 1 || !pointInRing(projected.position, study.area.geometry.coordinates[0])) invalid('The route end must be within one meter of its street edge.');
  if (distance(intersection.geometry.coordinates, projected.position) < 0.001) invalid('The route endpoints must be different.');
  const startKey = endpointKey(startId.slice(5), intersection.geometry.coordinates);
  const adjacency = new Map<string, Arc[]>();
  const add = (node: string, arc: Arc): void => { const list = adjacency.get(node) ?? []; list.push(arc); adjacency.set(node, list); };
  for (const edge of edges) { add(edge.from, { edge, next: edge.to, forward: true }); add(edge.to, { edge, next: edge.from, forward: false }); }
  for (const list of adjacency.values()) list.sort((a, b) => a.edge.id.localeCompare(b.edge.id) || a.next.localeCompare(b.next) || Number(a.forward) - Number(b.forward));
  const costs = new Map<string, number>([[startKey, 0]]), previous = new Map<string, { node: string; arc: Arc }>();
  const heap = new MinHeap(); heap.push({ node: startKey, cost: 0 });
  while (true) {
    const item = heap.pop(); if (!item) break;
    if (item.cost !== costs.get(item.node)) continue;
    for (const arc of adjacency.get(item.node) ?? []) {
      const cost = item.cost + arc.edge.length, old = costs.get(arc.next);
      if (old === undefined || cost < old - 1e-9) { costs.set(arc.next, cost); previous.set(arc.next, { node: item.node, arc }); heap.push({ node: arc.next, cost }); }
    }
  }
  const candidates = [
    { node: target.from, from: 0, extra: target.length * projected.fraction },
    { node: target.to, from: 1, extra: target.length * (1 - projected.fraction) }
  ].filter(candidate => costs.has(candidate.node)).map(candidate => ({ ...candidate, cost: costs.get(candidate.node)! + candidate.extra }))
    .sort((a, b) => a.cost - b.cost || a.node.localeCompare(b.node) || a.from - b.from);
  if (!candidates.length) throw new WalkAuditError(409, 'ROUTE_DISCONNECTED', 'The selected endpoint is disconnected from the starting intersection.');
  const best = candidates[0], reverse: Traversal[] = [];
  let node = best.node;
  while (node !== startKey) {
    const step = previous.get(node); if (!step) throw new WalkAuditError(409, 'ROUTE_DISCONNECTED', 'The route could not be connected.');
    reverse.push({ featureId: step.arc.edge.id, fromFraction: step.arc.forward ? 0 : 1, toFraction: step.arc.forward ? 1 : 0 }); node = step.node;
  }
  const traversals = reverse.reverse();
  if (Math.abs(best.from - projected.fraction) > 1e-12) traversals.push({ featureId: target.id, fromFraction: best.from, toFraction: projected.fraction });
  if (!traversals.length || best.cost < 0.001) invalid('The route must have a nonzero length.');
  const byId = new Map(edges.map(edge => [edge.id, edge])), coordinates: Position[] = [];
  for (const traversal of traversals) {
    for (const point of sliceLine(byId.get(traversal.featureId)!.coordinates, traversal.fromFraction, traversal.toFraction)) {
      const last = coordinates[coordinates.length - 1];
      if (!last || distance(last, point) > 0.000001) coordinates.push(point);
    }
  }
  if (coordinates.length < 2) invalid('The route must have a nonzero length.');
  return {
    routeSelection: { startIntersectionId: startId, end: { featureId: endId, locationGps: { longitude: projected.position[0], latitude: projected.position[1] } }, edges: traversals, lengthMeters: Number(best.cost.toFixed(3)) },
    geojson: { type: 'Feature', properties: { id: traversals[0].featureId }, geometry: { type: 'LineString', coordinates } }
  };
}
