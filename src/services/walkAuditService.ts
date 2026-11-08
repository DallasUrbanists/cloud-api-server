/** PostgreSQL-backed walk-audit administration and study workflows. @module */
import { AreaFeature, GeneratedStudy, WalkAuditError } from '../models/walkAudit.js';
import { randomUUID } from 'node:crypto';
import { auditType, fields, invalid, object, positiveInt, text, validateArea, validatePrompts } from '../utils/walkAuditValidation.js';
import { WalkAuditGenerator } from './walkAuditGeospatial.js';
import { WalkAuditConnection, WalkAuditStore } from './walkAuditStore.js';
import type { Pool } from 'pg';

/** Identity supplied only after Firebase has verified the ID token. */
export interface WalkAuditActor { uid: string; staff: boolean }
export interface Page { limit: number; offset: number; [key: string]: string | number | boolean | undefined }
type Db = WalkAuditConnection | Pool;
type Row = Record<string, any>;

/** A parameterized query helper shared with the transactional workflows. */
export async function rows(db: Db, sql: string, values: unknown[] = []): Promise<Row[]> {
  return (await db.query(sql, values)).rows;
}
/** Require an existing record. */
export function found<T>(row: T | undefined): T {
  if (!row) throw new WalkAuditError(404, 'NOT_FOUND', 'The requested resource was not found.');
  return row;
}
/** Compare an optimistic version after acquiring the row lock. */
export function version(row: Row, expected: unknown): void {
  if (row.version !== positiveInt(expected, 'expectedVersion')) throw new WalkAuditError(409, 'VERSION_CONFLICT', 'The resource has changed; reload it and try again.');
}
/** Return an ISO timestamp whether PostgreSQL or a test adapter returned a date. */
export function iso(value: Date | string): string { return new Date(value).toISOString(); }
/** Public contributor information contains no Firebase identity. */
export function contributorDto(row: Row): Row { return { id: row.id, displayName: row.display_name, createdOn: iso(row.created_on), updatedOn: iso(row.updated_on) }; }
/** Convert a worksheet row to its public representation. */
export function worksheetDto(row: Row): Row {
  return { id: row.id, slug: row.slug, version: row.version, title: row.title, description: row.description, sourceUrl: row.source_url, recommendFor: row.recommend_for, prompts: row.prompts, createdOn: iso(row.created_on), updatedOn: iso(row.updated_on) };
}
/** Convert a study row without exposing the binary thumbnail or creator UID. */
export function studyDto(row: Row, detail = false): Row {
  const result: Row = { id: row.id, createdBy: { id: row.created_by, displayName: row.display_name }, neighborhood: row.neighborhood, createdOn: iso(row.created_on), updatedOn: iso(row.updated_on), version: row.version };
  if (detail) Object.assign(result, { locationGps: row.location_gps, locationDescription: row.location_description, area: row.area, intersections: row.intersections, segments: row.segments, sourceMetadata: row.source_metadata, allowedAuditTypes: row.allowedAuditTypes, questionnaires: row.questionnaires });
  return result;
}
/** Convert a submitted audit to its sanitized public representation. */
export function auditDto(row: Row): Row {
  return { id: row.id, studyId: row.study_id, createdBy: { id: row.created_by, displayName: row.display_name }, worksheetId: row.worksheet_id, createdOn: iso(row.created_on), updatedOn: iso(row.updated_on), version: row.version, type: row.type, featureId: row.feature_id, locationGps: row.location_gps, locationDescription: row.location_description, geojson: row.geojson, routeSelection: row.route_selection, answers: row.answers, photos: row.photos ?? [] };
}
/** Drafts are returned only to their owner. */
export function draftDto(row: Row): Row {
  return { id: row.id, studyId: row.study_id, createdBy: row.created_by, createdOn: iso(row.created_on), updatedOn: iso(row.updated_on), version: row.version, editingAuditId: row.editing_audit_id, editingAuditVersion: row.editing_audit_version, type: row.type, worksheetId: row.worksheet_id, featureId: row.feature_id, locationGps: row.location_gps, locationDescription: row.location_description, geojson: row.geojson, routeSelection: row.route_selection, answers: row.answers, photos: row.photos ?? [] };
}
/** Report lists omit the captured answer and geometry payload. */
export function reportDto(row: Row, detail = false): Row {
  const result: Row = { id: row.id, studyId: row.study_id, createdBy: { id: row.created_by, displayName: row.display_name }, createdOn: iso(row.created_on), updatedOn: iso(row.updated_on), version: row.version, title: row.title, description: row.description, auditIds: row.audit_ids, completion: Number(row.completion), coverageApplicable: row.captured_data?.progress?.overall?.coverageApplicable };
  if (detail) result.capturedData = row.captured_data;
  return result;
}
/** Produce a deterministic list envelope after requesting one extra row. */
export function pageResult(list: Row[], page: Page, key: string, map: (row: Row) => Row): Row {
  return { [key]: list.slice(0, page.limit).map(map), limit: page.limit, offset: page.offset, hasMore: list.length > page.limit };
}
/** Find the contributor for a verified identity; registration is required for domain writes. */
export async function contributor(db: Db, actor: WalkAuditActor): Promise<Row> {
  const row = (await rows(db, 'SELECT * FROM walk_audit_contributors WHERE firebase_uid = $1', [actor.uid]))[0];
  if (!row) throw new WalkAuditError(409, 'REGISTRATION_REQUIRED', 'Create a contributor profile before this action.');
  return row;
}
/** Lock a study before locking any of its child rows. */
export async function lockStudy(db: Db, id: number): Promise<Row> {
  return found((await rows(db, 'SELECT s.*, c.display_name FROM walk_audit_studies s JOIN walk_audit_contributors c ON c.id=s.created_by WHERE s.id=$1 FOR UPDATE OF s', [id]))[0]);
}
/** Require the study organizer or canonical staff. */
export async function organizer(db: Db, study: Row, actor: WalkAuditActor): Promise<void> {
  const caller = await contributor(db, actor);
  if (actor.staff) return;
  if (study.created_by !== caller.id) throw new WalkAuditError(403, 'FORBIDDEN', 'Only the organizer or staff may perform this action.');
}
/** Require canonical staff, not legacy role strings. */
export function staff(actor: WalkAuditActor): void { if (!actor.staff) throw new WalkAuditError(403, 'FORBIDDEN', 'Staff access is required.'); }

