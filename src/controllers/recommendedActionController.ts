/**
 * Per-idea action and activity orchestration, with authenticated actor attribution.
 * Routes enforce staff-only action mutations; manual activity also checks author ownership.
 * OpenAPI owns the request/response and authentication contracts.
 * @module
 */
import { NextFunction, Request, Response } from 'express';
import { hasRole } from '../middleware/auth.js';
import { RECOMMENDED_ACTION_STATUSES, validateActionInput, validateLogInput } from '../models/recommendedAction.js';
import { RecommendedActionService } from '../services/recommendedActionService.js';
import { IdeaService } from '../services/ideaService.js';

/** Parses nested identifiers and sends validation failures before service calls. */
function ids(req: Request, res: Response): { ideaId: number; actionId?: string } | null {
  const ideaId = Number(req.params.ideaId);
  const rawActionId = req.params.actionId;
  const actionId = typeof rawActionId === 'string' ? rawActionId : undefined;
  if (!Number.isInteger(ideaId) || ideaId < 1) {
    res.status(400).json({ error: 'Bad Request', message: 'ideaId must be a positive integer.' });
    return null;
  }
  if (actionId !== undefined && (!actionId || actionId.includes('/'))) {
    res.status(400).json({ error: 'Bad Request', message: 'actionId must be a non-empty string.' });
    return null;
  }
  return { ideaId, actionId };
}

/** Derives log attribution from verified request identity, never from submitted actor fields. */
function actor(req: Request, res: Response): { name: string; email: string } | null {
  const email = req.user?.email?.trim();
  if (!email) {
    res.status(400).json({ error: 'Bad Request', message: 'Authenticated user must have an email address to create a log entry.' });
    return null;
  }
  const tokenName = typeof req.user?.token.name === 'string' ? req.user.token.name.trim() : '';
  return { name: tokenName || email, email };
}

/** Handles expected service errors locally and forwards other failures to Express. */
function sendError(error: any, res: Response, next: NextFunction): void {
  if ([400, 404, 409].includes(error?.status)) {
    res.status(error.status).json({ error: error.status === 404 ? 'Not Found' : error.status === 400 ? 'Bad Request' : 'Conflict', message: error.message });
  } else next(error);
}

/** Adapts nested HTTP operations to action/history services with explicit public-field validation. */
export class RecommendedActionController {
  /** Validates list choices, hiding expired actions unless explicitly requested. */
  static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    const parsed = ids(req, res); if (!parsed) return;
    const status = req.query.status; const include = req.query.includeExpired;
    if (status !== undefined && (typeof status !== 'string' || !RECOMMENDED_ACTION_STATUSES.includes(status as any))) { res.status(400).json({ error: 'Bad Request', message: `status must be one of: ${RECOMMENDED_ACTION_STATUSES.join(', ')}.` }); return; }
    if (include !== undefined && include !== 'true' && include !== 'false') { res.status(400).json({ error: 'Bad Request', message: 'includeExpired must be true or false.' }); return; }
    try { const data = await RecommendedActionService.list(parsed.ideaId, { status: status as any, includeExpired: include === 'true' }); res.json({ data, count: data.length }); } catch (error) { sendError(error, res, next); }
  }
  /** Reads one action, distinguishing missing children from service failures. */
  static async get(req: Request, res: Response, next: NextFunction): Promise<void> {
    const parsed = ids(req, res); if (!parsed?.actionId) return;
    try { const data = await RecommendedActionService.get(parsed.ideaId, parsed.actionId); if (!data) { res.status(404).json({ error: 'Not Found', message: 'Recommended Action not found.' }); return; } res.json({ data }); } catch (error) { sendError(error, res, next); }
  }
  /** Validates staff-submitted action content, excluding internal matcher linkage. */
  static async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    const parsed = ids(req, res); if (!parsed) return;
    const validation = validateActionInput(req.body); if (validation.error || !validation.data) { res.status(400).json({ error: 'Bad Request', message: validation.error }); return; }
    try { const data = await RecommendedActionService.create(parsed.ideaId, validation.data as any); res.status(201).json({ message: 'Recommended Action created successfully.', data }); } catch (error) { sendError(error, res, next); }
  }
  /** Applies partial action changes and supplies verified actor details for any status-transition log. */
  static async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    const parsed = ids(req, res); if (!parsed?.actionId) return;
    const validation = validateActionInput(req.body, true); if (validation.error || !validation.data) { res.status(400).json({ error: 'Bad Request', message: validation.error }); return; }
    const userActor = actor(req, res); if (validation.data.status !== undefined && !userActor) return;
    try {
      const result = await RecommendedActionService.update(parsed.ideaId, parsed.actionId, validation.data, userActor ?? { name: '', email: '' });
      if (!result) { res.status(404).json({ error: 'Not Found', message: 'Recommended Action not found.' }); return; }
      res.json({ message: result.noOp ? 'Recommended Action status is unchanged.' : 'Recommended Action updated successfully.', data: result.action, ...(result.noOp ? { noOp: true } : {}) });
    } catch (error) { sendError(error, res, next); }
  }
  /** Delegates removal of a staff-selected child while retaining its activity history. */
  static async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    const parsed = ids(req, res); if (!parsed?.actionId) return;
    try { if (!await RecommendedActionService.delete(parsed.ideaId, parsed.actionId)) { res.status(404).json({ error: 'Not Found', message: 'Recommended Action not found.' }); return; } res.json({ message: 'Recommended Action deleted successfully.' }); } catch (error) { sendError(error, res, next); }
  }
  /** Validates activity pagination before retrieving a newest-first page. */
  static async getLog(req: Request, res: Response, next: NextFunction): Promise<void> {
    const parsed = ids(req, res); if (!parsed) return;
    const rawLimit = req.query.limit; const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) { res.status(400).json({ error: 'Bad Request', message: 'limit must be a positive integer no greater than 100.' }); return; }
    if (req.query.cursor !== undefined && typeof req.query.cursor !== 'string') { res.status(400).json({ error: 'Bad Request', message: 'cursor must be a string.' }); return; }
    try { res.json(await RecommendedActionService.getLog(parsed.ideaId, limit, req.query.cursor as string | undefined)); } catch (error) { sendError(error, res, next); }
  }
  /** Authorizes the idea's author or staff, then appends text with server-derived actor/time. */
  static async appendLog(req: Request, res: Response, next: NextFunction): Promise<void> {
    const parsed = ids(req, res); if (!parsed) return;
    const validation = validateLogInput(req.body); if (validation.error || !validation.data) { res.status(400).json({ error: 'Bad Request', message: validation.error }); return; }
    if (!req.user) { res.status(403).json({ error: 'Forbidden', message: 'You are not authorized to add a log entry to this idea.' }); return; }
    const userActor = actor(req, res); if (!userActor) return;
    try {
      const idea = await IdeaService.getById(parsed.ideaId);
      if (!idea) { res.status(404).json({ error: 'Not Found', message: `Idea with ID ${parsed.ideaId} was not found.` }); return; }
      if (!hasRole(req, 'staff') && !req.user.emails.some((email) => email.toLowerCase() === idea.author.email.toLowerCase())) { res.status(403).json({ error: 'Forbidden', message: 'You are not authorized to add a log entry to this idea.' }); return; }
      const data = await RecommendedActionService.appendLog(parsed.ideaId, validation.data, userActor); res.status(201).json({ data });
    } catch (error) { sendError(error, res, next); }
  }
}
