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
import { apiAccess, userAuth } from '../middleware/auth.js';

const router = Router();
router.post('/candidates', apiAccess({ apiKey: 'required' }), userAuth('private'), RecommendableActionController.submit);
router.get('/candidates', apiAccess({ apiKey: 'required' }), userAuth('private', ['staff']), RecommendableActionController.candidates);
router.patch('/candidates/:id', apiAccess({ apiKey: 'required' }), userAuth('private', ['staff']), RecommendableActionController.review);
router.patch('/:id', apiAccess({ apiKey: 'required' }), userAuth('private', ['staff']), RecommendableActionController.updateStatus);
router.get('/', apiAccess({ apiKey: 'required' }), userAuth('public'), RecommendableActionController.approved);
export default router;
