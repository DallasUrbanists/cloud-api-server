/**
 * Coordinates, evidence, and cross-sections used by the Streetmix feature.
 * Let's imagine a neighbor choosing a spot on their street and receiving a
 * side-to-side drawing, with notes explaining which dimensions were estimated.
 * @module
 */

/** A geographic position in WGS84, in degrees. */
export interface StreetmixPoint { latitude: number; longitude: number }

/** Validated request with optional explicit carriageway confirmation. */
export interface StreetmixRequest extends StreetmixPoint { osmWayId?: number }

/** A nearby street offered for confirmation before publishing. */
export interface StreetmixCandidate { osmWayId: number; name: string; highway: string; distanceMeters: number; bearingDegrees: number; layer: string; bridge: boolean; tunnel: boolean; osmUrl: string; geometry: StreetmixPoint[][]; snappedCoordinate: StreetmixPoint; oppositeOsmWayId?: number }

/** A selected OSM carriageway; left and right follow its node order. */
export interface StreetmixRoad {
  id: number;
  tags: Record<string, string>;
  geometry: StreetmixPoint[];
  /** Identifies the retrieval API; feature evidence still links to the OSM way. */
  source?: 'overpass' | 'osm-api';
}

/** One independently attributable decision; estimates are never observations. */
export interface StreetmixEvidence {
  field: string;
  value: string | number | boolean;
  basis: 'mapped' | 'derived' | 'estimated';
  source: string;
  retrievedAt: string;
}

/** Streetmix's serialized segment; widths are meters even with imperial display. */
export interface StreetmixSegment {
  type: string; variantString: string; width: number; id: string;
  elevation: number; slope: { on: boolean; values: number[] };
}

/** Published street data is kept separate from our evidence and credentials. */
export interface StreetmixDesign {
  street: {
    schemaVersion: number;
    name: string;
    width: number;
    units: number;
    segments: StreetmixSegment[];
    location: { latlng: { lat: number; lng: number }; label: string; hierarchy: { country: string; locality: string; region: string; street: string } };
    [key: string]: unknown;
  };
  plugins: Record<string, unknown>;
}

/** A confirmed publication receipt, replayable for the same request key. */
export interface StreetmixResult {
  streetmixUrl: string;
  streetmixId: string;
  design: StreetmixDesign;
  selectedStreet: { osmWayId: number; name: string; highway: string; distanceMeters: number; carriagewayOnly: boolean; dallasStreetName?: string };
  snappedCoordinate: StreetmixPoint;
  viewingDirection: { bearingDegrees: number; description: string };
  evidence: StreetmixEvidence[];
  estimates: StreetmixEvidence[];
  warnings: string[];
  generatedAt: string;
  dividedRoad?: { oppositeOsmWayId: number; medianWidthMeters: number; medianWidthBasis: 'mapped' | 'estimated'; centerlineSeparationMeters: number };
  quality?: { mappedCount: number; derivedCount: number; estimatedCount: number; unknownDetails: string[]; summary: string };
  cache?: { hit: boolean; generatedAt: string; expiresAt: string; coordinatePrecision: number };
}

/** A safe public error; provider bodies and credentials must never be messages. */
export class StreetmixError extends Error {
  constructor(public status: number, public code: string, message: string, public retryAfter?: number, public details?: { candidates: StreetmixCandidate[] }) { super(message); }
}

/** Validates coordinates before any storage or provider access. */
export function streetmixPoint(value: unknown): StreetmixPoint {
  const body = value as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => !['latitude', 'longitude'].includes(key))
    || typeof body.latitude !== 'number' || !Number.isFinite(body.latitude) || Math.abs(body.latitude) > 90
    || typeof body.longitude !== 'number' || !Number.isFinite(body.longitude) || Math.abs(body.longitude) > 180) {
    throw new StreetmixError(400, 'INVALID_COORDINATES', 'Supply numeric latitude (-90 to 90) and longitude (-180 to 180).');
  }
  return { latitude: body.latitude, longitude: body.longitude };
}

/** Requires a bounded opaque key; its hash, rather than the key, is persisted. */
export function streetmixKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) {
    throw new StreetmixError(400, 'INVALID_IDEMPOTENCY_KEY', 'Supply an Idempotency-Key containing 16–128 letters, digits, underscores or hyphens.');
  }
  return value;
}

/** Validates the additive street-confirmation option while preserving coordinate validation. */
export function streetmixRequest(value: unknown): StreetmixRequest {
  const body = value as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['latitude', 'longitude', 'osmWayId'].includes(key))) return streetmixPoint(value);
  const point = streetmixPoint({ latitude: body.latitude, longitude: body.longitude });
  if (body.osmWayId !== undefined && (typeof body.osmWayId !== 'number' || !Number.isSafeInteger(body.osmWayId) || body.osmWayId <= 0)) throw new StreetmixError(400, 'INVALID_STREET_SELECTION', 'osmWayId must be a positive safe integer from the offered street candidates.');
  return { ...point, ...(body.osmWayId !== undefined ? { osmWayId: body.osmWayId as number } : {}) };
}
