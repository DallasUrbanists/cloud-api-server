/**
 * Coordinates Texas/OSM evidence, deterministic construction, and durable publication.
 * Client disconnects cancel reads, while persisted publication states protect retries.
 * @module
 */
import { StreetmixError, type StreetmixPoint, type StreetmixRequest, type StreetmixResult, type StreetmixRoad, type StreetmixCandidate } from '../models/streetmix.js';
import { findOppositeCarriageway, buildDividedStreetmix } from './streetmixDivided.js';
import { buildStreetmix } from './streetmixBuilder.js';
import { requireTexas, nearbyRoads, dallasStreetNames, selectRoad, projectRoad, streetmixCandidates } from './streetmixSources.js';
import { publishStreetmix, verifyStreetmix, streetmixUrl } from './streetmixPublisher.js';
import { FirestoreStreetmixCache, waitForStreetmixCache, type StreetmixCache } from './streetmixCache.js';
import { FirestoreStreetmixStore, streetmixHash, type StreetmixDraft, type StreetmixStore } from './streetmixStore.js';

/** Injectable I/O boundaries; defaults call the live providers and distributed store. */
export interface StreetmixDependencies {
  store: StreetmixStore;
  cache: StreetmixCache;
  requireTexas: typeof requireTexas;
  nearbyRoads: typeof nearbyRoads;
  dallasStreetNames: typeof dallasStreetNames;
  publish: typeof publishStreetmix;
  verify: typeof verifyStreetmix;
}
const defaults: StreetmixDependencies = { store: new FirestoreStreetmixStore(), cache: new FirestoreStreetmixCache(), requireTexas, nearbyRoads, dallasStreetNames, publish: publishStreetmix, verify: verifyStreetmix };

/** Server-owned workflow controls; refresh scopes remain stable across recovery attempts. */
export interface StreetmixGenerationOptions {
  refreshScope?: string;
  beforePublish?: () => Promise<void>;
}

/** Generates and verifies one public design; same-key retries replay or verify only.
 * @example
 * Let's imagine a neighbor testing a spot on their street. They receive a drawing
 * and a Streetmix link where they can explore changes with other neighbors.
 */
export async function generateStreetmix(point: StreetmixRequest, key: string, applicationIdentity: string, signal: AbortSignal, dependencies: StreetmixDependencies = defaults, options: StreetmixGenerationOptions = {}): Promise<StreetmixResult> {
  if (process.env.STREETMIX_ENABLED !== 'true') throw new StreetmixError(503, 'STREETMIX_DISABLED', 'Streetmix generation is disabled. Enable it after the live compatibility check.');
  const application = streetmixHash(applicationIdentity);
  const id = streetmixHash(`${application}:${key}`);
  const fingerprint = streetmixHash(JSON.stringify(point));
  const request = await dependencies.store.reserve(id, fingerprint, application, signal);
  if (request.state === 'completed' && request.result) return request.result;
  try {
    // Preserve recoverability of publications created before shared caching existed.
    if (request.state === 'published' && request.publication && request.draft) {
      await dependencies.verify(request.publication, request.draft.design, signal);
      const result = { ...request.draft, streetmixId: request.publication.id, streetmixUrl: streetmixUrl(request.publication) };
      await dependencies.store.update(id, request.attempt, { state: 'completed', result }, signal);
      return result;
    }
    const result = await sharedGeneration(point, signal, dependencies, options);
    await dependencies.store.update(id, request.attempt, { state: 'completed', result }, signal);
    return result;
  } catch (error) {
    if (request.state !== 'published') await dependencies.store.update(id, request.attempt, { state: 'failed' }, AbortSignal.timeout(3000)).catch(() => {});
    throw error;
  }
}

/** Five decimal places coalesce sub-meter coordinate noise without grouping whole roads. */
export function streetmixCachePoint(point: StreetmixPoint): StreetmixPoint {
  return { latitude: Number(point.latitude.toFixed(5)), longitude: Number(point.longitude.toFixed(5)) };
}

interface Discovery { retrievedAt: string; roads: StreetmixRoad[]; official: { features: any[]; unavailable: boolean } }

async function discover(point: StreetmixPoint, signal: AbortSignal, dependencies: StreetmixDependencies, refreshScope = ''): Promise<Discovery> {
  const id = streetmixHash(`texas-v2:sources:${JSON.stringify(point)}${refreshScope ? `:refresh:${refreshScope}` : ''}`);
  const { owner, record } = await waitForStreetmixCache(dependencies.cache, id, signal);
  if (!owner) {
    if (record.state !== 'ready') throw new StreetmixError(503, 'STORAGE_UNAVAILABLE', 'Street source cache is incomplete.');
    return record.value as Discovery;
  }
  try {
    await dependencies.requireTexas(point, signal);
    const [roads, official] = await Promise.all([dependencies.nearbyRoads(point, signal), dependencies.dallasStreetNames(point, signal).then(features => ({ features, unavailable: false }), () => ({ features: [] as any[], unavailable: true }))]);
    const value = { retrievedAt: new Date().toISOString(), roads, official };
    // Dense provider responses can exceed Firestore's document limit. Fail safely,
    // rather than silently losing the shared lock and making duplicate requests.
    if (Buffer.byteLength(JSON.stringify(value)) > 700000) throw new StreetmixError(502, 'SOURCE_INVALID', 'Street discovery exceeded the shared cache size limit.');
    await dependencies.cache.update(id, record.attempt, { state: 'ready', value, expiresAtMs: Date.now() + 3600000 }, signal);
    return value;
  } catch (error) {
    await dependencies.cache.update(id, record.attempt, { state: 'failed' }, AbortSignal.timeout(3000)).catch(() => {});
    throw error;
  }
}

