import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { WalkAuditStore } from '../src/services/walkAuditStore.js';
import { WalkAuditWorkflows } from '../src/services/walkAuditWorkflows.js';
import type { WalkAuditGenerator } from '../src/services/walkAuditGeospatial.js';

const area = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]] } };
const intersections = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { id: 'node/1', name: null }, geometry: { type: 'Point', coordinates: [0.001, 0.001] } }] };
const segments = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { id: 'way/10/1/2/0/0', name: null }, geometry: { type: 'LineString', coordinates: [[0.001, 0.001], [0.005, 0.001]] } }] };
const types = ['intersection', 'street-segment', 'point'];
const actor = { uid: 'author', staff: false }, staff = { uid: 'staff', staff: true };
const definition = { prompts: [{ id: 'q-1', type: 'text', label: 'Describe it', required: false, maxLength: 2000 }], sourceMetadata: { catalogVersion: 'test-v1', questions: { 'q-1': { sourceQuestionId: 'common-observations' } } } };
const config = (enabled: string[]) => ({ allowedAuditTypes: enabled, questionnaires: Object.fromEntries(enabled.map(type => [type, definition])) });
const endpoint = { startIntersectionId: 'node/1', end: { featureId: 'way/10/1/2/0/0', locationGps: { longitude: 0.003, latitude: 0.001 } } };

async function fixture() {
  const db = new PGlite();
  for (const name of ['009_walk_audits.sql', '010_seed_walk_audit_worksheets.sql', '011_study_questionnaires_routes_photos.sql']) await db.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  const query = (sql: string, params?: unknown[]) => db.query(sql, params);
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  let generations = 0;
  const generator = { config: { intervalMs: 0 }, async generate() { generations++; return { area, locationGps: { longitude: 0.005, latitude: 0.005 }, locationDescription: 'Study', intersections, segments, thumbnailPng: Buffer.from([1]), sourceMetadata: { provider: 'fixture', attribution: '', fetchedAt: '', endpoint: '' } }; } } as unknown as WalkAuditGenerator;
  const service = new WalkAuditWorkflows(new WalkAuditStore(pool), generator);
  await service.createContributor(actor, { displayName: 'Author' });
  await service.createContributor(staff, { displayName: 'Staff' });
  return { db, service, generations: () => generations };
}
function code(expected: string) { return (error: any) => error?.code === expected; }

test('all seven combinations persist fixed authored definitions and reject invalid configurations before generation', async () => {
  const { db, service, generations } = await fixture();
  try {
    for (let mask = 1; mask < 8; mask++) {
      const enabled = types.filter((_, index) => mask & (1 << index));
      const created = await service.createStudy(actor, { neighborhood: `Study ${mask}`, area, ...config(enabled) });
      const read = await service.getStudy(created.id);
      assert.deepEqual(new Set(read.allowedAuditTypes), new Set(enabled));
      for (const type of enabled) {
        assert.equal(read.questionnaires[type].prompts[0].label, 'Describe it');
        assert.deepEqual(read.questionnaires[type].sourceMetadata.questions['q-1'], { sourceQuestionId: 'common-observations' });
      }
    }
    const before = generations();
    const invalid = [
      { allowedAuditTypes: [], questionnaires: {} },
      { allowedAuditTypes: ['point', 'point'], questionnaires: { point: definition } },
      { allowedAuditTypes: ['point'], questionnaires: {} },
      { allowedAuditTypes: ['point'], questionnaires: { point: definition, intersection: definition } },
      { allowedAuditTypes: ['point'] },
      { allowedAuditTypes: ['point'], questionnaires: { point: { ...definition, prompts: [] } } },
      { allowedAuditTypes: ['point'], questionnaires: { point: { ...definition, prompts: Array.from({ length: 31 }, (_, i) => ({ ...definition.prompts[0], id: `q-${i}` })) } } }
    ];
    for (const value of invalid) await assert.rejects(service.createStudy(actor, { neighborhood: 'Invalid', area, ...value }));
    assert.equal(generations(), before);
    const list = await service.listWorksheets({ limit: 100, offset: 0, includeVersions: true });
    assert.equal(list.worksheets.length, 2);
    const assigned = (await service.getStudy(1)).questionnaires.intersection.worksheetId;
    await assert.rejects(service.patchWorksheet(staff, assigned, { title: 'Replace it' }), code('STUDY_QUESTIONNAIRE_IMMUTABLE'));
    const legacy = await service.createStudy(actor, { neighborhood: 'Old client', area });
    assert.deepEqual(new Set(legacy.allowedAuditTypes), new Set(['intersection', 'street-segment']));
    const pinned = legacy.questionnaires.intersection;
    const revision = await service.patchWorksheet(staff, pinned.worksheetId, { title: 'Revised global template' });
    assert.notEqual(revision.id, pinned.worksheetId);
    assert.equal((await service.getStudy(legacy.id)).questionnaires.intersection.worksheetId, pinned.worksheetId);
    assert.deepEqual((await service.getStudy(legacy.id)).questionnaires.intersection.prompts, pinned.prompts);
  } finally { await db.close(); }
});

