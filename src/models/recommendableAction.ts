/**
 * Domain shapes, input normalization, and geographic applicability for reusable civic actions.
 *
 * Let's imagine there's a city webpage inviting residents to comment on a proposed
 * neighborhood park redesign. A recommendable action is like a helpful card saying,
 * "Share your ideas for the park." It tells people what they can do and why their
 * ideas matter. Recommendable actions can apply to particular neighborhoods or
 * have no geographic boundaries and apply anywhere.
 *
 * @remarks
 * This module performs no I/O. Source retrieval, boundary existence checks, and
 * persistence belong to the service layer; HTTP contracts belong to OpenAPI.
 *
 * @module
 */

/** Lifecycle states shared by review candidates and published catalog entries. */
export const RECOMMENDABLE_STATUSES = ['candidate', 'approved', 'closed', 'uncertain', 'rejected'] as const;
/** A review or catalog state; only approved catalog entries participate in matching. */
export type RecommendableStatus = typeof RECOMMENDABLE_STATUSES[number];

/** A reusable, source-backed action, distinct from an action attached to one suggestion. */
export interface RecommendableAction {
  id: string;
  summary: string;
  instructions: string;
  reason: string;
  /** Applicable boundary IDs; an empty list means geographically unrestricted. */
  boundaries: number[];
  sourceUrl: string;
  /** Supporting excerpt checked against retrieved source text during extraction. */
  sourceEvidence: string;
  /** Submitter or registry context, not a substitute for source evidence. */
  sourceDescription: string;
  status: RecommendableStatus;
  /** Catalog revision used to identify persisted snapshots; candidates start at one. */
  version: number;
  /** Optional extraction confidence, distinct from a suggestion's match probability. */
  confidence: number | null;
  createdAt: string;
  updatedAt: string;
}

/** Candidate content before persistence adds identity, lifecycle state, and timestamps. */
export interface RecommendableInput {
  summary: string;
  instructions: string;
  reason: string;
  boundaries: number[];
  sourceUrl: string;
  sourceEvidence: string;
  sourceDescription: string;
  confidence?: number | null;
}

/**
 * Validates candidate content and returns a normalized copy without mutating the input.
 *
 * @remarks
 * Rejects unsupported properties and invalid fields before trimming text, serializing
 * the source URL, and deduplicating/sorting boundary IDs. URL checks are syntactic:
 * they do not resolve hosts, retrieve evidence, or confirm boundary existence.
 *
 * @param body - Untrusted candidate content, not the HTTP extraction request shape.
 * @returns Normalized data on success, or the first validation error on failure.
 *
 * @example
 * Let's imagine someone fills out a card inviting neighbors to share ideas for a
 * park. This function helps tidy the card and check that the important pieces are
 * there, so its message is ready for someone to review.
 * ```typescript
 * const result = validateRecommendableInput({
 *   summary: ' Share park feedback ',
 *   instructions: 'Use the feedback channel described by the source.',
 *   reason: 'Help shape the proposed park redesign.',
 *   boundaries: [20, 10, 20],
 *   sourceUrl: 'https://example.org/park-feedback',
 *   sourceEvidence: 'Invitation to share park feedback.',
 *   sourceDescription: 'Park consultation.',
 * });
 * result.data?.summary; // 'Share park feedback'
 * result.data?.boundaries; // [10, 20]
 * ```
 */
export function validateRecommendableInput(body: unknown): { data?: RecommendableInput; error?: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Request body must be an object.' };
  const input = body as Record<string, unknown>;
  const allowed = ['summary', 'instructions', 'reason', 'boundaries', 'sourceUrl', 'sourceEvidence', 'sourceDescription', 'confidence'];
  if (Object.keys(input).some(key => !allowed.includes(key))) return { error: 'Request contains unsupported properties.' };
  for (const key of ['summary', 'instructions', 'reason', 'sourceUrl', 'sourceEvidence', 'sourceDescription']) {
    if (typeof input[key] !== 'string' || !(input[key] as string).trim()) return { error: `${key} must be a non-empty string.` };
    if ((input[key] as string).length > (key === 'sourceDescription' ? 5000 : 4000)) return { error: `${key} is too long.` };
  }
  let source: URL;
  try { source = new URL(input.sourceUrl as string); } catch { return { error: 'sourceUrl must be a valid HTTPS URL.' }; }
  if (source.protocol !== 'https:' || source.username || source.password || source.port && source.port !== '443') return { error: 'sourceUrl must be a public HTTPS URL.' };
  if (!Array.isArray(input.boundaries) || input.boundaries.length > 50 || input.boundaries.some(id => !Number.isSafeInteger(id) || (id as number) < 1)) return { error: 'boundaries must be an array of up to 50 positive integer IDs.' };
  const confidence = input.confidence;
  if (confidence !== undefined && confidence !== null && (typeof confidence !== 'number' || confidence < 0 || confidence > 1)) return { error: 'confidence must be null or a number from 0 to 1.' };
  return { data: {
    summary: (input.summary as string).trim(), instructions: (input.instructions as string).trim(), reason: (input.reason as string).trim(),
    boundaries: [...new Set(input.boundaries as number[])].sort((a, b) => a - b), sourceUrl: source.toString(),
    sourceEvidence: (input.sourceEvidence as string).trim(), sourceDescription: (input.sourceDescription as string).trim(), confidence: confidence as number | null | undefined,
  } };
}

/**
 * Determines whether an action's geographic scope includes a suggestion.
 *
 * @remarks
 * An unrestricted action matches even when no suggestion boundaries are known.
 * Restricted actions need any shared ID, not a match against every boundary.
 *
 * @param recommendableBoundaries - Action restrictions; empty means global applicability.
 * @param suggestionBoundaryIds - Boundaries resolved for the suggestion's location.
 * @returns Whether the geographic scope matches; does not judge topical relevance.
 *
 * @example
 * Let's imagine there's a recommendable action for Downtown and Uptown. A suggestion
 * in either neighborhood is in the right place for that action. This function is
 * like checking a map to see whether the action and the suggestion share a place.
 * ```typescript
 * const downtown = 10;
 * const uptown = 20;
 * const oakCliff = 99;
 * anyBoundaryOverlap([downtown, uptown], [uptown]); // true
 * anyBoundaryOverlap([downtown, uptown], [oakCliff]); // false
 * ```
 */
export function anyBoundaryOverlap(recommendableBoundaries: number[], suggestionBoundaryIds: number[]): boolean {
  if (recommendableBoundaries.length === 0) return true;
  const suggestionIds = new Set(suggestionBoundaryIds);
  return recommendableBoundaries.some(id => suggestionIds.has(id));
}
