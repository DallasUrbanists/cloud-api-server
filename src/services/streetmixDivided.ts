/**
 * Pairs nearby opposing carriageways and combines their cross-sections with one median.
 * Geometry is evidence of separation, not a survey of median width or material.
 * @module
 */
import { randomUUID } from 'node:crypto';
import { StreetmixError, type StreetmixPoint, type StreetmixRoad, type StreetmixSegment } from '../models/streetmix.js';
import { projectRoad } from './streetmixSources.js';
import { buildStreetmix, osmWidth } from './streetmixBuilder.js';

const direction = (road: StreetmixRoad) => road.tags.oneway === '-1' ? -1 : ['yes', '1', 'true'].includes(road.tags.oneway) ? 1 : 0;
const normalized = (value?: string) => (value || '').trim().toLowerCase().replace(/\s+/g, ' ');
const difference = (a: number, b: number) => Math.abs((a - b + 540) % 360 - 180);
const flag = (value?: string) => Boolean(value && value !== 'no');

/** One supported opposite carriageway, measured relative to the selected way's node direction. */
export interface StreetmixCarriagewayPair {
  road: StreetmixRoad;
  point: StreetmixPoint;
  separationMeters: number;
  lateralMeters: number;
  reverseGeometry: boolean;
  counterpartInnerSide: 'left' | 'right';
}

/** Conservatively matches identity, road class, opposing traffic, level, alignment and local overlap.
 * Ambiguous counterparts are left unpaired rather than silently joining another corridor.
 */
export function findOppositeCarriageway(selected: StreetmixRoad, point: StreetmixPoint, roads: StreetmixRoad[]): { pair?: StreetmixCarriagewayPair; warning?: string } {
  const sign = direction(selected);
  if (!sign || selected.tags.junction === 'roundabout') return {};
  const origin = projectRoad(point, selected), radians = origin.bearing * Math.PI / 180;
  const bearing = (origin.bearing + (sign === -1 ? 180 : 0)) % 360;
  const ranked: StreetmixCarriagewayPair[] = [];
  for (const road of roads) {
    const otherSign = direction(road);
    const identity = normalized(selected.tags.name) && normalized(selected.tags.name) === normalized(road.tags.name)
      || normalized(selected.tags.ref) && normalized(selected.tags.ref) === normalized(road.tags.ref);
    if (road.id === selected.id || !identity || !otherSign || road.tags.highway !== selected.tags.highway || road.tags.junction === 'roundabout'
      || (road.tags.layer || '0') !== (selected.tags.layer || '0') || flag(road.tags.bridge) !== flag(selected.tags.bridge) || flag(road.tags.tunnel) !== flag(selected.tags.tunnel)) continue;
    const other = projectRoad(origin.point, road);
    if (Math.abs(difference(bearing, (other.bearing + (otherSign === -1 ? 180 : 0)) % 360) - 180) > 20) continue;
    const east = (other.point.longitude - origin.point.longitude) * 111195.08 * Math.cos(point.latitude * Math.PI / 180);
    const north = (other.point.latitude - origin.point.latitude) * 111195.08;
    const lateralMeters = east * Math.cos(radians) - north * Math.sin(radians);
    const longitudinal = east * Math.sin(radians) + north * Math.cos(radians);
    // Texas drives on the right: opposite traffic must be on the driver's left.
    if (other.distance < 4 || other.distance > 45 || lateralMeters * sign >= 0 || Math.abs(longitudinal) > 5) continue;
    // Endpoints of an adjacent block do not establish a parallel carriageway.
    const samples = [-12, 12].map(distance => ({ latitude: origin.point.latitude + distance * Math.cos(radians) / 111195.08, longitude: origin.point.longitude + distance * Math.sin(radians) / (111195.08 * Math.cos(point.latitude * Math.PI / 180)) }));
    if (samples.some(sample => projectRoad(sample, road).distance > other.distance + 3)) continue;
    const otherRadians = other.bearing * Math.PI / 180;
    const innerLateral = -east * Math.cos(otherRadians) + north * Math.sin(otherRadians);
    ranked.push({ road, point: other.point, separationMeters: Math.abs(lateralMeters), lateralMeters, reverseGeometry: difference(origin.bearing, other.bearing) > 90, counterpartInnerSide: innerLateral < 0 ? 'left' : 'right' });
  }
  ranked.sort((a, b) => a.separationMeters - b.separationMeters || a.road.id - b.road.id);
  if (!ranked.length) return { warning: 'No sufficiently certain opposite carriageway was found; this drawing covers only the selected carriageway.' };
  if (ranked.length > 1 && ranked[1].separationMeters - ranked[0].separationMeters < 3) return { warning: 'Multiple possible opposite carriageways were found; this drawing covers only the selected carriageway until the pairing can be resolved.' };
  return { pair: ranked[0] };
}

function reflect(segment: StreetmixSegment): StreetmixSegment {
  const mirror: Record<string, string> = { inbound: 'outbound', outbound: 'inbound', left: 'right', right: 'left', 'twoway-left': 'twoway-right', 'twoway-right': 'twoway-left', 'angled-front-left': 'angled-front-right', 'angled-front-right': 'angled-front-left' };
  return { ...segment, variantString: segment.variantString.split('|').map(part => mirror[part] || part).join('|') };
}

