/**
 * HTTP orchestration for Streetmix generation; OpenAPI owns the wire contract.
 * Requests have a fixed deadline and safe errors, including uncertain publications.
 * @module
 */
import type { Request, Response } from 'express';
import { StreetmixError, streetmixKey, streetmixRequest, streetmixPoint } from '../models/streetmix.js';
import { generateStreetmix, findStreetmixCandidates } from '../services/streetmixService.js';

/** Validates input, attaches cancellation, and returns a confirmed publication receipt. */
export async function createStreetmixDesign(req: Request, res: Response): Promise<void> {
  return generateDesign(req, res, req.header('X-API-Key')!);
}

/** Uses a dedicated shared playground quota and retry namespace after browser attestation. */
export async function createPlaygroundStreetmixDesign(req: Request, res: Response): Promise<void> {
  return generateDesign(req, res, 'streetmix-playground:v1');
}

/** Returns candidate geometry for a browser-selected location without creating a design. */
export async function previewPlaygroundStreetmix(req: Request, res: Response): Promise<void> {
  return generateDesign(req, res, 'streetmix-playground:v1', true);
}

async function generateDesign(req: Request, res: Response, application: string, preview = false): Promise<void> {
  const disconnect = new AbortController();
  const close = () => { if (!res.writableEnded) disconnect.abort(); };
  res.on('close', close);
  res.set('Cache-Control', 'no-store');
  try {
    if (!req.is('application/json')) throw new StreetmixError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send an application/json request body.');
    const point = preview ? streetmixPoint(req.body) : streetmixRequest(req.body);
    const key = streetmixKey(req.header('Idempotency-Key'));
    const signal = AbortSignal.any([disconnect.signal, AbortSignal.timeout(60000)]);
    const result = preview ? await findStreetmixCandidates(point, key, application, signal) : await generateStreetmix(point, key, application, signal);
    if (!disconnect.signal.aborted) res.status(preview ? 200 : 201).json(result);
  } catch (error) {
    if (disconnect.signal.aborted) return;
    const safe = error instanceof StreetmixError ? error : new StreetmixError(503, 'STREETMIX_UNAVAILABLE', 'Street generation is unavailable. Retry with the same request key.');
    if (safe.retryAfter) res.set('Retry-After', String(safe.retryAfter));
    res.status(safe.status).json({ error: safe.code, message: safe.message, ...(safe.details || {}) });
  } finally { res.off('close', close); }
}
