import { Router } from 'express';
import { CheckinController } from '../controllers/checkinController.js';

const router = Router();

// CRUD Endpoints for Checkins
router.get('/', CheckinController.getAllCheckins);
router.post('/', CheckinController.createCheckin);
router.get('/:id', CheckinController.getCheckinById);
router.put('/:id', CheckinController.updateCheckin);
router.delete('/:id', CheckinController.deleteCheckin);

export default router;
