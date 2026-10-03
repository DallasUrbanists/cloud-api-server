import { Router } from 'express';
import { SuggestionController } from '../controllers/suggestionController.js';
import { apiAccess, userAuth } from '../middleware/auth.js';

const router = Router();

// Signed URL Upload Helper
router.post('/upload-url', apiAccess({ apiKey: 'required' }), userAuth('public'), SuggestionController.getUploadUrl);

// CRUD Endpoints for Suggestion
router.get('/', apiAccess({ apiKey: 'required' }), userAuth('public'), SuggestionController.list);
router.get('/:id', apiAccess({ apiKey: 'required' }), userAuth('public'), SuggestionController.getById);
router.post('/', apiAccess({ apiKey: 'required' }), userAuth('public'), SuggestionController.create);
router.put('/:id', apiAccess({ apiKey: 'required' }), userAuth('private'), SuggestionController.update);
router.delete('/:id', apiAccess({ apiKey: 'required' }), userAuth('private'), SuggestionController.delete);

export default router;
