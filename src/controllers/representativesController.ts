/**
 * Public directory and Dallas Council shortcut orchestration with shared geography parsing.
 * Expected validation/provider failures are translated locally; OpenAPI owns HTTP contracts.
 * @module
 */
import { NextFunction, Request, Response } from 'express';
import { AddressGeocodingError, RepresentativesService } from '../services/representativesService.js';
import { RepresentativeSearch } from '../models/representative.js';
import { BoundaryError } from '../models/boundary.js';
import { parseBoundarySearch, positiveId } from '../utils/boundaryQuery.js';

class QueryValidationError extends Error {}

/** Distinguishes omitted filters from non-scalar or blank supplied query values. */
function queryString(req: Request, name: string): string | undefined {
  const value = req.query[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new QueryValidationError(`Query parameter '${name}' must be a non-empty string.`);
  }
  return value.trim();
}

/** Round-trips a positive-year ISO calendar date so impossible dates do not reach SQL casts. */
function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Adapts public HTTP queries to directory searches without changing stored records. */
export class RepresentativesController {
  /** Searches with caller-selected office and geographic filters. */
  static async list(req: Request, res: Response, _next: NextFunction): Promise<void> {
    await RepresentativesController.search(req, res, false);
  }

  /** Uses fixed City of Dallas/City Council/Council member filters, excluding the mayor. */
  static async listDallasCityCouncil(req: Request, res: Response, _next: NextFunction): Promise<void> {
    await RepresentativesController.search(req, res, true);
  }

  /** Validates date/identifier filters, resolves optional addresses, and maps safe error responses. */
  private static async search(req: Request, res: Response, dallasCityCouncil: boolean): Promise<void> {
    try {
      const servingAsOf = queryString(req, 'servingAsOf');
      const electionAsOf = queryString(req, 'electionAsOf');
      if (servingAsOf !== undefined && !isDate(servingAsOf)) {
        throw new QueryValidationError("Query parameter 'servingAsOf' must be a valid YYYY-MM-DD date.");
      }
      if (electionAsOf !== undefined && !isDate(electionAsOf)) {
        throw new QueryValidationError("Query parameter 'electionAsOf' must be a valid YYYY-MM-DD date.");
      }

      const search: RepresentativeSearch = {
        ...await parseBoundarySearch(req, dallasCityCouncil ? { entity: 'City of Dallas', body: 'City Council' } : {}),
        entity: dallasCityCouncil ? 'City of Dallas' : queryString(req, 'entity'),
        body: dallasCityCouncil ? 'City Council' : queryString(req, 'body'),
        title: dallasCityCouncil ? 'Council member' : queryString(req, 'title'),
        district: queryString(req, 'district'),
        servingAsOf,
        electionAsOf,
        boundaryId: req.query.boundaryId === undefined ? undefined : positiveId(req.query.boundaryId),
      };

      res.status(200).json(await RepresentativesService.findAll(search));
    } catch (error) {
      if (error instanceof QueryValidationError) {
        res.status(400).json({ error: 'Bad Request', message: error.message });
        return;
      }
      if (error instanceof AddressGeocodingError) {
        if (error.status >= 500) console.error('Representative address geocoding failed:', error.message);
        res.status(error.status).json({ error: error.status === 404 ? 'Not Found' : 'Address Lookup Failed', message: error.message });
        return;
      }

      if (error instanceof BoundaryError) {
        res.status(error.status).json({ error: error.code, message: error.message });
        return;
      }
      console.error('Error searching representatives:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'An unexpected error occurred while searching representatives.',
      });
    }
  }
}
