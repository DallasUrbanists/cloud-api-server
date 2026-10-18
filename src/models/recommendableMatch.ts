import type { RecommendableAction } from './recommendableAction.js';
import type { Representative } from './representative.js';

export interface MatchInput { text: string; latitude?: number; longitude?: number }
export interface MatchResult {
  data: Array<RecommendableAction & { matchProbability: number }>;
  /** All geographically eligible actions, including scores below the threshold. */
  eligibleActions: Array<RecommendableAction & { matchProbability: number }>;
  count: number;
  diagnostics: {
    catalogCount: number; eligibleCount: number; threshold: number;
    boundaries: Array<{ id: number; name: string; representatives?: Array<Pick<Representative, 'id' | 'name' | 'title' | 'phones' | 'emails'>> }>;
  };
}

/** Validate a standalone matching request without requiring a persisted suggestion. */
export function validateMatchInput(body: unknown): { data?: MatchInput; error?: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Send a JSON object.' };
  const { text, latitude, longitude } = body as Record<string, unknown>;
  if (typeof text !== 'string' || !text.trim() || text.length > 10000) return { error: 'text must be nonblank and at most 10,000 characters.' };
  if ((latitude === undefined) !== (longitude === undefined)) return { error: 'Supply both latitude and longitude, or omit both.' };
  if (latitude !== undefined && (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180)) return { error: 'Coordinates must be finite numbers: latitude -90 to 90, longitude -180 to 180.' };
  return { data: { text, ...(latitude !== undefined ? { latitude: latitude as number, longitude: longitude as number } : {}) } };
}
