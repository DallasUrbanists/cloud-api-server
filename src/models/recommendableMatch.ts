import type { RecommendableAction } from './recommendableAction.js';
import type { Representative } from './representative.js';

export interface MatchInput { text: string; latitude?: number; longitude?: number; bypassJevCache?: boolean }
export interface ComparisonPair {
  actionIds: [string, string]; probability: number | null; cacheHit: boolean;
  decision: 'keep_both' | 'remove_lower' | 'keep_on_failure'; removedActionId?: string;
  failureCode?: 'timeout' | 'network' | 'http' | 'malformed_response' | 'invalid_answer';
}
export interface ComparisonDiagnostics {
  policyVersion: string; question: string; candidateMinimumProbability: number; removalThreshold: number;
  durationMs: number; candidateCount: number; pairCount: number; cacheHits: number;
  networkRequestCount: number; failures: number; removedActionCount: number;
  actions: Array<Pick<RecommendableAction, 'id' | 'summary' | 'instructions' | 'why' | 'whyNot'> & { matchProbability: number }>;
  pairs: ComparisonPair[];
}
/** Shared cache identity; original text is still sent to JEV on a miss. */
export const matchCacheContext = (input: MatchInput) => [
  input.text.toUpperCase().replace(/[^A-Z0-9]/g, ''),
  input.latitude === undefined ? null : Number(input.latitude.toFixed(4)),
  input.longitude === undefined ? null : Number(input.longitude.toFixed(4)),
];
export interface MatchResult {
  data: Array<RecommendableAction & { matchProbability: number }>;
  /** Geographically eligible actions after redundancy filtering, including scores below the threshold. */
  eligibleActions: Array<RecommendableAction & { matchProbability: number }>;
  count: number;
  diagnostics: {
    catalogCount: number; eligibleCount: number;
    /** Selected inclusive bucket floor: 0.8, 0.15, or 0.04 (also used for empty results). */
    threshold: number;
    model: string; bypassJevCache: boolean; totalDurationMs: number;
    relevance: { durationMs: number; cacheHit: boolean; networkRequestCount: number };
    comparisons: ComparisonDiagnostics;
    boundaries: Array<{ id: number; name: string; representatives?: Array<Pick<Representative, 'id' | 'name' | 'title' | 'phones' | 'emails'>> }>;
  };
}

/** Validate a standalone matching request without requiring a persisted suggestion. */
export function validateMatchInput(body: unknown): { data?: MatchInput; error?: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Send a JSON object.' };
  const { text, latitude, longitude, bypassJevCache } = body as Record<string, unknown>;
  if (bypassJevCache !== undefined && typeof bypassJevCache !== 'boolean') return { error: 'bypassJevCache must be a boolean.' };
  if (typeof text !== 'string' || !text.trim() || text.length > 10000) return { error: 'text must be nonblank and at most 10,000 characters.' };
  if ((latitude === undefined) !== (longitude === undefined)) return { error: 'Supply both latitude and longitude, or omit both.' };
  if (latitude !== undefined && (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180)) return { error: 'Coordinates must be finite numbers: latitude -90 to 90, longitude -180 to 180.' };
  return { data: { text, ...(bypassJevCache !== undefined ? { bypassJevCache: bypassJevCache as boolean } : {}), ...(latitude !== undefined ? { latitude: latitude as number, longitude: longitude as number } : {}) } };
}
