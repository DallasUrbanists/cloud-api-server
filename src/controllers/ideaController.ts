/**
 * Idea CRUD, upload-link delegation, and detail/activity enrichment for both route aliases.
 *
 * @remarks
 * Routes apply application/user access; update/delete also compare verified emails
 * with stored attribution or accept canonical staff. OpenAPI owns HTTP contracts.
 * @module
 */
import { Request, Response, NextFunction } from 'express';
import { IdeaService } from '../services/ideaService.js';
import { IdeaEmojiService } from '../services/ideaEmojiService.js';
import { RecommendedActionService } from '../services/recommendedActionService.js';
import { RecommendableActionService } from '../services/recommendableActionService.js';
import { StorageService } from '../services/storageService.js';
import { BoundaryService } from '../services/boundaryService.js';
import { RepresentativesService } from '../services/representativesService.js';
import { validDate } from '../utils/boundaryQuery.js';
import { hasRole } from '../middleware/auth.js';
import {
  validateCreateIdea,
  validateUpdateIdea,
  Idea,
  IdeaStatus,
  VALID_IDEA_STATUSES,
} from '../models/idea.js';

/** Coordinates base persistence, optional next-step matching, and safe authorization checks. */
export class IdeaController {
  /** Attempts to fill a missing emoji without making idea reads or writes depend on JEV. */
  private static async ensureEmoji(idea: Idea): Promise<Idea> {
    if (idea.emoji) return idea;
    try {
      const emoji = await IdeaEmojiService.assign(idea.content.summary, idea.content.details, { ideaId: idea.id });
      return (await IdeaService.assignEmojiIfMissing(idea.id, emoji)) ?? idea;
    } catch (error) {
      console.warn(JSON.stringify({ event: 'idea_emoji_assignment_failed', ideaId: idea.id, message: error instanceof Error ? error.message : 'unknown error' }));
      return idea;
    }
  }

