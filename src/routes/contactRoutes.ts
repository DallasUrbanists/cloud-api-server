import { Router } from 'express';
import { ContactController } from '../controllers/contactController.js';

const router = Router();

// CRUD Endpoints for Contacts
router.get('/', ContactController.getAllContacts);
router.post('/', ContactController.createContact);
router.get('/:id', ContactController.getContactById);
router.put('/:id', ContactController.updateContact);
router.delete('/:id', ContactController.deleteContact);

export default router;