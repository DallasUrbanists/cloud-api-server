/**
 * Jurisdiction shapes, administrative membership, calendar dates, and refresh metadata.
 *
 * Let's imagine a map showing which neighborhoods belong to a council district.
 * A boundary describes that area, so someone can find the people responsible for it.
 * Some areas are described by place names instead of a line drawn on the map.
 *
 * @remarks
 * Pure conversion helpers do not fetch geometry or research. Calendar validity uses
 * Dallas dates with inclusive starts and exclusive expirations; sync TTLs are days.
 * @module
 */

/** A GeoJSON polygon with a closed outer ring and optional interior holes. Positions are longitude, latitude. */
export interface PolygonShape {
  type: 'Polygon';
  coordinates: number[][][];
}
/** A jurisdiction made of multiple polygon pieces, each with its own possible holes. */
export interface MultiPolygonShape {
  type: 'MultiPolygon';
  coordinates: number[][][][];
}
/** Supported WGS84 geometry; validation at persistence/adapter boundaries is separate. */
export type BoundaryShape = PolygonShape | MultiPolygonShape;
/** Names an allowlisted refresh adapter and its configuration, not an arbitrary module to import. */
export interface ServiceDescriptor {
  file: string;
  function: string;
  params: Record<string, unknown>;
}
/**
 * Public jurisdiction information with geometry or administrative membership rules.
 *
 * Let's imagine looking up a school district to learn which neighborhoods it serves
 * and when its current map takes effect. This record brings those facts together.
 */
export interface Boundary {
  id: number;
  entityName: string;
  bodyName: string | null;
  districtName: string | null;
  shape: BoundaryShape | null;
  /** True means geometry is unknown; null geometry must not be treated as an address-only rule yet. */
  shapePending: boolean;
  cities: string[];
  counties: string[];
  zips: string[];
  states: string[];
  description: string;
  whenToContact: string;
  shapeService: ServiceDescriptor | null;
  researchService: ServiceDescriptor | null;
  effectiveDate: string | null;
  expirationDate: string | null;
  lastShapeSync: string | null;
  lastResearchSync: string | null;
  shapeSyncTTL: number;
  researchSyncTTL: number;
  isInEffect: boolean;
}
/** Service-level filters after HTTP parsing; supplied fields are combined rather than alternatives. */
export interface BoundarySearch {
  entity?: string;
  body?: string;
  district?: string;
  latitude?: number;
  longitude?: number;
  address?: string;
  city?: string;
  county?: string;
  state?: string;
  zip?: string;
  asOf?: string;
  limit?: number;
  offset?: number;
}
/** PostgreSQL storage shape, including internal success clocks and retry backoff omitted from public conversion. */
export interface BoundaryRow {
  id: number;
  entity_name: string;
  body_name: string | null;
  district_name: string | null;
  shape: BoundaryShape | null;
  shape_pending: boolean;
  cities: string[];
  counties: string[];
  zips: string[];
  states: string[];
  description: string;
  when_to_contact: string;
  shape_service: ServiceDescriptor | null;
  research_service: ServiceDescriptor | null;
  effective_date: string | Date | null;
  expiration_date: string | Date | null;
  last_shape_sync: string | Date | null;
  last_research_sync: string | Date | null;
  last_shape_success: string | Date | null;
  last_research_success: string | Date | null;
  shape_sync_ttl: number;
  research_sync_ttl: number;
  shape_retry_after: string | Date | null;
  research_retry_after: string | Date | null;
  source_key: string | null;
}
/** Expected boundary/synchronization failure carrying a public code and response status. */
export class BoundaryError extends Error {
  /** Preserves a deliberate public message; callers must not supply internal diagnostics. */
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}
/**
 * Computes the Dallas calendar date independently of the server's local timezone.
 * @example
 * Let's imagine a server far away has already reached tomorrow. The map still uses
 * the day people in Dallas are experiencing when deciding which boundaries apply.
 */
export function dallasDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const value = (type: string) => parts.find(part => part.type === type)!.value;
  return `${value('year').padStart(4, '0')}-${value('month')}-${value('day')}`;
}
/** Preserves a stored calendar day rather than converting it through UTC; nullish input stays null. */
export function dateString(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  return value instanceof Date
    ? `${String(value.getFullYear()).padStart(4, '0')}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
    : value.slice(0, 10);
}
/** Converts an instant to UTC ISO text; nullish input stays null and invalid dates can throw. */
export function timestampString(value: string | Date | null | undefined): string | null {
  return value == null ? null : new Date(value).toISOString();
}
/**
 * Projects a database row and derives whether its calendar window contains today.
 * @remarks
 * The supplied today controls only isInEffect, not query filtering or timestamps.
 * This maps trusted stored data; it is not a geometry or service-descriptor validator.
 */
export function boundaryFromRow(row: BoundaryRow, today = dallasDate()): Boundary {
  const effectiveDate = dateString(row.effective_date);
  const expirationDate = dateString(row.expiration_date);
  return {
    id: row.id, entityName: row.entity_name, bodyName: row.body_name,
    districtName: row.district_name, shape: row.shape, shapePending: row.shape_pending,
    cities: row.cities, counties: row.counties, zips: row.zips, states: row.states,
    description: row.description, whenToContact: row.when_to_contact,
    shapeService: row.shape_service, researchService: row.research_service,
    effectiveDate, expirationDate,
    lastShapeSync: timestampString(row.last_shape_sync),
    lastResearchSync: timestampString(row.last_research_sync),
    shapeSyncTTL: row.shape_sync_ttl, researchSyncTTL: row.research_sync_ttl,
    isInEffect: (effectiveDate === null || effectiveDate <= today)
      && (expirationDate === null || today < expirationDate),
  };
}