  /** Returns the boundary records associated with a persisted idea. */
  static async getBoundaries(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = Number(req.params.ideaId);
      if (!Number.isInteger(id) || id < 1) {
        res.status(400).json({ error: 'Bad Request', message: 'The ideaId parameter must be a positive integer.' });
        return;
      }

      const idea = await IdeaService.getById(id);
      if (!idea) {
        res.status(404).json({ error: 'Not Found', message: `Idea with ID ${id} was not found.` });
        return;
      }

      const boundaries = await Promise.all(idea.boundaryIds.map(boundaryId => BoundaryService.findById(boundaryId)));
      res.status(200).json({ data: boundaries, count: boundaries.length });
    } catch (error) {
      next(error);
    }
  }

  /** Returns current representatives for an idea's stored boundaries, optionally as of a date. */
  static async getRepresentatives(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const rawId = String(req.params.ideaId);
      const id = Number(rawId);
      if (!/^\d+$/.test(rawId) || !Number.isSafeInteger(id) || id < 1) {
        res.status(400).json({ error: 'Bad Request', message: 'The ideaId parameter must be a positive integer.' });
        return;
      }

      const servingAsOf = req.query.servingAsOf;
      if (servingAsOf !== undefined && (typeof servingAsOf !== 'string' || !validDate(servingAsOf))) {
        res.status(400).json({ error: 'Bad Request', message: "Query parameter 'servingAsOf' must be a valid YYYY-MM-DD date." });
        return;
      }

      const parsePage = (name: 'limit' | 'offset', fallback: number, min: number, max: number): number | null => {
        const value = req.query[name];
        if (value === undefined) return fallback;
        if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
        const parsed = Number(value);
        return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
      };
      const limit = parsePage('limit', 100, 1, 500);
      const offset = parsePage('offset', 0, 0, 100000);
      if (limit === null || offset === null) {
        res.status(400).json({ error: 'Bad Request', message: 'limit must be 1–500 and offset must be 0–100000.' });
        return;
      }

      const idea = await IdeaService.getById(id);
      if (!idea) {
        res.status(404).json({ error: 'Not Found', message: `Idea with ID ${id} was not found.` });
        return;
      }

      const representatives = await RepresentativesService.findAll({
        boundaryIds: idea.boundaryIds,
        servingAsOf: servingAsOf as string | undefined,
        limit,
        offset,
      });
      res.status(200).json(representatives);
    } catch (error) {
      next(error);
    }
  }

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
        status?: IdeaStatus;
        authorEmail?: string;
        limit?: number;
      } = {};

      if (status) {
        if (!VALID_IDEA_STATUSES.includes(status as IdeaStatus)) {
          res.status(400).json({
            error: 'Bad Request',
            message: `Invalid status filter "${status}". Allowed: ${VALID_IDEA_STATUSES.join(', ')}`,
          });
          return;
        }
        filters.status = status as IdeaStatus;
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

      const ideas = await IdeaService.getAll(filters);
      res.status(200).json({
        data: ideas,
        count: ideas.length,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Reads the idea and newest activity page, exposing cursor metadata for additional history.
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

      let idea = await IdeaService.getById(id);
      if (!idea) {
        res.status(404).json({
          error: 'Not Found',
          message: `Idea with ID ${id} was not found.`,
        });
        return;
      }

      idea = await IdeaController.ensureEmoji(idea);

      const logPage = await RecommendedActionService.getLog(id, 50);
      res.status(200).json({ data: { ...idea, log: logPage.data }, logNextCursor: logPage.nextCursor, logHasMore: logPage.hasMore });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Validates and saves the idea before attempting reusable-action matching.
   * @remarks Matcher failures are logged but do not undo successful idea creation.
   * @example
   * Let's imagine sharing an idea for shade by a bus stop. The idea is saved first;
   * a helper then looks for useful ways the neighbor might move it forward.
   */
  static async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const validation = validateCreateIdea(req.body);
      if (validation.error || !validation.data) {
        res.status(400).json({
          error: 'Bad Request',
          message: validation.error,
        });
        return;
      }

      let created = await IdeaService.create(validation.data);
      created = await IdeaController.ensureEmoji(created);
      // Ideas remain available if the external matcher is temporarily unavailable.
      try { await RecommendableActionService.matchIdea(created); }
      catch (error) { console.warn(JSON.stringify({ event: 'recommendable_match_failed', ideaId: created.id, message: error instanceof Error ? error.message : 'unknown error' })); }
      res.status(201).json({
        message: 'Idea created successfully.',
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

      const existing = await IdeaService.getById(id);
      const authorized = Boolean(existing && (hasRole(req, 'staff') || req.user?.emails.some((email) => email.toLowerCase() === existing.author.email.toLowerCase())));
      if (!authorized) {
        res.status(403).json({ error: 'Forbidden', message: 'You are not authorized to modify this idea.' });
        return;
      }

      const validation = validateUpdateIdea(req.body);
      if (validation.error || !validation.data) {
        res.status(400).json({
          error: 'Bad Request',
          message: validation.error,
        });
        return;
      }

      const updated = await IdeaService.update(id, validation.data);
      if (!updated) {
        res.status(404).json({
          error: 'Not Found',
          message: `Idea with ID ${id} was not found.`,
        });
        return;
      }

      res.status(200).json({
        message: 'Idea updated successfully.',
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

      const existing = await IdeaService.getById(id);
      const authorized = Boolean(existing && (hasRole(req, 'staff') || req.user?.emails.some((email) => email.toLowerCase() === existing.author.email.toLowerCase())));
      if (!authorized) {
        res.status(403).json({ error: 'Forbidden', message: 'You are not authorized to delete this idea.' });
        return;
      }

      const deleted = await IdeaService.delete(id);
      if (!deleted) {
        res.status(404).json({
          error: 'Not Found',
          message: `Idea with ID ${id} was not found.`,
        });
        return;
      }

      res.status(200).json({
        message: `Idea with ID ${id} has been deleted successfully.`,
      });
    } catch (error) {
      next(error);
    }
  }
}
