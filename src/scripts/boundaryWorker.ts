import 'dotenv/config';
import { setTimeout as sleep } from 'node:timers/promises';
import { pool } from '../config/db.js';
import { BoundaryError } from '../models/boundary.js';
import { BoundarySyncService } from '../services/boundarySyncService.js';

let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
if (process.env.BOUNDARY_SYNC_ENABLED !== 'true') {
  console.error('Set BOUNDARY_SYNC_ENABLED=true before starting the boundary worker.');
  process.exitCode = 1;
} else {
  try {
    await pool.query('SELECT id FROM boundary_sync_jobs LIMIT 1');
    console.log('Boundary worker connected; polling durable PostgreSQL jobs.');
    do {
      try {
        const job = await BoundarySyncService.claim();
        if (job) { await BoundarySyncService.execute(job); continue; }
      } catch (error) {
        console.warn(error instanceof BoundaryError ? error.code : 'BOUNDARY_WORKER_UNAVAILABLE');
      }
      if (process.argv.includes('--once')) break;
      await sleep(2000);
    } while (!stopping);
  } catch {
    console.error('Boundary worker could not connect to the migrated database.');
    process.exitCode = 1;
  }
}
await pool.end();
