/**
 * Text-edit request validation, local concurrency, quota reservation, and cancellation.
 * Input policy lives in the model; provider/output checks live in AssistService.
 * HTTP authentication is supplied by routes and contracts remain in OpenAPI.
 * @module
 */
import { Request, Response } from 'express';
import { validateGrammarInput, validateSummaryInput } from '../models/assist.js';
import { AssistError, assistLimit, AssistService } from '../services/assistService.js';

/** Coordinates all three modes through one cleanup-safe request lifecycle. */
export class AssistController {
  private static activeRequests = 0;

  /** Selects minimal grammar/spelling editing while retaining the shared validation/quota lifecycle. */
  static async grammar(req: Request, res: Response): Promise<void> {
    return AssistController.edit(req, res, 'grammar');
  }

  /** Selects full-document clarity editing, not summarization. */
  static async clarity(req: Request, res: Response): Promise<void> {
    return AssistController.edit(req, res, 'clarity');
  }

  /** Selects summary generation with server-validated options. */
  static async summarize(req: Request, res: Response): Promise<void> {
    return AssistController.edit(req, res, 'summarize');
  }

  /**
   * Validates before charging quota, reserves process-local capacity, and cancels on early response closure.
   * @remarks Capacity and listeners are released on every exit. Quota is shared across
   * modes/instances and is not refunded on provider failure; local capacity is not distributed.
   */
  private static async edit(req: Request, res: Response, mode: 'grammar' | 'clarity' | 'summarize'): Promise<void> {
    const label = mode === 'grammar' ? 'Grammar' : mode === 'clarity' ? 'Clarity' : 'Summarization';
    const inputError = mode === 'grammar' ? 'INVALID_GRAMMAR_INPUT' : mode === 'clarity' ? 'INVALID_CLARITY_INPUT' : 'INVALID_SUMMARY_INPUT';
    const summaryInput = mode === 'summarize' ? validateSummaryInput(req.body) : undefined;
    const validation = summaryInput ?? validateGrammarInput(req.body);
    if (!validation.data) {
      res.status(validation.feedback ? 422 : 400).json({
        error: validation.feedback ? 'EXECUTABLE_CONTENT_DETECTED' : inputError,
        message: validation.error,
        ...(validation.feedback ? { feedback: validation.feedback } : {}),
      });
      return;
    }
    const abort = new AbortController();
    const onClose = () => { if (!res.writableEnded) abort.abort(); };
    let reserved = false;
    try {
      if (!process.env.GEMINI_API_KEY?.trim()) throw new AssistError(503, 'ASSIST_UNAVAILABLE', `${label} assistance is not configured.`);
      if (AssistController.activeRequests >= assistLimit('ASSIST_MAX_CONCURRENT', 4, 32)) {
        throw new AssistError(429, 'ASSIST_BUSY', `${label} assistance is busy. Try again shortly.`, 5);
      }
      AssistController.activeRequests++;
      reserved = true;
      res.once('close', onClose);
      await AssistService.consumeQuota(req.header('X-API-Key')!, req.user?.uid);
      if (abort.signal.aborted) return;
      const text = mode === 'grammar'
        ? await AssistService.correctGrammar(validation.data.text, abort.signal)
        : mode === 'clarity' ? await AssistService.improveClarity(validation.data.text, abort.signal)
          : await AssistService.summarize(validation.data.text, summaryInput?.data, abort.signal);
      if (!res.destroyed) res.status(200).json({ data: { text } });
    } catch (error) {
      const failure = error instanceof AssistError ? error : new AssistError(500, 'ASSIST_INTERNAL_ERROR', `${label} assistance could not complete the request.`);
      console.warn(JSON.stringify({ event: `${mode}_assistance_failed`, code: failure.code, status: failure.status }));
      if (!res.destroyed) {
        if (failure.retryAfter) res.setHeader('Retry-After', failure.retryAfter);
        res.status(failure.status).json({ error: failure.code, message: failure.message });
      }
    } finally {
      res.off('close', onClose);
      if (reserved) AssistController.activeRequests--;
    }
  }
}