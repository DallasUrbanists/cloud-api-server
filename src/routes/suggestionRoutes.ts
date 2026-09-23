import { Router } from 'express';
import { SuggestionController } from '../controllers/suggestionController.js';

const router = Router();

// Signed URL Upload Helper
router.post('/upload-url', SuggestionController.getUploadUrl);

// CRUD Endpoints for Suggestion
router.get('/', SuggestionController.list);
router.get('/:id', SuggestionController.getById);
router.post('/', SuggestionController.create);
router.put('/:id', SuggestionController.update);
router.delete('/:id', SuggestionController.delete);

export default router;
