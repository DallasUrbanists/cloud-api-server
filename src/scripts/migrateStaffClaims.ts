import 'dotenv/config';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { migrateStaffClaims, type StaffMigrationCheckpoint } from '../services/staffClaimMigration.js';

export async function runStaffClaimMigration(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: {
    project: { type: 'string' }, apply: { type: 'boolean', default: false },
    checkpoint: { type: 'string' }, cursor: { type: 'string' },
  } });
  if (!values.project) throw new Error('Explicit --project is required.');
  if (values.apply && !values.checkpoint) throw new Error('--apply requires --checkpoint <file>.');
  if (!values.apply && values.checkpoint) throw new Error('--checkpoint is only valid with --apply; dry runs never write checkpoints.');
  let cursor = values.cursor;
  const checkpointPath = values.checkpoint ? resolve(values.checkpoint) : undefined;
  if (checkpointPath) {
    let saved: unknown;
    try { saved = JSON.parse(await readFile(checkpointPath, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (saved !== undefined) {
      if (!saved || typeof saved !== 'object') throw new Error('Invalid checkpoint.');
      const checkpoint = saved as StaffMigrationCheckpoint;
      if (checkpoint.projectId !== values.project || typeof checkpoint.completed !== 'boolean'
        || (checkpoint.pageToken !== undefined && typeof checkpoint.pageToken !== 'string')
        || (!checkpoint.completed && !checkpoint.pageToken)) throw new Error('Invalid checkpoint or project mismatch.');
      if (values.cursor) throw new Error('Use either an existing checkpoint or --cursor, not both.');
      if (checkpoint.completed) { console.info('Migration already completed; use a new checkpoint for another full scan.'); return; }
      cursor = checkpoint.pageToken;
    }
  }
  // Independent app, explicitly project-bound. Only CLI execution contacts Firebase.
  const app = initializeApp({ projectId: values.project }, 'staff-claims-migration');
  try {
    const result = await migrateStaffClaims(getAuth(app), {
      projectId: values.project, apply: values.apply, cursor,
      audit: entry => console.info(JSON.stringify(entry)),
      saveCheckpoint: checkpointPath ? async checkpoint => {
        const temporary = `${checkpointPath}.tmp`;
        await writeFile(temporary, JSON.stringify(checkpoint), { mode: 0o600 });
        await rename(temporary, checkpointPath);
      } : undefined,
    });
    console.info(JSON.stringify({ event: 'staff_claim_migration', projectId: values.project, ...result }));
  } finally { await deleteApp(app); }
}

export function reportMigrationFailure(error: unknown): void {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  const message = error instanceof Error ? error.message : 'Unknown error.';
  console.error(`Staff claim migration failed${code ? ` (${code})` : ''}: ${message}`);
  console.error('Check project, Application Default Credentials and Firebase Auth permissions. For interrupted apply runs, retry with the same checkpoint.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runStaffClaimMigration(process.argv.slice(2)).catch(error => {
    reportMigrationFailure(error);
    process.exitCode = 1;
  });
}
