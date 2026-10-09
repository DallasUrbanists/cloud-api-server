import { pool } from '../config/db.js';
import { Representative, RepresentativeResponse, RepresentativeSearch } from '../models/representative.js';

const GEOCODING_TIMEOUT_MS = 10_000;

export class AddressGeocodingError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 502 | 503,
  ) {
    super(message);
    this.name = 'AddressGeocodingError';
  }
}

interface GeoJsonPolygon {
  type: 'Polygon';
  coordinates: number[][][];
}

function isPolygon(value: unknown): value is GeoJsonPolygon {
  if (!value || typeof value !== 'object') return false;
  const polygon = value as { type?: unknown; coordinates?: unknown };
  return polygon.type === 'Polygon' && Array.isArray(polygon.coordinates)
    && polygon.coordinates.every((ring) => Array.isArray(ring));
}

function pointOnSegment(
  longitude: number,
  latitude: number,
  start: number[],
  end: number[],
): boolean {
  const cross = (longitude - start[0]) * (end[1] - start[1])
    - (latitude - start[1]) * (end[0] - start[0]);
  if (Math.abs(cross) > 1e-10) return false;
  return longitude >= Math.min(start[0], end[0]) - 1e-10
    && longitude <= Math.max(start[0], end[0]) + 1e-10
    && latitude >= Math.min(start[1], end[1]) - 1e-10
    && latitude <= Math.max(start[1], end[1]) + 1e-10;
}

function pointInRing(longitude: number, latitude: number, ring: number[][]): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const start = ring[previous];
    const end = ring[index];
    if (pointOnSegment(longitude, latitude, start, end)) return true;

    const crossesLatitude = (start[1] > latitude) !== (end[1] > latitude);
    if (crossesLatitude
      && longitude < ((end[0] - start[0]) * (latitude - start[1])) / (end[1] - start[1]) + start[0]) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInPolygon(longitude: number, latitude: number, value: unknown): boolean {
  if (!isPolygon(value) || value.coordinates.length === 0) return false;
  const [outerRing, ...holes] = value.coordinates;
  if (!pointInRing(longitude, latitude, outerRing)) return false;
  return !holes.some((hole) => pointInRing(longitude, latitude, hole));
}

export class RepresentativesService {
  static async findAll(search: RepresentativeSearch): Promise<RepresentativeResponse[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    const addParameter = (value: unknown): string => {
      values.push(value);
      return `$${values.length}`;
    };

    for (const field of ['entity', 'body', 'title', 'district'] as const) {
      const value = search[field];
      if (value !== undefined) {
        conditions.push(`LOWER(${field}) = LOWER(${addParameter(value)})`);
      }
    }

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

    const { rows } = await pool.query<Representative>(
      `SELECT * FROM representatives WHERE ${conditions.join(' AND ')} ORDER BY id`,
      values,
    );

    const matches = search.latitude === undefined || search.longitude === undefined
      ? rows
      : rows.filter((representative) =>
        pointInPolygon(search.longitude!, search.latitude!, representative.district_bounds));
    return matches.map(({ district_bounds: _districtBounds, ...representative }) => representative);
  }

  static async geocodeAddress(address: string): Promise<{ latitude: number; longitude: number }> {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      throw new AddressGeocodingError('Address search is not configured on this server.', 503);
    }

    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('address', address);
    url.searchParams.set('key', apiKey);

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(GEOCODING_TIMEOUT_MS) });
      if (!response.ok) {
        throw new AddressGeocodingError('The address lookup service is unavailable.', 502);
      }

      const result = await response.json() as {
        status?: string;
        results?: Array<{ geometry?: { location?: { lat?: number; lng?: number } } }>;
      };
      if (result.status === 'ZERO_RESULTS') {
        throw new AddressGeocodingError('The address could not be located.', 404);
      }

      const location = result.results?.[0]?.geometry?.location;
      if (result.status !== 'OK' || typeof location?.lat !== 'number' || typeof location.lng !== 'number') {
        throw new AddressGeocodingError('The address lookup service could not process this request.', 502);
      }

      return { latitude: location.lat, longitude: location.lng };
    } catch (error) {
      if (error instanceof AddressGeocodingError) throw error;
      throw new AddressGeocodingError('The address lookup service is unavailable.', 502);
    }
  }
}
