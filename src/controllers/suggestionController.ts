import { Request, Response, NextFunction } from 'express';
import { SuggestionService } from '../services/suggestionService.js';
import { StorageService } from '../services/storageService.js';
import {
  validateCreateSuggestion,
  validateUpdateSuggestion,
  SuggestionStatus,
  VALID_SUGGESTION_STATUSES,
} from '../models/suggestion.js';

export class SuggestionController {
  /**
   * POST /api/public-improvements/suggestions/upload-url
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
   * GET /api/public-improvements/suggestions
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
   * GET /api/public-improvements/suggestions/:id
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

      res.status(200).json({ data: suggestion });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/public-improvements/suggestions
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
   * PUT /api/public-improvements/suggestions/:id
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
   * DELETE /api/public-improvements/suggestions/:id
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
