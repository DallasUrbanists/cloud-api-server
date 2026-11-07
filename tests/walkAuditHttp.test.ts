import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { PGlite } from '@electric-sql/pglite';
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';
import { getAppCheck } from 'firebase-admin/app-check';
import type { Pool } from 'pg';
import { firebaseApp } from '../src/config/firebase.js';
import { createApp } from '../src/app.js';
import { WalkAuditStore } from '../src/services/walkAuditStore.js';
import { WalkAuditGenerator } from '../src/services/walkAuditGeospatial.js';
import { WalkAuditWorkflows } from '../src/services/walkAuditWorkflows.js';

const area = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]] } };
const osm = { elements: [
  { type: 'node', id: 1, lon: 0, lat: 0.005 }, { type: 'node', id: 2, lon: 0.005, lat: 0.005 },
  { type: 'node', id: 3, lon: 0.01, lat: 0.005 }, { type: 'node', id: 4, lon: 0.005, lat: 0 },
  { type: 'node', id: 5, lon: 0.005, lat: 0.01 },
  { type: 'way', id: 10, nodes: [1, 2, 3], tags: { highway: 'residential' } },
  { type: 'way', id: 20, nodes: [4, 2, 5], tags: { highway: 'service' } },
] };
let db: PGlite, base: string, server: ReturnType<ReturnType<typeof createApp>['listen']>;
let overpassFailure = false;
const previousEnvironment = process.env.NODE_ENV;

