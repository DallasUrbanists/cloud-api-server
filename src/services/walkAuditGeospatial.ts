/** Bounded Overpass retrieval, topology extraction and clipping for study generation. @module */
import { AreaFeature, FeatureCollection, GeneratedStudy, NetworkFeature, Position, WalkAuditError } from '../models/walkAudit.js';
import { pointInRing } from '../utils/walkAuditValidation.js';
import { renderWalkAuditThumbnail } from './walkAuditThumbnail.js';

const MAX_BYTES = 10 * 1024 * 1024, MAX_FEATURES = 10000;
const roads = new Set(['primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street', 'service', 'pedestrian']);
const defaults = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
interface OsmNode { type: 'node'; id: number; lat: number; lon: number }
interface OsmWay { type: 'way'; id: number; nodes: number[]; tags?: Record<string, unknown> }
class ProviderFailure extends Error {
  constructor(readonly reason: string, message: string) { super(message); }
}

/** Validate administrator-controlled endpoints once when constructing the generator. */
export function generationConfig(env: NodeJS.ProcessEnv = process.env): { urls: string[]; timeoutMs: number; concurrency: number; intervalMs: number } {
  const urls = env.WALK_AUDIT_OVERPASS_URLS ? env.WALK_AUDIT_OVERPASS_URLS.split(',').map(s => s.trim()) : defaults;
  if (!urls.length || urls.length > 4 || urls.some(value => {
    try { const url = new URL(value); return url.protocol !== 'https:' || !!url.username || !!url.password || !!url.hash || !!url.search; } catch { return true; }
  })) throw new Error('WALK_AUDIT_OVERPASS_URLS must contain 1 to 4 HTTPS URLs without credentials, query or fragment.');
  const number = (name: string, fallback: number, min: number, max: number): number => {
    const raw = env[name]; if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new Error(`${name} is out of range.`);
    return Number(raw);
  };
  return { urls, timeoutMs: number('WALK_AUDIT_GENERATION_TIMEOUT_MS', 60000, 1000, 300000), concurrency: number('WALK_AUDIT_GENERATION_CONCURRENCY', 2, 1, 20), intervalMs: number('WALK_AUDIT_GENERATION_INTERVAL_MS', 60000, 1000, 86400000) };
}

function cross(a: Position, b: Position): number { return a[0] * b[1] - a[1] * b[0]; }
function clip(a: Position, b: Position, ring: Position[]): Array<[Position, Position]> {
  const delta: Position = [b[0] - a[0], b[1] - a[1]], cuts = [0, 1];
  for (let i = 1; i < ring.length; i++) {
    const c = ring[i - 1], d = ring[i], edge: Position = [d[0] - c[0], d[1] - c[1]], denom = cross(delta, edge);
    if (Math.abs(denom) < 1e-15) continue;
    const rel: Position = [c[0] - a[0], c[1] - a[1]], t = cross(rel, edge) / denom, u = cross(rel, delta) / denom;
    if (t >= -1e-10 && t <= 1 + 1e-10 && u >= -1e-10 && u <= 1 + 1e-10) cuts.push(Math.max(0, Math.min(1, t)));
  }
  cuts.sort((x, y) => x - y);
  const unique = cuts.filter((v, i) => i === 0 || v - cuts[i - 1] > 1e-10);
  const point = (t: number): Position => [a[0] + t * delta[0], a[1] + t * delta[1]];
  const result: Array<[Position, Position]> = [];
  for (let i = 1; i < unique.length; i++) {
    if (unique[i] - unique[i - 1] > 1e-10 && pointInRing(point((unique[i] + unique[i - 1]) / 2), ring)) result.push([point(unique[i - 1]), point(unique[i])]);
  }
  return result;
}

