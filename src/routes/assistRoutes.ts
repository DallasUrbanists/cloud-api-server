import { Router } from 'express';
import { AssistController } from '../controllers/assistController.js';
import { apiAccess, userAuth } from '../middleware/auth.js';

const router = Router();

router.post('/grammar', apiAccess({ apiKey: 'required' }), userAuth('public'), AssistController.grammar);
router.post('/clarity', apiAccess({ apiKey: 'required' }), userAuth('public'), AssistController.clarity);
router.post('/summarize', apiAccess({ apiKey: 'required' }), userAuth('public'), AssistController.summarize);

export default router;