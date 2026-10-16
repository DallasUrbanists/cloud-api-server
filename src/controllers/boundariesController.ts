import type { NextFunction, Request, Response } from 'express';
import { BoundaryError } from '../models/boundary.js';
import { BoundaryService } from '../services/boundaryService.js';
import { BoundarySyncService } from '../services/boundarySyncService.js';
import { RepresentativesService } from '../services/representativesService.js';
import { parseBoundarySearch, positiveId } from '../utils/boundaryQuery.js';

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
export const listBoundaries = boundaryHandler(async (req, res) => {
  res.json(await BoundaryService.findAll(await parseBoundarySearch(req)));
});
export const getBoundary = boundaryHandler(async (req, res) => {
  res.json(await BoundaryService.findById(positiveId(req.params.id)));
});
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
export const getSyncJob = boundaryHandler(async (req, res) => {
  const id = req.params.id;
  if (typeof id !== 'string' || !/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) throw new BoundaryError(400, 'INVALID_ID', 'Job ID must be a positive PostgreSQL bigint.');
  const job = await BoundarySyncService.status(id);
  res.json(job.status === 'succeeded' ? { ...job, result: job.targetType === 'boundary' ? await BoundaryService.findById(job.targetId) : await RepresentativesService.findById(job.targetId) } : job);
});