function worksheetInput(body: unknown): Row {
  const data = fields(body, ['slug', 'title', 'description', 'sourceUrl', 'recommendFor', 'prompts']);
  const slug = text(data.slug, 'slug', 100);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) invalid('slug must be a lowercase slug.');
  const sourceUrl = text(data.sourceUrl, 'sourceUrl', 2048);
  try { if (new URL(sourceUrl).protocol !== 'https:') invalid('sourceUrl must use HTTPS.'); } catch { invalid('sourceUrl must be an HTTPS URL.'); }
  if (!Array.isArray(data.recommendFor) || !data.recommendFor.length || data.recommendFor.length > 3) invalid('recommendFor must contain audit types.');
  const recommendFor = data.recommendFor.map(auditType);
  if (new Set(recommendFor).size !== recommendFor.length) invalid('recommendFor must not contain duplicates.');
  return { slug, title: text(data.title, 'title', 200), description: text(data.description, 'description', 4000, true), sourceUrl, recommendFor, prompts: validatePrompts(data.prompts) };
}
function generatedValues(result: GeneratedStudy): unknown[] {
  return [JSON.stringify(result.locationGps), result.locationDescription, JSON.stringify(result.area), JSON.stringify(result.intersections), JSON.stringify(result.segments), result.thumbnailPng, JSON.stringify(result.sourceMetadata)];
}

