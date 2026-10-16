import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { pool } from '../config/db.js';
import { BoundaryError, boundaryFromRow, dallasDate, type Boundary, type BoundaryRow, type BoundarySearch, type BoundaryShape } from '../models/boundary.js';

export class AddressGeocodingError extends BoundaryError {
  constructor(message: string, status: 404 | 502 | 503) { super(status, 'ADDRESS_LOOKUP_FAILED', message); }
}
export function normalizeLocation(value: string, kind: 'city' | 'county' | 'state' | 'zip'): string {
  const text = value.trim().toLowerCase();
  if (kind === 'state' && text === 'texas') return 'tx';
  if (kind === 'county') return text.replace(/\s+county$/, '');
  if (kind === 'zip') return text.split('-')[0];
  return text;
}
export function containsPoint(shape: BoundaryShape, latitude: number, longitude: number): boolean {
  const polygons = shape.type === 'Polygon' ? [shape.coordinates] : shape.coordinates;
  const point = [longitude, latitude];
  return polygons.some(([outer, ...holes]) =>
    booleanPointInPolygon(point, { type: 'Polygon', coordinates: [outer] })
    && !holes.some(hole => booleanPointInPolygon(point, { type: 'Polygon', coordinates: [hole] })));
}
export function matchesLocation(boundary: Boundary, search: BoundarySearch): boolean {
  const fields = [['cities', 'city'], ['counties', 'county'], ['states', 'state'], ['zips', 'zip']] as const;
  const spatial = search.latitude !== undefined && search.longitude !== undefined;
  const locationRequested = spatial || fields.some(([, field]) => search[field] !== undefined) || search.address !== undefined;
  if (!locationRequested) return true;
  let hasRule = false;
  for (const [array, field] of fields) {
    const choices = boundary[array];
    if (!choices.length) continue;
    hasRule = true;
    const supplied = search[field];
    if (supplied === undefined) {
      if (boundary.shape === null && !boundary.shapePending) return false;
    } else if (!choices.some(choice => normalizeLocation(choice, field) === normalizeLocation(supplied, field))) {
      return false;
    }
  }
  if (boundary.shapePending) return false;
  if (boundary.shape === null) return hasRule;
  return !spatial || containsPoint(boundary.shape, search.latitude!, search.longitude!);
}
export function boundaryConditions(search: BoundarySearch, alias = 'b', values: unknown[] = []): string[] {
  const conditions: string[] = [];
  const param = (value: unknown) => { values.push(value); return `$${values.length}`; };
  for (const [field, column] of [['entity', 'entity_name'], ['body', 'body_name'], ['district', 'district_name']] as const) {
    if (search[field] !== undefined) conditions.push(`lower(${alias}.${column}) = lower(${param(search[field])})`);
  }
  for (const [field, column] of [['city', 'cities'], ['county', 'counties'], ['state', 'states'], ['zip', 'zips']] as const) {
    if (search[field] === undefined) continue;
    const normalized = param(normalizeLocation(search[field]!, field));
    const element = field === 'county' ? "regexp_replace(lower(btrim(candidate)), '\\s+county$', '')"
      : field === 'state' ? "CASE WHEN lower(btrim(candidate)) = 'texas' THEN 'tx' ELSE lower(btrim(candidate)) END"
        : field === 'zip' ? "split_part(lower(btrim(candidate)), '-', 1)" : 'lower(btrim(candidate))';
    conditions.push(`(cardinality(${alias}.${column}) = 0 OR EXISTS (SELECT 1 FROM unnest(${alias}.${column}) AS candidate WHERE ${element} = ${normalized}))`);
  }
  if (search.latitude !== undefined && search.longitude !== undefined) {
    const lon = param(search.longitude);
    const lat = param(search.latitude);
    conditions.push(`(${alias}.shape IS NULL OR ${alias}.shape_box @> point(${lon}::float8, ${lat}::float8))`);
  }
  const asOf = `${param(search.asOf ?? dallasDate())}::date`;
  conditions.push(`(${alias}.effective_date IS NULL OR ${alias}.effective_date <= ${asOf})`);
  conditions.push(`(${alias}.expiration_date IS NULL OR ${alias}.expiration_date > ${asOf})`);
  return conditions;
}
export class BoundaryService {
  static async getRow(id: number): Promise<BoundaryRow> {
    const { rows } = await pool.query<BoundaryRow>('SELECT b.*, b.effective_date::text AS effective_date, b.expiration_date::text AS expiration_date FROM boundaries b WHERE b.id = $1', [id]);
    if (!rows[0]) throw new BoundaryError(404, 'NOT_FOUND', 'Boundary not found.');
    return rows[0];
  }
  static async findById(id: number): Promise<Boundary> { return boundaryFromRow(await this.getRow(id)); }
  static async findAll(search: BoundarySearch): Promise<Boundary[]> {
    const values: unknown[] = [];
    const conditions = boundaryConditions(search, 'b', values);
    const { rows } = await pool.query<BoundaryRow>(`SELECT b.*, b.effective_date::text AS effective_date, b.expiration_date::text AS expiration_date FROM boundaries b WHERE ${conditions.join(' AND ')} ORDER BY b.id`, values);
    return rows.map(row => boundaryFromRow(row)).filter(row => matchesLocation(row, search))
      .slice(search.offset ?? 0, (search.offset ?? 0) + (search.limit ?? 100));
  }
  static async geocodeAddress(address: string): Promise<BoundarySearch & { latitude: number; longitude: number }> {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) throw new AddressGeocodingError('Address search is not configured on this server.', 503);
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('address', address);
    url.searchParams.set('key', apiKey);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new AddressGeocodingError('The address lookup service is unavailable.', 502);
      const result = await response.json() as { status?: string; results?: Array<{
        geometry?: { location?: { lat?: number; lng?: number } };
        address_components?: Array<{ long_name: string; short_name: string; types: string[] }>;
      }> };
      if (result.status === 'ZERO_RESULTS') throw new AddressGeocodingError('The address could not be located.', 404);
      const first = result.results?.[0];
      const location = first?.geometry?.location;
      if (result.status !== 'OK' || !Number.isFinite(location?.lat) || !Number.isFinite(location?.lng)) {
        throw new AddressGeocodingError('The address lookup service could not process this request.', 502);
      }
      const component = (type: string, short = false) => {
        const match = first?.address_components?.find(item => item.types.includes(type));
        return short ? match?.short_name : match?.long_name;
      };
      return { latitude: location!.lat!, longitude: location!.lng!, city: component('locality'),
        county: component('administrative_area_level_2'), state: component('administrative_area_level_1', true), zip: component('postal_code') };
    } catch (error) {
      if (error instanceof AddressGeocodingError) throw error;
      throw new AddressGeocodingError('The address lookup service is unavailable.', 502);
    }
  }
}
