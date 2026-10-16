export interface PolygonShape {
  type: 'Polygon';
  coordinates: number[][][];
}
export interface MultiPolygonShape {
  type: 'MultiPolygon';
  coordinates: number[][][][];
}
export type BoundaryShape = PolygonShape | MultiPolygonShape;
export interface ServiceDescriptor {
  file: string;
  function: string;
  params: Record<string, unknown>;
}
export interface Boundary {
  id: number;
  entityName: string;
  bodyName: string | null;
  districtName: string | null;
  shape: BoundaryShape | null;
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
export class BoundaryError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}
export function dallasDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const value = (type: string) => parts.find(part => part.type === type)!.value;
  return `${value('year').padStart(4, '0')}-${value('month')}-${value('day')}`;
}
export function dateString(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  return value instanceof Date
    ? `${String(value.getFullYear()).padStart(4, '0')}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
    : value.slice(0, 10);
}
export function timestampString(value: string | Date | null | undefined): string | null {
  return value == null ? null : new Date(value).toISOString();
}
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
