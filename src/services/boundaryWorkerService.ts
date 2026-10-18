import { setTimeout as sleep } from 'node:timers/promises';
import { BoundaryError } from '../models/boundary.js';
import { BoundarySyncService } from './boundarySyncService.js';

/** Enqueues due research before draining jobs; continuous workers rescan once per minute. */
export async function runBoundaryWorker(options: { once?: boolean; shouldStop?: () => boolean } = {}): Promise<boolean> {
  let nextScan = 0;
  let successful = true;
  while (!options.shouldStop?.()) {
    if (Date.now() >= nextScan) {
      nextScan = Date.now() + 60000;
      try {
        const result = await BoundarySyncService.enqueueDueResearch();
        console.log(JSON.stringify({ event: 'boundary_research_enqueued', queued: result.queued, skipped: result.skipped.length }));
        for (const skipped of result.skipped) console.warn(JSON.stringify({ event: 'boundary_research_enqueue_skipped', ...skipped }));
      } catch (error) {
        successful = false;
        console.warn(error instanceof BoundaryError ? error.code : 'BOUNDARY_RESEARCH_ENQUEUE_FAILED');
      }
    }
    if (options.shouldStop?.()) break;
    try {
      const job = await BoundarySyncService.claim();
      if (job) {
        if (await BoundarySyncService.execute(job) === 'failed') successful = false;
        continue;
      }
    } catch (error) {
      successful = false;
      console.warn(error instanceof BoundaryError ? error.code : 'BOUNDARY_WORKER_UNAVAILABLE');
    }
    if (options.once) break;
    await sleep(2000);
  }
  return successful;
}
