import { Router } from 'express';
import { ContactController } from '../controllers/contactController.js';
import { apiAccess, userAuth } from '../middleware/auth.js';

const router = Router();

// CRUD Endpoints for Contacts
router.get('/', apiAccess({ apiKey: 'required' }), userAuth('partial'), ContactController.getAllContacts);
router.post('/', apiAccess({ apiKey: 'required' }), userAuth('public'), ContactController.createContact);
router.get('/:id', apiAccess({ apiKey: 'required' }), userAuth('partial'), ContactController.getContactById);
router.put('/:id', apiAccess({ apiKey: 'required' }), userAuth('partial'), ContactController.updateContact);
router.delete('/:id', apiAccess({ apiKey: 'required' }), userAuth('private'), ContactController.deleteContact);

export default router;