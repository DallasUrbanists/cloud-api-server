import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import type { Pool } from 'pg';
import type { RequestHandler } from 'express';
import { createApp } from '../src/app.js';
import { WalkAuditStore } from '../src/services/walkAuditStore.js';
import { WalkAuditWorkflows } from '../src/services/walkAuditWorkflows.js';
import type { WalkAuditGenerator } from '../src/services/walkAuditGeospatial.js';

test('photo HTTP routes enforce ownership, bytes, versions, transfer and edit preservation', async () => {
  const db = new PGlite();
  let server: ReturnType<ReturnType<typeof createApp>['listen']> | undefined;
  try {
    for (const file of ['009_walk_audits.sql', '010_seed_walk_audit_worksheets.sql', '011_study_questionnaires_routes_photos.sql']) await db.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
    const query = (sql: string, params?: unknown[]) => db.query(sql, params);
    const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
    const area = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[0, 0], [0.01, 0], [0.01, 0.01], [0, 0.01], [0, 0]]] } };
    const intersection = { type: 'Feature', properties: { id: 'node/1', name: null }, geometry: { type: 'Point', coordinates: [0.005, 0.005] } };
    const generator = { config: { intervalMs: 0 }, async generate() { return { area, locationGps: { longitude: 0.005, latitude: 0.005 }, locationDescription: 'Fixture', intersections: { type: 'FeatureCollection', features: [intersection] }, segments: { type: 'FeatureCollection', features: [] }, thumbnailPng: Buffer.from([1]), sourceMetadata: { provider: 'fixture' } }; } } as unknown as WalkAuditGenerator;
    const service = new WalkAuditWorkflows(new WalkAuditStore(pool), generator);
    const owner = { uid: 'owner', staff: false }, other = { uid: 'other', staff: false };
    await service.createContributor(owner, { displayName: 'Owner' }); await service.createContributor(other, { displayName: 'Other' });
    const study = await service.createStudy(owner, { neighborhood: 'Photo study', area, allowedAuditTypes: ['intersection'], questionnaires: { intersection: { prompts: [{ id: 'q-1', type: 'text', label: 'Notes', required: false, maxLength: 2000 }], sourceMetadata: { questions: {} } } } });
    let draft = await service.createDraft(owner, study.id, {});
    const auth: RequestHandler = (req, res, next) => {
      const uid = req.get('Authorization')?.replace(/^Bearer /, '');
      if (!uid || !['owner', 'other'].includes(uid)) { res.status(401).json({ error: 'UNAUTHENTICATED' }); return; }
      req.user = { uid, emails: [], roles: [], token: { uid } as any }; next();
    };
    server = createApp({ walkAuditService: service, walkAuditAuth: [auth] }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/walk-audits`;
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2]);
    const jpeg = Buffer.from([255, 216, 255, 1, 2]);
    const webp = Buffer.from('RIFF0000WEBP', 'ascii');
    const fenceDraft = await service.createDraft(owner, study.id, {});
    const fenced = await service.deleteDraftPhoto(owner, fenceDraft.id, 1, fenceDraft.version);
    assert.equal(fenced.version, 2);
    await assert.rejects(service.putDraftPhoto(owner, fenceDraft.id, 1, 1, 'image/png', png), (error: any) => error.code === 'VERSION_CONFLICT');
    assert.equal((await service.getDraft(owner, fenceDraft.id)).photos.length, 0);
    await service.deleteDraft(owner, fenceDraft.id);
    const upload = (slot: number, bytes: Buffer, contentType: string, version?: number, uid = 'owner') => fetch(`${base}/drafts/${draft.id}/photos/${slot}`, { method: 'PUT', headers: { Authorization: `Bearer ${uid}`, 'Content-Type': contentType, ...(version === undefined ? {} : { 'If-Match': `"${version}"` }) }, body: bytes as any });
    const preflight = await fetch(`${base}/drafts/${draft.id}/photos/1`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'authorization,content-type,if-match,x-firebase-appcheck' } });
    assert.equal(preflight.status, 204); assert.match(preflight.headers.get('access-control-allow-headers')!, /If-Match/i);
    assert.equal((await upload(1, png, 'image/png')).status, 428);
    assert.equal((await upload(4, png, 'image/png', 1)).status, 400);
    assert.equal((await upload(1, png, 'image/jpeg', 1)).status, 415);
    assert.equal((await upload(1, png, 'text/plain', 1)).status, 415);
    assert.equal((await fetch(`${base}/drafts/${draft.id}/photos/1`, { method: 'PUT', headers: { Authorization: 'Bearer owner', 'Content-Type': 'image/png', 'Content-Encoding': 'unsupported-fixture', 'If-Match': '"1"' }, body: png as any })).status, 415);
    assert.equal((await upload(1, png, 'image/png', 1, 'other')).status, 404);
    const tooLarge = Buffer.alloc(2097153); png.copy(tooLarge);
    assert.equal((await upload(1, tooLarge, 'image/png', 1)).status, 413);
    for (const [slot, bytes, type] of [[1, png, 'image/png'], [2, jpeg, 'image/jpeg'], [3, webp, 'image/webp']] as const) {
      const result = await upload(slot, bytes, type, draft.version); assert.equal(result.status, 200, await result.clone().text());
      draft = (await result.json()).draft;
    }
    assert.equal(draft.photos.length, 3); assert.equal(draft.version, 4);
    assert.equal((await service.listDrafts(owner, study.id, { limit: 10, offset: 0 })).drafts.find((item: any) => item.id === draft.id).photos.length, 3);
    assert.equal((await upload(1, png, 'image/png', 1)).status, 409);
    assert.equal((await fetch(`${base}/drafts/${draft.id}/photos/1`, { headers: { Authorization: 'Bearer other' } })).status, 404);
    const privatePhoto = await fetch(`${base}/drafts/${draft.id}/photos/1`, { headers: { Authorization: 'Bearer owner' } });
    assert.equal(privatePhoto.headers.get('cache-control'), 'private, no-store'); assert.deepEqual(Buffer.from(await privatePhoto.arrayBuffer()), png);
    await assert.rejects(service.submitDraft(owner, draft.id, { expectedVersion: draft.version }));
    assert.equal((await service.getDraft(owner, draft.id)).photos.length, 3);
    draft = await service.patchDraft(owner, draft.id, { expectedVersion: draft.version, type: 'intersection', featureId: 'node/1', locationGps: { longitude: 0.005, latitude: 0.005 }, locationDescription: 'Crossing', answers: {} });
    await db.exec(`CREATE FUNCTION fail_photo_transfer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.audit_id IS NOT NULL THEN RAISE EXCEPTION 'fixture failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fail_photo_transfer BEFORE UPDATE ON walk_audit_photos FOR EACH ROW EXECUTE FUNCTION fail_photo_transfer();`);
    await assert.rejects(service.submitDraft(owner, draft.id, { expectedVersion: draft.version }), /fixture failure/);
    assert.equal((await service.getDraft(owner, draft.id)).photos.length, 3);
    assert.equal((await db.query<any>('SELECT count(*)::int AS n FROM walk_audit_audits')).rows[0].n, 0);
    await db.exec('DROP TRIGGER fail_photo_transfer ON walk_audit_photos');
    const submitted = await service.submitDraft(owner, draft.id, { expectedVersion: draft.version });
    assert.equal(submitted.audit.photos.length, 3); assert.equal(JSON.stringify(submitted.audit).includes('image_bytes'), false);
    assert.equal((await service.listAudits(study.id, { limit: 10, offset: 0 })).audits[0].photos.length, 3);
    const report = await service.createReport(owner, study.id, { auditIds: [submitted.audit.id] });
    assert.equal(report.capturedData.audits[0].photos.length, 3);
    assert.equal(JSON.stringify(report.capturedData).includes('image_bytes'), false);
    assert.equal(report.capturedData.study.questionnaires.intersection.worksheetId, study.questionnaires.intersection.worksheetId);
    const publicPhoto = await fetch(`${base}/audits/${submitted.audit.id}/photos/1`);
    assert.equal(publicPhoto.status, 200); assert.equal(publicPhoto.headers.get('x-content-type-options'), 'nosniff'); assert.deepEqual(Buffer.from(await publicPhoto.arrayBuffer()), png);
    const edit = await service.createDraft(owner, study.id, { editingAuditId: submitted.audit.id });
    assert.equal(edit.photos.length, 3);
    const blank = await service.createDraft(owner, study.id, {});
    const mixedDrafts = (await service.listDrafts(owner, study.id, { limit: 10, offset: 0 })).drafts;
    assert.equal(mixedDrafts.find((item: any) => item.id === edit.id).photos.length, 3);
    assert.equal(mixedDrafts.find((item: any) => item.id === blank.id).photos.length, 0);
    await service.deleteDraft(owner, blank.id);
    const forbiddenEdit = await fetch(`${base}/drafts/${edit.id}/photos/1`, { method: 'PUT', headers: { Authorization: 'Bearer owner', 'Content-Type': 'image/png', 'If-Match': '"1"' }, body: png as any });
    assert.equal(forbiddenEdit.status, 409);
    assert.equal((await service.submitDraft(owner, edit.id, { expectedVersion: 1 })).audit.photos.length, 3);
    assert.deepEqual((await service.getReport(report.id)).capturedData, report.capturedData);
    await service.deleteAudit(owner, submitted.audit.id);
    assert.equal((await db.query<any>('SELECT count(*)::int AS n FROM walk_audit_photos')).rows[0].n, 0);
    assert.equal((await fetch(`${base}/audits/${submitted.audit.id}/photos/1`)).status, 404);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    await db.close();
  }
});
