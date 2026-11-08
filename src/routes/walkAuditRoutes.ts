/** Firebase-authorized route wiring for walk-audit resources. @module */
import { Router, RequestHandler, raw } from 'express';
import { appCheckAccess, userAuth } from '../middleware/auth.js';
import { actor, draftId, handle, pagination, pathId, walkAuditError, withDisconnect } from '../controllers/walkAuditController.js';
import { WalkAuditWorkflows } from '../services/walkAuditWorkflows.js';
import { WalkAuditError } from '../models/walkAudit.js';
import { invalid } from '../utils/walkAuditValidation.js';

function photoSlot(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-3]$/.test(value)) invalid('Photo slot must be 1, 2, or 3.');
  return Number(value);
}
function photoVersion(value: string | undefined): number {
  if (value === undefined) throw new WalkAuditError(428, 'PRECONDITION_REQUIRED', 'Send the current draft version in If-Match.');
  if (!/^"[1-9]\d*"$/.test(value) || Number(value.slice(1, -1)) > 2147483647) invalid('If-Match must contain a quoted positive draft version.');
  return Number(value.slice(1, -1));
}

/** Allow isolated HTTP tests to provide verified identities without Firebase accounts. */
export function createWalkAuditRouter(service = new WalkAuditWorkflows(), privateAuth: RequestHandler[] = [appCheckAccess, userAuth('private')]): Router {
  const router = Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Access-Control-Expose-Headers', 'ETag, Retry-After, Location');
    if (Object.values(req.query).some(value => typeof value !== 'string' || !value.trim())) { next(new WalkAuditError(400, 'INVALID_INPUT', 'Invalid or duplicate query parameter.')); return; }
    next();
  });
  router.get('/contributors/me', ...privateAuth, handle(async (req, res) => { res.json({ contributor: await service.getContributor(actor(req)) }); }));
  router.post('/contributors/me', ...privateAuth, handle(async (req, res) => { const contributor = await service.createContributor(actor(req), req.body); res.location(`/api/walk-audits/contributors/me`).status(201).json({ contributor }); }));
  router.patch('/contributors/me', ...privateAuth, handle(async (req, res) => { res.json({ contributor: await service.patchContributor(actor(req), req.body) }); }));
  router.delete('/contributors/me', ...privateAuth, handle(async (req, res) => { await service.deleteContributor(actor(req)); res.status(204).end(); }));
  router.get('/contributors', ...privateAuth, handle(async (req, res) => { res.json(await service.listContributors(actor(req), pagination(req))); }));
  router.get('/contributors/:id', ...privateAuth, handle(async (req, res) => { res.json({ contributor: await service.getContributor(actor(req), pathId(req.params.id)) }); }));
  router.patch('/contributors/:id', ...privateAuth, handle(async (req, res) => { res.json({ contributor: await service.patchContributor(actor(req), req.body, pathId(req.params.id)) }); }));
  router.delete('/contributors/:id', ...privateAuth, handle(async (req, res) => { await service.deleteContributor(actor(req), pathId(req.params.id)); res.status(204).end(); }));

  router.get('/dashboard', ...privateAuth, handle(async (req, res) => { res.json(await service.dashboard(actor(req), pagination(req, ['group']))); }));
  router.get('/studies', handle(async (req, res) => { res.json(await service.listStudies(pagination(req, ['creator', 'neighborhood']))); }));
  router.post('/studies', ...privateAuth, handle(async (req, res) => { const study = await withDisconnect(req, res, signal => service.createStudy(actor(req), req.body, signal)); res.location(`/api/walk-audits/studies/${study.id}`).status(201).json({ study }); }));
  router.get('/studies/:id', handle(async (req, res) => { res.json({ study: await service.getStudy(pathId(req.params.id)) }); }));
  router.patch('/studies/:id', ...privateAuth, handle(async (req, res) => { const study = await withDisconnect(req, res, signal => service.patchStudy(actor(req), pathId(req.params.id), req.body, signal)); res.json({ study }); }));
  router.delete('/studies/:id', ...privateAuth, handle(async (req, res) => {
    if (Object.keys(req.query).length !== 1 || req.query.confirmPermanentDelete !== 'true') invalid('Set confirmPermanentDelete=true to permanently delete this study.');
    await service.deleteStudy(actor(req), pathId(req.params.id)); res.status(204).end();
  }));
  router.get('/studies/:id/thumbnail', handle(async (req, res) => { const png = await service.thumbnail(pathId(req.params.id)); res.set('Cache-Control', 'public, max-age=0, must-revalidate').type('png').send(png); }));
  router.get('/studies/:id/progress', handle(async (req, res) => { res.json(await service.progress(pathId(req.params.id))); }));
  router.post('/studies/:id/route-preview', ...privateAuth, handle(async (req, res) => { res.json({ route: await service.routePreview(actor(req), pathId(req.params.id), req.body) }); }));

  router.get('/worksheets', handle(async (req, res) => { res.json(await service.listWorksheets(pagination(req, ['type', 'includeVersions']))); }));
  router.post('/worksheets', ...privateAuth, handle(async (req, res) => { const worksheet = await service.createWorksheet(actor(req), req.body); res.location(`/api/walk-audits/worksheets/${worksheet.id}`).status(201).json({ worksheet }); }));
  router.get('/worksheets/:id', handle(async (req, res) => { res.json({ worksheet: await service.getWorksheet(pathId(req.params.id)) }); }));
  router.patch('/worksheets/:id', ...privateAuth, handle(async (req, res) => { res.json({ worksheet: await service.patchWorksheet(actor(req), pathId(req.params.id), req.body) }); }));
  router.delete('/worksheets/:id', ...privateAuth, handle(async (req, res) => { await service.deleteWorksheet(actor(req), pathId(req.params.id)); res.status(204).end(); }));

  router.get('/studies/:id/audits', handle(async (req, res) => { res.json(await service.listAudits(pathId(req.params.id), pagination(req, ['type', 'author', 'worksheet']))); }));
  router.post('/studies/:id/audits', ...privateAuth, handle(async (req, res) => { const audit = await service.createAudit(actor(req), pathId(req.params.id), req.body); res.location(`/api/walk-audits/audits/${audit.id}`).status(201).json({ audit }); }));
  router.get('/audits/:id', handle(async (req, res) => { res.json({ audit: await service.getAudit(pathId(req.params.id)) }); }));
  router.get('/audits/:id/photos/:slot', handle(async (req, res) => { const photo = await service.auditPhoto(pathId(req.params.id), photoSlot(req.params.slot)); res.set('Cache-Control', 'public, max-age=0, must-revalidate').set('X-Content-Type-Options', 'nosniff').type(photo.contentType).send(photo.bytes); }));
  router.patch('/audits/:id', ...privateAuth, handle(async (req, res) => { res.json({ audit: await service.patchAudit(actor(req), pathId(req.params.id), req.body) }); }));
  router.delete('/audits/:id', ...privateAuth, handle(async (req, res) => { await service.deleteAudit(actor(req), pathId(req.params.id)); res.status(204).end(); }));

  router.get('/studies/:id/drafts', ...privateAuth, handle(async (req, res) => { res.json(await service.listDrafts(actor(req), pathId(req.params.id), pagination(req, ['updatedSince']))); }));
  router.post('/studies/:id/drafts', ...privateAuth, handle(async (req, res) => { const draft = await service.createDraft(actor(req), pathId(req.params.id), req.body); res.location(`/api/walk-audits/drafts/${draft.id}`).status(201).json({ draft }); }));
  router.get('/drafts/:id', ...privateAuth, handle(async (req, res) => { res.json({ draft: await service.getDraft(actor(req), draftId(req.params.id)) }); }));
  router.get('/drafts/:id/photos/:slot', ...privateAuth, handle(async (req, res) => { const photo = await service.draftPhoto(actor(req), draftId(req.params.id), photoSlot(req.params.slot)); res.set('Cache-Control', 'private, no-store').set('X-Content-Type-Options', 'nosniff').type(photo.contentType).send(photo.bytes); }));
  router.put('/drafts/:id/photos/:slot', ...privateAuth, (req, _res, next) => {
    const type = req.get('Content-Type')?.split(';')[0].trim().toLowerCase();
    if (!type || !['image/jpeg', 'image/png', 'image/webp'].includes(type)) { next(new WalkAuditError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send JPEG, PNG, or WebP image bytes.')); return; }
    next();
  }, raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: 2097152 }), handle(async (req, res) => {
    const draft = await service.putDraftPhoto(actor(req), draftId(req.params.id), photoSlot(req.params.slot), photoVersion(req.get('If-Match')), req.get('Content-Type')!.split(';')[0].trim().toLowerCase(), req.body);
    res.json({ draft });
  }));
  router.delete('/drafts/:id/photos/:slot', ...privateAuth, handle(async (req, res) => { res.json({ draft: await service.deleteDraftPhoto(actor(req), draftId(req.params.id), photoSlot(req.params.slot), photoVersion(req.get('If-Match'))) }); }));
  router.patch('/drafts/:id', ...privateAuth, handle(async (req, res) => { res.json({ draft: await service.patchDraft(actor(req), draftId(req.params.id), req.body) }); }));
  router.delete('/drafts/:id', ...privateAuth, handle(async (req, res) => { await service.deleteDraft(actor(req), draftId(req.params.id)); res.status(204).end(); }));
  router.post('/drafts/:id/submit', ...privateAuth, handle(async (req, res) => { const result = await service.submitDraft(actor(req), draftId(req.params.id), req.body); if (result.created) res.location(`/api/walk-audits/audits/${result.audit.id}`); res.status(result.created ? 201 : 200).json({ audit: result.audit }); }));

  router.get('/studies/:id/reports', handle(async (req, res) => { res.json(await service.listReports(pathId(req.params.id), pagination(req))); }));
  router.post('/studies/:id/reports', ...privateAuth, handle(async (req, res) => { const report = await service.createReport(actor(req), pathId(req.params.id), req.body); res.location(`/api/walk-audits/reports/${report.id}`).status(201).json({ report }); }));
  router.get('/reports/:id', handle(async (req, res) => { res.json({ report: await service.getReport(pathId(req.params.id)) }); }));
  router.patch('/reports/:id', ...privateAuth, handle(async (req, res) => { res.json({ report: await service.patchReport(actor(req), pathId(req.params.id), req.body) }); }));
  router.delete('/reports/:id', ...privateAuth, handle(async (req, res) => { await service.deleteReport(actor(req), pathId(req.params.id)); res.status(204).end(); }));
  router.use(walkAuditError);
  return router;
}
