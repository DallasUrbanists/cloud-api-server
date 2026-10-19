/**
 * Application-authenticated Streetmix routes; user identity is optional.
 * @module
 */
import { Router } from 'express';
import { apiAccess, appCheckAccess, userAuth } from '../middleware/auth.js';
import { createStreetmixDesign, createPlaygroundStreetmixDesign, previewPlaygroundStreetmix } from '../controllers/streetmixController.js';

const router = Router();
router.post('/designs', apiAccess({ apiKey: 'required' }), userAuth('public'), createStreetmixDesign);
router.post('/playground/designs', appCheckAccess, createPlaygroundStreetmixDesign);
router.post('/playground/candidates', appCheckAccess, previewPlaygroundStreetmix);
export default router;