/** Load immutable study assignments before passing the row to a pure DTO. */
export async function loadStudyQuestionnaires(db: Db, study: Row): Promise<Row> {
  const assignments = await rows(db, `SELECT q.audit_type,q.catalog_version,q.source_metadata,w.id,w.title,w.prompts
    FROM walk_audit_study_questionnaires q JOIN walk_audit_worksheets w ON w.id=q.worksheet_id
    WHERE q.study_id=$1 ORDER BY q.audit_type`, [study.id]);
  study.allowedAuditTypes = assignments.map(row => row.audit_type);
  study.questionnaires = Object.fromEntries(assignments.map(row => [row.audit_type, {
    worksheetId: row.id, title: row.title, prompts: row.prompts,
    catalogVersion: row.catalog_version, sourceMetadata: row.source_metadata
  }]));
  return study;
}

function questionnaireInput(data: Row): Row | null {
  if (data.allowedAuditTypes === undefined && data.questionnaires === undefined) return null;
  if (!Array.isArray(data.allowedAuditTypes) || !data.allowedAuditTypes.length || data.allowedAuditTypes.length > 3 || data.questionnaires === undefined) invalid('allowedAuditTypes and questionnaires must describe at least one audit type.');
  const types = data.allowedAuditTypes.map(auditType);
  if (new Set(types).size !== types.length) invalid('allowedAuditTypes must not contain duplicates.');
  const input = object(data.questionnaires, 'questionnaires');
  if (Object.keys(input).length !== types.length || types.some((type: string) => !(type in input))) invalid('questionnaire keys must match allowedAuditTypes.');
  const result: Row = {};
  for (const type of types) {
    const item = fields(input[type], ['prompts', 'sourceMetadata'], 'questionnaire');
    const prompts = validatePrompts(item.prompts);
    if (prompts.length > 30) invalid('Study questionnaires may contain at most 30 prompts.');
    const metadata = fields(item.sourceMetadata, ['catalogVersion', 'questions'], 'sourceMetadata');
    const catalogVersion = metadata.catalogVersion === undefined ? 'custom-v1' : text(metadata.catalogVersion, 'catalogVersion', 100);
    const questionSources = object(metadata.questions, 'sourceMetadata questions');
    if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > 100000) invalid('sourceMetadata is too large.');
    const validIds = new Set(prompts.map(prompt => prompt.id));
    for (const [id, source] of Object.entries(questionSources)) {
      if (!validIds.has(id)) invalid('sourceMetadata references an unknown question.');
      const sourceData = fields(source, ['sourceQuestionId'], 'question source');
      const sourceId = text(sourceData.sourceQuestionId, 'sourceQuestionId', 100);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(sourceId)) invalid('sourceQuestionId must be a lowercase slug.');
    }
    result[type] = { prompts, catalogVersion, sourceMetadata: metadata };
  }
  return result;
}

/** Administrative CRUD and generation use the same PostgreSQL pool as the rest of the API. */
export class WalkAuditService {
  constructor(public readonly store = new WalkAuditStore(), public readonly generator = new WalkAuditGenerator()) {}