test('assignments, point geometry, routed drafts and every submitted type lock survive all write paths', async () => {
  const { db, service } = await fixture();
  try {
    const study = await service.createStudy(actor, { neighborhood: 'All types', area, ...config(types) });
    const payload = (type: string) => ({
      type, worksheetId: study.questionnaires[type].worksheetId, locationDescription: 'Here', answers: { 'q-1': 'A note' },
      ...(type === 'intersection' ? { featureId: 'node/1', locationGps: { longitude: 0.001, latitude: 0.001 } }
        : type === 'point' ? { featureId: 'way/10/1/2/0/0', locationGps: { longitude: 0.003, latitude: 0.001 } }
          : { routeSelection: endpoint })
    });
    const saved: Record<string, any> = {};
    for (const type of types) saved[type] = await service.createAudit(actor, study.id, payload(type));
    assert.equal(saved.point.geojson.geometry.type, 'Point');
    assert.deepEqual((await service.getAudit(saved.point.id)).geojson.geometry.coordinates, [0.003, 0.001]);
    assert.equal(saved['street-segment'].routeSelection.edges.length, 1);
    await assert.rejects(service.createAudit(actor, study.id, { ...payload('point'), worksheetId: study.questionnaires.intersection.worksheetId }), code('QUESTIONNAIRE_MISMATCH'));
    await assert.rejects(service.createAudit(actor, study.id, { ...payload('point'), locationGps: { longitude: 0.003, latitude: 0.002 } }), /one meter/);
    await assert.rejects(service.createAudit(actor, study.id, { ...payload('point'), geojson: { type: 'Feature', properties: { id: 'way/10/1/2/0/0' }, geometry: { type: 'Point', coordinates: ['bad', 'bad'] } } }), /geojson/);
    await assert.rejects(service.createAudit(actor, study.id, { ...payload('street-segment'), routeSelection: undefined }), /both endpoints/);
    const route = await service.routePreview(actor, study.id, endpoint);
    await assert.rejects(service.createAudit(actor, study.id, { ...payload('street-segment'), routeSelection: { ...route.routeSelection, edges: [{ featureId: 'way/10/1/2/0/0', fromFraction: 0, toFraction: 1 }] } }), /route edges/);
    await assert.rejects(service.createAudit(actor, study.id, { ...payload('street-segment'), geojson: { ...route.geojson, properties: { id: 'tampered' } } }), /geojson/);
    const oldDraft = await service.createDraft(actor, study.id, {});
    await db.query('UPDATE walk_audit_drafts SET type=$2,worksheet_id=$3,answers=$4 WHERE id=$1', [oldDraft.id, 'intersection', study.questionnaires.point.worksheetId, JSON.stringify({ 'q-1': 'Keep this answer' })]);
    await assert.rejects(service.patchDraft(actor, oldDraft.id, { expectedVersion: 1, locationDescription: 'Change' }), code('QUESTIONNAIRE_MISMATCH'));
    await assert.rejects(service.submitDraft(actor, oldDraft.id, { expectedVersion: 1 }), code('QUESTIONNAIRE_MISMATCH'));
    assert.equal((await service.getDraft(actor, oldDraft.id)).answers['q-1'], 'Keep this answer');
    await service.deleteDraft(actor, oldDraft.id);
    const unbound = await service.createDraft(actor, study.id, {});
    await db.query('UPDATE walk_audit_drafts SET answers=$2 WHERE id=$1', [unbound.id, JSON.stringify({ 'legacy-note': 'Keep this unbound answer' })]);
    await assert.rejects(service.patchDraft(actor, unbound.id, { expectedVersion: 1, type: 'intersection' }), code('QUESTIONNAIRE_MISMATCH'));
    await assert.rejects(service.submitDraft(actor, unbound.id, { expectedVersion: 1 }), code('QUESTIONNAIRE_MISMATCH'));
    assert.equal((await service.getDraft(actor, unbound.id)).answers['legacy-note'], 'Keep this unbound answer');
    await service.deleteDraft(actor, unbound.id);
    const missingWorksheet = await service.createDraft(actor, study.id, {});
    await db.query('UPDATE walk_audit_drafts SET type=$2,answers=$3 WHERE id=$1', [missingWorksheet.id, 'intersection', JSON.stringify({ 'q-1': 'Do not rebind' })]);
    await assert.rejects(service.patchDraft(actor, missingWorksheet.id, { expectedVersion: 1, locationDescription: 'Change' }), code('QUESTIONNAIRE_MISMATCH'));
    await assert.rejects(service.submitDraft(actor, missingWorksheet.id, { expectedVersion: 1 }), code('QUESTIONNAIRE_MISMATCH'));
    assert.equal((await service.getDraft(actor, missingWorksheet.id)).answers['q-1'], 'Do not rebind');
    await service.deleteDraft(actor, missingWorksheet.id);
    for (const from of types) for (const to of types.filter(type => type !== from)) {
      const audit = saved[from];
      await assert.rejects(service.patchAudit(actor, audit.id, { expectedVersion: audit.version, type: to }), code('AUDIT_TYPE_IMMUTABLE'));
      await assert.rejects(service.patchAudit(staff, audit.id, { expectedVersion: audit.version, type: to }), code('AUDIT_TYPE_IMMUTABLE'));
      const draft = await service.createDraft(actor, study.id, { editingAuditId: audit.id });
      await assert.rejects(service.patchDraft(actor, draft.id, { expectedVersion: 1, type: to }), code('AUDIT_TYPE_IMMUTABLE'));
      await db.query('UPDATE walk_audit_drafts SET type=$2 WHERE id=$1', [draft.id, to]);
      await assert.rejects(service.submitDraft(actor, draft.id, { expectedVersion: 1 }), code('AUDIT_TYPE_IMMUTABLE'));
      assert.equal((await service.getDraft(actor, draft.id)).answers['q-1'], 'A note');
      await service.deleteDraft(actor, draft.id);
    }
    for (const from of types) {
      const audit = await service.createAudit(staff, study.id, payload(from));
      for (const to of types.filter(type => type !== from)) {
        const draft = await service.createDraft(staff, study.id, { editingAuditId: audit.id });
        await assert.rejects(service.patchDraft(staff, draft.id, { expectedVersion: 1, type: to }), code('AUDIT_TYPE_IMMUTABLE'));
        await db.query('UPDATE walk_audit_drafts SET type=$2 WHERE id=$1', [draft.id, to]);
        await assert.rejects(service.submitDraft(staff, draft.id, { expectedVersion: 1 }), code('AUDIT_TYPE_IMMUTABLE'));
        await service.deleteDraft(staff, draft.id);
      }
    }
    let draft = await service.createDraft(actor, study.id, {});
    await assert.rejects(service.patchDraft(actor, draft.id, { expectedVersion: draft.version, locationDescription: 'Unbound location' }), /Choose an audit type/);
    assert.equal((await service.getDraft(actor, draft.id)).version, draft.version);
    draft = await service.patchDraft(actor, draft.id, { expectedVersion: draft.version, type: 'street-segment' });
    assert.equal(draft.worksheetId, study.questionnaires['street-segment'].worksheetId);
    draft = await service.patchDraft(actor, draft.id, { expectedVersion: draft.version, routeSelection: { startIntersectionId: 'node/1' } });
    assert.deepEqual((await service.getDraft(actor, draft.id)).routeSelection, { startIntersectionId: 'node/1' });
    draft = await service.patchDraft(actor, draft.id, { expectedVersion: draft.version, routeSelection: endpoint, locationDescription: 'Route', answers: { 'q-1': 'Route note' } });
    const result = await service.submitDraft(actor, draft.id, { expectedVersion: draft.version });
    assert.equal(result.audit.routeSelection.edges.length, 1);
    const edit = await service.createDraft(actor, study.id, { editingAuditId: result.audit.id });
    assert.equal((await service.submitDraft(actor, edit.id, { expectedVersion: edit.version })).audit.type, 'street-segment');
  } finally { await db.close(); }
});

