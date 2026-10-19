/**
 * Saved street drawings and recoverable suggestion workflows.
 * Let's imagine neighbors opening an idea and seeing the same street drawing,
 * even when several people requested it at once.
 * @module
 */
import type { StreetmixCandidate, StreetmixPoint, StreetmixResult } from './streetmix.js';

/** Public, server-managed summary included in suggestion reads. */
export interface SuggestionStreetmix {
  streetmixId: string;
  streetmixUrl: string;
  selectedStreet: StreetmixResult['selectedStreet'];
  coordinate: StreetmixPoint;
  snappedCoordinate: StreetmixPoint;
  dividedRoad?: StreetmixResult['dividedRoad'];
  generatedAt: string;
  savedAt: string;
  requestId: string;
  revision: number;
  stale: boolean;
}

/** Durable request state; publication uncertainty never receives automatic expiry. */
export interface SuggestionStreetmixRequest {
  requestId: string;
  application: string;
  mode: 'initial' | 'regenerate';
  status: 'generating' | 'publishing' | 'awaiting_selection' | 'save_pending' | 'completed' | 'failed' | 'publication_uncertain' | 'expired';
  coordinate: StreetmixPoint;
  expectedRevision: number;
  attempt: string;
  leaseUntil: number;
  createdAt: string;
  refreshScope?: string;
  osmWayId?: number;
  candidates?: StreetmixCandidate[];
  selectionExpiresAt?: string;
  result?: StreetmixResult;
  streetmix?: SuggestionStreetmix;
  error?: string;
  message?: string;
  expiresAtMs?: number;
  expiresAt?: Date;
}

/** Stable revision validator shared by GET, regeneration, and completion responses. */
export function suggestionStreetmixETag(id: string, revision: number): string {
  return `"streetmix-${id}-${revision}"`;
}

/** Computes staleness on reads so legacy and coordinate edits need no migration. */
export function suggestionStreetmixSummary(value: SuggestionStreetmix | undefined, location: Partial<StreetmixPoint>): SuggestionStreetmix | null {
  return value ? { ...value, stale: value.coordinate.latitude !== location?.latitude || value.coordinate.longitude !== location?.longitude } : null;
}
