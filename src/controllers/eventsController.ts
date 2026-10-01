import { Request, Response, NextFunction } from 'express';
import { EventsService } from '../services/eventsService.js';

export class EventsController {
  /**
   * Proxies the Meetup iCal feed for Dallas Urbanists events.
   * Enables CORS access for client applications and provides fallback caching headers.
   */
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
