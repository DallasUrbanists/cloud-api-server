import { Router } from 'express';
import { EventsController } from '../controllers/eventsController.js';
import { apiAccess, userAuth } from '../middleware/auth.js';

const router = Router();

// Meetup iCal proxy endpoints (for direct calendar subscriptions and proxying)
router.get('/ical', apiAccess({ apiKey: 'optional' }), userAuth('public'), EventsController.getMeetupICal);
router.get('/meetup/ical', apiAccess({ apiKey: 'optional' }), userAuth('public'), EventsController.getMeetupICal);

// Bulk iCal Import endpoint (fetches iCal from URL and inserts/updates DB events)
router.post('/import-ical', apiAccess({ apiKey: 'required' }), userAuth('private', ['staff', 'system']), EventsController.importICal);
router.post('/import', apiAccess({ apiKey: 'required' }), userAuth('private', ['staff', 'system']), EventsController.importICal);

// RESTful CRUD endpoints for Events
router.get('/', apiAccess({ apiKey: 'optional' }), userAuth('public'), EventsController.getAllEvents);
router.post('/', apiAccess({ apiKey: 'required' }), userAuth('private', ['staff', 'system']), EventsController.createEvent);
router.get('/:id', apiAccess({ apiKey: 'optional' }), userAuth('public'), EventsController.getEventById);
router.put('/:id', apiAccess({ apiKey: 'required' }), userAuth('private', ['staff', 'system']), EventsController.updateEvent);
router.patch('/:id', apiAccess({ apiKey: 'required' }), userAuth('private', ['staff', 'system']), EventsController.updateEvent);
router.delete('/:id', apiAccess({ apiKey: 'required' }), userAuth('private', ['staff', 'system']), EventsController.deleteEvent);

export default router;

