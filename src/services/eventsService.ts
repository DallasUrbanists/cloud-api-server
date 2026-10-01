/**
 * Service for fetching and proxying event feeds (e.g. Meetup iCal).
 */

const DEFAULT_MEETUP_ICAL_URL = 'https://www.meetup.com/dallasurbanists/events/ical/';
const FETCH_TIMEOUT_MS = 15000;

export interface ICalFeedResult {
  data: string;
  contentType: string;
  etag?: string | null;
  lastModified?: string | null;
}

export class EventsService {
  /**
   * Retrieves the configured Meetup iCal URL.
   */
  static getMeetupICalUrl(): string {
    return process.env.MEETUP_ICAL_URL || DEFAULT_MEETUP_ICAL_URL;
  }

  /**
   * Fetches the Meetup iCal feed from upstream.
   */
  static async fetchMeetupICal(): Promise<ICalFeedResult> {
    const url = this.getMeetupICalUrl();

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'DallasUrbanists-ApiServer/1.0 (+https://dallasurbanists.org)',
          'Accept': 'text/calendar, text/plain, */*',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`Upstream Meetup server returned HTTP ${response.status}: ${response.statusText}`);
      }

      const rawText = await response.text();
      const contentType = response.headers.get('content-type') || 'text/calendar; charset=utf-8';
      const etag = response.headers.get('etag');
      const lastModified = response.headers.get('last-modified');

      return {
        data: rawText,
        contentType,
        etag,
        lastModified,
      };
    } catch (error: any) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        throw new Error(`Request to upstream Meetup feed timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
      }
      throw error;
    }
  }
}
