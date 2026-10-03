import { pool } from '../config/db.js';
import {
  Event,
  CreateEventDTO,
  UpdateEventDTO,
  EventQueryParams,
  ImportICalResult,
  ImportICalItemResult,
} from '../models/event.js';
import { parseICalToEvents } from '../utils/icalParser.js';

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
   * Fetches an iCalendar feed from a given or default URL.
   */
  static async fetchICal(url?: string): Promise<ICalFeedResult> {
    const targetUrl = url || this.getMeetupICalUrl();

    try {
      const response = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'DallasUrbanists-ApiServer/1.0 (+https://dallasurbanists.org)',
          'Accept': 'text/calendar, text/plain, */*',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        throw new Error(`Upstream server returned HTTP ${response.status}: ${response.statusText}`);
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
        throw new Error(`Request to upstream iCal feed timed out after ${FETCH_TIMEOUT_MS / 1000}s`);
      }
      throw error;
    }
  }

  /**
   * Fetches the default Meetup iCal feed from upstream.
   */
  static async fetchMeetupICal(): Promise<ICalFeedResult> {
    return this.fetchICal(this.getMeetupICalUrl());
  }

  // -----------------------------------------------------------------
  // 1. CREATE EVENT
  // -----------------------------------------------------------------
  static async create(data: CreateEventDTO): Promise<Event> {
    // Validate constraint: end_at OR duration must be present, but NOT both
    let endAt = data.end_at !== undefined ? data.end_at : null;
    let duration = data.duration !== undefined ? data.duration : null;

    if (!endAt && !duration) {
      if (data.all_day) {
        duration = 'P1D';
      } else {
        duration = 'PT1H';
      }
    } else if (endAt && duration) {
      duration = null;
    }

    const query = `
      INSERT INTO events (
        uid,
        start_at,
        end_at,
        duration,
        all_day,
        timezone,
        title,
        description,
        location,
        url,
        status,
        img,
        classification,
        sequence,
        organizer_name,
        organizer_email,
        recurrence_rule,
        recurrence_id,
        categories,
        resources,
        attachments,
        geo_latitude,
        geo_longitude,
        is_hosted_by_du,
        ical_raw,
        ical_dtstamp,
        ical_created,
        ical_last_modified
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
        $21, $22, $23, $24, $25, $26, $27, $28
      )
      RETURNING *;
    `;

    const values = [
      data.uid.trim(),
      data.start_at,
      endAt,
      duration,
      data.all_day ?? false,
      data.timezone ?? null,
      data.title ?? null,
      data.description ?? null,
      data.location ?? null,
      data.url ?? null,
      data.status ?? null,
      data.img ?? null,
      data.classification ?? null,
      data.sequence ?? 0,
      data.organizer_name ?? null,
      data.organizer_email ?? null,
      data.recurrence_rule ?? null,
      data.recurrence_id ?? null,
      data.categories && data.categories.length > 0 ? data.categories : null,
      data.resources && data.resources.length > 0 ? data.resources : null,
      data.attachments ? JSON.stringify(data.attachments) : null,
      data.geo_latitude !== undefined && data.geo_latitude !== null ? Number(data.geo_latitude) : null,
      data.geo_longitude !== undefined && data.geo_longitude !== null ? Number(data.geo_longitude) : null,
      data.is_hosted_by_du ?? true,
      data.ical_raw ?? null,
      data.ical_dtstamp ?? new Date(),
      data.ical_created ?? null,
      data.ical_last_modified ?? null,
    ];

    const result = await pool.query<Event>(query, values);
    return result.rows[0];
  }

  // -----------------------------------------------------------------
  // 2. FIND ALL EVENTS (WITH FILTERS & PAGINATION)
  // -----------------------------------------------------------------
  static async findAll(params: EventQueryParams): Promise<{ data: Event[]; count: number; total: number }> {
    const conditions: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (params.status) {
      conditions.push(`status ILIKE $${paramIndex++}`);
      values.push(params.status.trim());
    }

    if (params.is_hosted_by_du !== undefined && params.is_hosted_by_du !== '') {
      const isHosted = params.is_hosted_by_du.toLowerCase() === 'true';
      conditions.push(`is_hosted_by_du = $${paramIndex++}`);
      values.push(isHosted);
    }

    if (params.start_after) {
      conditions.push(`start_at >= $${paramIndex++}`);
      values.push(new Date(params.start_after));
    }

    if (params.start_before) {
      conditions.push(`start_at <= $${paramIndex++}`);
      values.push(new Date(params.start_before));
    }

    if (params.category) {
      conditions.push(`$${paramIndex++} = ANY(categories)`);
      values.push(params.category.trim());
    }

    if (params.search) {
      conditions.push(`(title ILIKE $${paramIndex} OR description ILIKE $${paramIndex} OR location ILIKE $${paramIndex})`);
      values.push(`%${params.search.trim()}%`);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';

    // Total count query
    const countQuery = `SELECT COUNT(*)::int AS total FROM events${whereClause};`;
    const countResult = await pool.query<{ total: number }>(countQuery, values);
    const total = countResult.rows[0]?.total ?? 0;

    // Sorting
    const sortOrder = params.order?.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    let query = `SELECT * FROM events${whereClause} ORDER BY start_at ${sortOrder}`;

    // Pagination
    const limit = params.limit ? parseInt(params.limit, 10) : 50;
    const offset = params.offset ? parseInt(params.offset, 10) : 0;

    query += ` LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    values.push(limit, offset);

    const result = await pool.query<Event>(query, values);
    return {
      data: result.rows,
      count: result.rows.length,
      total,
    };
  }

  // -----------------------------------------------------------------
  // 3. FIND BY ID OR UID
  // -----------------------------------------------------------------
  static async findById(id: number | string): Promise<Event | null> {
    const isNumeric = typeof id === 'number' || /^\d+$/.test(String(id));
    let query: string;
    let values: any[];

    if (isNumeric) {
      query = 'SELECT * FROM events WHERE id = $1 LIMIT 1;';
      values = [id];
    } else {
      query = 'SELECT * FROM events WHERE uid = $1 LIMIT 1;';
      values = [String(id)];
    }

    const result = await pool.query<Event>(query, values);
    return result.rows[0] || null;
  }

  // -----------------------------------------------------------------
  // 4. FIND BY UID
  // -----------------------------------------------------------------
  static async findByUid(uid: string): Promise<Event | null> {
    const query = 'SELECT * FROM events WHERE uid = $1 LIMIT 1;';
    const result = await pool.query<Event>(query, [uid.trim()]);
    return result.rows[0] || null;
  }

  // -----------------------------------------------------------------
  // 5. UPDATE EVENT
  // -----------------------------------------------------------------
  static async update(id: number | string, data: UpdateEventDTO): Promise<Event | null> {
    const existing = await this.findById(id);
    if (!existing) {
      return null;
    }

    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (data.uid !== undefined) {
      updates.push(`uid = $${paramIndex++}`);
      values.push(data.uid.trim());
    }
    if (data.start_at !== undefined) {
      updates.push(`start_at = $${paramIndex++}`);
      values.push(data.start_at);
    }

    // Handle end_at & duration constraint logic
    if (data.end_at !== undefined && data.duration !== undefined) {
      if (data.end_at && data.duration) {
        updates.push(`end_at = $${paramIndex++}`);
        values.push(data.end_at);
        updates.push(`duration = $${paramIndex++}`);
        values.push(null);
      } else {
        updates.push(`end_at = $${paramIndex++}`);
        values.push(data.end_at);
        updates.push(`duration = $${paramIndex++}`);
        values.push(data.duration);
      }
    } else if (data.end_at !== undefined) {
      updates.push(`end_at = $${paramIndex++}`);
      values.push(data.end_at);
      if (data.end_at !== null) {
        updates.push(`duration = NULL`);
      }
    } else if (data.duration !== undefined) {
      updates.push(`duration = $${paramIndex++}`);
      values.push(data.duration);
      if (data.duration !== null) {
        updates.push(`end_at = NULL`);
      }
    }

    if (data.all_day !== undefined) {
      updates.push(`all_day = $${paramIndex++}`);
      values.push(data.all_day);
    }
    if (data.timezone !== undefined) {
      updates.push(`timezone = $${paramIndex++}`);
      values.push(data.timezone);
    }
    if (data.title !== undefined) {
      updates.push(`title = $${paramIndex++}`);
      values.push(data.title);
    }
    if (data.description !== undefined) {
      updates.push(`description = $${paramIndex++}`);
      values.push(data.description);
    }
    if (data.location !== undefined) {
      updates.push(`location = $${paramIndex++}`);
      values.push(data.location);
    }
    if (data.url !== undefined) {
      updates.push(`url = $${paramIndex++}`);
      values.push(data.url);
    }
    if (data.status !== undefined) {
      updates.push(`status = $${paramIndex++}`);
      values.push(data.status);
    }
    if (data.img !== undefined) {
      updates.push(`img = $${paramIndex++}`);
      values.push(data.img);
    }
    if (data.classification !== undefined) {
      updates.push(`classification = $${paramIndex++}`);
      values.push(data.classification);
    }
    if (data.sequence !== undefined) {
      updates.push(`sequence = $${paramIndex++}`);
      values.push(data.sequence);
    }
    if (data.organizer_name !== undefined) {
      updates.push(`organizer_name = $${paramIndex++}`);
      values.push(data.organizer_name);
    }
    if (data.organizer_email !== undefined) {
      updates.push(`organizer_email = $${paramIndex++}`);
      values.push(data.organizer_email);
    }
    if (data.recurrence_rule !== undefined) {
      updates.push(`recurrence_rule = $${paramIndex++}`);
      values.push(data.recurrence_rule);
    }
    if (data.recurrence_id !== undefined) {
      updates.push(`recurrence_id = $${paramIndex++}`);
      values.push(data.recurrence_id);
    }
    if (data.categories !== undefined) {
      updates.push(`categories = $${paramIndex++}`);
      values.push(data.categories && data.categories.length > 0 ? data.categories : null);
    }
    if (data.resources !== undefined) {
      updates.push(`resources = $${paramIndex++}`);
      values.push(data.resources && data.resources.length > 0 ? data.resources : null);
    }
    if (data.attachments !== undefined) {
      updates.push(`attachments = $${paramIndex++}`);
      values.push(data.attachments ? JSON.stringify(data.attachments) : null);
    }
    if (data.geo_latitude !== undefined) {
      updates.push(`geo_latitude = $${paramIndex++}`);
      values.push(data.geo_latitude !== null ? Number(data.geo_latitude) : null);
    }
    if (data.geo_longitude !== undefined) {
      updates.push(`geo_longitude = $${paramIndex++}`);
      values.push(data.geo_longitude !== null ? Number(data.geo_longitude) : null);
    }
    if (data.is_hosted_by_du !== undefined) {
      updates.push(`is_hosted_by_du = $${paramIndex++}`);
      values.push(data.is_hosted_by_du);
    }
    if (data.ical_raw !== undefined) {
      updates.push(`ical_raw = $${paramIndex++}`);
      values.push(data.ical_raw);
    }
    if (data.ical_dtstamp !== undefined) {
      updates.push(`ical_dtstamp = $${paramIndex++}`);
      values.push(data.ical_dtstamp);
    }
    if (data.ical_created !== undefined) {
      updates.push(`ical_created = $${paramIndex++}`);
      values.push(data.ical_created);
    }
    if (data.ical_last_modified !== undefined) {
      updates.push(`ical_last_modified = $${paramIndex++}`);
      values.push(data.ical_last_modified);
    }

    updates.push(`updated_at = NOW()`);

    values.push(existing.id);
    const query = `
      UPDATE events
      SET ${updates.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *;
    `;

    const result = await pool.query<Event>(query, values);
    return result.rows[0];
  }

  // -----------------------------------------------------------------
  // 6. DELETE EVENT
  // -----------------------------------------------------------------
  static async delete(id: number | string): Promise<boolean> {
    const isNumeric = typeof id === 'number' || /^\d+$/.test(String(id));
    const query = isNumeric
      ? 'DELETE FROM events WHERE id = $1 RETURNING id;'
      : 'DELETE FROM events WHERE uid = $1 RETURNING id;';

    const result = await pool.query(query, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  // -----------------------------------------------------------------
  // 7. IMPORT FROM ICAL (BULK UPSERT WITH NEWER CHECKS)
  // -----------------------------------------------------------------
  static async importFromICal(
    url?: string,
    options: { is_hosted_by_du?: boolean; force?: boolean } = {}
  ): Promise<ImportICalResult> {
    const targetUrl = url || this.getMeetupICalUrl();
    const feed = await this.fetchICal(targetUrl);
    const parsedEvents = parseICalToEvents(feed.data, {
      is_hosted_by_du: options.is_hosted_by_du,
    });

    const items: ImportICalItemResult[] = [];
    let createdCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const incoming of parsedEvents) {
      try {
        const existing = await this.findByUid(incoming.uid);

        if (!existing) {
          // Insert new event
          const created = await this.create(incoming);
          createdCount++;
          items.push({
            uid: incoming.uid,
            title: incoming.title ?? null,
            action: 'created',
            id: created.id,
          });
        } else {
          // Determine whether incoming iCal data has newer updates
          let isNewer = options.force ?? false;

          if (!isNewer) {
            const incomingSeq = incoming.sequence ?? 0;
            const existingSeq = existing.sequence ?? 0;

            // Check sequence number
            if (incomingSeq > existingSeq) {
              isNewer = true;
            } else if (incomingSeq === existingSeq) {
              // Compare LAST-MODIFIED timestamps
              const incomingMod = incoming.ical_last_modified
                ? new Date(incoming.ical_last_modified).getTime()
                : null;
              const existingMod = existing.ical_last_modified
                ? new Date(existing.ical_last_modified).getTime()
                : null;

              if (incomingMod && existingMod) {
                if (incomingMod > existingMod) {
                  isNewer = true;
                }
              } else if (incomingMod && !existingMod) {
                isNewer = true;
              } else {
                // Fallback to DTSTAMP comparison
                const incomingDtstamp = incoming.ical_dtstamp
                  ? new Date(incoming.ical_dtstamp).getTime()
                  : null;
                const existingDtstamp = existing.ical_dtstamp
                  ? new Date(existing.ical_dtstamp).getTime()
                  : null;

                if (incomingDtstamp && existingDtstamp && incomingDtstamp > existingDtstamp) {
                  isNewer = true;
                }
              }
            }
          }

          if (isNewer) {
            const updated = await this.update(existing.id, incoming);
            updatedCount++;
            items.push({
              uid: incoming.uid,
              title: incoming.title ?? null,
              action: 'updated',
              id: updated?.id,
            });
          } else {
            skippedCount++;
            items.push({
              uid: incoming.uid,
              title: incoming.title ?? null,
              action: 'skipped',
              reason: 'Existing event is up-to-date or newer.',
              id: existing.id,
            });
          }
        }
      } catch (err: any) {
        failedCount++;
        console.error(`Failed to import event with UID ${incoming.uid}:`, err);
        items.push({
          uid: incoming.uid,
          title: incoming.title ?? null,
          action: 'error',
          reason: err.message || 'Unknown database error',
        });
      }
    }

    return {
      sourceUrl: targetUrl,
      totalFound: parsedEvents.length,
      created: createdCount,
      updated: updatedCount,
      skipped: skippedCount,
      failed: failedCount,
      items,
    };
  }
}

