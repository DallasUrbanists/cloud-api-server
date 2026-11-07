/**
 * Public email-draft request orchestration and minimally projected playground catalogs.
 * Request validation, capacity, and safe HTTP errors stay separate from provider work.
 * @module
 */
import type { Request, Response } from 'express';
import { EmailDraftError, EmailDraftService, emailLimit, validateUnsavedEmailSuggestion, type EmailDraft } from '../services/emailDraftService.js';
import { PlaygroundLocationController } from './playgroundLocationController.js';
import { SuggestionService } from '../services/suggestionService.js';
import { RepresentativesService } from '../services/representativesService.js';

function positiveId(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function coordinate(value: unknown, limit: number): number | null {
  if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= limit ? number : null;
}

function sendFailure(res: Response, error: unknown): void {
  const failure = error instanceof EmailDraftError ? error : new EmailDraftError(500, 'EMAIL_INTERNAL_ERROR', 'Email generation could not complete.');
  if (failure.retryAfter) res.setHeader('Retry-After', failure.retryAfter);
  if (!res.destroyed) res.status(failure.status).json({ error: failure.code, message: failure.message });
}

/** Public endpoints for draft generation and the playground's limited choice lists. */
export class EmailDraftController {
  private static active = 0;

  /** Returns a bounded ID-ordered suggestion page without author email or full records. */
  static async suggestions(req: Request, res: Response): Promise<void> {
    try {
      const cursor = req.query.cursor;
      if (cursor !== undefined && positiveId(cursor) === null) throw new EmailDraftError(400, 'INVALID_EMAIL_REQUEST', 'Cursor must be a positive integer.');
      const page = await SuggestionService.getPresentationPage((cursor as string | undefined) ?? null, 100);
      res.json({ data: page.items.map(item => ({ id: item.id, emoji: item.emoji ?? '', summary: item.content.summary, author: item.author.name, date: item.creationDate })), nextCursor: page.nextCursor });
    } catch (error) { sendFailure(res, error); }
  }

  /** Returns current representatives for saved boundaries or a selected map point. */
  static async representatives(req: Request, res: Response): Promise<void> {
    try {
      const offset = req.query.offset === undefined ? 0 : typeof req.query.offset === 'string' && /^\d+$/.test(req.query.offset) ? Number(req.query.offset) : NaN;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > Number.MAX_SAFE_INTEGER - 100) throw new EmailDraftError(400, 'INVALID_EMAIL_REQUEST', 'Offset is invalid.');
      let location: { boundaryIds: number[] } | { latitude: number; longitude: number };
      if (req.query.suggestionId !== undefined) {
        const suggestionId = positiveId(req.query.suggestionId);
        if (!suggestionId || req.query.latitude !== undefined || req.query.longitude !== undefined) throw new EmailDraftError(400, 'INVALID_EMAIL_REQUEST', 'Choose a suggestion or a location.');
        const suggestion = await SuggestionService.getForPresentation(suggestionId);
        if (!suggestion) throw new EmailDraftError(404, 'SUGGESTION_NOT_FOUND', 'Suggestion not found.');
        location = { boundaryIds: suggestion.boundaryIds };
      } else {
        const latitude = coordinate(req.query.latitude, 90), longitude = coordinate(req.query.longitude, 180);
        if (latitude === null || longitude === null) throw new EmailDraftError(400, 'INVALID_EMAIL_REQUEST', 'A valid latitude and longitude are required.');
        location = { latitude, longitude };
      }
      const records = await RepresentativesService.findAll({ ...location, limit: 101, offset });
      res.json({ data: records.slice(0, 100).map(record => ({ id: record.id, name: record.name, title: record.title, boundary: [record.boundary.entityName, record.boundary.bodyName, record.boundary.districtName].filter(Boolean).join(' / ') })), nextOffset: records.length > 100 ? offset + 100 : null });
    } catch (error) { sendFailure(res, error); }
  }

  /** Reuses the server-side Places proxy with the email playground's public CORS policy. */
  static async locations(req: Request, res: Response): Promise<void> {
    await PlaygroundLocationController.search(req, res, error => {
      const status = error?.status === 400 ? 400 : 503;
      sendFailure(res, new EmailDraftError(status, status === 400 ? 'INVALID_EMAIL_REQUEST' : 'EMAIL_LOCATION_UNAVAILABLE', status === 400 ? 'Invalid address search.' : 'Address search is unavailable.'));
    });
  }

  /** Generates from a saved suggestion while sharing capacity with unsaved drafts. */
  static async generate(req: Request, res: Response): Promise<void> {
    const suggestionId = positiveId(req.query.suggestionId);
    const representativeId = positiveId(req.query.representativeId);
    if (!suggestionId || !representativeId) {
      sendFailure(res, new EmailDraftError(400, 'INVALID_EMAIL_REQUEST', 'Suggestion and representative IDs must be positive integers.'));
      return;
    }
    await EmailDraftController.run(res, signal => EmailDraftService.generate(suggestionId, representativeId, signal));
  }

  /** Generates from a validated unsaved idea without creating a suggestion. */
  static async generateUnsaved(req: Request, res: Response): Promise<void> {
    try {
      if (!req.is('application/json')) throw new EmailDraftError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send an application/json request body.');
      const input = validateUnsavedEmailSuggestion(req.body);
      await EmailDraftController.run(res, signal => EmailDraftService.generateUnsaved(input, signal));
    } catch (error) { sendFailure(res, error); }
  }

  private static async run(res: Response, generate: (signal: AbortSignal) => Promise<EmailDraft>): Promise<void> {
    const abort = new AbortController();
    const onClose = () => { if (!res.writableEnded) abort.abort(); };
    let reserved = false;
    try {
      if (EmailDraftController.active >= emailLimit('EMAIL_MAX_CONCURRENT', 4, 32)) throw new EmailDraftError(429, 'EMAIL_BUSY', 'Email generation is busy. Try again shortly.', 5);
      EmailDraftController.active++;
      reserved = true;
      res.once('close', onClose);
      const result = await generate(abort.signal);
      if (!res.destroyed) res.json(result);
    } catch (error) {
      sendFailure(res, error);
    } finally {
      res.off('close', onClose);
      if (reserved) EmailDraftController.active--;
    }
  }
}
