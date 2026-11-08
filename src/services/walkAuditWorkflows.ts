/** Transactional audits, private drafts, coverage and captured editable reports. @module */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { FeatureCollection, Prompt, WalkAuditError } from '../models/walkAudit.js';
import { auditType, fields, invalid, object, pointInRing, positiveInt, text, validateAnswers } from '../utils/walkAuditValidation.js';
import { WalkAuditConnection } from './walkAuditStore.js';
import { projectOnLine, routeForStudy } from './walkAuditRouting.js';
import { auditDto, contributor, draftDto, found, loadStudyQuestionnaires, lockStudy, organizer, pageResult, Page, reportDto, rows, studyDto, version, WalkAuditActor, WalkAuditService, worksheetDto } from './walkAuditService.js';

type Db = WalkAuditConnection | Pool;
type Row = Record<string, any>;
const auditFields = ['type', 'worksheetId', 'featureId', 'locationGps', 'locationDescription', 'geojson', 'routeSelection', 'answers'];
const auditSelect = 'SELECT a.*,c.display_name FROM walk_audit_audits a JOIN walk_audit_contributors c ON c.id=a.created_by';
const reportSelect = 'SELECT r.*,c.display_name FROM walk_audit_reports r JOIN walk_audit_contributors c ON c.id=r.created_by';

