/**
 * Shared walk-audit shapes and safe domain errors.
 *
 * A neighborhood group can map streets, save private notes, and later publish
 * observations and a report about the places they visited.
 * @module
 */

/** Longitude and latitude, in WGS84 order. */
export type Position = [number, number];
export type AuditType = 'intersection' | 'street-segment' | 'point';
export interface AreaFeature {
  type: 'Feature';
  properties: Record<string, unknown>;
  geometry: { type: 'Polygon'; coordinates: [Position[]] };
}
export interface NetworkFeature {
  type: 'Feature';
  properties: { id: string; name: string | null; highway?: string; fromNodeKey?: string; toNodeKey?: string };
  geometry: { type: 'Point'; coordinates: Position } | { type: 'LineString'; coordinates: Position[] };
}
export interface FeatureCollection { type: 'FeatureCollection'; features: NetworkFeature[] }
export interface Prompt {
  id: string;
  type: 'choice' | 'text';
  label: string;
  required: boolean;
  options?: string[];
  maxLength?: number;
}
export interface GeneratedStudy {
  area: AreaFeature;
  locationGps: { longitude: number; latitude: number };
  locationDescription: string;
  intersections: FeatureCollection;
  segments: FeatureCollection;
  thumbnailPng: Buffer;
  sourceMetadata: { provider: string; attribution: string; fetchedAt: string; endpoint: string };
}

/** An expected domain failure whose message is safe to return to a client. */
export class WalkAuditError extends Error {
  constructor(public status: number, public code: string, message: string, public retryAfter?: number) {
    super(message);
    this.name = 'WalkAuditError';
  }
}
