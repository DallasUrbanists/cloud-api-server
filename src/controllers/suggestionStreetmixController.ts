/**
 * Suggestion Streetmix HTTP boundary: strict bodies, deadlines, and recoverable errors.
 * Authentication is applied by the suggestion router; OpenAPI owns the contract.
 * @module
 */
import type { Request, Response } from 'express';
import { StreetmixError, streetmixKey } from '../models/streetmix.js';
import { SuggestionStreetmixService } from '../services/suggestionStreetmixService.js';

/** Builds a route handler without opening database connections at module import time. */
export function suggestionStreetmixHandler(action: 'read' | 'request' | 'initial' | 'regenerate' | 'selection') {
  return async (req: Request, res: Response): Promise<void> => {
    const disconnect = new AbortController();
    const close = () => { if (!res.writableEnded) disconnect.abort(); };
    res.on('close', close);
    res.set('Cache-Control', 'no-store');
    try {
      const id = String(req.params.suggestionId), requestId = req.params.requestId ? String(req.params.requestId) : undefined;
      if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new StreetmixError(400, 'INVALID_SUGGESTION_ID', 'Suggestion ID must be a positive safe integer.');
      if (requestId && !/^[a-f0-9-]{36}$/.test(requestId)) throw new StreetmixError(400, 'INVALID_REQUEST_ID', 'Invalid request identifier.');
      const signal = AbortSignal.any([disconnect.signal, AbortSignal.timeout(60000)]);
      const service = new SuggestionStreetmixService();
      let outcome;
      if (action === 'read') outcome = await service.read(id, signal);
      else if (action === 'request') outcome = await service.readRequest(id, requestId!, signal);
      else {
        if (!req.is('application/json')) throw new StreetmixError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send application/json.');
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => action !== 'selection' || key !== 'osmWayId')) throw new StreetmixError(400, 'INVALID_BODY', 'Send {} or, for selection, only osmWayId.');
        if (action === 'selection' && (!Number.isSafeInteger(body.osmWayId) || body.osmWayId <= 0)) throw new StreetmixError(400, 'INVALID_STREET_SELECTION', 'Supply a positive integer osmWayId.');
        outcome = await service.run({ id, application: req.header('X-API-Key')!, key: streetmixKey(req.header('Idempotency-Key')), mode: action, requestId, osmWayId: body.osmWayId, ifMatch: req.header('If-Match'), user: req.user }, signal);
      }
      if (outcome.etag) res.set('ETag', outcome.etag);
      if (outcome.status === 202) res.set('Retry-After', '3');
      if (!disconnect.signal.aborted) res.status(outcome.status).json(outcome.body);
    } catch (error) {
      if (disconnect.signal.aborted) return;
      const safe = error instanceof StreetmixError ? error : new StreetmixError(503, 'STORAGE_UNAVAILABLE', 'Suggestion Streetmix storage is unavailable. Retry the same request.');
      if (safe.retryAfter) res.set('Retry-After', String(safe.retryAfter));
      res.status(safe.status).json({ ...(error as any)?.workflowResponse, error: safe.code, message: safe.message });
    } finally { res.off('close', close); }
  };
}
