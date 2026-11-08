/** Loopback-only browser rehearsal: PGlite, fixture topology and test identities.
 * Run only after building the frontend. Never mounted by the production server. */
import express, { type RequestHandler } from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import { createApp } from '../../src/app.js';
import { WalkAuditStore } from '../../src/services/walkAuditStore.js';
import { WalkAuditWorkflows } from '../../src/services/walkAuditWorkflows.js';
import type { WalkAuditGenerator } from '../../src/services/walkAuditGeospatial.js';

const db = new PGlite();
for (const file of ['009_walk_audits.sql', '010_seed_walk_audit_worksheets.sql', '011_study_questionnaires_routes_photos.sql']) await db.exec(await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'));
const query = (sql: string, params?: unknown[]) => db.query(sql, params);
const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
const area = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-96.8, 32.774], [-96.794, 32.774], [-96.794, 32.779], [-96.8, 32.779], [-96.8, 32.774]]] } };
const coords: Record<number, [number, number]> = { 1: [-96.797, 32.7767], 2: [-96.7965, 32.7767], 3: [-96.7965, 32.7771], 4: [-96.797, 32.7771], 8: [-96.7958, 32.776], 9: [-96.7955, 32.776] };
const point = (id: number) => ({ type: 'Feature', properties: { id: `node/${id}`, name: `Intersection ${id}` }, geometry: { type: 'Point', coordinates: coords[id] } });
const edge = (way: number, from: number, to: number) => ({ type: 'Feature', properties: { id: `way/${way}/${from}/${to}/0/0`, name: `Fixture street ${way}` }, geometry: { type: 'LineString', coordinates: [coords[from], coords[to]] } });
const intersections = { type: 'FeatureCollection', features: [point(1), point(2), point(3), point(4)] };
const segments = { type: 'FeatureCollection', features: [edge(10, 1, 2), edge(20, 2, 3), edge(30, 1, 4), edge(40, 4, 3), edge(80, 8, 9)] };
const generator = { config: { intervalMs: 0 }, async generate(inputArea: unknown, neighborhood: string) { return { area: inputArea, locationGps: { longitude: -96.797, latitude: 32.7767 }, locationDescription: neighborhood, intersections, segments, thumbnailPng: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a7sAAAAASUVORK5CYII=', 'base64'), sourceMetadata: { provider: 'test fixture', attribution: 'fixture', fetchedAt: new Date().toISOString(), endpoint: 'fixture' } }; } } as unknown as WalkAuditGenerator;
const service = new WalkAuditWorkflows(new WalkAuditStore(pool), generator);
const organizer = { uid: 'organizer', staff: false }, contributor = { uid: 'contributor', staff: false }, viewer = { uid: 'viewer', staff: false };
for (const [actor, displayName] of [[organizer, 'Organizer'], [contributor, 'Contributor'], [viewer, 'New viewer']] as const) await service.createContributor(actor, { displayName });
const definition = { prompts: [
  { id: 'q-1', type: 'choice', label: 'Is this location comfortable for walking?', required: true, options: ['Yes', 'No', 'Not applicable', 'Not observed / unsure'] },
  { id: 'q-2', type: 'text', label: 'What else should the study team know?', required: false, maxLength: 2000 }
], sourceMetadata: { catalogVersion: 'fixture-v1', questions: {} } };
const config = (types: string[]) => ({ allowedAuditTypes: types, questionnaires: Object.fromEntries(types.map(type => [type, definition])) });
const study = await service.createStudy(organizer, { neighborhood: 'Fixture all types', area, ...config(['intersection', 'street-segment', 'point']) });
await service.createAudit(contributor, study.id, { type: 'intersection', featureId: 'node/1', locationGps: { longitude: coords[1][0], latitude: coords[1][1] }, locationDescription: 'Fixture crossing', answers: { 'q-1': 'Yes' } });
// A pre-upgrade observation deliberately retains its original template and
// single-edge geometry, together with an old-format immutable report capture.
const legacyAudit = (await db.query<any>(`INSERT INTO walk_audit_audits(study_id,created_by,worksheet_id,type,feature_id,location_gps,location_description,geojson,answers)
  VALUES($1,2,2,'street-segment',$2,$3,'Legacy single-edge fixture',$4,$5) RETURNING id`, [study.id, segments.features[0].properties.id, JSON.stringify({ longitude: coords[1][0], latitude: coords[1][1] }), JSON.stringify(segments.features[0]), JSON.stringify({ 'walking-comfort': 'comfortable', notes: 'Historical answer' })])).rows[0];
const legacyReport = (await db.query<any>(`INSERT INTO walk_audit_reports(study_id,created_by,title,description,audit_ids,completion,captured_data)
  VALUES($1,1,'Legacy fixture report','Historical fixture report remains unchanged.',ARRAY[$2::integer],0.25,$3) RETURNING id`, [study.id, legacyAudit.id, JSON.stringify({ study: { id: study.id, neighborhood: 'Fixture all types' }, audits: [{ id: legacyAudit.id, type: 'street-segment', worksheetId: 2, answers: { 'walking-comfort': 'comfortable', notes: 'Historical answer' } }], progress: { overall: { audited: 1, total: 4, ratio: 0.25 } } })])).rows[0];
for (let index = 0; index < 13; index++) {
  await service.createStudy(organizer, { neighborhood: `Other fixture ${String(index + 1).padStart(2, '0')}`, area, ...config(['point']) });
  await service.createStudy(contributor, { neighborhood: `My fixture ${String(index + 1).padStart(2, '0')}`, area, ...config(['intersection']) });
}
const auth: RequestHandler = (req, res, next) => {
  const token = req.get('Authorization')?.match(/^Bearer ([a-z0-9-]+)$/)?.[1];
  if (!token) { res.status(401).json({ error: 'UNAUTHENTICATED', message: 'Fixture identity required.' }); return; }
  req.user = { uid: token, emails: [], roles: [], token: { uid: token } as any }; next();
};
const realApi = createApp({ walkAuditService: service, walkAuditAuth: [auth] });
const app = express();
app.use((req, res, next) => req.path.startsWith('/api/walk-audits') ? realApi(req, res, next) : next());
app.get('/runtime-config.json', (req, res) => res.json({ backend: 'shared', apiOrigin: `${req.protocol}://${req.get('host')}`, demoMode: false, firebase: {}, appCheck: {} }));
app.get('/firebase-auth.js', (_req, res) => res.type('application/javascript').send(`
export async function initializeFirebaseAuth() {
  let current = JSON.parse(localStorage.getItem('walk-audit-fixture-user') || 'null');
  const listeners = new Set();
  const change = user => { current = user; localStorage.setItem('walk-audit-fixture-user', JSON.stringify(user)); for (const listener of listeners) listener(user); return user; };
  return {
    user: () => current,
    headers: async () => { if (!current) throw new Error('Fixture sign-in required.'); return { Authorization: 'Bearer ' + current.uid, 'X-Firebase-AppCheck': 'fixture' }; },
    google: async () => change({ uid: 'contributor', email: 'contributor@example.test' }),
    email: async email => change({ uid: email.split('@')[0].toLowerCase(), email }),
    resetPassword: async () => {}, signOut: async () => change(null),
    onChange: callback => { listeners.add(callback); return () => listeners.delete(callback); }
  };
}`));
app.get('/__fixture/ids', (_req, res) => res.json({ studyId: study.id, legacyAuditId: legacyAudit.id, legacyReportId: legacyReport.id, coordinates: coords, identity: 'stubbed', overpass: 'fixture network', gps: 'browser supplied' }));
app.post('/__fixture/old-draft/:kind', async (req, res) => {
  if (req.get('Authorization') !== 'Bearer viewer' || !['unbound', 'mismatched'].includes(req.params.kind)) { res.sendStatus(403); return; }
  const draft = await service.createDraft(viewer, study.id, {});
  if (req.params.kind === 'unbound') await db.query('UPDATE walk_audit_drafts SET answers=$2 WHERE id=$1', [draft.id, JSON.stringify({ 'old-note': 'Keep unbound fixture answer' })]);
  else await db.query('UPDATE walk_audit_drafts SET type=$2,worksheet_id=$3,answers=$4 WHERE id=$1', [draft.id, 'intersection', study.questionnaires.point.worksheetId, JSON.stringify({ 'q-1': 'Yes' })]);
  res.json({ draftId: draft.id });
});
const frontend = path.resolve('C:/Users/hexel/repos/neighborhood-walk-audit/dist');
app.use(express.static(frontend));
app.use((_req, res) => res.sendFile(path.join(frontend, 'index.html')));
const server = app.listen(0, '127.0.0.1', () => process.stdout.write(`WALK_AUDIT_BROWSER_FIXTURE=http://127.0.0.1:${(server.address() as { port: number }).port}\n`));
const stop = () => { server.closeAllConnections(); server.close(() => { void db.close().finally(() => process.exit(0)); }); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