function requireAuthor(row: Row, caller: Row, actor: WalkAuditActor): void {
  if (row.created_by !== caller.id && !actor.staff) throw new WalkAuditError(403, 'FORBIDDEN', 'Only the author or staff may modify this audit.');
}
function validateGps(value: unknown, study: Row): Row {
  const gps = fields(value, ['longitude', 'latitude'], 'locationGps');
  if (typeof gps.longitude !== 'number' || typeof gps.latitude !== 'number' || !Number.isFinite(gps.longitude) || !Number.isFinite(gps.latitude) || Math.abs(gps.longitude) > 180 || Math.abs(gps.latitude) > 90 || !pointInRing([gps.longitude, gps.latitude], study.area.geometry.coordinates[0])) invalid('locationGps must be inside the study boundary.');
  return gps;
}
function immutableType(): never {
  throw new WalkAuditError(409, 'AUDIT_TYPE_IMMUTABLE', 'A submitted audit type cannot be changed. Start a new audit for a different type.');
}
function questionnaireMismatch(): never {
  throw new WalkAuditError(409, 'QUESTIONNAIRE_MISMATCH', 'This draft uses a different questionnaire. Keep its answers for reference and start a new draft using the study questions.');
}
function hasUnboundDraftData(row: Row): boolean {
  const answersPresent = Object.keys(row.answers ?? {}).length > 0;
  return row.type == null
    ? row.worksheet_id != null || row.feature_id != null || row.location_gps != null || row.location_description != null || row.geojson != null || row.route_selection != null || answersPresent
    : row.worksheet_id == null && answersPresent;
}
async function assignedWorksheet(db: Db, studyId: number, type: string, requested: unknown, prior?: Row): Promise<number> {
  let worksheetId: number;
  if (prior) {
    if (type !== prior.type) immutableType();
    worksheetId = prior.worksheet_id;
  } else {
    const assignment = (await rows(db, 'SELECT worksheet_id FROM walk_audit_study_questionnaires WHERE study_id=$1 AND audit_type=$2', [studyId, type]))[0];
    if (!assignment) throw new WalkAuditError(409, 'AUDIT_TYPE_DISABLED', 'This audit type is not enabled for the study.');
    worksheetId = assignment.worksheet_id;
  }
  if (requested != null && positiveInt(requested, 'worksheetId') !== worksheetId) questionnaireMismatch();
  return worksheetId;
}
function locationFor(study: Row, type: string, value: Row, prior?: Row, final = false): Row {
  if (type === 'street-segment' && value.routeSelection != null) {
    const intent = fields(value.routeSelection, ['startIntersectionId', 'end', 'edges', 'lengthMeters'], 'routeSelection');
    const startId = text(intent.startIntersectionId, 'startIntersectionId', 255);
    const start = (study.intersections as FeatureCollection).features.find(feature => feature.properties.id === startId && feature.geometry.type === 'Point');
    if (!start || start.geometry.type !== 'Point') invalid('The route start must be a saved study intersection.');
    if (intent.end === undefined) {
      if (final || intent.edges !== undefined || intent.lengthMeters !== undefined) invalid('Select both endpoints for the street route.');
      return { featureId: null, locationGps: { longitude: start.geometry.coordinates[0], latitude: start.geometry.coordinates[1] }, geojson: null, routeSelection: { startIntersectionId: startId } };
    }
    const canonical = routeForStudy(study, { startIntersectionId: startId, end: intent.end });
    if (intent.edges !== undefined && (!Array.isArray(intent.edges) || intent.edges.length !== canonical.routeSelection.edges.length || intent.edges.some((edge, index) => {
      const expected = canonical.routeSelection.edges[index];
      return !edge || edge.featureId !== expected.featureId || typeof edge.fromFraction !== 'number' || typeof edge.toFraction !== 'number' || Math.abs(edge.fromFraction - expected.fromFraction) > 1e-9 || Math.abs(edge.toFraction - expected.toFraction) > 1e-9;
    }))) invalid('The supplied route edges do not match the shortest route.');
    if (intent.lengthMeters !== undefined && (typeof intent.lengthMeters !== 'number' || Math.abs(intent.lengthMeters - canonical.routeSelection.lengthMeters) > 0.001)) invalid('The supplied route length does not match the shortest route.');
    const featureId = canonical.routeSelection.edges[0].featureId;
    const locationGps = { longitude: start.geometry.coordinates[0], latitude: start.geometry.coordinates[1] };
    if (value.featureId != null && value.featureId !== featureId) invalid('featureId does not match the route anchor.');
    if (value.locationGps != null && (value.locationGps.longitude !== locationGps.longitude || value.locationGps.latitude !== locationGps.latitude)) invalid('locationGps does not match the route start.');
    if (value.geojson != null && (value.geojson.type !== 'Feature' || value.geojson.properties?.id !== featureId || value.geojson.geometry?.type !== 'LineString' || JSON.stringify(value.geojson.geometry?.coordinates) !== JSON.stringify(canonical.geojson.geometry.coordinates))) invalid('geojson does not match the shortest route.');
    return { featureId, locationGps, geojson: canonical.geojson, routeSelection: canonical.routeSelection };
  }
  if (type === 'street-segment') {
    if (prior?.route_selection) invalid('A routed street audit cannot discard its route.');
    if (prior) {
      if (value.featureId !== prior.feature_id || JSON.stringify(value.locationGps) !== JSON.stringify(prior.location_gps) || JSON.stringify(value.geojson) !== JSON.stringify(prior.geojson)) invalid('Replace the legacy location by selecting both route endpoints.');
      return { featureId: prior.feature_id, locationGps: prior.location_gps, geojson: prior.geojson, routeSelection: null };
    }
    if (final) invalid('Select both endpoints for the street route.');
    // Pre-upgrade unsubmitted drafts may retain their old single-edge location
    // for reference, but it is never sufficient for a new submission.
    if (value.featureId != null && !(study.segments as FeatureCollection).features.some(feature => feature.properties.id === value.featureId && feature.geometry.type === 'LineString')) invalid('featureId must identify a saved street edge.');
    return { featureId: value.featureId ?? null, locationGps: value.locationGps ?? null, geojson: value.geojson ?? null, routeSelection: null };
  }
  if (value.routeSelection != null) invalid('Only street audits can have a route selection.');
  if (value.featureId == null || value.locationGps == null) {
    if (final) invalid('Select an audit location.');
    if (value.featureId != null) {
      const features: FeatureCollection = type === 'intersection' ? study.intersections : study.segments;
      if (!features.features.some(feature => feature.properties.id === value.featureId)) invalid('featureId must identify a matching feature in this study.');
    }
    if (value.locationGps != null) validateGps(value.locationGps, study);
    if (value.geojson != null) invalid('Save a feature and coordinate before its geometry.');
    return { featureId: value.featureId ?? null, locationGps: value.locationGps ?? null, geojson: value.geojson ?? null, routeSelection: null };
  }
  const featureId = text(value.featureId, 'featureId', 255), locationGps = validateGps(value.locationGps, study);
  const features: FeatureCollection = type === 'intersection' ? study.intersections : study.segments;
  const feature = features.features.find(item => item.properties.id === featureId);
  if (!feature || feature.geometry.type !== (type === 'intersection' ? 'Point' : 'LineString')) invalid('featureId must identify a matching feature in this study.');
  if (type === 'intersection' && feature.geometry.type === 'Point') {
    if (Math.abs(locationGps.longitude - feature.geometry.coordinates[0]) > 1e-8 || Math.abs(locationGps.latitude - feature.geometry.coordinates[1]) > 1e-8) invalid('locationGps must match the intersection.');
    if (value.geojson != null && (value.geojson.type !== 'Feature' || value.geojson.properties?.id !== featureId || value.geojson.geometry?.type !== 'Point' || JSON.stringify(value.geojson.geometry?.coordinates) !== JSON.stringify(feature.geometry.coordinates))) invalid('geojson must match the saved intersection.');
    return { featureId, locationGps, geojson: feature, routeSelection: null };
  }
  if (feature.geometry.type !== 'LineString') invalid('A point must identify a saved street edge.');
  const projected = projectOnLine(feature.geometry.coordinates, [locationGps.longitude, locationGps.latitude]);
  if (projected.distanceMeters > 1 || !pointInRing(projected.position, study.area.geometry.coordinates[0])) invalid('The point must be within one meter of its street edge.');
  if (value.geojson != null) {
    const supplied = object(value.geojson, 'geojson'), geometry = object(supplied.geometry, 'geojson geometry');
    const coordinates = geometry.coordinates;
    if (supplied.type !== 'Feature' || geometry.type !== 'Point' || !Array.isArray(coordinates) || coordinates.length !== 2 || coordinates.some(coordinate => typeof coordinate !== 'number' || !Number.isFinite(coordinate)) || Math.abs(coordinates[0] - locationGps.longitude) > 1e-8 || Math.abs(coordinates[1] - locationGps.latitude) > 1e-8 || object(supplied.properties, 'geojson properties').id !== featureId) invalid('geojson must match the point location and parent edge.');
  }
  return { featureId, locationGps: { longitude: projected.position[0], latitude: projected.position[1] }, geojson: { type: 'Feature', properties: feature.properties, geometry: { type: 'Point', coordinates: projected.position } }, routeSelection: null };
}
async function completeAudit(db: Db, study: Row, value: Row, prior?: Row): Promise<Row> {
  const type = auditType(value.type), worksheetId = await assignedWorksheet(db, study.id, type, value.worksheetId, prior);
  const worksheet = found((await rows(db, 'SELECT * FROM walk_audit_worksheets WHERE id=$1 FOR SHARE', [worksheetId]))[0]);
  if (!worksheet.recommend_for.includes(type)) invalid('The worksheet is not recommended for this audit type.');
  return { type, worksheetId, ...locationFor(study, type, value, prior, true), locationDescription: text(value.locationDescription, 'locationDescription', 500, true), answers: validateAnswers(value.answers, worksheet.prompts as Prompt[], true) };
}
function mergedAudit(row: Row): Row {
  return { type: row.type, worksheetId: row.worksheet_id, featureId: row.feature_id, locationGps: row.location_gps, locationDescription: row.location_description, geojson: row.geojson, routeSelection: row.route_selection, answers: row.answers };
}
function sqlAudit(data: Row): unknown[] { return [data.worksheetId, data.type, data.featureId, JSON.stringify(data.locationGps), data.locationDescription, JSON.stringify(data.geojson), JSON.stringify(data.answers), data.routeSelection == null ? null : JSON.stringify(data.routeSelection)]; }

