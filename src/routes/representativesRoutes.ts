/**
 * Public representative-search wiring mounted at /api/representatives.
 * No API-key/user middleware is required; OpenAPI owns the query and response contract.
 * @module
 */
import { Router } from 'express';
import { RepresentativesController } from '../controllers/representativesController.js';

const router = Router();

router.get('/', RepresentativesController.list);

export default router;
