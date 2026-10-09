import { Router } from 'express';
import { RepresentativesController } from '../controllers/representativesController.js';

const router = Router();

router.get('/', RepresentativesController.list);

export default router;