/** Compute distinct known-feature coverage; repeated observations count once. */
export function calculateProgress(study: Row, audits: Row[]): Row {
  const enabled: string[] = study.allowedAuditTypes ?? ['intersection', 'street-segment'];
  const intersectionIds = new Set<string>(enabled.includes('intersection') ? study.intersections.features.map((f: any) => f.properties.id) : []);
  const completedIntersections = new Set(audits.filter(a => a.type === 'intersection' && intersectionIds.has(a.feature_id ?? a.featureId)).map(a => a.feature_id ?? a.featureId));
  const intersections = { audited: completedIntersections.size, total: intersectionIds.size, ratio: intersectionIds.size ? completedIntersections.size / intersectionIds.size : 0 };
  const streetIds = new Set<string>(enabled.includes('street-segment') ? study.segments.features.map((f: any) => f.properties.id) : []);
  const intervals = new Map<string, Array<[number, number]>>();
  const add = (id: string, from: number, to: number): void => {
    if (!streetIds.has(id) || !Number.isFinite(from) || !Number.isFinite(to) || from < 0 || from > 1 || to < 0 || to > 1) return;
    const list = intervals.get(id) ?? []; list.push([Math.min(from, to), Math.max(from, to)]); intervals.set(id, list);
  };
  for (const audit of audits.filter(a => a.type === 'street-segment')) {
    const route = audit.route_selection ?? audit.routeSelection;
    if (route && Array.isArray(route.edges)) for (const edge of route.edges) add(edge.featureId, edge.fromFraction, edge.toFraction);
    else add(audit.feature_id ?? audit.featureId, 0, 1);
  }
  const coverage = [...intervals.entries()].map(([featureId, parts]) => {
    const merged: Array<[number, number]> = [];
    for (const part of parts.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
      const last = merged[merged.length - 1];
      if (last && part[0] <= last[1] + 1e-6) last[1] = Math.max(last[1], part[1]); else merged.push([...part]);
    }
    const complete = merged.length === 1 && merged[0][0] <= 1e-6 && merged[0][1] >= 1 - 1e-6;
    return { featureId, intervals: merged, complete, partial: !complete };
  }).sort((a, b) => a.featureId.localeCompare(b.featureId));
  const streetCount = coverage.filter(item => item.complete).length;
  const streets = { audited: streetCount, partial: coverage.length - streetCount, total: streetIds.size, ratio: streetIds.size ? streetCount / streetIds.size : 0, coverage };
  const total = streets.total + intersections.total, audited = streets.audited + intersections.audited;
  return { streets, intersections, points: { observations: audits.filter(a => a.type === 'point').length }, overall: { audited, total, ratio: total ? audited / total : 0, coverageApplicable: total > 0 } };
}
async function getProgress(db: Db, study: Row): Promise<Row> {
  if (!study.allowedAuditTypes) await loadStudyQuestionnaires(db, study);
  return calculateProgress(study, await rows(db, 'SELECT type,feature_id,route_selection FROM walk_audit_audits WHERE study_id=$1', [study.id]));
}
async function studyById(db: Db, id: number): Promise<Row> {
  return found((await rows(db, 'SELECT s.*,c.display_name FROM walk_audit_studies s JOIN walk_audit_contributors c ON c.id=s.created_by WHERE s.id=$1', [id]))[0]);
}
async function draftParent(db: Db, id: string, actor: WalkAuditActor): Promise<number> {
  const row = (await rows(db, 'SELECT d.study_id FROM walk_audit_drafts d JOIN walk_audit_contributors c ON c.id=d.created_by WHERE d.id=$1 AND c.firebase_uid=$2', [id, actor.uid]))[0];
  return found(row).study_id;
}
async function privateDraft(db: Db, id: string, actor: WalkAuditActor, lock = false): Promise<Row> {
  return found((await rows(db, `SELECT d.* FROM walk_audit_drafts d JOIN walk_audit_contributors c ON c.id=d.created_by WHERE d.id=$1 AND c.firebase_uid=$2${lock ? ' FOR UPDATE OF d' : ''}`, [id, actor.uid]))[0]);
}
async function photoDescriptorMap(db: Db, kind: 'draft' | 'audit', ids: Array<string | number>): Promise<Map<string, Row[]>> {
  const parent = kind === 'draft' ? 'draft_id' : 'audit_id';
  const result = new Map<string, Row[]>();
  if (!ids.length) return result;
  const type = kind === 'draft' ? 'uuid' : 'integer';
  const photos = await rows(db, `SELECT id,${parent},slot,content_type,byte_count,created_on FROM walk_audit_photos WHERE ${parent}=ANY($1::${type}[]) ORDER BY ${parent},slot`, [ids]);
  for (const row of photos) {
    const id = String(row[parent]), list = result.get(id) ?? [];
    list.push({ id: String(row.id), slot: row.slot, contentType: row.content_type, byteCount: row.byte_count,
      createdOn: new Date(row.created_on).toISOString(), path: `/api/walk-audits/${kind === 'draft' ? 'drafts' : 'audits'}/${id}/photos/${row.slot}` });
    result.set(id, list);
  }
  return result;
}
async function photoDescriptors(db: Db, kind: 'draft' | 'audit', id: string | number): Promise<Row[]> { return (await photoDescriptorMap(db, kind, [id])).get(String(id)) ?? []; }
async function draftWithPhotos(db: Db, row: Row): Promise<Row> {
  row.photos = row.editing_audit_id ? await photoDescriptors(db, 'audit', row.editing_audit_id) : await photoDescriptors(db, 'draft', row.id);
  return draftDto(row);
}
async function auditWithPhotos(db: Db, row: Row): Promise<Row> { row.photos = await photoDescriptors(db, 'audit', row.id); return auditDto(row); }
function checkSlot(slot: number): void { if (!Number.isInteger(slot) || slot < 1 || slot > 3) invalid('Photo slot must be 1, 2, or 3.'); }
function validatePhoto(contentType: string, value: unknown): Buffer {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) throw new WalkAuditError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send JPEG, PNG, or WebP image bytes.');
  if (!Buffer.isBuffer(value)) throw new WalkAuditError(415, 'INVALID_IMAGE', 'The image bytes are missing or invalid.');
  if (value.length > 2097152) throw new WalkAuditError(413, 'PAYLOAD_TOO_LARGE', 'The photo exceeds the 2 MiB limit.');
  const jpeg = value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff;
  const png = value.length >= 8 && value.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const webp = value.length >= 12 && value.toString('ascii', 0, 4) === 'RIFF' && value.toString('ascii', 8, 12) === 'WEBP';
  if (!(contentType === 'image/jpeg' ? jpeg : contentType === 'image/png' ? png : webp)) throw new WalkAuditError(415, 'INVALID_IMAGE', 'The image signature does not match its declared type.');
  return value;
}
function photoBytes(row: Row): Row {
  return { contentType: row.content_type, bytes: Buffer.isBuffer(row.image_bytes) ? row.image_bytes : Buffer.from(row.image_bytes) };
}
async function partialDraft(db: Db, study: Row, data: Row, prior?: Row): Promise<Row> {
  if (data.type != null) data.type = auditType(data.type);
  if (data.type != null) {
    data.worksheetId = await assignedWorksheet(db, study.id, data.type, data.worksheetId, prior);
    const worksheet = found((await rows(db, 'SELECT * FROM walk_audit_worksheets WHERE id=$1 FOR SHARE', [positiveInt(data.worksheetId, 'worksheetId')]))[0]);
    if (data.type != null && !worksheet.recommend_for.includes(data.type)) invalid('The worksheet is not recommended for this audit type.');
    data.answers = validateAnswers(data.answers, worksheet.prompts as Prompt[], false);
  } else {
    if (data.worksheetId != null || Object.keys(validateAnswers(data.answers, undefined, false)).length) invalid('Choose an audit type before saving answers.');
    data.answers = {};
  }
  if (data.featureId != null) data.featureId = text(data.featureId, 'featureId', 255);
  if (data.locationGps != null) data.locationGps = validateGps(data.locationGps, study);
  if (data.locationDescription != null) data.locationDescription = text(data.locationDescription, 'locationDescription', 500, true);
  if (data.geojson != null) {
    const geo = object(data.geojson, 'geojson'); const geometry = object(geo.geometry, 'geojson geometry');
    if (geo.type !== 'Feature' || (geometry.type !== 'Point' && geometry.type !== 'LineString') || !Array.isArray(geometry.coordinates)) invalid('geojson must be a Point or LineString Feature.');
    if (data.type && geometry.type !== (data.type === 'street-segment' ? 'LineString' : 'Point')) invalid('geojson must match the audit type.');
    const positions = geometry.type === 'Point' ? [geometry.coordinates] : geometry.coordinates;
    if ((geometry.type === 'LineString' && positions.length < 2) || positions.some((p: unknown) => !Array.isArray(p) || p.length !== 2 || p.some(n => typeof n !== 'number' || !Number.isFinite(n)) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90)) invalid('geojson coordinates must be finite longitude/latitude pairs.');
    object(geo.properties, 'geojson properties');
  }
  if (data.type) Object.assign(data, locationFor(study, data.type, data, prior));
  else if (data.routeSelection != null || data.featureId != null || data.locationGps != null || data.locationDescription != null || data.geojson != null) invalid('Choose an audit type before selecting a location.');
  return data;
}