/** Extract stable node and way-edge IDs, clipping every segment to the study. */
export function extractWalkAuditNetwork(area: AreaFeature, value: unknown, control?: { deadlineAt: number; signal?: AbortSignal }): { intersections: FeatureCollection; segments: FeatureCollection } {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { elements?: unknown }).elements)) throw new Error('Invalid Overpass response');
  if (typeof (value as { remark?: unknown }).remark === 'string' && (value as { remark: string }).remark.trim()) throw new Error('Overpass returned a partial result');
  const checkDeadline = (): void => { if (control && (Date.now() >= control.deadlineAt || control.signal?.aborted)) throw new Error('Generation deadline exceeded'); };
  checkDeadline();
  const elements: unknown[] = (value as { elements: unknown[] }).elements;
  const nodes = new Map<number, Position>(), ways: OsmWay[] = [], ids = new Set<number>();
  for (const [index, item] of elements.entries()) {
    if (index % 256 === 0) checkDeadline();
    if (!item || typeof item !== 'object') throw new Error('Invalid OSM element');
    const e = item as { type?: string; id?: number; lat?: number; lon?: number; nodes?: number[]; tags?: Record<string, unknown> };
    if (e.type !== 'node' && e.type !== 'way') continue;
    if (!Number.isSafeInteger(e.id) || e.id! <= 0) throw new Error('Invalid OSM ID');
    if (e.type === 'node') {
      if (nodes.has(e.id!) || typeof e.lon !== 'number' || typeof e.lat !== 'number' || !Number.isFinite(e.lon) || !Number.isFinite(e.lat) || Math.abs(e.lon) > 180 || Math.abs(e.lat) > 90) throw new Error('Invalid OSM node');
      nodes.set(e.id!, [e.lon, e.lat]);
    } else {
      if (ids.has(e.id!) || !Array.isArray(e.nodes) || e.nodes.length < 2 || e.nodes.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('Invalid OSM way');
      ids.add(e.id!);
      if (e.tags && typeof e.tags.highway === 'string' && roads.has(e.tags.highway)) ways.push(e as OsmWay);
    }
  }
  const ring = area.geometry.coordinates[0], segments: NetworkFeature[] = [], neighbours = new Map<number, Set<number>>();
  ways.sort((a, b) => a.id - b.id);
  for (const way of ways) {
    const highway = way.tags!.highway as string;
    const name = typeof way.tags?.name === 'string' ? way.tags.name.slice(0, 300) : null;
    const occurrences = new Map<string, number>();
    for (let i = 1; i < way.nodes.length; i++) {
      if (i % 256 === 1) checkDeadline();
      const from = way.nodes[i - 1], to = way.nodes[i], a = nodes.get(from), b = nodes.get(to);
      if (!a || !b) throw new Error('Incomplete OSM way');
      if (from === to || (a[0] === b[0] && a[1] === b[1])) continue;
      const edgeKey = `${from}/${to}`, occurrence = occurrences.get(edgeKey) ?? 0;
      occurrences.set(edgeKey, occurrence + 1);
      if (!neighbours.has(from)) neighbours.set(from, new Set()); if (!neighbours.has(to)) neighbours.set(to, new Set());
      neighbours.get(from)!.add(to); neighbours.get(to)!.add(from);
      for (const [part, coordinates] of clip(a, b, ring).entries()) {
        segments.push({ type: 'Feature', properties: { id: `way/${way.id}/${edgeKey}/${occurrence}/${part}`, name, highway }, geometry: { type: 'LineString', coordinates } });
        if (segments.length > MAX_FEATURES) throw new Error('Network exceeds feature limit');
      }
    }
  }
  const intersections: NetworkFeature[] = [];
  for (const id of [...neighbours.keys()].sort((a, b) => a - b)) {
    const coordinates = nodes.get(id)!;
    if (neighbours.get(id)!.size >= 3 && pointInRing(coordinates, ring)) intersections.push({ type: 'Feature', properties: { id: `node/${id}`, name: null }, geometry: { type: 'Point', coordinates } });
  }
  if (segments.length + intersections.length > MAX_FEATURES) throw new Error('Network exceeds feature limit');
  return { intersections: { type: 'FeatureCollection', features: intersections }, segments: { type: 'FeatureCollection', features: segments } };
}

async function readBounded(response: Response): Promise<unknown> {
  if (!response.ok) throw new ProviderFailure(response.status === 429 ? 'rate_limited' : 'upstream_status', 'Overpass returned an unsuccessful status');
  if (!response.body) throw new ProviderFailure('missing_body', 'Overpass response has no body');
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > MAX_BYTES) throw new ProviderFailure('response_too_large', 'Overpass response too large');
  const reader = response.body.getReader(), parts: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > MAX_BYTES) throw new ProviderFailure('response_too_large', 'Overpass response too large'); parts.push(item.value); }
  } catch (error) {
    if (error instanceof ProviderFailure) throw error;
    throw new ProviderFailure('truncated_or_stream_error', 'Overpass response stream failed');
  } finally { await reader.cancel().catch(() => {}); }
  if (declared && !response.headers.has('content-encoding') && /^\d+$/.test(declared) && Number(declared) !== size) throw new ProviderFailure('truncated_response', 'Truncated Overpass response');
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown; }
  catch { throw new ProviderFailure('invalid_json', 'Invalid Overpass JSON'); }
}

