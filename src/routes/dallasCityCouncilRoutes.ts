/**
 * Public Dallas Council convenience route, sharing directory logic with fixed office filters.
 * Mounted at /api/dallascitycouncil; this is not a separate directory or research pipeline.
 * @module
 */
import { Router } from 'express';
import { RepresentativesController } from '../controllers/representativesController.js';

const router = Router();

router.get('/', RepresentativesController.listDallasCityCouncil);

export default router;