/** Adds transactional observation and report operations to the administrative service. */
export class WalkAuditWorkflows extends WalkAuditService {
  /** A registered viewer's two stable, independently paged study groups. */
  async dashboard(actor: WalkAuditActor, page: Page): Promise<Row> {
    if (page.group !== 'mine' && page.group !== 'other') invalid('group must be mine or other.');
    const caller = await contributor(this.store.db, actor);
    const list = await rows(this.store.db, `WITH counts AS (
      SELECT study_id,count(*)::int AS audit_count,bool_or(created_by=$1) AS contributed
      FROM walk_audit_audits GROUP BY study_id
    ) SELECT s.id,s.created_by,s.neighborhood,s.created_on,s.updated_on,s.version,c.display_name,
      COALESCE(counts.audit_count,0)::int AS audit_count,COALESCE(counts.contributed,false) AS contributed
      FROM walk_audit_studies s JOIN walk_audit_contributors c ON c.id=s.created_by
      LEFT JOIN counts ON counts.study_id=s.id
      WHERE (s.created_by=$1 OR COALESCE(counts.contributed,false))=$2
      ORDER BY s.created_on DESC,s.id DESC LIMIT $3 OFFSET $4`, [caller.id, page.group === 'mine', page.limit + 1, page.offset]);
    return pageResult(list, page, 'studies', row => ({ ...studyDto(row), auditCount: row.audit_count, isOrganizer: row.created_by === caller.id, hasContributed: row.contributed }));
  }
  /** Compute a route preview from a saved network and a verified contributor. */
  async routePreview(actor: WalkAuditActor, id: number, input: unknown): Promise<Row> {
    await contributor(this.store.db, actor);
    return routeForStudy(await studyById(this.store.db, id), input);
  }
  /** Study details include current coverage without embedding every audit. */
  override async getStudy(id: number): Promise<Row> {
    const study = await studyById(this.store.db, id);
    await loadStudyQuestionnaires(this.store.db, study);
    return { ...studyDto(study, true), progress: await getProgress(this.store.db, study) };
  }
  /** Return current deduplicated network coverage. */
  async progress(id: number): Promise<Row> { return getProgress(this.store.db, await studyById(this.store.db, id)); }
  /** List public audits within one study. */
  async listAudits(id: number, page: Page): Promise<Row> {
    await studyById(this.store.db, id); const args: unknown[] = [id], conditions = ['a.study_id=$1'];
    for (const [field, column] of [['type', 'type'], ['author', 'created_by'], ['worksheet', 'worksheet_id']] as const) if (page[field] !== undefined) { args.push(page[field]); conditions.push(`a.${column}=$${args.length}`); }
    args.push(page.limit + 1, page.offset);
    const list = await rows(this.store.db, `${auditSelect} WHERE ${conditions.join(' AND ')} ORDER BY a.created_on DESC,a.id DESC LIMIT $${args.length - 1} OFFSET $${args.length}`, args);
    const photos = await photoDescriptorMap(this.store.db, 'audit', list.slice(0, page.limit).map(row => row.id));
    for (const row of list.slice(0, page.limit)) row.photos = photos.get(String(row.id)) ?? [];
    return pageResult(list, page, 'audits', row => {
      const summary = auditDto(row); delete summary.geojson; delete summary.answers; return summary;
    });
  }
  /** Read a public submitted audit. */
  async getAudit(id: number): Promise<Row> { return auditWithPhotos(this.store.db, found((await rows(this.store.db, `${auditSelect} WHERE a.id=$1`, [id]))[0])); }
  /** Validate a complete observation and persist it while locking its parent study. */
  async createAudit(actor: WalkAuditActor, studyId: number, body: unknown): Promise<Row> {
    const data = fields(body, auditFields);
    return this.store.transaction(async db => {
      const study = await lockStudy(db, studyId), caller = await contributor(db, actor), audit = await completeAudit(db, study, data);
      const row = (await rows(db, `INSERT INTO walk_audit_audits(study_id,created_by,worksheet_id,type,feature_id,location_gps,location_description,geojson,answers,route_selection) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [studyId, caller.id, ...sqlAudit(audit)]))[0];
      row.display_name = caller.display_name; return auditDto(row);
    });
  }
  /** Merge and validate a direct edit while rejecting stale versions. */
  async patchAudit(actor: WalkAuditActor, id: number, body: unknown): Promise<Row> {
    const patch = fields(body, ['expectedVersion', ...auditFields]); positiveInt(patch.expectedVersion, 'expectedVersion');
    if (Object.keys(patch).length < 2) invalid('An audit change is required.');
    const parent = found((await rows(this.store.db, 'SELECT study_id FROM walk_audit_audits WHERE id=$1', [id]))[0]).study_id;
    return this.store.transaction(async db => {
      const study = await lockStudy(db, parent), caller = await contributor(db, actor);
      const current = found((await rows(db, `${auditSelect} WHERE a.id=$1 FOR UPDATE OF a`, [id]))[0]);
      requireAuthor(current, caller, actor); version(current, patch.expectedVersion);
      if (patch.type !== undefined && patch.type !== current.type) immutableType();
      if (patch.worksheetId !== undefined && patch.worksheetId !== current.worksheet_id) questionnaireMismatch();
      const base = mergedAudit(current);
      if (patch.routeSelection !== undefined && patch.routeSelection !== null) Object.assign(base, { featureId: null, locationGps: null, geojson: null });
      const merged = { ...base, ...patch }; delete merged.expectedVersion;
      if (JSON.stringify(merged) === JSON.stringify(mergedAudit(current))) invalid('An audit change is required.');
      const audit = await completeAudit(db, study, merged, current);
      const row = (await rows(db, `UPDATE walk_audit_audits SET worksheet_id=$2,type=$3,feature_id=$4,location_gps=$5,location_description=$6,geojson=$7,answers=$8,route_selection=$9,version=version+1,updated_on=now() WHERE id=$1 RETURNING *`, [id, ...sqlAudit(audit)]))[0];
      row.display_name = current.display_name; return auditWithPhotos(db, row);
    });
  }
  /** Physically delete an audit and its edit drafts; report snapshots survive. */
  async deleteAudit(actor: WalkAuditActor, id: number): Promise<void> {
    const parent = found((await rows(this.store.db, 'SELECT study_id FROM walk_audit_audits WHERE id=$1', [id]))[0]).study_id;
    await this.store.transaction(async db => {
      await lockStudy(db, parent); const caller = await contributor(db, actor);
      const audit = found((await rows(db, 'SELECT * FROM walk_audit_audits WHERE id=$1 FOR UPDATE', [id]))[0]);
      requireAuthor(audit, caller, actor); await rows(db, 'DELETE FROM walk_audit_audits WHERE id=$1', [id]);
    });
  }
  /** List only the caller's private drafts. */
  async listDrafts(actor: WalkAuditActor, studyId: number, page: Page): Promise<Row> {
    await studyById(this.store.db, studyId); const caller = await contributor(this.store.db, actor);
    const args: unknown[] = [studyId, caller.id]; const filter = page.updatedSince ? ' AND updated_on >= $3::timestamptz' : '';
    if (page.updatedSince) args.push(page.updatedSince);
    args.push(page.limit + 1, page.offset);
    const list = await rows(this.store.db, `SELECT * FROM walk_audit_drafts WHERE study_id=$1 AND created_by=$2${filter} ORDER BY updated_on DESC,id DESC LIMIT $${args.length - 1} OFFSET $${args.length}`, args);
    const visible = list.slice(0, page.limit);
    const [draftPhotos, auditPhotos] = await Promise.all([
      photoDescriptorMap(this.store.db, 'draft', visible.filter(row => !row.editing_audit_id).map(row => row.id)),
      photoDescriptorMap(this.store.db, 'audit', visible.filter(row => row.editing_audit_id).map(row => row.editing_audit_id))
    ]);
    for (const row of visible) row.photos = row.editing_audit_id ? auditPhotos.get(String(row.editing_audit_id)) ?? [] : draftPhotos.get(String(row.id)) ?? [];
    return pageResult(list, page, 'drafts', draftDto);
  }
  /** Start a blank draft or seed an edit draft from the caller's own audit. */
  async createDraft(actor: WalkAuditActor, studyId: number, body: unknown): Promise<Row> {
    const data = fields(body, ['editingAuditId']);
    return this.store.transaction(async db => {
      await lockStudy(db, studyId); const caller = await contributor(db, actor);
      let edit: Row | undefined;
      if (data.editingAuditId !== undefined) {
        edit = found((await rows(db, 'SELECT * FROM walk_audit_audits WHERE id=$1 AND study_id=$2 AND created_by=$3 FOR UPDATE', [positiveInt(data.editingAuditId, 'editingAuditId'), studyId, caller.id]))[0]);
      }
      const row = (await rows(db, `INSERT INTO walk_audit_drafts(id,study_id,created_by,editing_audit_id,editing_audit_version,worksheet_id,type,feature_id,location_gps,location_description,geojson,answers,route_selection)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, [randomUUID(), studyId, caller.id, edit?.id ?? null, edit?.version ?? null, edit?.worksheet_id ?? null, edit?.type ?? null, edit?.feature_id ?? null, edit ? JSON.stringify(edit.location_gps) : null, edit?.location_description ?? null, edit ? JSON.stringify(edit.geojson) : null, JSON.stringify(edit?.answers ?? {}), edit?.route_selection ? JSON.stringify(edit.route_selection) : null]))[0];
      return draftWithPhotos(db, row);
    });
  }
  /** Read a draft only for its owner, concealing it from staff and other users. */
  async getDraft(actor: WalkAuditActor, id: string): Promise<Row> { return draftWithPhotos(this.store.db, await privateDraft(this.store.db, id, actor)); }
  /** Autosave a structurally valid partial draft with optimistic concurrency. */
  async patchDraft(actor: WalkAuditActor, id: string, body: unknown): Promise<Row> {
    const patch = fields(body, ['expectedVersion', ...auditFields]); positiveInt(patch.expectedVersion, 'expectedVersion');
    if (Object.keys(patch).length < 2) invalid('A draft change is required.');
    const parent = await draftParent(this.store.db, id, actor);
    return this.store.transaction(async db => {
      const study = await lockStudy(db, parent), current = await privateDraft(db, id, actor, true); version(current, patch.expectedVersion);
      let target: Row | undefined;
      if (current.editing_audit_id) {
        target = found((await rows(db, 'SELECT * FROM walk_audit_audits WHERE id=$1 AND study_id=$2 FOR SHARE', [current.editing_audit_id, parent]))[0]);
        if (current.type !== target.type || (patch.type !== undefined && patch.type !== target.type)) immutableType();
        if (current.worksheet_id !== target.worksheet_id || (patch.worksheetId !== undefined && patch.worksheetId !== target.worksheet_id)) questionnaireMismatch();
      } else if (hasUnboundDraftData(current)) {
        questionnaireMismatch();
      } else if (current.type != null && current.worksheet_id != null) {
        await assignedWorksheet(db, parent, current.type, current.worksheet_id);
      }
      const typeChanged = !target && patch.type !== undefined && patch.type !== current.type;
      if (typeChanged && current.type != null && ['worksheetId', 'featureId', 'locationGps', 'locationDescription', 'geojson', 'routeSelection', 'answers'].some(key => patch[key] != null && !(key === 'answers' && typeof patch[key] === 'object' && !Object.keys(patch[key]).length))) {
        invalid('Change the audit type separately before adding its new location or answers.');
      }
      const base = typeChanged ? { type: patch.type, worksheetId: null, featureId: null, locationGps: null, locationDescription: null, geojson: null, routeSelection: null, answers: {} } : mergedAudit(current);
      if (patch.routeSelection !== undefined && patch.routeSelection !== null) Object.assign(base, { featureId: null, locationGps: null, geojson: null });
      const merged = { ...base, ...patch }; delete merged.expectedVersion;
      if (JSON.stringify(merged) === JSON.stringify(mergedAudit(current))) invalid('A draft change is required.');
      const data = await partialDraft(db, study, merged, target);
      const row = (await rows(db, `UPDATE walk_audit_drafts SET worksheet_id=$2,type=$3,feature_id=$4,location_gps=$5,location_description=$6,geojson=$7,answers=$8,route_selection=$9,version=version+1,updated_on=now() WHERE id=$1 RETURNING *`, [id, data.worksheetId ?? null, data.type ?? null, data.featureId ?? null, data.locationGps == null ? null : JSON.stringify(data.locationGps), data.locationDescription ?? null, data.geojson == null ? null : JSON.stringify(data.geojson), JSON.stringify(data.answers), data.routeSelection == null ? null : JSON.stringify(data.routeSelection)]))[0];
      return draftWithPhotos(db, row);
    });
  }
  /** Read private image bytes only after checking the draft's owner. */
  async draftPhoto(actor: WalkAuditActor, id: string, slot: number): Promise<Row> {
    checkSlot(slot); await privateDraft(this.store.db, id, actor);
    return photoBytes(found((await rows(this.store.db, 'SELECT content_type,image_bytes FROM walk_audit_photos WHERE draft_id=$1 AND slot=$2', [id, slot]))[0]));
  }
  /** Read published image bytes without exposing private draft attachments. */
  async auditPhoto(id: number, slot: number): Promise<Row> {
    checkSlot(slot);
    return photoBytes(found((await rows(this.store.db, 'SELECT content_type,image_bytes FROM walk_audit_photos WHERE audit_id=$1 AND slot=$2', [id, slot]))[0]));
  }
  /** Replace one owner-private slot under the same version lock as autosaves. */
  async putDraftPhoto(actor: WalkAuditActor, id: string, slot: number, expected: number, contentType: string, value: unknown): Promise<Row> {
    checkSlot(slot); const image = validatePhoto(contentType, value), parent = await draftParent(this.store.db, id, actor);
    return this.store.transaction(async db => {
      await lockStudy(db, parent); const draft = await privateDraft(db, id, actor, true); version(draft, expected);
      if (draft.editing_audit_id) throw new WalkAuditError(409, 'EDIT_PHOTOS_UNAVAILABLE', 'Photos cannot be changed while editing a submitted audit.');
      await rows(db, `INSERT INTO walk_audit_photos(id,study_id,created_by,draft_id,slot,content_type,byte_count,image_bytes)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (draft_id,slot) DO UPDATE SET id=EXCLUDED.id,content_type=EXCLUDED.content_type,byte_count=EXCLUDED.byte_count,image_bytes=EXCLUDED.image_bytes,created_on=now()`, [randomUUID(), parent, draft.created_by, id, slot, contentType, image.length, image]);
      const updated = (await rows(db, 'UPDATE walk_audit_drafts SET version=version+1,updated_on=now() WHERE id=$1 RETURNING *', [id]))[0];
      return draftWithPhotos(db, updated);
    });
  }
  /** Remove one owner-private slot and increment the draft version. */
  async deleteDraftPhoto(actor: WalkAuditActor, id: string, slot: number, expected: number): Promise<Row> {
    checkSlot(slot); const parent = await draftParent(this.store.db, id, actor);
    return this.store.transaction(async db => {
      await lockStudy(db, parent); const draft = await privateDraft(db, id, actor, true); version(draft, expected);
      if (draft.editing_audit_id) throw new WalkAuditError(409, 'EDIT_PHOTOS_UNAVAILABLE', 'Photos cannot be changed while editing a submitted audit.');
      // A no-op deletion still advances the version. This fences a delayed
      // upload that the owner explicitly cancelled after an uncertain outcome.
      await rows(db, 'DELETE FROM walk_audit_photos WHERE draft_id=$1 AND slot=$2', [id, slot]);
      const updated = (await rows(db, 'UPDATE walk_audit_drafts SET version=version+1,updated_on=now() WHERE id=$1 RETURNING *', [id]))[0];
      return draftWithPhotos(db, updated);
    });
  }
  /** Physically remove one private draft. */
  async deleteDraft(actor: WalkAuditActor, id: string): Promise<void> {
    const parent = await draftParent(this.store.db, id, actor);
    await this.store.transaction(async db => { await lockStudy(db, parent); await privateDraft(db, id, actor, true); await rows(db, 'DELETE FROM walk_audit_drafts WHERE id=$1', [id]); });
  }
  /** Consume a draft exactly once in the same transaction that creates or updates its audit. */
  async submitDraft(actor: WalkAuditActor, id: string, body: unknown): Promise<{ audit: Row; created: boolean }> {
    const data = fields(body, ['expectedVersion']); positiveInt(data.expectedVersion, 'expectedVersion');
    const parent = await draftParent(this.store.db, id, actor);
    return this.store.transaction(async db => {
      const study = await lockStudy(db, parent), draft = await privateDraft(db, id, actor, true); version(draft, data.expectedVersion);
      const caller = await contributor(db, actor); let current: Row | undefined;
      if (!draft.editing_audit_id && hasUnboundDraftData(draft)) questionnaireMismatch();
      if (draft.editing_audit_id) {
        current = found((await rows(db, `${auditSelect} WHERE a.id=$1 AND a.created_by=$2 FOR UPDATE OF a`, [draft.editing_audit_id, caller.id]))[0]);
        version(current, draft.editing_audit_version);
        if (draft.type !== current.type) immutableType();
        if (draft.worksheet_id !== current.worksheet_id) questionnaireMismatch();
      }
      const audit = await completeAudit(db, study, mergedAudit(draft), current);
      const saved = current
        ? (await rows(db, `UPDATE walk_audit_audits SET worksheet_id=$2,type=$3,feature_id=$4,location_gps=$5,location_description=$6,geojson=$7,answers=$8,route_selection=$9,version=version+1,updated_on=now() WHERE id=$1 RETURNING *`, [current.id, ...sqlAudit(audit)]))[0]
        : (await rows(db, `INSERT INTO walk_audit_audits(study_id,created_by,worksheet_id,type,feature_id,location_gps,location_description,geojson,answers,route_selection) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [parent, caller.id, ...sqlAudit(audit)]))[0];
      if (!current) await rows(db, 'UPDATE walk_audit_photos SET audit_id=$2,draft_id=NULL WHERE draft_id=$1', [id, saved.id]);
      await rows(db, 'DELETE FROM walk_audit_drafts WHERE id=$1', [id]); saved.display_name = caller.display_name;
      return { audit: await auditWithPhotos(db, saved), created: !current };
    });
  }

  /** List report summaries without large captured payloads. */
  async listReports(studyId: number, page: Page): Promise<Row> {
    await studyById(this.store.db, studyId);
    return pageResult(await rows(this.store.db, `${reportSelect} WHERE r.study_id=$1 ORDER BY r.created_on DESC,r.id DESC LIMIT $2 OFFSET $3`, [studyId, page.limit + 1, page.offset]), page, 'reports', row => reportDto(row));
  }
  /** Read an editable report and its captured data. */
  async getReport(id: number): Promise<Row> { return reportDto(found((await rows(this.store.db, `${reportSelect} WHERE r.id=$1`, [id]))[0]), true); }
  private async capture(db: Db, study: Row, input: unknown): Promise<{ ids: number[]; completion: number; data: Row }> {
    let selected: Row[];
    if (input === undefined) selected = await rows(db, `${auditSelect} WHERE a.study_id=$1 ORDER BY a.id LIMIT 501 FOR SHARE OF a`, [study.id]);
    else {
      if (!Array.isArray(input)) invalid('auditIds must be an array.');
      if (input.length > 500) throw new WalkAuditError(413, 'REPORT_TOO_LARGE', 'Select at most 500 audits.');
      const ids = input.map(id => positiveInt(id, 'auditId'));
      if (new Set(ids).size !== ids.length) invalid('auditIds must be unique.');
      selected = await rows(db, `${auditSelect} WHERE a.study_id=$1 AND a.id=ANY($2::integer[]) ORDER BY a.id FOR SHARE OF a`, [study.id, ids]);
      if (selected.length !== ids.length) invalid('Every audit must exist in this study.');
    }
    if (selected.length > 500) throw new WalkAuditError(413, 'REPORT_TOO_LARGE', 'Select at most 500 audits.');
    const worksheetIds = [...new Set(selected.map(row => row.worksheet_id))];
    const worksheets = await rows(db, 'SELECT * FROM walk_audit_worksheets WHERE id=ANY($1::integer[]) ORDER BY id FOR SHARE', [worksheetIds]);
    await loadStudyQuestionnaires(db, study);
    const coverage = calculateProgress(study, selected);
    const photos = await photoDescriptorMap(db, 'audit', selected.map(row => row.id));
    for (const row of selected) row.photos = photos.get(String(row.id)) ?? [];
    const data = { study: studyDto(study, true), audits: selected.map(auditDto), worksheets: worksheets.map(worksheetDto), progress: coverage };
    if (Buffer.byteLength(JSON.stringify(data), 'utf8') > 16 * 1024 * 1024) throw new WalkAuditError(413, 'REPORT_TOO_LARGE', 'Select fewer audits to reduce report size.');
    return { ids: selected.map(row => row.id), completion: coverage.overall.ratio, data };
  }
  /** Capture a consistent same-study selection without any external narrative provider. */
  async createReport(actor: WalkAuditActor, studyId: number, body: unknown): Promise<Row> {
    const input = fields(body, ['title', 'description', 'auditIds']);
    return this.store.transaction(async db => {
      const study = await lockStudy(db, studyId); await organizer(db, study, actor); const caller = await contributor(db, actor);
      const capture = await this.capture(db, study, input.auditIds);
      const title = input.title === undefined ? `${study.neighborhood} walk audit` : text(input.title, 'title', 200);
      const description = input.description === undefined ? `This report captures ${capture.ids.length} observations in ${study.neighborhood}.` : text(input.description, 'description', 20000, true);
      const row = (await rows(db, `INSERT INTO walk_audit_reports(study_id,created_by,title,description,audit_ids,completion,captured_data) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [studyId, caller.id, title, description, capture.ids, capture.completion, JSON.stringify(capture.data)]))[0];
      row.display_name = caller.display_name; return reportDto(row, true);
    });
  }
  /** Edit authored text and optionally replace the captured membership and coverage. */
  async patchReport(actor: WalkAuditActor, id: number, body: unknown): Promise<Row> {
    const input = fields(body, ['expectedVersion', 'title', 'description', 'auditIds']); positiveInt(input.expectedVersion, 'expectedVersion');
    if (Object.keys(input).length < 2) invalid('A report change is required.');
    const parent = found((await rows(this.store.db, 'SELECT study_id FROM walk_audit_reports WHERE id=$1', [id]))[0]).study_id;
    return this.store.transaction(async db => {
      const study = await lockStudy(db, parent); await organizer(db, study, actor);
      const current = found((await rows(db, `${reportSelect} WHERE r.id=$1 FOR UPDATE OF r`, [id]))[0]); version(current, input.expectedVersion);
      const title = input.title === undefined ? current.title : text(input.title, 'title', 200);
      const description = input.description === undefined ? current.description : text(input.description, 'description', 20000, true);
      if (title === current.title && description === current.description && input.auditIds === undefined) invalid('A report change is required.');
      const capture = input.auditIds === undefined ? { ids: current.audit_ids, completion: current.completion, data: current.captured_data } : await this.capture(db, study, input.auditIds);
      const row = (await rows(db, `UPDATE walk_audit_reports SET title=$2,description=$3,audit_ids=$4,completion=$5,captured_data=$6,version=version+1,updated_on=now() WHERE id=$1 RETURNING *`, [id, title, description, capture.ids, capture.completion, JSON.stringify(capture.data)]))[0];
      row.display_name = current.display_name; return reportDto(row, true);
    });
  }
  /** Physically delete one report; other study data is retained. */
  async deleteReport(actor: WalkAuditActor, id: number): Promise<void> {
    const parent = found((await rows(this.store.db, 'SELECT study_id FROM walk_audit_reports WHERE id=$1', [id]))[0]).study_id;
    await this.store.transaction(async db => { const study = await lockStudy(db, parent); await organizer(db, study, actor); found((await rows(db, 'DELETE FROM walk_audit_reports WHERE id=$1 RETURNING id', [id]))[0]); });
  }
}