/** Owns the process-local work limit; PostgreSQL enforces the separate per-user interval. */
export class WalkAuditGenerator {
  private active = 0;
  readonly config: ReturnType<typeof generationConfig>;
  constructor(config = generationConfig(), private readonly fetcher: typeof fetch = fetch, private readonly clock = () => new Date()) { this.config = config; }

  /** Generate the complete network and thumbnail, or fail without saving anything. */
  async generate(area: AreaFeature, neighborhood: string, signal?: AbortSignal): Promise<GeneratedStudy> {
    if (this.active >= this.config.concurrency) throw new WalkAuditError(429, 'GENERATION_BUSY', 'Generation capacity is busy; try again shortly.', 1);
    this.active++;
    const start = Date.now(), deadline = AbortSignal.timeout(this.config.timeoutMs);
    try {
      const ring = area.geometry.coordinates[0], lons = ring.map(p => p[0]), lats = ring.map(p => p[1]);
      const bbox = `${Math.min(...lats)},${Math.min(...lons)},${Math.max(...lats)},${Math.max(...lons)}`;
      const query = `[out:json][timeout:25];(way["highway"~"^(primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service|pedestrian)$"](${bbox});>;);out body;`;
      let network: ReturnType<typeof extractWalkAuditNetwork> | undefined, endpoint = '';
      for (const url of this.config.urls) {
        const remaining = this.config.timeoutMs - (Date.now() - start);
        if (remaining <= 0 || deadline.aborted || signal?.aborted) break;
        const attempt = AbortSignal.timeout(Math.min(remaining, 25000));
        try {
          const combined = AbortSignal.any([deadline, attempt, ...(signal ? [signal] : [])]);
          const response = await this.fetcher(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ data: query }), redirect: 'error', signal: combined });
          const payload = await readBounded(response);
          try { network = extractWalkAuditNetwork(area, payload, { deadlineAt: start + this.config.timeoutMs, signal }); }
          catch { throw new ProviderFailure('invalid_network', 'Overpass network could not be used'); }
          endpoint = url; break;
        } catch (error) {
          const reason = signal?.aborted ? 'client_cancelled' : (deadline.aborted || attempt.aborted || Date.now() - start >= this.config.timeoutMs) ? 'deadline' : error instanceof ProviderFailure ? error.reason : 'network_error';
          console.warn(JSON.stringify({ event: 'walk_audit_generation_attempt_failed', reason }));
        }
      }
      if (!network || Date.now() - start >= this.config.timeoutMs || deadline.aborted || signal?.aborted) throw new WalkAuditError(503, 'GENERATION_UNAVAILABLE', 'Street network generation is temporarily unavailable.');
      const origin = ring[0]; let twiceArea = 0, weightedX = 0, weightedY = 0;
      for (let i = 1; i < ring.length; i++) {
        const a: Position = [ring[i - 1][0] - origin[0], ring[i - 1][1] - origin[1]], b: Position = [ring[i][0] - origin[0], ring[i][1] - origin[1]];
        const part = cross(a, b); twiceArea += part; weightedX += (a[0] + b[0]) * part; weightedY += (a[1] + b[1]) * part;
      }
      const locationGps = { longitude: origin[0] + weightedX / (3 * twiceArea), latitude: origin[1] + weightedY / (3 * twiceArea) };
      const thumbnailPng = renderWalkAuditThumbnail(area, network.segments);
      if (Date.now() - start >= this.config.timeoutMs || deadline.aborted || signal?.aborted) throw new WalkAuditError(503, 'GENERATION_UNAVAILABLE', 'Street network generation is temporarily unavailable.');
      return { area, locationGps, locationDescription: neighborhood, ...network, thumbnailPng,
        sourceMetadata: { provider: 'OpenStreetMap via Overpass', attribution: '© OpenStreetMap contributors', fetchedAt: this.clock().toISOString(), endpoint } };
    } finally { this.active--; }
  }
}