test('a failure while inserting a later questionnaire rolls back the study and earlier worksheets', async () => {
  const { db, service } = await fixture();
  try {
    await db.exec(`CREATE FUNCTION fail_study_questionnaire() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NOT NEW.is_template AND 'point' = ANY(NEW.recommend_for) THEN RAISE EXCEPTION 'fixture insertion failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_study_questionnaire BEFORE INSERT ON walk_audit_worksheets FOR EACH ROW EXECUTE FUNCTION fail_study_questionnaire();`);
    await assert.rejects(service.createStudy(actor, { neighborhood: 'Roll back', area, ...config(types) }), /fixture insertion failure/);
    assert.equal((await db.query<any>('SELECT count(*)::int AS n FROM walk_audit_studies')).rows[0].n, 0);
    assert.equal((await db.query<any>('SELECT count(*)::int AS n FROM walk_audit_worksheets WHERE NOT is_template')).rows[0].n, 0);
    assert.equal((await db.query<any>('SELECT count(*)::int AS n FROM walk_audit_study_questionnaires')).rows[0].n, 0);
  } finally { await db.close(); }
});

test('legacy single-edge audits keep their pinned form and location until an explicit routed replacement', async () => {
  const { db, service } = await fixture();
  try {
    const study = await service.createStudy(actor, { neighborhood: 'Legacy fixture', area, ...config(types) });
    const feature = segments.features[0], gps = { longitude: 0.001, latitude: 0.001 };
    const row = (await db.query<any>(`INSERT INTO walk_audit_audits(study_id,created_by,worksheet_id,type,feature_id,location_gps,location_description,geojson,answers)
      VALUES($1,1,2,'street-segment',$2,$3,'Legacy street',$4,$5) RETURNING id`, [study.id, feature.properties.id, JSON.stringify(gps), JSON.stringify(feature), JSON.stringify({ 'walking-comfort': 'comfortable' })])).rows[0];
    const original = await service.getAudit(row.id);
    const edited = await service.patchAudit(actor, row.id, { expectedVersion: 1, locationDescription: 'Renamed legacy street' });
    assert.equal(edited.worksheetId, 2); assert.equal(edited.routeSelection, null);
    assert.deepEqual(edited.geojson, original.geojson);
    await assert.rejects(service.patchAudit(actor, row.id, { expectedVersion: 2, locationGps: { longitude: 0.002, latitude: 0.001 } }), /both route endpoints/);
    let draft = await service.createDraft(actor, study.id, { editingAuditId: row.id });
    draft = await service.patchDraft(actor, draft.id, { expectedVersion: draft.version, routeSelection: { startIntersectionId: 'node/1' } });
    draft = await service.patchDraft(actor, draft.id, { expectedVersion: draft.version, routeSelection: null, featureId: original.featureId, locationGps: original.locationGps, geojson: original.geojson });
    assert.equal(draft.routeSelection, null); assert.deepEqual(draft.geojson, original.geojson);
    const retained = await service.submitDraft(actor, draft.id, { expectedVersion: draft.version });
    assert.equal(retained.audit.routeSelection, null); assert.equal(retained.audit.worksheetId, 2);
    const replaced = await service.patchAudit(actor, row.id, { expectedVersion: retained.audit.version, routeSelection: endpoint });
    assert.ok(replaced.routeSelection); assert.equal(replaced.worksheetId, 2);
    await assert.rejects(service.patchAudit(actor, row.id, { expectedVersion: replaced.version, routeSelection: null }), /cannot discard/);
  } finally { await db.close(); }
});

