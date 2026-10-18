/**
 * Wires reusable-action endpoints and their API-key, user, and staff access policies.
 *
 * @remarks
 * Mounted at /api/recommendables by the app. Candidate routes precede the catalog
 * ID route so the literal candidates path is not treated as a catalog ID.
 * Controllers handle HTTP orchestration; OpenAPI owns the endpoint contracts.
 *
 * @see [HTTP contracts](../docs/swagger.ts)
 * @module
 */
import { Router } from 'express';
import { RecommendableActionController } from '../controllers/recommendableActionController.js';
import { PlaygroundLocationController } from '../controllers/playgroundLocationController.js';
import { apiAccess, userAuth } from '../middleware/auth.js';

const router = Router();
router.get('/locations', apiAccess({ apiKey: 'optional' }), userAuth('public'), PlaygroundLocationController.search);
router.post('/match', apiAccess({ apiKey: 'optional' }), userAuth('public'), RecommendableActionController.match);
router.post('/candidates', apiAccess({ apiKey: 'required' }), userAuth('private'), RecommendableActionController.submit);
router.get('/candidates', apiAccess({ apiKey: 'required' }), userAuth('private', ['staff']), RecommendableActionController.candidates);
router.patch('/candidates/:id', apiAccess({ apiKey: 'required' }), userAuth('private', ['staff']), RecommendableActionController.review);
router.patch('/:id', apiAccess({ apiKey: 'required' }), userAuth('private', ['staff']), RecommendableActionController.updateStatus);
router.get('/', apiAccess({ apiKey: 'optional' }), userAuth('public'), RecommendableActionController.approved);
router.get('/:id', apiAccess({ apiKey: 'optional' }), userAuth('public'), RecommendableActionController.getApproved);
export default router;
