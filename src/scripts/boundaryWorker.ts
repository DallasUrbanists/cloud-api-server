/**
 * Standalone durable-job worker, intentionally separate from the HTTP server.
 *
 * @remarks
 * Requires explicit enablement and migrated PostgreSQL tables. Enqueues due boundary
 * research before processing jobs, then polls claim/execute
 * until shutdown and closes the pool. --once exits on an idle/error pass, not after
 * every successful job; this entrypoint must never be imported to start API work.
 * @module
 */
import 'dotenv/config';
import { pool } from '../config/db.js';
import { runBoundaryWorker } from '../services/boundaryWorkerService.js';

let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });
if (process.env.BOUNDARY_SYNC_ENABLED !== 'true') {
  console.error('Set BOUNDARY_SYNC_ENABLED=true before starting the boundary worker.');
  process.exitCode = 1;
} else {
  try {
    await pool.query('SELECT id FROM boundary_sync_jobs LIMIT 1');
    console.log('Boundary worker connected; enqueueing due research and processing durable PostgreSQL jobs.');
    if (!await runBoundaryWorker({ once: process.argv.includes('--once'), shouldStop: () => stopping })) process.exitCode = 1;
  } catch {
    console.error('Boundary worker could not connect to the migrated database.');
    process.exitCode = 1;
  }
}
await pool.end();
