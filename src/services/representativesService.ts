/**
 * PostgreSQL representative searches joined to shared boundary geography.
 *
 * @remarks
 * Reuses boundary normalization and exact location checks before pagination.
 * Current/historical tenure filtering belongs here; research publication belongs to sync.
 * @module
 */
import { pool } from '../config/db.js';
import { BoundaryError, boundaryFromRow, timestampString } from '../models/boundary.js';
import { AddressGeocodingError, BoundaryService, boundaryConditions, matchesLocation } from './boundaryService.js';
export { AddressGeocodingError };

import { Representative, RepresentativeResponse, RepresentativeSearch } from '../models/representative.js';

/** Projects a joined row into the public directory shape, retaining contacts/elections and UTC timestamps. */
export function representativeFromRow(row: Record<string, any>): Representative {
  return {
    id: row.id, boundaryId: row.boundary_id, boundary: boundaryFromRow(row.boundary),
    researchService: row.research_service, lastResearchSync: timestampString(row.last_research_sync),
    researchSyncTTL: row.research_sync_ttl,
    title: row.title, name: row.name, bio: row.bio, webpage_url: row.webpage_url,
    photo_url: row.photo_url, emails: row.emails, phones: row.phones,
    social_accounts: row.social_accounts, elections: row.elections,
    start: timestampString(row.start), end: timestampString(row.end),
  };
}

/** Reads representatives without performing refreshes or applying user authorization. */
export class RepresentativesService {
  /**
   * Combines office/term/election predicates with boundary membership and then paginates.
   * @remarks
   * Tenure end and election-day comparisons are inclusive, unlike boundary expiration.
   * Without servingAsOf, tenure uses the database's current timestamp. Nested boundary
   * isInEffect describes today even when the search asks for a historical serving date.
   * @example
   * Let's imagine finding the council member for your neighborhood, or checking who
   * represented it last year. This gathers the matching contact cards.
   */
  static async findAll(search: RepresentativeSearch): Promise<RepresentativeResponse[]> {
    const values: unknown[] = [];
    const conditions = boundaryConditions({ ...search, asOf: search.servingAsOf ?? search.asOf }, 'b', values);
    const addParameter = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };

    if (search.title !== undefined) conditions.push(`lower(r.title) = lower(${addParameter(search.title)})`);
    if (search.boundaryId !== undefined) conditions.push(`r.boundary_id = ${addParameter(search.boundaryId)}`);

    if (search.servingAsOf === undefined) {
      conditions.push('("start" IS NULL OR "start" <= CURRENT_TIMESTAMP)');
      conditions.push('("end" IS NULL OR "end" >= CURRENT_TIMESTAMP)');
    } else {
      const servingDate = `${addParameter(search.servingAsOf)}::date`;
      conditions.push(`("start" IS NULL OR "start"::date <= ${servingDate})`);
      conditions.push(`("end" IS NULL OR "end"::date >= ${servingDate})`);
    }

    if (search.electionAsOf !== undefined) {
      const electionAsOf = addParameter(search.electionAsOf);
      conditions.push(`EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(elections, '[]'::jsonb)) AS election
        WHERE ${electionAsOf}::date >= (election ->> 'early_vote_start')::date
          AND ${electionAsOf}::date <= (election ->> 'date')::date
      )`);
    }

    const { rows } = await pool.query(
      `SELECT r.*, row_to_json(b) AS boundary FROM representatives r
       JOIN boundaries b ON b.id = r.boundary_id WHERE ${conditions.join(' AND ')} ORDER BY r.id`, values,
    );
    return rows.map(representativeFromRow).filter(row => matchesLocation(row.boundary, search))
      .slice(search.offset ?? 0, (search.offset ?? 0) + (search.limit ?? 100));
  }

  /** Shares the boundary address resolver so directory and map searches use the same location hints. */
  static geocodeAddress(address: string) { return BoundaryService.geocodeAddress(address); }

  /** Fetches a joined record without tenure filtering; absent records throw an expected NOT_FOUND error. */
  static async findById(id: number): Promise<Representative> {
    const { rows } = await pool.query(
      'SELECT r.*, row_to_json(b) AS boundary FROM representatives r JOIN boundaries b ON b.id = r.boundary_id WHERE r.id = $1', [id],
    );
    if (!rows[0]) throw new BoundaryError(404, 'NOT_FOUND', 'Representative not found.');
    return representativeFromRow(rows[0]);
  }
}
