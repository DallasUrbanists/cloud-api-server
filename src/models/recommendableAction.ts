export const RECOMMENDABLE_STATUSES = ['candidate', 'approved', 'closed', 'uncertain', 'rejected'] as const;
export type RecommendableStatus = typeof RECOMMENDABLE_STATUSES[number];

export interface RecommendableAction {
  id: string;
  summary: string;
  instructions: string;
  reason: string;
  boundaries: number[];
  sourceUrl: string;
  sourceEvidence: string;
  sourceDescription: string;
  status: RecommendableStatus;
  version: number;
  confidence: number | null;
  createdAt: string;
  updatedAt: string;
}

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

export function anyBoundaryOverlap(recommendableBoundaries: number[], suggestionBoundaryIds: number[]): boolean {
  if (recommendableBoundaries.length === 0) return true;
  const suggestionIds = new Set(suggestionBoundaryIds);
  return recommendableBoundaries.some(id => suggestionIds.has(id));
}
