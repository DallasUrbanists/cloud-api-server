import { Request, Response, NextFunction } from 'express';
import { EventsService } from '../services/eventsService.js';
import { CreateEventDTO, UpdateEventDTO, EventQueryParams, ImportICalDTO } from '../models/event.js';

export class EventsController {
  // -----------------------------------------------------------------
  // 1. LIST ALL EVENTS (GET /api/events)
  // -----------------------------------------------------------------
  static async getAllEvents(req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      const queryParams: EventQueryParams = {
        status: req.query.status as string | undefined,
        is_hosted_by_du: req.query.is_hosted_by_du as string | undefined,
        start_after: req.query.start_after as string | undefined,
        start_before: req.query.start_before as string | undefined,
        category: req.query.category as string | undefined,
        search: req.query.search as string | undefined,
        limit: req.query.limit as string | undefined,
        offset: req.query.offset as string | undefined,
        order: (req.query.order as 'asc' | 'desc') || 'asc',
      };

      const result = await EventsService.findAll(queryParams);
      res.status(200).json(result);
    } catch (error: any) {
      console.error('Error retrieving events:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: error.message || 'An unexpected error occurred while querying events.',
      });
    }
  }

  // -----------------------------------------------------------------
  // 2. GET EVENT BY ID OR UID (GET /api/events/:id)
  // -----------------------------------------------------------------
  static async getEventById(req: Request, res: Response, _next: NextFunction): Promise<void> {
    const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = rawId ? String(rawId).trim() : '';

    if (!id) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'A valid event ID or UID must be provided in path parameters.',
      });
      return;
    }

    try {
      const event = await EventsService.findById(id);
      if (!event) {
        res.status(404).json({
          error: 'Not Found',
          message: `Event with identifier '${id}' was not found.`,
        });
        return;
      }

      res.status(200).json(event);
    } catch (error: any) {
      console.error(`Error retrieving event ${id}:`, error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: error.message || 'An unexpected error occurred while retrieving the event.',
      });
    }
  }

  // -----------------------------------------------------------------
  // 3. CREATE EVENT (POST /api/events)
  // -----------------------------------------------------------------
  static async createEvent(req: Request, res: Response, _next: NextFunction): Promise<void> {
    const body = (req.body || {}) as CreateEventDTO;

    if (!body.uid || typeof body.uid !== 'string' || body.uid.trim() === '') {
      res.status(400).json({
        error: 'Bad Request',
        message: 'uid is required and must be a non-empty string.',
      });
      return;
    }

    if (!body.start_at) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'start_at is required and must be a valid ISO timestamp or date.',
      });
      return;
    }

    const startAtDate = new Date(body.start_at);
    if (isNaN(startAtDate.getTime())) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'start_at must be a valid ISO 8601 date / timestamp.',
      });
      return;
    }

    // Check constraint: either end_at or duration must be present, but NOT both
    if (body.end_at && body.duration) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Cannot provide both end_at and duration simultaneously. Provide either end_at or duration.',
      });
      return;
    }

    if (body.end_at) {
      const endAtDate = new Date(body.end_at);
      if (isNaN(endAtDate.getTime())) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'end_at must be a valid ISO 8601 timestamp string if provided.',
        });
        return;
      }
    }

    try {
      const created = await EventsService.create({
        ...body,
        start_at: startAtDate,
      });

      res.status(201).json(created);
    } catch (error: any) {
      console.error('Error creating event:', error);

      if (error.code === '23505') {
        // Unique violation for UID
        res.status(409).json({
          error: 'Conflict',
          message: `An event with UID '${body.uid}' already exists.`,
        });
        return;
      }

      res.status(500).json({
        error: 'Internal Server Error',
        message: error.message || 'An unexpected error occurred while creating the event.',
      });
    }
  }

  // -----------------------------------------------------------------
  // 4. UPDATE EVENT (PUT/PATCH /api/events/:id)
  // -----------------------------------------------------------------
  static async updateEvent(req: Request, res: Response, _next: NextFunction): Promise<void> {
    const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = rawId ? String(rawId).trim() : '';
    const body = (req.body || {}) as UpdateEventDTO;

    if (!id) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'A valid event ID or UID must be provided in path parameters.',
      });
      return;
    }

    if (body.start_at) {
      const startAtDate = new Date(body.start_at);
      if (isNaN(startAtDate.getTime())) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'start_at must be a valid ISO 8601 date / timestamp.',
        });
        return;
      }
    }

    if (body.end_at && body.duration) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Cannot provide both end_at and duration simultaneously.',
      });
      return;
    }

    try {
      const updated = await EventsService.update(id, body);
      if (!updated) {
        res.status(404).json({
          error: 'Not Found',
          message: `Event with identifier '${id}' was not found.`,
        });
        return;
      }

      res.status(200).json(updated);
    } catch (error: any) {
      console.error(`Error updating event ${id}:`, error);

      if (error.code === '23505') {
        res.status(409).json({
          error: 'Conflict',
          message: `An event with UID '${body.uid}' already exists.`,
        });
        return;
      }

      res.status(500).json({
        error: 'Internal Server Error',
        message: error.message || 'An unexpected error occurred while updating the event.',
      });
    }
  }

  // -----------------------------------------------------------------
  // 5. DELETE EVENT (DELETE /api/events/:id)
  // -----------------------------------------------------------------
  static async deleteEvent(req: Request, res: Response, _next: NextFunction): Promise<void> {
    const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = rawId ? String(rawId).trim() : '';

    if (!id) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'A valid event ID or UID must be provided in path parameters.',
      });
      return;
    }

    try {
      const deleted = await EventsService.delete(id);
      if (!deleted) {
        res.status(404).json({
          error: 'Not Found',
          message: `Event with identifier '${id}' was not found.`,
        });
        return;
      }

      res.status(200).json({
        message: `Event with identifier '${id}' has been deleted successfully.`,
      });
    } catch (error: any) {
      console.error(`Error deleting event ${id}:`, error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: error.message || 'An unexpected error occurred while deleting the event.',
      });
    }
  }

  // -----------------------------------------------------------------
  // 6. BULK IMPORT FROM ICAL (POST /api/events/import-ical)
  // -----------------------------------------------------------------
  static async importICal(req: Request, res: Response, _next: NextFunction): Promise<void> {
    const { url, is_hosted_by_du, force } = (req.body || {}) as ImportICalDTO;

    if (url !== undefined && (typeof url !== 'string' || url.trim() === '')) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'If provided, url must be a valid non-empty string URL.',
      });
      return;
    }

    try {
      const result = await EventsService.importFromICal(url ? url.trim() : undefined, {
        is_hosted_by_du,
        force,
      });

      res.status(200).json({
        message: `Import completed: ${result.created} created, ${result.updated} updated, ${result.skipped} skipped, ${result.failed} failed.`,
        ...result,
      });
    } catch (error: any) {
      console.error('Error importing events from iCal feed:', error);
      res.status(502).json({
        error: 'Bad Gateway',
        message: error.message || 'Failed to fetch or import upstream iCal feed.',
      });
    }
  }

  // -----------------------------------------------------------------
  // 7. PROXY MEETUP ICAL STREAM (GET /api/events/ical)
  // -----------------------------------------------------------------
  static async getMeetupICal(_req: Request, res: Response, _next: NextFunction): Promise<void> {
    try {
      const feed = await EventsService.fetchMeetupICal();

      res.setHeader('Content-Type', feed.contentType || 'text/calendar; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
      res.setHeader('Content-Disposition', 'inline; filename="meetup-events.ics"');

      if (feed.etag) {
        res.setHeader('ETag', feed.etag);
      }
      if (feed.lastModified) {
        res.setHeader('Last-Modified', feed.lastModified);
      }

      res.status(200).send(feed.data);
    } catch (error: any) {
      console.error('Error proxying Meetup iCal feed:', error);
      res.status(502).json({
        error: 'Bad Gateway',
        message: error.message || 'Failed to fetch upstream Meetup iCal feed.',
      });
    }
  }
}

