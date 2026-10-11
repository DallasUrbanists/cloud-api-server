import { Request, Response } from 'express';
import { validateGrammarInput } from '../models/assist.js';
import { AssistError, assistLimit, AssistService } from '../services/assistService.js';

export class AssistController {
  private static activeRequests = 0;

  static async grammar(req: Request, res: Response): Promise<void> {
    return AssistController.edit(req, res, 'grammar');
  }

  static async clarity(req: Request, res: Response): Promise<void> {
    return AssistController.edit(req, res, 'clarity');
  }

  private static async edit(req: Request, res: Response, mode: 'grammar' | 'clarity'): Promise<void> {
    const label = mode === 'grammar' ? 'Grammar' : 'Clarity';
    const validation = validateGrammarInput(req.body);
    if (!validation.data) {
      res.status(validation.feedback ? 422 : 400).json({
        error: validation.feedback ? 'EXECUTABLE_CONTENT_DETECTED' : mode === 'grammar' ? 'INVALID_GRAMMAR_INPUT' : 'INVALID_CLARITY_INPUT',
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
        : await AssistService.improveClarity(validation.data.text, abort.signal);
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