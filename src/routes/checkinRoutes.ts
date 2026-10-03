import { Router } from 'express';
import { CheckinController } from '../controllers/checkinController.js';
import { apiAccess, userAuth } from '../middleware/auth.js';

const router = Router();

// CRUD Endpoints for Checkins
router.get('/', apiAccess({ apiKey: 'required' }), userAuth('partial'), CheckinController.getAllCheckins);
router.post('/', apiAccess({ apiKey: 'optional' }), userAuth('public'), CheckinController.createCheckin);
router.get('/:id', apiAccess({ apiKey: 'required' }), userAuth('partial'), CheckinController.getCheckinById);
router.put('/:id', apiAccess({ apiKey: 'required' }), userAuth('private'), CheckinController.updateCheckin);
router.delete('/:id', apiAccess({ apiKey: 'required' }), userAuth('private'), CheckinController.deleteCheckin);

export default router;
