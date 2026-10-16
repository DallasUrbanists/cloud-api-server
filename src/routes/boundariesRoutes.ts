import { Router } from 'express';
import { getBoundary, listBoundaries } from '../controllers/boundariesController.js';
const router = Router();
router.get('/boundaries', listBoundaries);
router.get('/boundary/:id', getBoundary);
export default router;
