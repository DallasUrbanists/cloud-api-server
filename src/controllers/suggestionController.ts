/**
 * Suggestion CRUD, upload-link delegation, and detail/activity enrichment for both route aliases.
 *
 * @remarks
 * Routes apply application/user access; update/delete also compare verified emails
 * with stored attribution or accept canonical staff. OpenAPI owns HTTP contracts.
 * @module
 */
import { Request, Response, NextFunction } from 'express';
import { SuggestionService } from '../services/suggestionService.js';
import { RecommendedActionService } from '../services/recommendedActionService.js';
import { RecommendableActionService } from '../services/recommendableActionService.js';
import { StorageService } from '../services/storageService.js';
import { hasRole } from '../middleware/auth.js';
import {
  validateCreateSuggestion,
  validateUpdateSuggestion,
  SuggestionStatus,
  VALID_SUGGESTION_STATUSES,
} from '../models/suggestion.js';

/** Coordinates base persistence, optional next-step matching, and safe authorization checks. */
export class SuggestionController {
  /**
   * Delegates signed image-upload URL generation without receiving or storing the file itself.
   */
  static async getUploadUrl(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { contentType, filename } = req.body || {};

      const result = await StorageService.generateUploadUrl({
        contentType,
        filename,
      });

      res.status(200).json({
        message: 'Signed upload URL generated successfully.',
        data: result,
      });
    } catch (error: any) {
      if (error?.message && error.message.includes('Invalid content type')) {
        res.status(400).json({
          error: 'Bad Request',
          message: error.message,
        });
        return;
      }
      next(error);
    }
  }
  /**
   * Parses optional list filters and returns base records with a result count, without activity logs.
   */
  static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { status, authorEmail, limit } = req.query;

      const filters: {
        status?: SuggestionStatus;
        authorEmail?: string;
        limit?: number;
      } = {};

      if (status) {
        if (!VALID_SUGGESTION_STATUSES.includes(status as SuggestionStatus)) {
          res.status(400).json({
            error: 'Bad Request',
            message: `Invalid status filter "${status}". Allowed: ${VALID_SUGGESTION_STATUSES.join(', ')}`,
          });
          return;
        }
        filters.status = status as SuggestionStatus;
      }

      if (authorEmail && typeof authorEmail === 'string') {
        filters.authorEmail = authorEmail;
      }

      if (limit) {
        const parsedLimit = parseInt(limit as string, 10);
        if (isNaN(parsedLimit) || parsedLimit < 1) {
          res.status(400).json({
            error: 'Bad Request',
            message: 'limit parameter must be a positive integer.',
          });
          return;
        }
        filters.limit = parsedLimit;
      }

      const suggestions = await SuggestionService.getAll(filters);
      res.status(200).json({
        data: suggestions,
        count: suggestions.length,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Reads the suggestion and newest activity page, exposing cursor metadata for additional history.
   */
  static async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id) || id < 1) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'The id parameter must be a positive integer.',
        });
        return;
      }

      const suggestion = await SuggestionService.getById(id);
      if (!suggestion) {
        res.status(404).json({
          error: 'Not Found',
          message: `Suggestion with ID ${id} was not found.`,
        });
        return;
      }

      const logPage = await RecommendedActionService.getLog(id, 50);
      res.status(200).json({ data: { ...suggestion, log: logPage.data }, logNextCursor: logPage.nextCursor, logHasMore: logPage.hasMore });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Validates and saves the idea before attempting reusable-action matching.
   * @remarks Matcher failures are logged but do not undo successful suggestion creation.
   * @example
   * Let's imagine sharing an idea for shade by a bus stop. The idea is saved first;
   * a helper then looks for useful ways the neighbor might move it forward.
   */
  static async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const validation = validateCreateSuggestion(req.body);
      if (validation.error || !validation.data) {
        res.status(400).json({
          error: 'Bad Request',
          message: validation.error,
        });
        return;
      }

      const created = await SuggestionService.create(validation.data);
      // Suggestions remain available if the external matcher is temporarily unavailable.
      try { await RecommendableActionService.matchSuggestion(created); }
      catch (error) { console.warn(JSON.stringify({ event: 'recommendable_match_failed', suggestionId: created.id, message: error instanceof Error ? error.message : 'unknown error' })); }
      res.status(201).json({
        message: 'Suggestion created successfully.',
        data: created,
      });
    } catch (error: any) {
      if (error?.message && error.message.includes('already exists')) {
        res.status(409).json({
          error: 'Conflict',
          message: error.message,
        });
        return;
      }
      next(error);
    }
  }

  /**
   * Requires author-email ownership or staff before preparing a partial update.
   * @remarks A missing record fails the initial authorization check as forbidden;
   * null returned after that check is handled as not found.
   */
  static async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id) || id < 1) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'The id parameter must be a positive integer.',
        });
        return;
      }

      const existing = await SuggestionService.getById(id);
      const authorized = Boolean(existing && (hasRole(req, 'staff') || req.user?.emails.some((email) => email.toLowerCase() === existing.author.email.toLowerCase())));
      if (!authorized) {
        res.status(403).json({ error: 'Forbidden', message: 'You are not authorized to modify this suggestion.' });
        return;
      }

      const validation = validateUpdateSuggestion(req.body);
      if (validation.error || !validation.data) {
        res.status(400).json({
          error: 'Bad Request',
          message: validation.error,
        });
        return;
      }

      const updated = await SuggestionService.update(id, validation.data);
      if (!updated) {
        res.status(404).json({
          error: 'Not Found',
          message: `Suggestion with ID ${id} was not found.`,
        });
        return;
      }

      res.status(200).json({
        message: 'Suggestion updated successfully.',
        data: updated,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Requires author-email ownership or staff, then delegates parent/child cleanup.
   * @remarks Authorization uses the existing stored author, not a supplied replacement.
   */
  static async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id) || id < 1) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'The id parameter must be a positive integer.',
        });
        return;
      }

      const existing = await SuggestionService.getById(id);
      const authorized = Boolean(existing && (hasRole(req, 'staff') || req.user?.emails.some((email) => email.toLowerCase() === existing.author.email.toLowerCase())));
      if (!authorized) {
        res.status(403).json({ error: 'Forbidden', message: 'You are not authorized to delete this suggestion.' });
        return;
      }

      const deleted = await SuggestionService.delete(id);
      if (!deleted) {
        res.status(404).json({
          error: 'Not Found',
          message: `Suggestion with ID ${id} was not found.`,
        });
        return;
      }

      res.status(200).json({
        message: `Suggestion with ID ${id} has been deleted successfully.`,
      });
    } catch (error) {
      next(error);
    }
  }
}
