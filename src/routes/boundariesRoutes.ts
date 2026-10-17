/**
 * Public boundary search/detail wiring, mounted under /api without key or user middleware.
 * HTTP contracts live in src/docs/boundaries.ts; refresh ticks use a separate router.
 * @module
 */
import { Router } from 'express';
import { getBoundary, listBoundaries } from '../controllers/boundariesController.js';
const router = Router();
router.get('/boundaries', listBoundaries);
router.get('/boundary/:id', getBoundary);
export default router;
