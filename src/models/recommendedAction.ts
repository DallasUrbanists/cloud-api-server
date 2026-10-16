export const RECOMMENDED_ACTION_STATUSES = ['open', 'ignored', 'started', 'paused', 'cancelled', 'finished'] as const;
export type RecommendedActionStatus = typeof RECOMMENDED_ACTION_STATUSES[number];

export interface RecommendedAction {
  id: string;
  summary: string;
  instructions: string;
  representativeId: number | null;
  reason: string;
  expirationDate: string | null;
  status: RecommendedActionStatus;
  creationDate: string;
  modificationDate: string;
  recommendableId?: string;
  matchProbability?: number;
}

export interface LoggedAction {
  id: string;
  summary: string;
  description: string;
  actor: { name: string; email: string };
  timestamp: string;
}

export interface ActionInput {
  summary: string;
  instructions: string;
  representativeId?: number | null;
  reason: string;
  expirationDate?: string | null;
  status?: RecommendedActionStatus;
  /** Set only by the automated Recommendable Action matcher. */
  recommendableId?: string;
  matchProbability?: number;
}

export function validateActionInput(body: any, partial = false): { error?: string; data?: Partial<ActionInput> } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Request body must be an object.' };
  const allowed = ['summary', 'instructions', 'representativeId', 'reason', 'expirationDate', 'status'];
  if (Object.keys(body).some((key) => !allowed.includes(key))) return { error: 'Request contains unsupported properties.' };
  if (!partial && ['summary', 'instructions', 'reason'].some((key) => body[key] === undefined)) return { error: 'summary, instructions, and reason are required.' };
  if (partial && Object.keys(body).length === 0) return { error: 'At least one property is required.' };
  const data: Partial<ActionInput> = {};
  for (const key of ['summary', 'instructions', 'reason'] as const) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== 'string' || !body[key].trim()) return { error: `${key} must be a non-empty string.` };
      data[key] = body[key].trim();
    }
  }
  if (body.representativeId !== undefined) {
    if (body.representativeId !== null && (!Number.isInteger(body.representativeId) || body.representativeId < 1)) return { error: 'representativeId must be a positive integer or null.' };
    data.representativeId = body.representativeId;
  }
  if (body.expirationDate !== undefined) {
    if (body.expirationDate === null) data.expirationDate = null;
    else if (typeof body.expirationDate !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d)$/.test(body.expirationDate) || !Number.isFinite(Date.parse(body.expirationDate))) return { error: 'expirationDate must be null or a timezone-qualified ISO 8601 date-time.' };
    else data.expirationDate = new Date(body.expirationDate).toISOString();
  }
  if (body.status !== undefined) {
    if (!RECOMMENDED_ACTION_STATUSES.includes(body.status)) return { error: `status must be one of: ${RECOMMENDED_ACTION_STATUSES.join(', ')}.` };
    data.status = body.status;
  }
  return { data };
}

export function validateLogInput(body: any): { error?: string; data?: { summary: string; description: string } } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Request body must be an object.' };
  if (Object.keys(body).some((key) => !['summary', 'description'].includes(key))) return { error: 'Only summary and description may be supplied.' };
  if (typeof body.summary !== 'string' || !body.summary.trim()) return { error: 'summary must be a non-empty string.' };
  if (typeof body.description !== 'string' || !body.description.trim()) return { error: 'description must be a non-empty string.' };
  return { data: { summary: body.summary.trim(), description: body.description.trim() } };
}
