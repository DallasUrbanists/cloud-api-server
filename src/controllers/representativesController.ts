import { NextFunction, Request, Response } from 'express';
import { AddressGeocodingError, RepresentativesService } from '../services/representativesService.js';
import { RepresentativeSearch } from '../models/representative.js';

class QueryValidationError extends Error {}

function queryString(req: Request, name: string): string | undefined {
  const value = req.query[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new QueryValidationError(`Query parameter '${name}' must be a non-empty string.`);
  }
  return value.trim();
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function coordinate(value: string, name: 'lat' | 'lon', minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new QueryValidationError(`Query parameter '${name}' must be a number between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

export class RepresentativesController {
  static async list(req: Request, res: Response, _next: NextFunction): Promise<void> {
    await RepresentativesController.search(req, res, false);
  }

  static async listDallasCityCouncil(req: Request, res: Response, _next: NextFunction): Promise<void> {
    await RepresentativesController.search(req, res, true);
  }

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

      const lat = queryString(req, 'lat');
      const lon = queryString(req, 'lon');
      let latitude: number | undefined;
      let longitude: number | undefined;
      if (lat !== undefined && lon !== undefined) {
        latitude = coordinate(lat, 'lat', -90, 90);
        longitude = coordinate(lon, 'lon', -180, 180);
      }

      const search: RepresentativeSearch = {
        entity: dallasCityCouncil ? 'City of Dallas' : queryString(req, 'entity'),
        body: dallasCityCouncil ? 'City Council' : queryString(req, 'body'),
        title: dallasCityCouncil ? 'Council member' : queryString(req, 'title'),
        district: queryString(req, 'district'),
        servingAsOf,
        electionAsOf,
        latitude,
        longitude,
      };

      const address = latitude !== undefined && longitude !== undefined ? undefined : queryString(req, 'address');
      if (address !== undefined) {
        const location = await RepresentativesService.geocodeAddress(address);
        search.latitude = location.latitude;
        search.longitude = location.longitude;
      }

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

      console.error('Error searching representatives:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'An unexpected error occurred while searching representatives.',
      });
    }
  }
}
