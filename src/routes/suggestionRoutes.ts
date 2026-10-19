/**
 * Suggestion, per-suggestion action, activity, and image-upload routing for both app aliases.
 *
 * @remarks
 * Every route requires application access. Reads/creation allow optional user identity;
 * private mutations use user/staff middleware plus ownership checks in controllers.
 * Nested action/log routes precede the base identifier route. OpenAPI owns contracts.
 * @module
 */
import { Router } from 'express';
import { SuggestionController } from '../controllers/suggestionController.js';
import { RecommendedActionController } from '../controllers/recommendedActionController.js';
import { apiAccess, userAuth } from '../middleware/auth.js';
import { suggestionStreetmixHandler } from '../controllers/suggestionStreetmixController.js';

const router = Router();

// Upgrades are handled by the HTTP server; reserve this path before /:id.
router.get('/ws', (_req, res) => {
  res.set('Upgrade', 'websocket').status(426).json({ error: 'UPGRADE_REQUIRED', message: 'Connect using WebSocket.' });
});

router.get('/:suggestionId/streetmix', apiAccess({ apiKey: 'required' }), userAuth('public'), suggestionStreetmixHandler('read'));
router.get('/:suggestionId/streetmix/thumbnail', apiAccess({ apiKey: 'required' }), userAuth('public'), suggestionStreetmixHandler('thumbnail'));
router.post('/:suggestionId/streetmix', apiAccess({ apiKey: 'required' }), userAuth('public'), suggestionStreetmixHandler('initial'));
router.post('/:suggestionId/streetmix/regenerate', apiAccess({ apiKey: 'required' }), userAuth('private'), suggestionStreetmixHandler('regenerate'));
router.get('/:suggestionId/streetmix/requests/:requestId', apiAccess({ apiKey: 'required' }), userAuth('public'), suggestionStreetmixHandler('request'));
router.post('/:suggestionId/streetmix/requests/:requestId/selection', apiAccess({ apiKey: 'required' }), userAuth('public'), suggestionStreetmixHandler('selection'));

// Signed URL Upload Helper
router.post('/upload-url', apiAccess({ apiKey: 'required' }), userAuth('public'), SuggestionController.getUploadUrl);

// CRUD Endpoints for Suggestion
router.get('/', apiAccess({ apiKey: 'required' }), userAuth('public'), SuggestionController.list);
router.get('/:suggestionId/boundaries', apiAccess({ apiKey: 'required' }), userAuth('public'), SuggestionController.getBoundaries);
router.get('/:suggestionId/representatives', apiAccess({ apiKey: 'required' }), userAuth('public'), SuggestionController.getRepresentatives);
router.get('/:suggestionId/recommended-actions', apiAccess({ apiKey: 'required' }), userAuth('public'), RecommendedActionController.list);
router.post('/:suggestionId/recommended-actions', apiAccess({ apiKey: 'required' }), userAuth('private', ['staff']), RecommendedActionController.create);
router.get('/:suggestionId/recommended-actions/:actionId', apiAccess({ apiKey: 'required' }), userAuth('public'), RecommendedActionController.get);
router.patch('/:suggestionId/recommended-actions/:actionId', apiAccess({ apiKey: 'required' }), userAuth('private', ['staff']), RecommendedActionController.update);
router.delete('/:suggestionId/recommended-actions/:actionId', apiAccess({ apiKey: 'required' }), userAuth('private', ['staff']), RecommendedActionController.delete);
router.get('/:suggestionId/log', apiAccess({ apiKey: 'required' }), userAuth('public'), RecommendedActionController.getLog);
router.post('/:suggestionId/log', apiAccess({ apiKey: 'required' }), userAuth('private'), RecommendedActionController.appendLog);
router.get('/:id', apiAccess({ apiKey: 'required' }), userAuth('public'), SuggestionController.getById);
router.post('/', apiAccess({ apiKey: 'required' }), userAuth('public'), SuggestionController.create);
router.put('/:id', apiAccess({ apiKey: 'required' }), userAuth('private'), SuggestionController.update);
router.delete('/:id', apiAccess({ apiKey: 'required' }), userAuth('private'), SuggestionController.delete);

export default router;
