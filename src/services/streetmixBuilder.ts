/**
 * Deterministic conversion from OSM carriageway tags to a Streetmix cross-section.
 * Every represented facility and dimension records its evidence or explicit estimate.
 * @module
 */
import { randomUUID } from 'node:crypto';
import compatibility from '../data/streetmixCompatibility.json' with { type: 'json' };
import { StreetmixError, type StreetmixDesign, type StreetmixEvidence, type StreetmixPoint, type StreetmixRoad, type StreetmixSegment } from '../models/streetmix.js';

const feet = (value: number) => value * 0.3048;
const round = (value: number) => Math.round(value * 10000) / 10000;
const invalid = (message: string): never => { throw new StreetmixError(422, 'INCONSISTENT_STREET', message); };

/** Parses OSM metric or explicitly suffixed customary widths, rejecting compound values. */
export function osmWidth(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(m|meters?|metres?|ft|feet|')?$/i);
  if (!match) return invalid('A mapped width is not a supported single measurement.');
  const value = Number(match[1]) * (/^(ft|feet|')$/i.test(match[2] ?? '') ? 0.3048 : 1);
  if (value <= 0 || value > 100) return invalid('A mapped width is outside the supported range.');
  return value;
}

function count(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || Number(raw) > 16) return invalid('Mapped lane counts must be whole numbers from zero to sixteen.');
  return Number(raw);
}

/** Builds a left-to-right drawing while looking along OSM way direction.
 * @example
 * Let's imagine a neighbor choosing a residential street. Two travel lanes and
 * sidewalks become a drawing, with estimated widths listed beside it.
 */
export function buildStreetmix(road: StreetmixRoad, point: StreetmixPoint, now = new Date().toISOString()) {
  const tags = road.tags;
  const evidence: StreetmixEvidence[] = [];
  const unknownDetails: string[] = [];
  const ruralOrUnknown = tags.urban !== 'yes' && tags.rural !== 'no';
  const warnings: string[] = ['Approximate existing conditions: mapped data may be incomplete or outdated.'];
  const source = `https://www.openstreetmap.org/way/${road.id}`;
  function record(field: string, value: string | number | boolean, basis: StreetmixEvidence['basis']) {
    evidence.push({ field, value, basis, source: basis === 'estimated' ? 'streetmix-texas-defaults-v2' : source, retrievedAt: now });
  }
  function width(field: string, raw: string | undefined, fallbackFeet: number): number {
    const value = osmWidth(raw) ?? feet(fallbackFeet);
    record(field, round(value), raw === undefined ? 'estimated' : 'mapped');
    return value;
  }
  record('roadContext', ruralOrUnknown ? (tags.rural === 'yes' || tags.urban === 'no' ? 'rural' : 'unknown') : 'urban', tags.urban !== undefined || tags.rural !== undefined ? 'mapped' : 'estimated');
  const oneway = tags.oneway === '-1' ? -1 : tags.oneway === 'yes' || tags.oneway === '1' || tags.oneway === 'true' || (tags.oneway === undefined && tags.junction === 'roundabout') ? 1 : 0;
  if (tags.oneway && !['yes', '1', 'true', '-1', 'no', '0', 'false'].includes(tags.oneway)) invalid('This street has unsupported conditional direction rules.');
  record('oneway', oneway, tags.oneway !== undefined ? 'mapped' : 'derived');
  let forward = count(tags['lanes:forward']);
  let backward = count(tags['lanes:backward']);
  const both = count(tags['lanes:both_ways']) ?? 0;
  if (both > 1 || (oneway && both)) invalid('This shared-lane configuration is not supported.');
  const explicitTotal = count(tags.lanes);
  let total = explicitTotal ?? (forward !== undefined && backward !== undefined ? forward + backward + both : undefined);
  if (total === undefined) {
    total = oneway ? (forward ?? backward ?? 1) : Math.max((forward ?? 0) + (backward ?? 0) + both + (forward !== undefined || backward !== undefined ? 1 : 0), 2);
    record('lanes', total, 'estimated');
  } else record('lanes', total, explicitTotal !== undefined ? 'mapped' : 'derived');
  if (oneway) {
    forward ??= oneway === 1 ? total : 0;
    backward ??= oneway === -1 ? total : 0;
    if ((oneway === 1 && backward !== 0) || (oneway === -1 && forward !== 0)) invalid('One-way and directional lane tags conflict.');
  } else {
    forward ??= backward !== undefined ? total - backward - both : Math.ceil((total - both) / 2);
    backward ??= total - forward - both;
  }
  if (forward < 0 || backward < 0 || total < 1 || total > 16 || forward + backward + both !== total) invalid('Total and directional lane counts conflict.');
  if (!oneway && (!forward || !backward)) warnings.push('This two-way street has a single shared travel lane; directional allocation is approximate.');
  record('lanes:forward', forward, tags['lanes:forward'] === undefined ? 'derived' : 'mapped');
  record('lanes:backward', backward, tags['lanes:backward'] === undefined ? 'derived' : 'mapped');
  const name = (tags.name || tags.ref || 'Unnamed Texas road').slice(0, 200);
  record('name', name, tags.name ? 'mapped' : 'estimated');
  record('highway', tags.highway, 'mapped');
  const segments: StreetmixSegment[] = [];
  const adjustable = new Set<StreetmixSegment>();
  const widthFields = new Map<StreetmixSegment, string>();
  const outsideRoadway = new Set<StreetmixSegment>();
  function add(type: keyof typeof compatibility.variants, variant: string, value: number, field: string, outside = false, estimate = false) {
    if (!(compatibility.variants[type] as string[]).includes(variant)) throw new Error('Unpinned Streetmix variant');
    const segment: StreetmixSegment = { id: randomUUID(), type, variantString: variant, width: round(value), elevation: type === 'sidewalk' || variant.endsWith('|sidewalk') ? 0.1524 : 0, slope: { on: false, values: [] } };
    record(`segments.${segments.length}.facility`, field, 'derived');
    segments.push(segment);
    if (outside) outsideRoadway.add(segment);
    if (estimate) { adjustable.add(segment); widthFields.set(segment, `${field}.width`); }
  }
  function sidewalk(side: 'left' | 'right') {
    const explicit = tags[`sidewalk:${side}`] ?? tags['sidewalk:both'];
    const general = tags.sidewalk;
    const present = explicit !== undefined ? ['yes', 'separate'].includes(explicit)
      : general !== undefined ? ['both', 'yes', side, 'separate'].includes(general) : !ruralOrUnknown;
    if (explicit === undefined && general === undefined) unknownDetails.push(`Sidewalk on the ${side}: not mapped; ${present ? 'assumed from mapped urban context' : 'omitted from this drawing, presence unknown'}.`);
    record(`sidewalk:${side}`, present, explicit !== undefined || general !== undefined ? 'mapped' : 'estimated');
    if (present) add('sidewalk', 'empty', width(`sidewalk:${side}:width`, tags[`sidewalk:${side}:width`] ?? tags['sidewalk:both:width'], 5), `sidewalk:${side}`, true);
  }
  function parking(side: 'left' | 'right') {
    const value = tags[`parking:${side}`] ?? tags['parking:both'] ?? tags[`parking:lane:${side}`] ?? tags['parking:lane:both'];
    if (!value) return;
    record(`parking:${side}`, value, 'mapped');
    if (['no', 'none', 'no_parking', 'no_stopping', 'separate'].includes(value)) return;
    const orientation = tags[`parking:${side}:orientation`] ?? tags['parking:both:orientation'] ?? (value === 'lane' ? 'parallel' : value);
    if (!['parallel', 'perpendicular', 'diagonal'].includes(orientation)) { warnings.push(`Unsupported ${side} parking arrangement omitted: ${value}.`); return; }
    const direction = orientation === 'perpendicular' ? 'sideways' : orientation === 'diagonal' ? (side === 'left' ? 'angled-front-left' : 'angled-front-right') : side === 'left' ? (oneway === 1 ? 'outbound' : 'inbound') : (oneway === -1 ? 'inbound' : 'outbound');
    add('parking-lane', `${direction}|${side}`, width(`parking:${side}:width`, tags[`parking:${side}:width`] ?? tags['parking:both:width'], orientation === 'parallel' ? 8 : 16), `parking:${side}`);
  }
  function cycling(side: 'left' | 'right') {
    let value: string | undefined = tags[`cycleway:${side}`] ?? tags['cycleway:both'];
    let opposite = value === 'opposite_lane' || value === 'opposite_track';
    if (opposite) value = value!.replace('opposite_', '');
    if (value === undefined && tags.cycleway) {
      if (tags.cycleway === 'opposite_lane' || tags.cycleway === 'opposite_track') { opposite = true; value = side === (oneway === -1 ? 'right' : 'left') ? tags.cycleway.replace('opposite_', '') : undefined; }
      else if (!oneway || side === (oneway === 1 ? 'right' : 'left')) value = tags.cycleway;
    }
    if (!value) return;
    record(`cycleway:${side}`, value, 'mapped');
    if (!['lane', 'track'].includes(value)) {
      if (!['no', 'none', 'separate'].includes(value)) warnings.push(`Unsupported ${side} cycle facility omitted: ${value}.`);
      return;
    }
    const dirTag = tags[`cycleway:${side}:oneway`];
    const defaultDirection = oneway ? ((oneway === 1) !== opposite ? 'outbound' : 'inbound') : side === 'left' ? 'inbound' : 'outbound';
    const direction = dirTag === 'no' ? `twoway-${side}` : dirTag === '-1' ? 'inbound' : dirTag === 'yes' ? 'outbound' : defaultDirection;
    // Track elevation is representational: no grade/curb measurement is implied.
    if (value === 'track') warnings.push(`The ${side} cycle track uses a schematic raised representation; its elevation is not measured.`);
    const bufferWidth = tags[`cycleway:${side}:buffer`] ?? tags['cycleway:both:buffer'];
    const separation = tags[`cycleway:${side}:separation`] ?? tags['cycleway:both:separation'];
    const hasSeparator = bufferWidth !== undefined && !['no', '0'].includes(bufferWidth) || separation !== undefined && !['no', 'none'].includes(separation);
    const separator = () => {
      if (!hasSeparator) return;
      record(`cycleway:${side}:separation`, separation ?? 'buffer', 'mapped');
      add('divider', separation && separation !== 'painted_buffer' ? 'median' : 'striped-buffer', width(`cycleway:${side}:buffer:width`, bufferWidth, 4), `cycleway:${side}:separator`, value === 'track');
    };
    if (side === 'right') separator();
    add('bike-lane', `${direction}|regular|${value === 'track' ? 'sidewalk' : 'road'}`, width(`cycleway:${side}:width`, tags[`cycleway:${side}:width`] ?? tags['cycleway:both:width'] ?? tags['cycleway:width'], 5), `cycleway:${side}`, value === 'track');
    if (side === 'left') separator();
  }
  const allWidths = tags['width:lanes']?.split('|');
  const backwardLanes = backward;
  if (allWidths && allWidths.length !== total) invalid('Mapped per-lane widths conflict with the total lane count.');
  function lanes(direction: 'inbound' | 'outbound', n: number, suffix: 'backward' | 'forward') {
    const rawWidths = tags[`width:lanes:${suffix}`];
    // Directional backward tags are ordered as seen by southbound/backward
    // travelers; reverse them to match the drawing's OSM-way-facing view.
    const widths = rawWidths !== undefined ? (suffix === 'backward' ? rawWidths.split('|').reverse() : rawWidths.split('|')) : allWidths?.slice(suffix === 'backward' ? 0 : backwardLanes + both, suffix === 'backward' ? backwardLanes : total);
    if (widths && widths.length !== n) invalid('Mapped per-lane widths conflict with the directional lane count.');
    for (let i = 0; i < n; i++) {
      const raw = widths?.[i] || tags['width:lanes:default'];
      add('drive-lane', `${direction}|car`, width(`lanes:${suffix}.${i}.width`, raw, ['residential', 'living_street'].includes(tags.highway) ? 10 : 11), `lanes:${suffix}.${i}`, false, raw === undefined);
    }
  }
  function shoulder(side: 'left' | 'right') {
    const value = tags[`shoulder:${side}`] ?? tags.shoulder;
    const raw = tags[`shoulder:${side}:width`] ?? tags['shoulder:width'];
    const present = raw !== undefined || value === 'yes' || value === 'both' || value === side;
    if (value === undefined && raw === undefined) { unknownDetails.push(`Shoulder on the ${side}: not mapped; omitted, presence and width unknown.`); return; }
    record(`shoulder:${side}`, present, 'mapped');
    if (!present) return;
    // Streetmix's painted buffer is only a schematic shoulder, never a bike lane.
    add('divider', 'striped-buffer', width(`shoulder:${side}:width`, raw, 3), `shoulder:${side}`);
    warnings.push(`The ${side} shoulder uses a schematic striped buffer; it is not a verified bike facility.`);
  }
  if (tags.surface) {
    record('surface', tags.surface, 'mapped');
    if (!['asphalt', 'concrete', 'paved', 'concrete:plates', 'paving_stones'].includes(tags.surface)) warnings.push(`Mapped surface is ${tags.surface}; the Streetmix pavement appearance is schematic and does not reproduce this surface.`);
  } else unknownDetails.push('Road surface: not mapped.');
  if (tags.maxspeed) record('maxspeed', tags.maxspeed, 'mapped');
  if (ruralOrUnknown) {
    warnings.push('Rural or unknown road context: unmapped sidewalks are omitted and missing two-way lane counts default to two, not four. These are assumptions, not observed conditions.');
    unknownDetails.push('Roadside ditches, drainage, clear zones, and adjacent land uses are not reconstructed.');
  }
  sidewalk('left'); cycling('left'); shoulder('left'); parking('left'); lanes('inbound', backward, 'backward');
  if (both) {
    const rawWidth = tags['width:lanes:both_ways'] ?? allWidths?.[backward];
    add('turn-lane', 'outbound|shared', width('lanes:both_ways.width', rawWidth, 11), 'lanes:both_ways', false, rawWidth === undefined);
  }
  const median = tags.median ?? tags.divider;
  if (median && !['no', 'none', 'solid_line', 'dashed_line'].includes(median)) {
    record('median', median, 'mapped');
    add('divider', median === 'striped_buffer' ? 'striped-buffer' : 'median', width('median:width', tags['median:width'] ?? tags['divider:width'], 4), 'median');
  }
  lanes('outbound', forward, 'forward'); parking('right'); shoulder('right'); cycling('right'); sidewalk('right');
  const roadwayWidth = osmWidth(tags.width);
  if (roadwayWidth !== undefined) {
    record('roadwayWidth', roadwayWidth, 'mapped');
    const roadway = segments.filter(segment => !outsideRoadway.has(segment));
    const fixedWidth = roadway.filter(segment => !adjustable.has(segment)).reduce((sum, s) => sum + s.width, 0);
    const flexible = roadway.filter(segment => adjustable.has(segment));
    if (flexible.length) {
      const perLane = (roadwayWidth - fixedWidth) / flexible.length;
      if (perLane < 2 || perLane > 5) invalid('Mapped roadway width cannot accommodate this lane and facility layout.');
      for (const segment of flexible) {
        const index = segments.indexOf(segment);
        segment.width = round(perLane);
        const previous = evidence.find(item => item.field === widthFields.get(segment));
        if (previous) { previous.value = segment.width; previous.basis = 'derived'; previous.source = source; }
        record(`segments.${index}.width`, segment.width, 'derived');
      }
    } else if (Math.abs(roadwayWidth - fixedWidth) > 0.15) invalid('Mapped roadway width conflicts with the mapped lane widths.');
  }
  const totalWidth = round(segments.reduce((sum, segment) => sum + segment.width, 0));
  if (totalWidth > 100 || totalWidth < 2 || segments.length > 64) invalid('This street is outside supported cross-section dimensions.');
  record('totalWidth', totalWidth, 'derived');
  if (tags['turn:lanes'] || tags['turn:lanes:forward'] || tags['turn:lanes:backward']) warnings.push('Dedicated turn movements are shown as travel lanes in this schematic cross-section.');
  warnings.push('Building boundaries and elevations are schematic; no building dimensions were measured.');
  const boundary = () => ({ id: randomUUID(), variant: 'narrow', floors: 1, elevation: 0.1524 });
  const design: StreetmixDesign = { street: { name, schemaVersion: compatibility.schemaVersion, units: compatibility.imperialUnits, segments, width: totalWidth,
    location: { latlng: { lat: point.latitude, lng: point.longitude }, label: `${name}, Texas`, hierarchy: { country: 'United States', locality: tags['addr:city'] || tags['is_in:city'] || '', region: 'Texas', street: name } },
    boundary: { left: boundary(), right: boundary() }, skybox: 'day', weather: null, showAnalytics: false, userUpdated: false, editCount: 0,
  }, plugins: {} };
  const estimates = evidence.filter(item => item.basis === 'estimated');
  const quality = { mappedCount: evidence.filter(item => item.basis === 'mapped').length, derivedCount: evidence.filter(item => item.basis === 'derived').length, estimatedCount: estimates.length, unknownDetails, summary: `${estimates.length} estimated decisions; ${unknownDetails.length} details unknown. This is a map-based approximation, not a survey.` };
  if (estimates.length) warnings.push(quality.summary);
  return { design, evidence, estimates, quality, warnings, name };
}
