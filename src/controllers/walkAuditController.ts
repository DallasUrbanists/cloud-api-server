/** HTTP input and error adaptation for the walk-audit domain. @module */
import { NextFunction, Request, RequestHandler, Response } from 'express';
import { WalkAuditError } from '../models/walkAudit.js';
import { Page, WalkAuditActor } from '../services/walkAuditService.js';
import { invalid } from '../utils/walkAuditValidation.js';

/** Reject noncanonical integer identifiers before they reach PostgreSQL. */
export function pathId(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || Number(value) > 2147483647) invalid('id must be a positive integer.');
  return Number(value);
}
/** Reject malformed draft UUIDs before they reach PostgreSQL. */
export function draftId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) invalid('id must be a UUID.');
  return value;
}
/** Parse a bounded page and reject unknown or duplicate scalar filters. */
export function pagination(req: Request, allowed: string[] = []): Page {
  const permitted = new Set(['limit', 'offset', ...allowed]);
  for (const [key, value] of Object.entries(req.query)) if (!permitted.has(key) || typeof value !== 'string' || !value.trim()) invalid('Invalid or duplicate query parameter.');
  const number = (name: string, fallback: number, min: number, max: number): number => {
    const raw = req.query[name]; if (raw === undefined) return fallback;
    if (typeof raw !== 'string' || !/^(0|[1-9]\d*)$/.test(raw) || Number(raw) < min || Number(raw) > max) invalid(`${name} is out of range.`);
    return Number(raw);
  };
  const page: Page = { limit: number('limit', 25, 1, 100), offset: number('offset', 0, 0, 2147483647) };
  for (const key of allowed) {
    const value = req.query[key]; if (value === undefined) continue;
    if (typeof value !== 'string') invalid('Invalid query parameter.');
    if (['creator', 'author', 'worksheet'].includes(key)) page[key] = pathId(value);
    else if (key === 'includeVersions') { if (value !== 'true' && value !== 'false') invalid('includeVersions must be true or false.'); page[key] = value === 'true'; }
    else if (key === 'type') { if (value !== 'intersection' && value !== 'street-segment') invalid('Invalid audit type.'); page[key] = value; }
    else if (key === 'updatedSince') { if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) invalid('updatedSince must be an ISO UTC timestamp.'); page[key] = value; }
    else { if (value.length > 200) invalid('Query value is too long.'); page[key] = value.trim(); }
  }
  return page;
}
/** Project the verified middleware identity into the domain authorization shape. */
export function actor(req: Request): WalkAuditActor {
  if (!req.user) throw new WalkAuditError(401, 'UNAUTHENTICATED', 'A valid user token is required.');
  return { uid: req.user.uid, staff: req.user.token.staff === true };
}
/** Convert expected domain/database conflicts into safe, structured responses. */
export function walkAuditError(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (error instanceof WalkAuditError) {
    if (error.retryAfter !== undefined) res.setHeader('Retry-After', String(error.retryAfter));
    res.status(error.status).json({ error: error.code, message: error.message }); return;
  }
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : undefined;
  if (code === '23505' || code === '23503' || code === '40001' || code === '40P01' || code === '55P03') {
    res.status(409).json({ error: 'CONFLICT', message: 'The requested change conflicts with existing data or another update.' }); return;
  }
  if (code === '57014') {
    res.status(503).json({ error: 'DATABASE_UNAVAILABLE', message: 'The request could not complete in time.' }); return;
  }
  console.error('Walk-audit request failed.');
  res.status(500).json({ error: 'INTERNAL_ERROR', message: 'The request could not be completed.' });
}
/** Adapt an async handler to Express error middleware. */
export function handle(fn: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => { void fn(req, res).catch(next); };
}
/** Abort work when the client disconnects before the response finishes. */
export async function withDisconnect<T>(req: Request, res: Response, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const abort = (): void => { if (!res.writableEnded) controller.abort(); };
  req.once('aborted', abort); res.once('close', abort);
  try { return await work(controller.signal); } finally { req.off('aborted', abort); res.off('close', abort); }
}
