/**
 * Read-only live provider/serialization check; publication requires explicit flags
 * and normal feature enablement. A stable request key makes interrupted runs safe.
 * @module
 */
import { streetmixKey, streetmixRequest } from '../models/streetmix.js';
import { requireTexas, nearbyRoads, dallasStreetNames, selectRoad } from '../services/streetmixSources.js';
import { buildStreetmix } from '../services/streetmixBuilder.js';
import { generateStreetmix } from '../services/streetmixService.js';

const args = process.argv.slice(2);
const option = (name: string) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
if (args.some(arg => arg !== '--publish' && !/^--(latitude|longitude|request-key|osm-way-id)=/.test(arg))) throw new Error('Unknown smoke-test option.');
const point = streetmixRequest({ ...(option('osm-way-id') ? { osmWayId: Number(option('osm-way-id')) } : {}), latitude: Number(option('latitude') ?? 32.78014), longitude: Number(option('longitude') ?? -96.79701) });
const signal = AbortSignal.timeout(60000);
if (args.includes('--publish')) {
  const key = streetmixKey(option('request-key'));
  const result = await generateStreetmix(point, key, 'streetmix-compatibility-smoke', signal);
  console.log(JSON.stringify(result, null, 2));
} else {
  await requireTexas(point, signal);
  const [roads, official] = await Promise.all([nearbyRoads(point, signal), dallasStreetNames(point, signal).catch(() => [])]);
  const selected = selectRoad(point, roads);
  const built = buildStreetmix(selected.road, selected.point);
  console.log(JSON.stringify({ mode: 'read-only', osmWayId: selected.road.id, tags: selected.road.tags, officialFeatureCount: official.length, ...built }, null, 2));
}
