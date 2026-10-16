import type { Request } from 'express';
import { BoundaryError, type BoundarySearch } from '../models/boundary.js';
import { BoundaryService } from '../services/boundaryService.js';

export function queryText(req: Request, name: string): string | undefined {
  const value = req.query[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > 1000) {
    throw new BoundaryError(400, 'INVALID_QUERY', `Query parameter '${name}' must be a non-empty string of at most 1000 characters.`);
  }
  return value.trim();
}
export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function positiveId(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 2147483647) {
    throw new BoundaryError(400, 'INVALID_ID', 'ID must be a positive PostgreSQL integer.');
  }
  return Number(value);
}
export async function parseBoundarySearch(req: Request, fixed: Partial<BoundarySearch> = {}): Promise<BoundarySearch> {
  const search: BoundarySearch = {};
  for (const field of ['entity', 'body', 'district', 'city', 'county', 'state', 'zip', 'asOf'] as const) search[field] = fixed[field] ?? queryText(req, field);
  if (search.asOf !== undefined && !validDate(search.asOf)) throw new BoundaryError(400, 'INVALID_QUERY', 'asOf must be a valid YYYY-MM-DD date.');
  const lat = queryText(req, 'lat');
  const lon = queryText(req, 'lon');
  if ((lat === undefined) !== (lon === undefined)) throw new BoundaryError(400, 'INVALID_QUERY', 'Supply lat and lon together.');
  if (lat !== undefined && lon !== undefined) {
    search.latitude = Number(lat);
    search.longitude = Number(lon);
    if (!Number.isFinite(search.latitude) || Math.abs(search.latitude) > 90 || !Number.isFinite(search.longitude) || Math.abs(search.longitude) > 180) {
      throw new BoundaryError(400, 'INVALID_QUERY', 'Invalid latitude or longitude.');
    }
  } else {
    search.address = queryText(req, 'address');
    if (search.address) {
      const location = await BoundaryService.geocodeAddress([search.address, search.city, search.state, search.zip].filter(Boolean).join(', '));
      for (const field of ['city', 'county', 'state', 'zip'] as const) search[field] ??= location[field];
      search.latitude = location.latitude;
      search.longitude = location.longitude;
    }
  }
  for (const [field, fallback, minimum, maximum] of [['limit', 100, 1, 500], ['offset', 0, 0, 100000]] as const) {
    const raw = queryText(req, field);
    const number = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new BoundaryError(400, 'INVALID_QUERY', `${field} must be an integer between ${minimum} and ${maximum}.`);
    search[field] = number;
  }
  return search;
}
