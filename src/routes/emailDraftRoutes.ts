/** Public, credential-free email drafting and minimal playground selector routes. @module */
import { Router } from 'express';
import { EmailDraftController } from '../controllers/emailDraftController.js';

const router = Router();
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
router.get('/suggestions', EmailDraftController.suggestions);
router.get('/representatives', EmailDraftController.representatives);
router.get('/locations', EmailDraftController.locations);
router.post('/generate', EmailDraftController.generate);
router.post('/generate-unsaved', EmailDraftController.generateUnsaved);
export default router;
