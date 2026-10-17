/**
 * Public boundary reads, tick orchestration, and durable job polling.
 *
 * @remarks
 * Expected BoundaryError failures are translated locally; unexpected details stay
 * server-side. Tick routes own force authorization and prefetch protection.
 * HTTP contracts are maintained in src/docs/boundaries.ts.
 * @module
 */
import type { NextFunction, Request, Response } from 'express';
import { BoundaryError } from '../models/boundary.js';
import { BoundaryService } from '../services/boundaryService.js';
import { BoundarySyncService } from '../services/boundarySyncService.js';
import { RepresentativesService } from '../services/representativesService.js';
import { parseBoundarySearch, positiveId } from '../utils/boundaryQuery.js';

/** Wraps async handlers with no-store headers and safe, consistent boundary-error translation. */
export function boundaryHandler(handler: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store');
    try { await handler(req, res); }
    catch (error) {
      if (error instanceof BoundaryError) {
        if (error.status === 429) res.setHeader('Retry-After', '60');
        res.status(error.status).json({ error: error.code, message: error.message });
      } else {
        console.error('Boundary request failed.');
        res.status(500).json({ error: 'INTERNAL_ERROR', message: 'The boundary request could not be completed.' });
      }
    }
  };
}
/** Parses optional filters/geocoding and returns the service's paginated boundary matches. */
export const listBoundaries = boundaryHandler(async (req, res) => {
  res.json(await BoundaryService.findAll(await parseBoundarySearch(req)));
});
/** Validates the identifier and reads a boundary without restricting it to currently effective records. */
export const getBoundary = boundaryHandler(async (req, res) => {
  res.json(await BoundaryService.findById(positiveId(req.params.id)));
});
/**
 * Creates a handler for due/forced refresh of a chosen target or one eligible record.
 * @remarks
 * No-work responses return current data or an empty count. Short shape-only work
 * may complete inline; research and unfinished work return a pollable durable job.
 * A reused job for a different target within the same boundary returns current data.
 * @example
 * Let's imagine the map's district outline needs refreshing. A quick update can
 * finish right away; a longer update gives the caller a way to check back later.
 */
export function tick(target: 'boundary' | 'representative', kind?: 'shape' | 'research', byId = false, force = false) {
  return boundaryHandler(async (req, res) => {
    const id = byId ? positiveId(req.params.id) : undefined;
    const job = await BoundarySyncService.enqueue({ target, id, kind, force, clientAddress: req.ip ?? 'unknown' });
    if (!job) {
      res.json(id === undefined ? { syncCount: 0 } : target === 'boundary' ? await BoundaryService.findById(id) : await RepresentativesService.findById(id));
      return;
    }
    if (id !== undefined && (job.target_type !== target || job.target_id !== id)) {
      res.json(target === 'boundary' ? await BoundaryService.findById(id) : await RepresentativesService.findById(id));
      return;
    }
    if (!job.research_requested && job.status === 'queued') {
      const claimed = await BoundarySyncService.claim(String(job.id));
      if (claimed) {
        const outcome = await BoundarySyncService.execute(claimed, 8000);
        if (outcome === 'succeeded') {
          res.json(await BoundaryService.findById(job.target_id));
          return;
        }
        if (outcome === 'failed') throw new BoundaryError(502, 'SYNC_FAILED', 'Shape synchronization failed. Inspect the job status and retry after backoff.');
      }
    }
    const statusUrl = `/api/tick/jobs/${job.id}`;
    res.setHeader('Location', statusUrl);
    res.setHeader('Retry-After', '5');
    res.status(202).json({ jobId: String(job.id), status: job.status === 'running' ? 'running' : 'queued', statusUrl });
  });
}
/** Polls a bigint job identifier and attaches the current target model after success, not a historical snapshot. */
export const getSyncJob = boundaryHandler(async (req, res) => {
  const id = req.params.id;
  if (typeof id !== 'string' || !/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) throw new BoundaryError(400, 'INVALID_ID', 'Job ID must be a positive PostgreSQL bigint.');
  const job = await BoundarySyncService.status(id);
  res.json(job.status === 'succeeded' ? { ...job, result: job.targetType === 'boundary' ? await BoundaryService.findById(job.targetId) : await RepresentativesService.findById(job.targetId) } : job);
});