  /** Create one profile for a verified Firebase UID. */
  async createContributor(actor: WalkAuditActor, body: unknown): Promise<Row> {
    const data = fields(body, ['displayName']);
    const row = (await rows(this.store.db, 'INSERT INTO walk_audit_contributors(firebase_uid,display_name) VALUES($1,$2) RETURNING *', [actor.uid, text(data.displayName, 'displayName', 120)]))[0];
    return contributorDto(row);
  }
  /** Read a caller's own profile or a staff-selected profile. */
  async getContributor(actor: WalkAuditActor, id?: number): Promise<Row> {
    if (id !== undefined) staff(actor);
    const result = id === undefined ? await rows(this.store.db, 'SELECT * FROM walk_audit_contributors WHERE firebase_uid=$1', [actor.uid]) : await rows(this.store.db, 'SELECT * FROM walk_audit_contributors WHERE id=$1', [id]);
    return contributorDto(found(result[0]));
  }
  /** List sanitized profiles for staff only. */
  async listContributors(actor: WalkAuditActor, page: Page): Promise<Row> {
    staff(actor);
    return pageResult(await rows(this.store.db, 'SELECT * FROM walk_audit_contributors ORDER BY created_on DESC,id DESC LIMIT $1 OFFSET $2', [page.limit + 1, page.offset]), page, 'contributors', contributorDto);
  }
  /** Update only the profile display name. */
  async patchContributor(actor: WalkAuditActor, body: unknown, id?: number): Promise<Row> {
    if (id !== undefined) { staff(actor); await contributor(this.store.db, actor); }
    const data = fields(body, ['displayName']);
    const name = text(data.displayName, 'displayName', 120);
    const row = (await rows(this.store.db, `UPDATE walk_audit_contributors SET display_name=$1,updated_on=now() WHERE ${id === undefined ? 'firebase_uid' : 'id'}=$2 AND display_name<>$1 RETURNING *`, [name, id ?? actor.uid]))[0];
    if (!row) { await this.getContributor(actor, id); invalid('No profile change was supplied.'); }
    return contributorDto(row);
  }
  /** Delete a profile only if no domain rows depend on it. */
  async deleteContributor(actor: WalkAuditActor, id?: number): Promise<void> {
    if (id !== undefined) { staff(actor); await contributor(this.store.db, actor); }
    found((await rows(this.store.db, `DELETE FROM walk_audit_contributors WHERE ${id === undefined ? 'firebase_uid' : 'id'}=$1 RETURNING id`, [id ?? actor.uid]))[0]);
  }
  /** List the latest worksheet versions, or explicit version history. */
  async listWorksheets(page: Page): Promise<Row> {
    const where = page.type ? 'WHERE $1=ANY(w.recommend_for)' : '';
    const args: unknown[] = page.type ? [auditType(page.type)] : [];
    args.push(page.limit + 1, page.offset);
    const source = page.includeVersions ? 'SELECT * FROM walk_audit_worksheets WHERE is_template' : 'SELECT DISTINCT ON (slug) * FROM walk_audit_worksheets WHERE is_template ORDER BY slug,version DESC';
    return pageResult(await rows(this.store.db, `SELECT w.* FROM (${source}) w ${where} ORDER BY w.created_on DESC,w.id DESC LIMIT $${args.length - 1} OFFSET $${args.length}`, args), page, 'worksheets', worksheetDto);
  }
  /** Retrieve one pinned worksheet version. */
  async getWorksheet(id: number): Promise<Row> { return worksheetDto(found((await rows(this.store.db, 'SELECT * FROM walk_audit_worksheets WHERE id=$1', [id]))[0])); }
  /** Create an original worksheet definition as version one. */
  async createWorksheet(actor: WalkAuditActor, body: unknown): Promise<Row> {
    staff(actor); await contributor(this.store.db, actor); const data = worksheetInput(body);
    return worksheetDto((await rows(this.store.db, 'INSERT INTO walk_audit_worksheets(slug,version,title,description,source_url,recommend_for,prompts) VALUES($1,1,$2,$3,$4,$5,$6) RETURNING *', [data.slug, data.title, data.description, data.sourceUrl, data.recommendFor, JSON.stringify(data.prompts)]))[0]);
  }
  /** Allocate a new version under a per-slug transaction lock, preserving earlier definitions. */
  async patchWorksheet(actor: WalkAuditActor, id: number, body: unknown): Promise<Row> {
    staff(actor); await contributor(this.store.db, actor); const data = fields(body, ['title', 'description', 'sourceUrl', 'recommendFor', 'prompts']);
    if (!Object.keys(data).length) invalid('A worksheet change is required.');
    return this.store.transaction(async db => {
      const prior = found((await rows(db, 'SELECT * FROM walk_audit_worksheets WHERE id=$1', [id]))[0]);
      if (!prior.is_template) throw new WalkAuditError(409, 'STUDY_QUESTIONNAIRE_IMMUTABLE', 'Study questionnaires cannot be revised as global templates.');
      await rows(db, 'SELECT pg_advisory_xact_lock(hashtext($1))', [prior.slug]);
      const current = found((await rows(db, 'SELECT * FROM walk_audit_worksheets WHERE id=$1 FOR UPDATE', [id]))[0]);
      const merged = worksheetInput({ slug: current.slug, title: current.title, description: current.description, sourceUrl: current.source_url, recommendFor: current.recommend_for, prompts: current.prompts, ...data });
      if (JSON.stringify([current.title, current.description, current.source_url, current.recommend_for, current.prompts]) === JSON.stringify([merged.title, merged.description, merged.sourceUrl, merged.recommendFor, merged.prompts])) invalid('A worksheet change is required.');
      const next = (await rows(db, 'SELECT MAX(version)::int + 1 AS version FROM walk_audit_worksheets WHERE slug=$1', [current.slug]))[0].version;
      return worksheetDto((await rows(db, 'INSERT INTO walk_audit_worksheets(slug,version,title,description,source_url,recommend_for,prompts) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *', [current.slug, next, merged.title, merged.description, merged.sourceUrl, merged.recommendFor, JSON.stringify(merged.prompts)]))[0]);
    });
  }
  /** Delete one unreferenced worksheet version. */
  async deleteWorksheet(actor: WalkAuditActor, id: number): Promise<void> { staff(actor); await contributor(this.store.db, actor); const current = found((await rows(this.store.db, 'SELECT is_template FROM walk_audit_worksheets WHERE id=$1', [id]))[0]); if (!current.is_template) throw new WalkAuditError(409, 'STUDY_QUESTIONNAIRE_IMMUTABLE', 'Study questionnaires cannot be changed as global templates.'); found((await rows(this.store.db, 'DELETE FROM walk_audit_worksheets WHERE id=$1 RETURNING id', [id]))[0]); }

