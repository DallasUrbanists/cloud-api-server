/** Transactional audits, private drafts, coverage and captured editable reports. @module */
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { FeatureCollection, Prompt, WalkAuditError } from '../models/walkAudit.js';
import { auditType, fields, invalid, object, pointInRing, positiveInt, text, validateAnswers } from '../utils/walkAuditValidation.js';
import { WalkAuditConnection } from './walkAuditStore.js';
import { auditDto, contributor, draftDto, found, lockStudy, organizer, pageResult, Page, reportDto, rows, studyDto, version, WalkAuditActor, WalkAuditService, worksheetDto } from './walkAuditService.js';

type Db = WalkAuditConnection | Pool;
type Row = Record<string, any>;
const auditFields = ['type', 'worksheetId', 'featureId', 'locationGps', 'locationDescription', 'geojson', 'answers'];
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
async function completeAudit(db: Db, study: Row, value: Row): Promise<Row> {
  const type = auditType(value.type), worksheetId = positiveInt(value.worksheetId, 'worksheetId'), featureId = text(value.featureId, 'featureId', 255);
  const worksheet = found((await rows(db, 'SELECT * FROM walk_audit_worksheets WHERE id=$1 FOR SHARE', [worksheetId]))[0]);
  if (!worksheet.recommend_for.includes(type)) invalid('The worksheet is not recommended for this audit type.');
  const features: FeatureCollection = type === 'intersection' ? study.intersections : study.segments;
  const feature = features.features.find(item => item.properties.id === featureId);
  if (!feature || feature.geometry.type !== (type === 'intersection' ? 'Point' : 'LineString')) invalid('featureId must identify a matching feature in this study.');
  if (value.geojson !== undefined && value.geojson !== null) {
    const supplied = object(value.geojson, 'geojson');
    if (supplied.type !== 'Feature' || JSON.stringify(supplied.geometry) !== JSON.stringify(feature.geometry) || object(supplied.properties, 'geojson properties').id !== featureId) invalid('geojson must match the saved study feature.');
  }
  const locationGps = validateGps(value.locationGps, study);
  if (feature.geometry.type === 'Point' && (Math.abs(locationGps.longitude - feature.geometry.coordinates[0]) > 1e-8 || Math.abs(locationGps.latitude - feature.geometry.coordinates[1]) > 1e-8)) invalid('locationGps must match the intersection.');
  return { type, worksheetId, featureId, locationGps, locationDescription: text(value.locationDescription, 'locationDescription', 500, true), geojson: feature, answers: validateAnswers(value.answers, worksheet.prompts as Prompt[], true) };
}
function mergedAudit(row: Row): Row {
  return { type: row.type, worksheetId: row.worksheet_id, featureId: row.feature_id, locationGps: row.location_gps, locationDescription: row.location_description, geojson: row.geojson, answers: row.answers };
}
function sqlAudit(data: Row): unknown[] { return [data.worksheetId, data.type, data.featureId, JSON.stringify(data.locationGps), data.locationDescription, JSON.stringify(data.geojson), JSON.stringify(data.answers)]; }

