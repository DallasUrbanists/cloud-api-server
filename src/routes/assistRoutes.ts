/**
 * Text-assistance routing for grammar, clarity, and summaries.
 * Mounted at /api/assist with required application access and optional user identity.
 * The app installs a smaller body parser before these routes; OpenAPI owns HTTP contracts.
 * @module
 */
import { Router } from 'express';
import { AssistController } from '../controllers/assistController.js';
import { apiAccess, userAuth } from '../middleware/auth.js';

const router = Router();

router.post('/grammar', apiAccess({ apiKey: 'required' }), userAuth('public'), AssistController.grammar);
router.post('/clarity', apiAccess({ apiKey: 'required' }), userAuth('public'), AssistController.clarity);
router.post('/summarize', apiAccess({ apiKey: 'required' }), userAuth('public'), AssistController.summarize);

export default router;