/** Builds both carriageways, reverses opposing geometry, and suppresses duplicated median-side sidewalks.
 * A median inferred from centerline spacing is explicitly estimated, never claimed as measured.
 */
export function buildDividedStreetmix(selected: StreetmixRoad, point: StreetmixPoint, pair: StreetmixCarriagewayPair, now = new Date().toISOString()) {
  const inner = pair.lateralMeters < 0 ? 'left' : 'right';
  const half = (road: StreetmixRoad, at: StreetmixPoint, side: 'left' | 'right') => {
    const built = buildStreetmix({ ...road, tags: { ...road.tags, [`sidewalk:${side}`]: 'no', median: 'no', divider: 'none' } }, at, now);
    const sidewalk = built.evidence.find(item => item.field === `sidewalk:${side}`);
    if (sidewalk) { sidewalk.basis = 'derived'; sidewalk.source = `https://www.openstreetmap.org/way/${road.id}`; }
    return built;
  };
  const first = half(selected, point, inner), second = half(pair.road, pair.point, pair.counterpartInnerSide);
  const roadway = (built: typeof first) => built.design.street.segments.filter(segment => segment.type !== 'sidewalk' && !segment.variantString.endsWith('|sidewalk')).reduce((sum, segment) => sum + segment.width, 0);
  const explicitFirst = osmWidth(selected.tags['median:width']), explicitSecond = osmWidth(pair.road.tags['median:width']);
  if (explicitFirst !== undefined && explicitSecond !== undefined && Math.abs(explicitFirst - explicitSecond) > 0.2) throw new StreetmixError(422, 'INCONSISTENT_STREET', 'The two carriageways have conflicting mapped median widths.');
  const mapped = explicitFirst ?? explicitSecond;
  const medianWidth = Math.round((mapped ?? pair.separationMeters - (roadway(first) + roadway(second)) / 2) * 10000) / 10000;
  if (medianWidth < 0.5 || medianWidth > 30) throw new StreetmixError(422, 'INCONSISTENT_STREET', 'Carriageway spacing and lane widths do not establish a plausible median. Choose a more representative point away from the junction.');
  const opposite = pair.reverseGeometry ? [...second.design.street.segments].reverse().map(reflect) : second.design.street.segments;
  const median: StreetmixSegment = { id: randomUUID(), type: 'divider', variantString: 'median', width: medianWidth, elevation: 0, slope: { on: false, values: [] } };
  const segments = inner === 'left' ? [...opposite, median, ...first.design.street.segments] : [...first.design.street.segments, median, ...opposite];
  const totalWidth = Math.round(segments.reduce((sum, segment) => sum + segment.width, 0) * 10000) / 10000;
  if (totalWidth > 100 || segments.length > 64) throw new StreetmixError(422, 'INCONSISTENT_STREET', 'The combined corridor exceeds supported cross-section dimensions.');
  const evidence = [
    ...first.evidence.map(item => ({ ...item, field: `ways.${selected.id}.${item.field}` })),
    ...second.evidence.map(item => ({ ...item, field: `ways.${pair.road.id}.${item.field}` })),
    { field: 'median.width', value: medianWidth, basis: mapped === undefined ? 'estimated' as const : 'mapped' as const, source: mapped === undefined ? 'OSM centerline spacing minus modeled carriageway half-widths; not a survey' : `https://www.openstreetmap.org/way/${explicitFirst === undefined ? pair.road.id : selected.id}`, retrievedAt: now },
    { field: 'oppositeCarriageway', value: pair.road.id, basis: 'derived' as const, source: `https://www.openstreetmap.org/way/${pair.road.id}`, retrievedAt: now },
    { field: 'totalWidth', value: totalWidth, basis: 'derived' as const, source: 'Combined carriageways and median', retrievedAt: now },
  ];
  const estimates = evidence.filter(item => item.basis === 'estimated');
  const unknownDetails = [...new Set([...first.quality.unknownDetails, ...second.quality.unknownDetails, 'Median material, curb height, landscaping, and median pedestrian facilities are not verified.'])];
  const quality = { mappedCount: evidence.filter(item => item.basis === 'mapped').length, derivedCount: evidence.filter(item => item.basis === 'derived').length, estimatedCount: estimates.length, unknownDetails, summary: `${estimates.length} estimated decisions; both carriageways represented. Median ${mapped === undefined ? 'width is estimated from geometry' : 'width is mapped'}. This is not a survey.` };
  const warnings = [...new Set([...first.warnings.filter(value => !value.includes('estimated decisions;')), ...second.warnings.filter(value => !value.includes('estimated decisions;')),
    'Both opposing carriageways are represented. Median-side sidewalks are omitted to avoid duplicating the corridor edges.',
    mapped === undefined ? 'Median width is estimated from OSM centerline separation and modeled carriageway widths; median presence and shape are schematic.' : 'Median width uses a mapped value; its material and height remain schematic.', quality.summary])];
  return { ...first, design: { ...first.design, street: { ...first.design.street, segments, width: totalWidth } }, evidence, estimates, quality, warnings,
    dividedRoad: { oppositeOsmWayId: pair.road.id, medianWidthMeters: medianWidth, medianWidthBasis: mapped === undefined ? 'estimated' as const : 'mapped' as const, centerlineSeparationMeters: Math.round(pair.separationMeters * 100) / 100 } };
}