test('dashboard pages all studies once by creator or contributor membership, including zero-audit studies', async () => {
  const { db, service } = await fixture();
  try {
    const viewer = { uid: 'viewer', staff: false };
    await service.createContributor(viewer, { displayName: 'New viewer' });
    const contributed = await service.createStudy(actor, { neighborhood: 'Contributed', area, ...config(['intersection']) });
    await service.createAudit(staff, contributed.id, { type: 'intersection', featureId: 'node/1', locationGps: { longitude: 0.001, latitude: 0.001 }, locationDescription: 'Crossing', answers: {} });
    const organized = await service.createStudy(staff, { neighborhood: 'Organized', area, ...config(['point']) });
    const empty = await service.createStudy(actor, { neighborhood: 'Zero audits', area, ...config(['point']) });
    const first = await service.dashboard(staff, { group: 'mine', limit: 1, offset: 0 });
    const second = await service.dashboard(staff, { group: 'mine', limit: 1, offset: 1 });
    assert.equal(first.hasMore, true); assert.equal(second.hasMore, false);
    assert.deepEqual(new Set([...first.studies, ...second.studies].map((study: any) => study.id)), new Set([contributed.id, organized.id]));
    const other = await service.dashboard(staff, { group: 'other', limit: 10, offset: 0 });
    assert.deepEqual(other.studies.map((study: any) => study.id), [empty.id]);
    assert.equal(other.studies[0].auditCount, 0);
    assert.equal((await service.dashboard(viewer, { group: 'mine', limit: 10, offset: 0 })).studies.length, 0);
    const every = await service.dashboard(viewer, { group: 'other', limit: 2, offset: 0 });
    const remaining = await service.dashboard(viewer, { group: 'other', limit: 2, offset: 2 });
    assert.equal(every.hasMore, true); assert.equal(remaining.hasMore, false);
    assert.equal(new Set([...every.studies, ...remaining.studies].map((study: any) => study.id)).size, 3);
    await assert.rejects(service.dashboard(staff, { group: 'bad', limit: 1, offset: 0 }), /group/);
  } finally { await db.close(); }
});