  /** Reserve the shared per-user generation interval atomically in PostgreSQL. */
  async reserveGeneration(actor: WalkAuditActor): Promise<Row> {
    const profile = await contributor(this.store.db, actor);
    const reserved = (await rows(this.store.db, `UPDATE walk_audit_contributors SET next_generation_on=clock_timestamp()+($2::integer * interval '1 millisecond') WHERE id=$1 AND (next_generation_on IS NULL OR next_generation_on<=clock_timestamp()) RETURNING id`, [profile.id, this.generator.config.intervalMs]))[0];
    if (!reserved) {
      const remaining = (await rows(this.store.db, 'SELECT GREATEST(1,CEIL(EXTRACT(EPOCH FROM next_generation_on-clock_timestamp())))::int AS seconds FROM walk_audit_contributors WHERE id=$1', [profile.id]))[0];
      throw new WalkAuditError(429, 'GENERATION_RATE_LIMIT', 'Please wait before starting another study generation.', remaining?.seconds ?? 1);
    }
    return profile;
  }
  /** Generate first, then atomically insert the complete study and its thumbnail. */
  async createStudy(actor: WalkAuditActor, body: unknown, signal?: AbortSignal): Promise<Row> {
    const data = fields(body, ['neighborhood', 'area', 'allowedAuditTypes', 'questionnaires']);
    const neighborhood = text(data.neighborhood, 'neighborhood', 200), area = validateArea(data.area);
    const definitions = questionnaireInput(data);
    const profile = await this.reserveGeneration(actor);
    const generated = await this.generator.generate(area, neighborhood, signal);
    return this.store.transaction(async db => {
      if (signal?.aborted) throw new WalkAuditError(503, 'GENERATION_CANCELLED', 'Generation was cancelled.');
      const row = (await rows(db, `INSERT INTO walk_audit_studies(created_by,neighborhood,location_gps,location_description,area,intersections,segments,thumbnail_png,source_metadata)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [profile.id, neighborhood, ...generatedValues(generated)]))[0];
      if (definitions) {
        for (const [type, definition] of Object.entries(definitions) as [string, Row][]) {
          const title = `${neighborhood}: ${type} questions`.slice(0, 200);
          const worksheet = (await rows(db, `INSERT INTO walk_audit_worksheets(slug,version,title,description,source_url,recommend_for,prompts,is_template)
            VALUES($1,1,$2,'Study-owned questionnaire','https://audit.mapmy.town/',$3,$4,false) RETURNING id`, [`study-${row.id}-${type}-${randomUUID().replaceAll('-', '')}`, title, [type], JSON.stringify(definition.prompts)]))[0];
          await rows(db, 'INSERT INTO walk_audit_study_questionnaires(study_id,audit_type,worksheet_id,catalog_version,source_metadata) VALUES($1,$2,$3,$4,$5)', [row.id, type, worksheet.id, definition.catalogVersion, JSON.stringify(definition.sourceMetadata)]);
        }
      } else {
        for (const [type, slug] of [['intersection', 'intersection-observation'], ['street-segment', 'street-observation']]) {
          const worksheet = (await rows(db, 'SELECT id FROM walk_audit_worksheets WHERE slug=$1 AND is_template ORDER BY version DESC,id DESC LIMIT 1', [slug]))[0];
          if (!worksheet) throw new WalkAuditError(409, 'QUESTIONNAIRE_SETUP_MISSING', `The default ${slug} worksheet is missing.`);
          await rows(db, `INSERT INTO walk_audit_study_questionnaires(study_id,audit_type,worksheet_id,catalog_version,source_metadata) VALUES($1,$2,$3,'legacy-template-v1','{}')`, [row.id, type, worksheet.id]);
        }
      }
      if (signal?.aborted) throw new WalkAuditError(503, 'GENERATION_CANCELLED', 'Generation was cancelled.');
      row.display_name = profile.display_name;
      await loadStudyQuestionnaires(db, row);
      return studyDto(row, true);
    });
  }
  /** Read public study metadata and generated geometry, without eagerly loading audits. */
  async getStudy(id: number): Promise<Row> {
    return studyDto(await loadStudyQuestionnaires(this.store.db, found((await rows(this.store.db, 'SELECT s.*,c.display_name FROM walk_audit_studies s JOIN walk_audit_contributors c ON c.id=s.created_by WHERE s.id=$1', [id]))[0])), true);
  }
  /** List compact studies with optional creator and neighborhood filters. */
  async listStudies(page: Page): Promise<Row> {
    const conditions: string[] = [], args: unknown[] = [];
    if (page.creator !== undefined) { args.push(page.creator); conditions.push(`s.created_by=$${args.length}`); }
    if (page.neighborhood !== undefined) { args.push(page.neighborhood); conditions.push(`s.neighborhood ILIKE '%' || $${args.length} || '%'`); }
    args.push(page.limit + 1, page.offset);
    const list = await rows(this.store.db, `SELECT s.id,s.created_by,s.neighborhood,s.created_on,s.updated_on,s.version,c.display_name FROM walk_audit_studies s JOIN walk_audit_contributors c ON c.id=s.created_by ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''} ORDER BY s.created_on DESC,s.id DESC LIMIT $${args.length - 1} OFFSET $${args.length}`, args);
    return pageResult(list, page, 'studies', row => studyDto(row));
  }
  /** Return only the stored PNG bytes. */
  async thumbnail(id: number): Promise<Buffer> { return found((await rows(this.store.db, 'SELECT thumbnail_png FROM walk_audit_studies WHERE id=$1', [id]))[0]).thumbnail_png; }
  /** Update a neighborhood or regenerate a childless study's geometry. */
  async patchStudy(actor: WalkAuditActor, id: number, body: unknown, signal?: AbortSignal): Promise<Row> {
    const data = fields(body, ['expectedVersion', 'neighborhood', 'area']); positiveInt(data.expectedVersion, 'expectedVersion');
    if (data.neighborhood === undefined && data.area === undefined) invalid('A study change is required.');
    const initial = found((await rows(this.store.db, 'SELECT s.*,c.display_name FROM walk_audit_studies s JOIN walk_audit_contributors c ON c.id=s.created_by WHERE s.id=$1', [id]))[0]);
    await organizer(this.store.db, initial, actor); version(initial, data.expectedVersion);
    const neighborhood = data.neighborhood === undefined ? initial.neighborhood : text(data.neighborhood, 'neighborhood', 200);
    const area: AreaFeature | undefined = data.area === undefined ? undefined : validateArea(data.area);
    if (neighborhood === initial.neighborhood && (!area || JSON.stringify(area) === JSON.stringify(initial.area))) invalid('A study change is required.');
    let generated: GeneratedStudy | undefined;
    if (area) {
      const dependencies = (await rows(this.store.db, `SELECT EXISTS(SELECT 1 FROM walk_audit_audits WHERE study_id=$1 UNION ALL SELECT 1 FROM walk_audit_drafts WHERE study_id=$1 UNION ALL SELECT 1 FROM walk_audit_reports WHERE study_id=$1) AS present`, [id]))[0].present;
      if (dependencies) throw new WalkAuditError(409, 'STUDY_HAS_DEPENDENCIES', 'A study with audits, drafts or reports cannot change its boundary.');
      await this.reserveGeneration(actor); generated = await this.generator.generate(area, neighborhood, signal);
    }
    return this.store.transaction(async db => {
      const current = await lockStudy(db, id); await organizer(db, current, actor); version(current, data.expectedVersion);
      if (generated) {
        const dependencies = (await rows(db, `SELECT EXISTS(SELECT 1 FROM walk_audit_audits WHERE study_id=$1 UNION ALL SELECT 1 FROM walk_audit_drafts WHERE study_id=$1 UNION ALL SELECT 1 FROM walk_audit_reports WHERE study_id=$1) AS present`, [id]))[0].present;
        if (dependencies) throw new WalkAuditError(409, 'STUDY_HAS_DEPENDENCIES', 'A study with audits, drafts or reports cannot change its boundary.');
        if (signal?.aborted) throw new WalkAuditError(503, 'GENERATION_CANCELLED', 'Generation was cancelled.');
      }
      const updated = generated
        ? (await rows(db, `UPDATE walk_audit_studies SET neighborhood=$2,location_gps=$3,location_description=$4,area=$5,intersections=$6,segments=$7,thumbnail_png=$8,source_metadata=$9,version=version+1,updated_on=now() WHERE id=$1 RETURNING *`, [id, neighborhood, ...generatedValues(generated)]))[0]
        : (await rows(db, 'UPDATE walk_audit_studies SET neighborhood=$2,location_description=$2,version=version+1,updated_on=now() WHERE id=$1 RETURNING *', [id, neighborhood]))[0];
      if (signal?.aborted) throw new WalkAuditError(503, 'GENERATION_CANCELLED', 'Generation was cancelled.');
      updated.display_name = current.display_name; await loadStudyQuestionnaires(db, updated); return studyDto(updated, true);
    });
  }
  /** Permanently delete the study and all contributors' child rows and stored thumbnail. */
  async deleteStudy(actor: WalkAuditActor, id: number): Promise<void> {
    await this.store.transaction(async db => { const study = await lockStudy(db, id); await organizer(db, study, actor); await rows(db, 'DELETE FROM walk_audit_studies WHERE id=$1', [id]); });
  }
}