/** Compute distinct known-feature coverage; repeated observations count once. */
export function calculateProgress(study: Row, audits: Row[]): Row {
  const measure = (type: string, collection: FeatureCollection): Row => {
    const known = new Set(collection.features.map(f => f.properties.id));
    const covered = new Set(audits.filter(a => a.type === type && known.has(a.feature_id ?? a.featureId)).map(a => a.feature_id ?? a.featureId));
    return { audited: covered.size, total: known.size, ratio: known.size ? covered.size / known.size : 0 };
  };
  const streets = measure('street-segment', study.segments), intersections = measure('intersection', study.intersections);
  const total = streets.total + intersections.total, audited = streets.audited + intersections.audited;
  return { streets, intersections, overall: { audited, total, ratio: total ? audited / total : 0 } };
}
async function getProgress(db: Db, study: Row): Promise<Row> {
  return calculateProgress(study, await rows(db, 'SELECT DISTINCT type,feature_id FROM walk_audit_audits WHERE study_id=$1', [study.id]));
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
async function partialDraft(db: Db, study: Row, data: Row): Promise<Row> {
  if (data.type != null) data.type = auditType(data.type);
  if (data.worksheetId != null) {
    const worksheet = found((await rows(db, 'SELECT * FROM walk_audit_worksheets WHERE id=$1 FOR SHARE', [positiveInt(data.worksheetId, 'worksheetId')]))[0]);
    if (data.type != null && !worksheet.recommend_for.includes(data.type)) invalid('The worksheet is not recommended for this audit type.');
    data.answers = validateAnswers(data.answers, worksheet.prompts as Prompt[], false);
  } else data.answers = validateAnswers(data.answers, undefined, false);
  if (data.featureId != null) data.featureId = text(data.featureId, 'featureId', 255);
  if (data.locationGps != null) data.locationGps = validateGps(data.locationGps, study);
  if (data.locationDescription != null) data.locationDescription = text(data.locationDescription, 'locationDescription', 500, true);
  if (data.geojson != null) {
    const geo = object(data.geojson, 'geojson'); const geometry = object(geo.geometry, 'geojson geometry');
    if (geo.type !== 'Feature' || (geometry.type !== 'Point' && geometry.type !== 'LineString') || !Array.isArray(geometry.coordinates)) invalid('geojson must be a Point or LineString Feature.');
    if (data.type && geometry.type !== (data.type === 'intersection' ? 'Point' : 'LineString')) invalid('geojson must match the audit type.');
    const positions = geometry.type === 'Point' ? [geometry.coordinates] : geometry.coordinates;
    if ((geometry.type === 'LineString' && positions.length < 2) || positions.some((p: unknown) => !Array.isArray(p) || p.length !== 2 || p.some(n => typeof n !== 'number' || !Number.isFinite(n)) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90)) invalid('geojson coordinates must be finite longitude/latitude pairs.');
    object(geo.properties, 'geojson properties');
  }
  return data;
}

/** Adds transactional observation and report operations to the administrative service. */
export class WalkAuditWorkflows extends WalkAuditService {
  /** Study details include current coverage without embedding every audit. */
  override async getStudy(id: number): Promise<Row> {
    const study = await studyById(this.store.db, id);
    return { ...studyDto(study, true), progress: await getProgress(this.store.db, study) };
  }
  /** Return current deduplicated network coverage. */
  async progress(id: number): Promise<Row> { return getProgress(this.store.db, await studyById(this.store.db, id)); }
  /** List public audits within one study. */
  async listAudits(id: number, page: Page): Promise<Row> {
    await studyById(this.store.db, id); const args: unknown[] = [id], conditions = ['a.study_id=$1'];
    for (const [field, column] of [['type', 'type'], ['author', 'created_by'], ['worksheet', 'worksheet_id']] as const) if (page[field] !== undefined) { args.push(page[field]); conditions.push(`a.${column}=$${args.length}`); }
    args.push(page.limit + 1, page.offset);
    return pageResult(await rows(this.store.db, `${auditSelect} WHERE ${conditions.join(' AND ')} ORDER BY a.created_on DESC,a.id DESC LIMIT $${args.length - 1} OFFSET $${args.length}`, args), page, 'audits', row => {
      const summary = auditDto(row); delete summary.geojson; delete summary.answers; return summary;
    });
  }
  /** Read a public submitted audit. */
  async getAudit(id: number): Promise<Row> { return auditDto(found((await rows(this.store.db, `${auditSelect} WHERE a.id=$1`, [id]))[0])); }
  /** Validate a complete observation and persist it while locking its parent study. */
  async createAudit(actor: WalkAuditActor, studyId: number, body: unknown): Promise<Row> {
    const data = fields(body, auditFields);
    return this.store.transaction(async db => {
      const study = await lockStudy(db, studyId), caller = await contributor(db, actor), audit = await completeAudit(db, study, data);
      const row = (await rows(db, `INSERT INTO walk_audit_audits(study_id,created_by,worksheet_id,type,feature_id,location_gps,location_description,geojson,answers) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [studyId, caller.id, ...sqlAudit(audit)]))[0];
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
      const merged = { ...mergedAudit(current), ...patch }; delete merged.expectedVersion;
      if (JSON.stringify(merged) === JSON.stringify(mergedAudit(current))) invalid('An audit change is required.');
      const audit = await completeAudit(db, study, merged);
      const row = (await rows(db, `UPDATE walk_audit_audits SET worksheet_id=$2,type=$3,feature_id=$4,location_gps=$5,location_description=$6,geojson=$7,answers=$8,version=version+1,updated_on=now() WHERE id=$1 RETURNING *`, [id, ...sqlAudit(audit)]))[0];
      row.display_name = current.display_name; return auditDto(row);
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
    return pageResult(await rows(this.store.db, `SELECT * FROM walk_audit_drafts WHERE study_id=$1 AND created_by=$2${filter} ORDER BY updated_on DESC,id DESC LIMIT $${args.length - 1} OFFSET $${args.length}`, args), page, 'drafts', draftDto);
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
      const row = (await rows(db, `INSERT INTO walk_audit_drafts(id,study_id,created_by,editing_audit_id,editing_audit_version,worksheet_id,type,feature_id,location_gps,location_description,geojson,answers)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [randomUUID(), studyId, caller.id, edit?.id ?? null, edit?.version ?? null, edit?.worksheet_id ?? null, edit?.type ?? null, edit?.feature_id ?? null, edit ? JSON.stringify(edit.location_gps) : null, edit?.location_description ?? null, edit ? JSON.stringify(edit.geojson) : null, JSON.stringify(edit?.answers ?? {})]))[0];
      return draftDto(row);
    });
  }
  /** Read a draft only for its owner, concealing it from staff and other users. */
  async getDraft(actor: WalkAuditActor, id: string): Promise<Row> { return draftDto(await privateDraft(this.store.db, id, actor)); }
  /** Autosave a structurally valid partial draft with optimistic concurrency. */
  async patchDraft(actor: WalkAuditActor, id: string, body: unknown): Promise<Row> {
    const patch = fields(body, ['expectedVersion', ...auditFields]); positiveInt(patch.expectedVersion, 'expectedVersion');
    if (Object.keys(patch).length < 2) invalid('A draft change is required.');
    const parent = await draftParent(this.store.db, id, actor);
    return this.store.transaction(async db => {
      const study = await lockStudy(db, parent), current = await privateDraft(db, id, actor, true); version(current, patch.expectedVersion);
      const merged = { ...mergedAudit(current), ...patch }; delete merged.expectedVersion;
      if (JSON.stringify(merged) === JSON.stringify(mergedAudit(current))) invalid('A draft change is required.');
      const data = await partialDraft(db, study, merged);
      const row = (await rows(db, `UPDATE walk_audit_drafts SET worksheet_id=$2,type=$3,feature_id=$4,location_gps=$5,location_description=$6,geojson=$7,answers=$8,version=version+1,updated_on=now() WHERE id=$1 RETURNING *`, [id, data.worksheetId ?? null, data.type ?? null, data.featureId ?? null, data.locationGps == null ? null : JSON.stringify(data.locationGps), data.locationDescription ?? null, data.geojson == null ? null : JSON.stringify(data.geojson), JSON.stringify(data.answers)]))[0];
      return draftDto(row);
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
      if (draft.editing_audit_id) {
        current = found((await rows(db, `${auditSelect} WHERE a.id=$1 AND a.created_by=$2 FOR UPDATE OF a`, [draft.editing_audit_id, caller.id]))[0]);
        version(current, draft.editing_audit_version);
      }
      const audit = await completeAudit(db, study, mergedAudit(draft));
      const saved = current
        ? (await rows(db, `UPDATE walk_audit_audits SET worksheet_id=$2,type=$3,feature_id=$4,location_gps=$5,location_description=$6,geojson=$7,answers=$8,version=version+1,updated_on=now() WHERE id=$1 RETURNING *`, [current.id, ...sqlAudit(audit)]))[0]
        : (await rows(db, `INSERT INTO walk_audit_audits(study_id,created_by,worksheet_id,type,feature_id,location_gps,location_description,geojson,answers) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [parent, caller.id, ...sqlAudit(audit)]))[0];
      await rows(db, 'DELETE FROM walk_audit_drafts WHERE id=$1', [id]); saved.display_name = caller.display_name;
      return { audit: auditDto(saved), created: !current };
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
    const coverage = calculateProgress(study, selected);
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
