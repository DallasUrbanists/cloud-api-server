/**
 * Bounded read-only adapters for Census Texas membership, Dallas ArcGIS and OpenStreetMap Overpass.
 * Geometry selects a carriageway; GIS street names are corroboration, not lane evidence.
 * @module
 */
import { StreetmixError, type StreetmixPoint, type StreetmixRoad, type StreetmixCandidate } from '../models/streetmix.js';
import { DALLAS_CITY_LAYER } from './boundarySources.js';

const DALLAS_ROADS = 'https://gis.dallascityhall.com/arcgis/rest/services/Basemap/DallasAreaRoads/MapServer/2';
const OVERPASS = 'https://maps.mail.ru/osm/tools/overpass/api/interpreter';
const eligible = new Set(['primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street']);

/** Server-managed HTTPS endpoint; callers cannot supply an Overpass URL or query. */
export function streetmixOverpassEndpoint(): string {
  try {
    const url = new URL(process.env.STREETMIX_OVERPASS_URL?.trim() || OVERPASS);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || !url.pathname.endsWith('/interpreter')) throw new Error('Invalid endpoint');
    return url.toString();
  } catch { throw new StreetmixError(503, 'STREETMIX_UNAVAILABLE', 'Configure STREETMIX_OVERPASS_URL as an HTTPS interpreter endpoint without credentials or query parameters.'); }
}