before(async () => {
  process.env.NODE_ENV = 'test';
  db = new PGlite();
  await db.exec(await readFile(new URL('../migrations/009_walk_audits.sql', import.meta.url), 'utf8'));
  await db.exec(await readFile(new URL('../migrations/010_seed_walk_audit_worksheets.sql', import.meta.url), 'utf8'));
  const query = (sql: string, params?: unknown[]) => db.query(sql, params);
  const adapter = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  const generator = new WalkAuditGenerator({ urls: ['https://overpass.example/api'], timeoutMs: 1000, concurrency: 2, intervalMs: 60000 }, async () => overpassFailure ? new Response('unavailable', { status: 503 }) : Response.json(osm));
  const service = new WalkAuditWorkflows(new WalkAuditStore(adapter), generator);
  const auth = getAuth(firebaseApp());
  mock.method(auth, 'verifyIdToken', async (token: string, revoked?: boolean) => {
    assert.equal(revoked, true);
    if (!['organizer', 'contributor', 'staff', 'legacy', 'unregistered', 'unregistered-staff'].includes(token)) throw new Error('invalid token');
    return { uid: token, ...(['staff', 'unregistered-staff'].includes(token) ? { staff: true } : {}), ...(token === 'legacy' ? { roles: ['staff'] } : {}) } as unknown as DecodedIdToken;
  });
  mock.method(getAppCheck(firebaseApp()), 'verifyToken', async token => { if (token !== 'valid-check') throw new Error('bad check'); return { appId: 'test' }; });
  server = createApp({ walkAuditService: service }).listen(0, '127.0.0.1');
  await once(server, 'listening'); base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/walk-audits`;
});
after(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  await db.close(); mock.restoreAll();
  if (previousEnvironment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnvironment;
});
async function request(path: string, method = 'GET', token?: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(base + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
async function expect(response: Response, status: number): Promise<any> {
  const raw = await response.text(); assert.equal(response.status, status, raw);
  return raw ? JSON.parse(raw) : undefined;
}

test('Firebase access, private drafts, reports, coverage and destructive lifecycle work through HTTP', async () => {
  assert.equal((await request('/worksheets')).status, 200);
  assert.equal((await request('/contributors')).status, 401);
  assert.equal((await request('/contributors', 'GET', 'legacy')).status, 403);
  assert.equal((await request('/contributors/me', 'POST', 'invalid', { displayName: 'Bad' })).status, 401);
  assert.equal((await request('/studies', 'POST', 'unregistered', { neighborhood: 'Place', area })).status, 409);
  assert.equal((await request('/worksheets', 'POST', 'unregistered-staff', {})).status, 409);
  for (const uid of ['organizer', 'contributor', 'staff']) {
    const response = await request('/contributors/me', 'POST', uid, { displayName: uid });
    const profile = (await expect(response, 201)).contributor;
    assert.equal(profile.displayName, uid); assert.equal('firebaseUid' in profile, false);
  }
  assert.equal((await request('/contributors/me', 'POST', 'organizer', { displayName: 'Again' })).status, 409);
  assert.equal((await request('/contributors', 'GET', 'staff')).status, 200);
  assert.equal((await request('/contributors/me', 'GET', 'organizer')).status, 200);
  assert.equal((await request('/contributors/me', 'PATCH', 'organizer', { displayName: 'Organizer' })).status, 200);
  assert.equal((await request('/contributors/1', 'GET', 'staff')).status, 200);
  assert.equal((await request('/contributors/1', 'PATCH', 'staff', { displayName: 'Organizer' })).status, 400);
  assert.equal((await request('/contributors/1', 'PATCH', 'staff', { displayName: 'Host' })).status, 200);
  assert.equal((await request('/studies?limit=2&limit=3')).status, 400);
  const mediaError = await request('/studies', 'POST', 'organizer', undefined, { 'Content-Type': 'text/plain', Origin: 'http://localhost:5173' });
  assert.equal(mediaError.status, 415); assert.equal(mediaError.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.equal((await request('/studies', 'POST', 'organizer', { neighborhood: 'Place', area, createdBy: 99 })).status, 400);
  const created = await request('/studies', 'POST', 'organizer', { neighborhood: 'Place', area });
  const study = (await expect(created, 201)).study; assert.equal(created.headers.get('location'), `/api/walk-audits/studies/${study.id}`);
  const publicList = await request('/studies?creator=1&neighborhood=Place', 'GET', undefined, undefined, { Origin: 'http://localhost:5173' });
  assert.equal(publicList.status, 200); assert.equal(publicList.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.match(publicList.headers.get('access-control-expose-headers')!, /Location/);
  assert.equal((await expect(publicList, 200)).studies.length, 1);
  const limited = await request('/studies', 'POST', 'organizer', { neighborhood: 'Another', area });
  assert.equal(limited.status, 429); assert.ok(limited.headers.get('retry-after'));
  assert.equal((await request('/studies', 'POST', 'organizer', { neighborhood: 'Another', area }, { 'X-Operation-Group': 'test' })).status, 400);
  await db.exec('UPDATE walk_audit_contributors SET next_generation_on=NULL WHERE id=1');
  overpassFailure = true;
  assert.equal((await request('/studies', 'POST', 'organizer', { neighborhood: 'Unavailable', area })).status, 503);
  assert.equal((await db.query<any>('SELECT count(*)::int AS n FROM walk_audit_studies')).rows[0].n, 1);
  overpassFailure = false;
  await db.exec('UPDATE walk_audit_contributors SET next_generation_on=NULL WHERE id=1');
  const renamed = (await expect(await request(`/studies/${study.id}`, 'PATCH', 'organizer', { expectedVersion: 1, neighborhood: 'Renamed' }), 200)).study;
  assert.equal(renamed.locationDescription, 'Renamed');
  assert.equal((await request(`/studies/${study.id}`, 'PATCH', 'organizer', { expectedVersion: 1, neighborhood: 'Stale' })).status, 409);
  const widerArea = { ...area, geometry: { ...area.geometry, coordinates: [[[0, 0], [0.012, 0], [0.012, 0.01], [0, 0.01], [0, 0]]] } };
  overpassFailure = true;
  assert.equal((await request(`/studies/${study.id}`, 'PATCH', 'organizer', { expectedVersion: 2, area: widerArea })).status, 503);
  assert.equal((await expect(await request(`/studies/${study.id}`), 200)).study.version, 2);
  overpassFailure = false; await db.exec('UPDATE walk_audit_contributors SET next_generation_on=NULL WHERE id=1');
  assert.equal((await request(`/studies/${study.id}`, 'PATCH', 'organizer', { expectedVersion: 2, area: widerArea })).status, 200);
  const thumb = await request(`/studies/${study.id}/thumbnail`); assert.equal(thumb.status, 200); assert.match(thumb.headers.get('content-type')!, /image\/png/);
  assert.deepEqual([...new Uint8Array(await thumb.arrayBuffer()).slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const draftResponse = await request(`/studies/${study.id}/drafts`, 'POST', 'contributor', {});
  let draft = (await expect(draftResponse, 201)).draft;
  assert.equal((await request(`/studies/${study.id}/drafts`, 'GET', 'contributor')).status, 200);
  assert.equal((await request(`/drafts/${draft.id}`, 'GET', 'staff')).status, 404);
  assert.equal((await request(`/drafts/${draft.id}/submit`, 'POST', 'contributor', { expectedVersion: 1 })).status, 400);
  assert.equal((await request(`/drafts/${draft.id}`, 'GET', 'contributor')).status, 200);
  const data = { type: 'intersection', worksheetId: 1, featureId: 'node/2', locationGps: { longitude: 0.005, latitude: 0.005 }, locationDescription: 'Crossing', answers: { 'crossing-comfort': 'comfortable' } };
  assert.equal((await request(`/studies/${study.id}/audits`, 'POST', 'contributor', { ...data, createdBy: 1 })).status, 400);
  assert.equal((await request(`/studies/${study.id}/audits`, 'POST', 'contributor', { ...data, featureId: 'node/999' })).status, 400);
  assert.equal((await request(`/studies/${study.id}/audits`, 'POST', 'contributor', { ...data, worksheetId: 2 })).status, 400);
  assert.equal((await request(`/studies/${study.id}/audits`, 'POST', 'contributor', { ...data, answers: { 'crossing-comfort': 'invented' } })).status, 400);
  assert.equal((await request(`/drafts/${draft.id}`, 'PATCH', 'contributor', { expectedVersion: 1, answers: { notes: 'x'.repeat(100001) } })).status, 413);
  const oversized = await request(`/drafts/${draft.id}`, 'PATCH', 'contributor', { expectedVersion: 1, answers: { notes: 'x'.repeat(270000) } }, { Origin: 'http://localhost:5173' });
  assert.equal(oversized.status, 413); assert.equal(oversized.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  draft = (await expect(await request(`/drafts/${draft.id}`, 'PATCH', 'contributor', { expectedVersion: 1, ...data }), 200)).draft;
  assert.equal((await request(`/drafts/${draft.id}`, 'PATCH', 'contributor', { expectedVersion: 1, answers: {} })).status, 409);
  let audit = (await expect(await request(`/drafts/${draft.id}/submit`, 'POST', 'contributor', { expectedVersion: 2 }), 201)).audit;
  assert.equal((await request(`/drafts/${draft.id}/submit`, 'POST', 'contributor', { expectedVersion: 2 })).status, 404);
  assert.equal((await request(`/audits/${audit.id}`, 'PATCH', 'organizer', { expectedVersion: 1, locationDescription: 'No' })).status, 403);
  const duplicate = (await expect(await request(`/studies/${study.id}/audits`, 'POST', 'contributor', data), 201)).audit;
  const summary = await expect(await request(`/studies/${study.id}/audits?limit=1`), 200);
  assert.equal(summary.hasMore, true); assert.equal('answers' in summary.audits[0], false);
  assert.equal((await request(`/studies/${study.id}`, 'PATCH', 'organizer', { expectedVersion: 3, area })).status, 409);
  const worksheet = (await expect(await request('/worksheets', 'POST', 'staff', { slug: 'number-note', title: 'Number note', description: '', sourceUrl: 'https://example.org/', recommendFor: ['intersection'], prompts: [{ id: 'count', type: 'text', label: 'Count?', required: true, maxLength: 10 }] }), 201)).worksheet;
  assert.equal((await request(`/worksheets/${worksheet.id}`)).status, 200);
  const counted = (await expect(await request(`/studies/${study.id}/audits`, 'POST', 'contributor', { ...data, worksheetId: worksheet.id, answers: { count: '123' } }), 201)).audit;
  assert.equal(counted.answers.count, '123');
  assert.equal((await expect(await request(`/audits/${counted.id}`), 200)).audit.answers.count, '123');
  const revised = (await expect(await request('/worksheets/1', 'PATCH', 'staff', { title: 'Revised title' }), 200)).worksheet;
  assert.notEqual(revised.id, 1); assert.equal(revised.version, 2);
  assert.equal((await request(`/worksheets/${revised.id}`, 'DELETE', 'staff')).status, 204);
  assert.equal((await request('/worksheets?type=intersection&includeVersions=true')).status, 200);
  const progress = await expect(await request(`/studies/${study.id}/progress`), 200); assert.equal(progress.intersections.audited, 1);
  const editing = (await expect(await request(`/studies/${study.id}/drafts`, 'POST', 'contributor', { editingAuditId: audit.id }), 201)).draft;
  audit = (await expect(await request(`/audits/${audit.id}`, 'PATCH', 'contributor', { expectedVersion: 1, locationDescription: 'Updated directly' }), 200)).audit;
  assert.equal((await request(`/drafts/${editing.id}/submit`, 'POST', 'contributor', { expectedVersion: 1 })).status, 409);
  assert.equal((await request(`/drafts/${editing.id}`, 'DELETE', 'contributor')).status, 204);
  const edit2 = (await expect(await request(`/studies/${study.id}/drafts`, 'POST', 'contributor', { editingAuditId: audit.id }), 201)).draft;
  const edited = (await expect(await request(`/drafts/${edit2.id}/submit`, 'POST', 'contributor', { expectedVersion: 1 }), 200)).audit;
  assert.equal(edited.id, audit.id); assert.equal(edited.version, 3);
  const report = (await expect(await request(`/studies/${study.id}/reports`, 'POST', 'organizer', { auditIds: [audit.id], description: 'My words' }), 201)).report;
  assert.equal((await request(`/studies/${study.id}/reports`, 'POST', 'organizer', { auditIds: [audit.id, audit.id] })).status, 400);
  assert.equal((await request(`/studies/${study.id}/reports`, 'POST', 'organizer', { auditIds: Array.from({ length: 501 }, (_, index) => index + 1) })).status, 413);
  assert.equal((await request(`/reports/${report.id}`, 'PATCH', 'organizer', { expectedVersion: 1, auditIds: [99999] })).status, 400);
  const disposable = (await expect(await request(`/studies/${study.id}/reports`, 'POST', 'organizer', { auditIds: [] }), 201)).report;
  assert.equal((await request(`/reports/${disposable.id}`, 'DELETE', 'organizer')).status, 204);
  const reportList = await expect(await request(`/studies/${study.id}/reports`), 200); assert.equal('capturedData' in reportList.reports[0], false);
  assert.equal(report.capturedData.audits.length, 1); assert.equal(JSON.stringify(report).includes('firebase_uid'), false);
  const named = (await expect(await request(`/reports/${report.id}`, 'PATCH', 'organizer', { expectedVersion: 1, title: 'Edited' }), 200)).report;
  assert.equal(named.description, 'My words'); assert.deepEqual(named.capturedData, report.capturedData);
  assert.equal((await request(`/audits/${audit.id}`, 'DELETE', 'contributor')).status, 204);
  assert.equal((await expect(await request(`/studies/${study.id}/progress`), 200)).intersections.audited, 1);
  const retained = (await expect(await request(`/reports/${report.id}`), 200)).report; assert.equal(retained.capturedData.audits.length, 1);
  const recaptured = (await expect(await request(`/reports/${report.id}`, 'PATCH', 'organizer', { expectedVersion: 2, auditIds: [] }), 200)).report;
  assert.equal(recaptured.description, 'My words'); assert.equal(recaptured.completion, 0); assert.deepEqual(recaptured.capturedData.audits, []);
  assert.equal((await request(`/worksheets/1`, 'DELETE', 'staff')).status, 409);
  assert.equal((await request('/contributors/me', 'DELETE', 'contributor')).status, 409);
  assert.equal((await request(`/studies/${study.id}`, 'DELETE', 'organizer')).status, 400);
  assert.equal((await request(`/studies/${study.id}?confirmPermanentDelete=true`, 'DELETE', 'contributor')).status, 403);
  assert.equal((await request(`/studies/${study.id}?confirmPermanentDelete=true`, 'DELETE', 'organizer')).status, 204);
  for (const path of [`/studies/${study.id}`, `/studies/${study.id}/thumbnail`, `/audits/${duplicate.id}`, `/reports/${report.id}`]) assert.equal((await request(path)).status, 404);
  for (const table of ['walk_audit_studies', 'walk_audit_audits', 'walk_audit_drafts', 'walk_audit_reports']) assert.equal((await db.query<any>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0);
  assert.equal((await request('/contributors/2', 'DELETE', 'staff')).status, 204);
  assert.equal((await request('/contributors/2', 'GET', 'staff')).status, 404);
  assert.equal((await request('/contributors/me', 'DELETE', 'organizer')).status, 204);
});

test('production writes require App Check and legacy roles do not grant staff access', async () => {
  process.env.NODE_ENV = 'production';
  try {
    assert.equal((await request('/contributors/me', 'GET', 'staff')).status, 401);
    assert.equal((await request('/contributors', 'GET', 'legacy', undefined, { 'X-Firebase-AppCheck': 'valid-check' })).status, 403);
    assert.equal((await request('/contributors', 'GET', 'staff', undefined, { 'X-Firebase-AppCheck': 'valid-check' })).status, 200);
    assert.equal((await request('/worksheets')).status, 200);
  } finally { process.env.NODE_ENV = 'test'; }
});
