/**
 * Idea, per-idea action, activity, and image-upload routing for both app aliases.
 *
 * @remarks
 * Every route requires application access. Reads/creation allow optional user identity;
 * private mutations use user/staff middleware plus ownership checks in controllers.
 * Nested action/log routes precede the base identifier route. OpenAPI owns contracts.
 * @module
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { IdeaController } from '../controllers/ideaController.js';
import { RecommendedActionController } from '../controllers/recommendedActionController.js';
import { apiAccess, userAuth } from '../middleware/auth.js';
import { ideaStreetmixHandler } from '../controllers/ideaStreetmixController.js';
import { ideasMaintenanceEnabled } from '../config/ideas.js';

export type IdeasContract = 'ideas' | 'suggestions';

function maintenance(_req: Request, res: Response, next: NextFunction): void {
  if (!ideasMaintenanceEnabled()) { next(); return; }
  res.set('Retry-After', '5').status(503).json({ error: 'SERVICE_UNAVAILABLE', message: 'Idea services are briefly unavailable for a data migration. Retry shortly.' });
}

function deprecatedUse(req: Request, res: Response, next: NextFunction): void {
  res.set('Deprecation', 'true').set('Link', '</api/ideas>; rel="successor-version"');
  let recorded = false;
  const record = () => {
    if (recorded) return;
    recorded = true;
    console.info(JSON.stringify({ event: 'ideas_legacy_rest_request', method: req.method,
      route: `${req.baseUrl}${req.route?.path ?? ''}`, status: res.statusCode }));
  };
  res.once('finish', record);
  res.once('close', record);
  next();
}

/** Creates the canonical or deprecated adapter over the same Idea service and authorization rules. */
export function createIdeaRouter(contract: IdeasContract = 'ideas') {
  const router = Router();
  const legacy = contract === 'suggestions';
  const streetmix = (action: Parameters<typeof ideaStreetmixHandler>[0]) => ideaStreetmixHandler(action, contract);
  if (legacy) router.use(deprecatedUse);
  router.use(maintenance);

  // Upgrades are handled by the HTTP server; reserve this path before /:id.
  router.get('/ws', (_req, res) => {
    res.set('Upgrade', 'websocket').status(426).json({ error: 'UPGRADE_REQUIRED', message: 'Connect using WebSocket.' });
  });

  router.get('/:ideaId/streetmix', apiAccess({ apiKey: 'required' }), userAuth('public'), streetmix('read'));
  router.get('/:ideaId/streetmix/thumbnail', apiAccess({ apiKey: 'required' }), userAuth('public'), streetmix('thumbnail'));
  router.post('/:ideaId/streetmix', apiAccess({ apiKey: 'required' }), userAuth('public'), streetmix('initial'));
  router.post('/:ideaId/streetmix/regenerate', apiAccess({ apiKey: 'required' }), userAuth('private'), streetmix('regenerate'));
  router.get('/:ideaId/streetmix/requests/:requestId', apiAccess({ apiKey: 'required' }), userAuth('public'), streetmix('request'));
  router.post('/:ideaId/streetmix/requests/:requestId/selection', apiAccess({ apiKey: 'required' }), userAuth('public'), streetmix('selection'));

  router.post('/upload-url', apiAccess({ apiKey: 'required' }), userAuth('public'), IdeaController.getUploadUrl);
  router.get('/', apiAccess({ apiKey: 'required' }), userAuth('public'), IdeaController.list);
  router.get('/:ideaId/boundaries', apiAccess({ apiKey: 'required' }), userAuth('public'), IdeaController.getBoundaries);
  router.get('/:ideaId/representatives', apiAccess({ apiKey: 'required' }), userAuth('public'), IdeaController.getRepresentatives);
  router.get('/:ideaId/recommended-actions', apiAccess({ apiKey: 'required' }), userAuth('public'), RecommendedActionController.list);
  router.post('/:ideaId/recommended-actions', apiAccess({ apiKey: 'required' }), userAuth('private', ['staff']), RecommendedActionController.create);
  router.get('/:ideaId/recommended-actions/:actionId', apiAccess({ apiKey: 'required' }), userAuth('public'), RecommendedActionController.get);
  router.patch('/:ideaId/recommended-actions/:actionId', apiAccess({ apiKey: 'required' }), userAuth('private', ['staff']), RecommendedActionController.update);
  router.delete('/:ideaId/recommended-actions/:actionId', apiAccess({ apiKey: 'required' }), userAuth('private', ['staff']), RecommendedActionController.delete);
  router.get('/:ideaId/log', apiAccess({ apiKey: 'required' }), userAuth('public'), RecommendedActionController.getLog);
  router.post('/:ideaId/log', apiAccess({ apiKey: 'required' }), userAuth('private'), RecommendedActionController.appendLog);
  router.get('/:id', apiAccess({ apiKey: 'required' }), userAuth('public'), IdeaController.getById);
  router.post('/', apiAccess({ apiKey: 'required' }), userAuth('public'), IdeaController.create);
  router.put('/:id', apiAccess({ apiKey: 'required' }), userAuth('private'), IdeaController.update);
  router.delete('/:id', apiAccess({ apiKey: 'required' }), userAuth('private'), IdeaController.delete);
  return router;
}

export const ideaRoutes = createIdeaRouter('ideas');
export const legacySuggestionRoutes = createIdeaRouter('suggestions');
export default ideaRoutes;
