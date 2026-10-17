/**
 * PostgreSQL boundary lookup, exact spatial membership, and optional address geocoding.
 *
 * @remarks
 * SQL shortlists candidates; JavaScript applies exact membership before pagination.
 * Refresh scheduling belongs to BoundarySyncService, not these read operations.
 * @module
 */
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import { pool } from '../config/db.js';
import { BoundaryError, boundaryFromRow, dallasDate, type Boundary, type BoundaryRow, type BoundarySearch, type BoundaryShape } from '../models/boundary.js';

/** Expected address-provider failure, distinct from an empty boundary result. */
export class AddressGeocodingError extends BoundaryError {
  /** Attaches the shared address-lookup code to a public failure message. */
  constructor(message: string, status: 404 | 502 | 503) { super(status, 'ADDRESS_LOOKUP_FAILED', message); }
}
/** Normalizes administrative names for comparisons, including Texas, county suffixes, and ZIP+4. */
export function normalizeLocation(value: string, kind: 'city' | 'county' | 'state' | 'zip'): string {
  const text = value.trim().toLowerCase();
  if (kind === 'state' && text === 'texas') return 'tx';
  if (kind === 'county') return text.replace(/\s+county$/, '');
  if (kind === 'zip') return text.split('-')[0];
  return text;
}
/**
 * Tests a location against polygon pieces, counting outer edges but excluding holes and their edges.
 * @remarks GeoJSON coordinates are longitude first, while arguments are latitude first.
 * @example
 * Let's imagine a district drawn around a neighborhood with a small area cut out.
 * This checks whether a house is in the district, like placing a pin on that map.
 */
export function containsPoint(shape: BoundaryShape, latitude: number, longitude: number): boolean {
  const polygons = shape.type === 'Polygon' ? [shape.coordinates] : shape.coordinates;
  const point = [longitude, latitude];
  return polygons.some(([outer, ...holes]) =>
    booleanPointInPolygon(point, { type: 'Polygon', coordinates: [outer] })
    && !holes.some(hole => booleanPointInPolygon(point, { type: 'Polygon', coordinates: [hole] })));
}
/**
 * Applies administrative and exact spatial membership after the SQL shortlist.
 * @remarks
 * Pending shapes cannot establish location membership. Intentionally null shapes
 * need populated administrative rules and every populated field supplied/matched.
 * A metadata-only lookup with no location request bypasses membership testing.
 * @example
 * Let's imagine a neighborhood group serves all of Uptown. This helps check whether
 * a resident's location belongs to the area that group looks after.
 */
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
/**
 * Builds parameterized SQL predicates for metadata, bounding boxes, and effective dates.
 * @remarks
 * Appends to the caller's values array so joined representative queries can add more
 * parameters. Alias is trusted internal SQL, not a user field. Geometry needs a later exact test.
 */
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
/** Reads jurisdiction records and delegates address-to-location lookup to Google Maps. */
export class BoundaryService {
  /** Reads storage metadata even outside the effective window; throws NOT_FOUND if absent. */
  static async getRow(id: number): Promise<BoundaryRow> {
    const { rows } = await pool.query<BoundaryRow>('SELECT b.*, b.effective_date::text AS effective_date, b.expiration_date::text AS expiration_date FROM boundaries b WHERE b.id = $1', [id]);
    if (!rows[0]) throw new BoundaryError(404, 'NOT_FOUND', 'Boundary not found.');
    return rows[0];
  }
  /** Returns a public model including its derived current validity, without excluding historical records. */
  static async findById(id: number): Promise<Boundary> { return boundaryFromRow(await this.getRow(id)); }
  /**
   * Searches effective records, applies exact membership, then slices the ordered result.
   * @remarks Database/geocoding input preparation is separate; this does not resolve addresses itself.
   * @example
   * Let's imagine looking for all the public districts around your home. This gathers
   * the matching areas so you can see which groups serve your neighborhood.
   */
  static async findAll(search: BoundarySearch): Promise<Boundary[]> {
    const values: unknown[] = [];
    const conditions = boundaryConditions(search, 'b', values);
    const { rows } = await pool.query<BoundaryRow>(`SELECT b.*, b.effective_date::text AS effective_date, b.expiration_date::text AS expiration_date FROM boundaries b WHERE ${conditions.join(' AND ')} ORDER BY b.id`, values);
    return rows.map(row => boundaryFromRow(row)).filter(row => matchesLocation(row, search))
      .slice(search.offset ?? 0, (search.offset ?? 0) + (search.limit ?? 100));
  }
  /**
   * Resolves the first Google Maps result into coordinates and administrative hints.
   * @throws AddressGeocodingError for missing configuration, no result, or provider failure.
   * @example
   * Let's imagine typing a street address instead of finding your home on a map.
   * This turns the address into a place the boundary search can look up.
   */
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
