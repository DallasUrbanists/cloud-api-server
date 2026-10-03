import { Router } from 'express';
import { EventsController } from '../controllers/eventsController.js';

const router = Router();

// Meetup iCal proxy endpoints (for direct calendar subscriptions and proxying)
router.get('/ical', EventsController.getMeetupICal);
router.get('/meetup/ical', EventsController.getMeetupICal);

// Bulk iCal Import endpoint (fetches iCal from URL and inserts/updates DB events)
router.post('/import-ical', EventsController.importICal);
router.post('/import', EventsController.importICal);

// RESTful CRUD endpoints for Events
router.get('/', EventsController.getAllEvents);
router.post('/', EventsController.createEvent);
router.get('/:id', EventsController.getEventById);
router.put('/:id', EventsController.updateEvent);
router.patch('/:id', EventsController.updateEvent);
router.delete('/:id', EventsController.deleteEvent);

export default router;

