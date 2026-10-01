import { Router } from 'express';
import { EventsController } from '../controllers/eventsController.js';

const router = Router();

// Meetup iCal proxy endpoints
router.get('/ical', EventsController.getMeetupICal);
router.get('/meetup/ical', EventsController.getMeetupICal);
router.get('/', EventsController.getMeetupICal);

export default router;