async function sharedGeneration(request: StreetmixRequest, signal: AbortSignal, dependencies: StreetmixDependencies, options: StreetmixGenerationOptions): Promise<StreetmixResult> {
  const point = streetmixCachePoint(request);
  const { roads, official, retrievedAt } = await discover(point, signal, dependencies, options.refreshScope);
  const nearest = selectRoad(point, roads);
  const candidates = candidatesWithOpposite(point, roads);
  const choice = request.osmWayId === undefined ? undefined : candidates.find(item => item.osmWayId === request.osmWayId);
  if (request.osmWayId !== undefined && !choice) throw new StreetmixError(422, 'INVALID_STREET_SELECTION', 'The selected way is not an eligible public road within 100 meters.');
  const gradeSeparated = candidates.some(item => item.bridge || item.tunnel || item.layer !== '0');
  if (!choice && (nearest.ambiguous || gradeSeparated)) throw new StreetmixError(409, 'STREET_SELECTION_REQUIRED', 'Confirm the intended street or carriageway before creating a public design.', undefined, { candidates });
  const selected = choice ? { ...projectRoad(point, roads.find(road => road.id === choice.osmWayId)!), road: roads.find(road => road.id === choice.osmWayId)!, ambiguous: nearest.ambiguous } : nearest;
  const pairing = findOppositeCarriageway(selected.road, selected.point, roads);
  const id = streetmixHash(`texas-v3:design:${JSON.stringify(point)}:${selected.road.id}:${pairing.pair?.road.id || 0}${options.refreshScope ? `:refresh:${options.refreshScope}` : ''}`);
  const { owner, record } = await waitForStreetmixCache(dependencies.cache, id, signal);
  if (!owner && record.state === 'ready') {
    const cached = record.value as StreetmixResult;
    return { ...cached, cache: { hit: true, generatedAt: cached.generatedAt, expiresAt: new Date(record.expiresAtMs).toISOString(), coordinatePrecision: 5 } };
  }
  if (!owner && record.state === 'publishing') throw new StreetmixError(502, 'PUBLICATION_UNCERTAIN', 'Publication for this location may have succeeded. It will not be repeated automatically.');
  if (!owner && record.state !== 'published') throw new StreetmixError(503, 'STORAGE_UNAVAILABLE', 'Shared street cache is incomplete.');
  let draft = record.draft;
  let publication = record.publication;
  let publicationStarted = record.state === 'published';
  const started = Date.now();
  try {
    if (!publication) {
      const generatedAt = new Date().toISOString();
      const built = pairing.pair ? buildDividedStreetmix(selected.road, selected.point, pairing.pair, retrievedAt) : buildStreetmix(selected.road, selected.point, retrievedAt);
      const dividedRoad = 'dividedRoad' in built ? built.dividedRoad : undefined;
      if (!dividedRoad && pairing.warning) built.warnings.push(pairing.warning);
      if (selected.road.source === 'osm-api') built.warnings.push('Overpass was unavailable; bounded main OpenStreetMap API data was used as a fallback.');
      const carriagewayOnly = !dividedRoad && (selected.road.tags.dual_carriageway === 'yes' || (Boolean(selected.road.tags.oneway) && !['no', '0', 'false'].includes(selected.road.tags.oneway)) || selected.road.tags.junction === 'roundabout');
      if (choice) built.warnings.push('The caller confirmed the selected OSM way. Check its mapped direction, bridge/tunnel status, and carriageway.');
      if (carriagewayOnly) built.warnings.push('This drawing represents the selected carriageway; it may not include the entire divided-road corridor.');
      if (official.unavailable) built.warnings.push('Dallas supplemental coverage or street data was unavailable; OpenStreetMap was used.');
      const matches = official.features.flatMap((feature: any) => {
        if (!Array.isArray(feature.geometry?.paths)) return [];
        return feature.geometry.paths.flatMap((path: any) => {
          if (!Array.isArray(path) || path.length < 2 || path.some((p: any) => !Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) return [];
          const projection = projectRoad(selected.point, { id: 0, tags: {}, geometry: path.map((p: number[]) => ({ latitude: p[1], longitude: p[0] })) });
          return [{ name: feature.attributes?.FULLSTREETNAME ?? feature.attributes?.NAME, distance: projection.distance }];
        });
      }).filter((item: any) => typeof item.name === 'string' && item.distance < 25).sort((a: any, b: any) => a.distance - b.distance || a.name.localeCompare(b.name));
      const officialName = matches[0]?.name as string | undefined;
      if (officialName) built.evidence.push({ field: 'dallasStreetName', value: officialName, basis: 'mapped', source: 'https://gis.dallascityhall.com/arcgis/rest/services/Basemap/DallasAreaRoads/MapServer/2', retrievedAt });
      if (officialName && officialName.toLowerCase() !== built.name.toLowerCase()) built.warnings.push('The nearby Dallas centerline name differs from the selected OSM name; OSM identity was retained.');
      if (officialName) built.quality.mappedCount++;
      draft = { design: built.design, selectedStreet: { osmWayId: selected.road.id, name: built.name, highway: selected.road.tags.highway, distanceMeters: Math.round(selected.distance * 100) / 100, carriagewayOnly, ...(officialName ? { dallasStreetName: officialName } : {}) }, snappedCoordinate: selected.point,
        viewingDirection: { bearingDegrees: Math.round(selected.bearing * 100) / 100, description: 'Looking along OSM way direction; drawing left/right match OSM left/right.' },
        evidence: built.evidence, estimates: built.estimates, warnings: built.warnings, quality: built.quality, ...(dividedRoad ? { dividedRoad } : {}), generatedAt } satisfies StreetmixDraft;
      await dependencies.cache.update(id, record.attempt, { draft }, signal);
      await dependencies.store.publicationBudget(signal);
      // Persist intent BEFORE dispatch. A lost acknowledgement of this write also
      // prevents a second create, even though the first may not have been sent.
      await options.beforePublish?.();
      publicationStarted = true;
      await dependencies.cache.update(id, record.attempt, { state: 'publishing', draft }, signal);
      signal.throwIfAborted();
      publication = await dependencies.publish(draft.design, signal);
      await dependencies.cache.update(id, record.attempt, { state: 'published', publication }, signal);
    }
    if (!draft) throw new StreetmixError(503, 'STORAGE_UNAVAILABLE', 'The saved street design is unavailable.');
    await dependencies.verify(publication, draft.design, signal);
    const result: StreetmixResult = { ...draft, streetmixId: publication.id, streetmixUrl: streetmixUrl(publication) };
    const expiresAtMs = Date.now() + 86400000;
    result.cache = { hit: false, generatedAt: result.generatedAt, expiresAt: new Date(expiresAtMs).toISOString(), coordinatePrecision: 5 };
    await dependencies.cache.update(id, record.attempt, { state: 'ready', value: result, expiresAtMs }, signal);
    console.info(JSON.stringify({ event: 'streetmix_generation', status: 'completed', durationMs: Date.now() - started, estimateCount: result.estimates.length }));
    return result;
  } catch (error) {
    if (!publicationStarted) {
      // Cleanup has its own short deadline; it cannot publish anything.
      await dependencies.cache.update(id, record.attempt, { state: 'failed' }, AbortSignal.timeout(3000)).catch(() => {});
    }
    const safe = error instanceof StreetmixError ? error : new StreetmixError(signal.aborted ? 504 : 503, signal.aborted ? 'GENERATION_TIMEOUT' : 'STREETMIX_UNAVAILABLE', 'Street generation could not complete. Retry with the same request key.');
    console.warn(JSON.stringify({ event: 'streetmix_generation', status: 'failed', code: safe.code, publicationStarted, durationMs: Date.now() - started }));
    throw safe;
  }
}

/** Read-only discovery for map clicks; consumes application quota but never publishes or reserves publication budget. */
export async function findStreetmixCandidates(point: StreetmixPoint, key: string, applicationIdentity: string, signal: AbortSignal, dependencies: StreetmixDependencies = defaults): Promise<{ candidates: StreetmixCandidate[]; coordinate: StreetmixPoint }> {
  if (process.env.STREETMIX_ENABLED !== 'true') throw new StreetmixError(503, 'STREETMIX_DISABLED', 'Streetmix generation is disabled.');
  const application = streetmixHash(applicationIdentity), id = streetmixHash(`${application}:preview:${key}`);
  const record = await dependencies.store.reserve(id, streetmixHash(JSON.stringify(point)), application, signal);
  try {
    const coordinate = streetmixCachePoint(point);
    const { roads } = await discover(coordinate, signal, dependencies);
    return { coordinate, candidates: candidatesWithOpposite(coordinate, roads) };
  } finally {
    // Discovery itself is cached by location. Release this quota reservation so
    // retries can read again; no publication state is ever attached to previews.
    await dependencies.store.update(id, record.attempt, { state: 'failed' }, AbortSignal.timeout(3000)).catch(() => {});
  }
}

function candidatesWithOpposite(point: StreetmixPoint, roads: StreetmixRoad[]): StreetmixCandidate[] {
  return streetmixCandidates(point, roads).map(candidate => {
    const road = roads.find(item => item.id === candidate.osmWayId)!;
    const opposite = findOppositeCarriageway(road, candidate.snappedCoordinate, roads).pair;
    return { ...candidate, ...(opposite ? { oppositeOsmWayId: opposite.road.id } : {}) };
  });
}
