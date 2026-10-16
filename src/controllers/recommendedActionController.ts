import { NextFunction, Request, Response } from 'express';
import { hasRole } from '../middleware/auth.js';
import { RECOMMENDED_ACTION_STATUSES, validateActionInput, validateLogInput } from '../models/recommendedAction.js';
import { RecommendedActionService } from '../services/recommendedActionService.js';
import { SuggestionService } from '../services/suggestionService.js';

function ids(req: Request, res: Response): { suggestionId: number; actionId?: string } | null {
  const suggestionId = Number(req.params.suggestionId);
  const rawActionId = req.params.actionId;
  const actionId = typeof rawActionId === 'string' ? rawActionId : undefined;
  if (!Number.isInteger(suggestionId) || suggestionId < 1) {
    res.status(400).json({ error: 'Bad Request', message: 'suggestionId must be a positive integer.' });
    return null;
  }
  if (actionId !== undefined && (!actionId || actionId.includes('/'))) {
    res.status(400).json({ error: 'Bad Request', message: 'actionId must be a non-empty string.' });
    return null;
  }
  return { suggestionId, actionId };
}

function actor(req: Request, res: Response): { name: string; email: string } | null {
  const email = req.user?.email?.trim();
  if (!email) {
    res.status(400).json({ error: 'Bad Request', message: 'Authenticated user must have an email address to create a log entry.' });
    return null;
  }
  const tokenName = typeof req.user?.token.name === 'string' ? req.user.token.name.trim() : '';
  return { name: tokenName || email, email };
}

function sendError(error: any, res: Response, next: NextFunction): void {
  if ([400, 404, 409].includes(error?.status)) {
    res.status(error.status).json({ error: error.status === 404 ? 'Not Found' : error.status === 400 ? 'Bad Request' : 'Conflict', message: error.message });
  } else next(error);
}

export class RecommendedActionController {
  static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    const parsed = ids(req, res); if (!parsed) return;
    const status = req.query.status; const include = req.query.includeExpired;
    if (status !== undefined && (typeof status !== 'string' || !RECOMMENDED_ACTION_STATUSES.includes(status as any))) { res.status(400).json({ error: 'Bad Request', message: `status must be one of: ${RECOMMENDED_ACTION_STATUSES.join(', ')}.` }); return; }
    if (include !== undefined && include !== 'true' && include !== 'false') { res.status(400).json({ error: 'Bad Request', message: 'includeExpired must be true or false.' }); return; }
    try { const data = await RecommendedActionService.list(parsed.suggestionId, { status: status as any, includeExpired: include === 'true' }); res.json({ data, count: data.length }); } catch (error) { sendError(error, res, next); }
  }
  static async get(req: Request, res: Response, next: NextFunction): Promise<void> {
    const parsed = ids(req, res); if (!parsed?.actionId) return;
    try { const data = await RecommendedActionService.get(parsed.suggestionId, parsed.actionId); if (!data) { res.status(404).json({ error: 'Not Found', message: 'Recommended Action not found.' }); return; } res.json({ data }); } catch (error) { sendError(error, res, next); }
  }
  static async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    const parsed = ids(req, res); if (!parsed) return;
    const validation = validateActionInput(req.body); if (validation.error || !validation.data) { res.status(400).json({ error: 'Bad Request', message: validation.error }); return; }
    try { const data = await RecommendedActionService.create(parsed.suggestionId, validation.data as any); res.status(201).json({ message: 'Recommended Action created successfully.', data }); } catch (error) { sendError(error, res, next); }
  }
  static async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    const parsed = ids(req, res); if (!parsed?.actionId) return;
    const validation = validateActionInput(req.body, true); if (validation.error || !validation.data) { res.status(400).json({ error: 'Bad Request', message: validation.error }); return; }
    const userActor = actor(req, res); if (validation.data.status !== undefined && !userActor) return;
    try {
      const result = await RecommendedActionService.update(parsed.suggestionId, parsed.actionId, validation.data, userActor ?? { name: '', email: '' });
      if (!result) { res.status(404).json({ error: 'Not Found', message: 'Recommended Action not found.' }); return; }
      res.json({ message: result.noOp ? 'Recommended Action status is unchanged.' : 'Recommended Action updated successfully.', data: result.action, ...(result.noOp ? { noOp: true } : {}) });
    } catch (error) { sendError(error, res, next); }
  }
  static async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    const parsed = ids(req, res); if (!parsed?.actionId) return;
    try { if (!await RecommendedActionService.delete(parsed.suggestionId, parsed.actionId)) { res.status(404).json({ error: 'Not Found', message: 'Recommended Action not found.' }); return; } res.json({ message: 'Recommended Action deleted successfully.' }); } catch (error) { sendError(error, res, next); }
  }
  static async getLog(req: Request, res: Response, next: NextFunction): Promise<void> {
    const parsed = ids(req, res); if (!parsed) return;
    const rawLimit = req.query.limit; const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) { res.status(400).json({ error: 'Bad Request', message: 'limit must be a positive integer no greater than 100.' }); return; }
    if (req.query.cursor !== undefined && typeof req.query.cursor !== 'string') { res.status(400).json({ error: 'Bad Request', message: 'cursor must be a string.' }); return; }
    try { res.json(await RecommendedActionService.getLog(parsed.suggestionId, limit, req.query.cursor as string | undefined)); } catch (error) { sendError(error, res, next); }
  }
  static async appendLog(req: Request, res: Response, next: NextFunction): Promise<void> {
    const parsed = ids(req, res); if (!parsed) return;
    const validation = validateLogInput(req.body); if (validation.error || !validation.data) { res.status(400).json({ error: 'Bad Request', message: validation.error }); return; }
    if (!req.user) { res.status(403).json({ error: 'Forbidden', message: 'You are not authorized to add a log entry to this suggestion.' }); return; }
    const userActor = actor(req, res); if (!userActor) return;
    try {
      const suggestion = await SuggestionService.getById(parsed.suggestionId);
      if (!suggestion) { res.status(404).json({ error: 'Not Found', message: `Suggestion with ID ${parsed.suggestionId} was not found.` }); return; }
      if (!hasRole(req, 'staff') && !req.user.emails.some((email) => email.toLowerCase() === suggestion.author.email.toLowerCase())) { res.status(403).json({ error: 'Forbidden', message: 'You are not authorized to add a log entry to this suggestion.' }); return; }
      const data = await RecommendedActionService.appendLog(parsed.suggestionId, validation.data, userActor); res.status(201).json({ data });
    } catch (error) { sendError(error, res, next); }
  }
}