/** Fetches bounded JSON with one read retry, an independent timeout and no redirects. */
export async function streetmixJson(url: string, signal: AbortSignal, init: RequestInit = {}, retry = true, timeoutMs = 10000): Promise<any> {
  const started = Date.now();
  let success = false;
  try {
    signal.throwIfAborted();
    const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
    if (!response.ok) {
      await response.body?.cancel();
      if (retry && [429, 502, 503, 504].includes(response.status)) return streetmixJson(url, signal, init, false, timeoutMs);
      throw new StreetmixError(502, 'SOURCE_UNAVAILABLE', 'A street data provider is unavailable. Retry shortly.');
    }
    if (Number(response.headers.get('content-length')) > 2_000_000) {
      await response.body?.cancel();
      throw new StreetmixError(502, 'SOURCE_INVALID', 'Street data exceeded the response limit.');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No body');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.length;
        if (size > 2_000_000) throw new StreetmixError(502, 'SOURCE_INVALID', 'Street data exceeded the response limit.');
        chunks.push(item.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (json?.error) throw new Error('Provider error');
    success = true;
    return json;
  } catch (error) {
    if (signal.aborted) throw new StreetmixError(504, 'GENERATION_TIMEOUT', 'Street generation exceeded its deadline.');
    if (error instanceof StreetmixError) throw error;
    if (retry) return streetmixJson(url, signal, init, false, timeoutMs);
    throw new StreetmixError(502, 'SOURCE_INVALID', 'A street data provider returned an invalid or incomplete response.');
  } finally {
    console.info(JSON.stringify({ event: 'streetmix_provider', provider: new URL(url).hostname, method: init.method ?? 'GET', durationMs: Date.now() - started, success }));
  }
}

function pointQuery(layer: string, point: StreetmixPoint, extra: Record<string, string> = {}): string {
  return `${layer}/query?${new URLSearchParams({ f: 'json', geometry: `${point.longitude},${point.latitude}`, geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outFields: 'OBJECTID', returnGeometry: 'false', ...extra })}`;
}

/** Checks the Census state polygon rather than treating the Texas bounding box as coverage. */
export async function requireTexas(point: StreetmixPoint, signal: AbortSignal): Promise<void> {
  if (point.latitude < 25 || point.latitude > 37 || point.longitude < -107 || point.longitude > -93) throw new StreetmixError(422, 'OUTSIDE_TEXAS', 'This service supports coordinates in Texas.');
  const layer = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/0';
  const data = await streetmixJson(pointQuery(layer, point, { where: "STATE = '48'", outFields: 'STATE' }), signal);
  if (!Array.isArray(data.features) || data.exceededTransferLimit) throw new StreetmixError(502, 'SOURCE_INVALID', 'Texas state coverage could not be checked.');
  if (!data.features.some((feature: any) => feature.attributes?.STATE === '48')) throw new StreetmixError(422, 'OUTSIDE_TEXAS', 'This service supports coordinates in Texas.');
}

/** Retrieves eligible carriageways around the coordinate, without accepting caller query text. */
export async function nearbyRoads(point: StreetmixPoint, signal: AbortSignal): Promise<StreetmixRoad[]> {
  const endpoint = streetmixOverpassEndpoint();
  const latitudeDelta = 150 / 111195.08;
  const longitudeDelta = latitudeDelta / Math.cos(point.latitude * Math.PI / 180);
  // Four decimal places reduce accidental cache fragmentation while retaining
  // ample margin around the 100 m selection radius.
  const south = Number((point.latitude - latitudeDelta).toFixed(4)), north = Number((point.latitude + latitudeDelta).toFixed(4));
  const west = Number((point.longitude - longitudeDelta).toFixed(4)), east = Number((point.longitude + longitudeDelta).toFixed(4));
  const query = `[out:json][timeout:25];way(${south},${west},${north},${east})[highway];out geom;`;
  let data: any;
  let source: StreetmixRoad['source'] = 'overpass';
  try {
    // One bounded Overpass attempt leaves time for the explicitly enabled fallback.
    data = await streetmixJson(endpoint, signal, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': 'DallasUrbanists-Streetmix/1.0 (+https://dallasurbanists.org)' }, body: new URLSearchParams({ data: query }).toString() }, false, 20000);
    if (!Array.isArray(data.elements) || data.remark) throw new StreetmixError(502, 'SOURCE_INVALID', 'OpenStreetMap returned incomplete street data.');
  } catch (error) {
    if (signal.aborted || process.env.STREETMIX_OSM_FALLBACK_ENABLED !== 'true') throw error;
    const url = `https://api.openstreetmap.org/api/0.6/map.json?${new URLSearchParams({ bbox: `${west},${south},${east},${north}` })}`;
    data = await streetmixJson(url, signal, { headers: { Accept: 'application/json', 'User-Agent': 'DallasUrbanists-Streetmix/1.0 (+https://dallasurbanists.org)' } }, false);
    if (!Array.isArray(data.elements)) throw new StreetmixError(502, 'SOURCE_INVALID', 'OpenStreetMap returned incomplete street data.');
    const nodes = new Map<number, { lat: number; lon: number }>();
    for (const item of data.elements) if (item.type === 'node' && Number.isSafeInteger(item.id) && Number.isFinite(item.lat) && Number.isFinite(item.lon)) nodes.set(item.id, { lat: item.lat, lon: item.lon });
    data.elements = data.elements.filter((item: any) => item.type === 'way').map((way: any) => ({ ...way, geometry: Array.isArray(way.nodes) ? way.nodes.map((id: number) => nodes.get(id)) : undefined }));
    source = 'osm-api';
  }
  return data.elements.flatMap((way: any): StreetmixRoad[] => {
    if (way.type !== 'way' || !Number.isSafeInteger(way.id) || !eligible.has(way.tags?.highway)
      || ['private', 'no'].includes(way.tags?.access) || way.tags?.motor_vehicle === 'no' || way.tags?.vehicle === 'no' || way.tags?.area === 'yes'
      || !Array.isArray(way.geometry) || way.geometry.length < 2) return [];
    if (way.geometry.some((p: any) => !p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon) || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180)) return [];
    const tags: Record<string, string> = Object.fromEntries(Object.entries(way.tags).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    return [{ id: way.id, tags, source, geometry: way.geometry.map((p: any) => ({ latitude: p.lat, longitude: p.lon })) }];
  });
}

/** Gets nearby official centerlines as a best-effort supplement with WGS84 geometry. */
export async function dallasStreetNames(point: StreetmixPoint, signal: AbortSignal): Promise<any[]> {
  // Avoid Dallas-only requests elsewhere in Texas. Within the coarse envelope,
  // confirm actual city membership before querying Dallas centerlines.
  if (point.latitude < 32.5 || point.latitude > 33.1 || point.longitude < -97.1 || point.longitude > -96.4) return [];
  const membership = await streetmixJson(pointQuery(DALLAS_CITY_LAYER, point), signal);
  if (!Array.isArray(membership.features)) throw new StreetmixError(502, 'SOURCE_INVALID', 'Dallas supplemental coverage could not be checked.');
  if (!membership.features.length) return [];
  const data = await streetmixJson(pointQuery(DALLAS_ROADS, point, { distance: '100', units: 'esriSRUnit_Meter', outFields: '*', returnGeometry: 'true', outSR: '4326' }), signal);
  if (!Array.isArray(data.features) || data.exceededTransferLimit) throw new StreetmixError(502, 'SOURCE_INVALID', 'Dallas street data is incomplete.');
  return data.features;
}

/** Projects onto road segments in a local metric plane; sufficient for a 150 m query. */
export function projectRoad(point: StreetmixPoint, road: StreetmixRoad): { point: StreetmixPoint; distance: number; bearing: number } {
  const north = 111195.08;
  const east = north * Math.cos(point.latitude * Math.PI / 180);
  let best = { point, distance: Infinity, bearing: 0 };
  for (let i = 1; i < road.geometry.length; i++) {
    const a = road.geometry[i - 1], b = road.geometry[i];
    const ax = (a.longitude - point.longitude) * east, ay = (a.latitude - point.latitude) * north;
    const dx = (b.longitude - a.longitude) * east, dy = (b.latitude - a.latitude) * north;
    if (dx * dx + dy * dy === 0) continue;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy)));
    const distance = Math.hypot(ax + t * dx, ay + t * dy);
    if (distance < best.distance) best = { point: { latitude: a.latitude + t * (b.latitude - a.latitude), longitude: a.longitude + t * (b.longitude - a.longitude) }, distance, bearing: (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360 };
  }
  return best;
}

/** Selects the nearest eligible carriageway, using OSM ID as a stable tie-breaker. */
export function selectRoad(point: StreetmixPoint, roads: StreetmixRoad[]) {
  const ranked = roads.map(road => ({ road, ...projectRoad(point, road) })).filter(item => item.distance <= 100)
    .sort((a, b) => a.distance - b.distance || a.road.id - b.road.id);
  if (!ranked.length) throw new StreetmixError(422, 'NO_SUITABLE_STREET', 'No supported public street was found within 100 meters.');
  return { ...ranked[0], ambiguous: ranked.length > 1 && ranked[1].distance - ranked[0].distance < 10 };
}

/** Offers all nearby eligible ways, including grade separation clues, without publishing. */
export function streetmixCandidates(point: StreetmixPoint, roads: StreetmixRoad[]): StreetmixCandidate[] {
  return roads.map(road => ({ road, ...projectRoad(point, road) })).filter(item => item.distance <= 100)
    .sort((a, b) => a.distance - b.distance || a.road.id - b.road.id).map(({ road, distance, bearing, point: snappedCoordinate }) => ({
      geometry: clipCandidateRoad(point, road), snappedCoordinate, osmWayId: road.id, name: road.tags.name || road.tags.ref || 'Unnamed Texas road', highway: road.tags.highway,
      distanceMeters: Math.round(distance * 100) / 100, bearingDegrees: Math.round(bearing * 100) / 100,
      layer: road.tags.layer || '0', bridge: Boolean(road.tags.bridge && road.tags.bridge !== 'no'), tunnel: Boolean(road.tags.tunnel && road.tags.tunnel !== 'no'), osmUrl: `https://www.openstreetmap.org/way/${road.id}`,
    }));
}

/** Clips segments to a 250-meter square around the request, retaining crossings with endpoints outside it. */
export function clipCandidateRoad(point: StreetmixPoint, road: StreetmixRoad): StreetmixPoint[][] {
  const dy = 250 / 111195.08, dx = dy / Math.cos(point.latitude * Math.PI / 180);
  const lines: StreetmixPoint[][] = [];
  for (let i = 1; i < road.geometry.length; i++) {
    const a = road.geometry[i - 1], b = road.geometry[i];
    const x = b.longitude - a.longitude, y = b.latitude - a.latitude;
    let low = 0, high = 1, visible = true;
    for (const [p, q] of [[-x, a.longitude - (point.longitude - dx)], [x, point.longitude + dx - a.longitude], [-y, a.latitude - (point.latitude - dy)], [y, point.latitude + dy - a.latitude]]) {
      if (p === 0) { if (q < 0) visible = false; continue; }
      const t = q / p;
      if (p < 0) low = Math.max(low, t); else high = Math.min(high, t);
    }
    if (visible && low <= high) lines.push([low, high].map(t => ({ latitude: Number((a.latitude + y * t).toFixed(7)), longitude: Number((a.longitude + x * t).toFixed(7)) })));
  }
  return lines;
}
