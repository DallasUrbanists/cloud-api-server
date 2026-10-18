/** Consolidates legacy review records into recommendableActions without losing fields. */
import 'dotenv/config';
import { Firestore, type DocumentData } from '@google-cloud/firestore';
import { isDeepStrictEqual } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// These names are intentionally confined to the one-time migration.
export const LEGACY_COLLECTIONS = ['recommendableActionCandidates', 'recommendableActionSubmissions'];
export const ACTIONS_COLLECTION = 'recommendableActions';
export interface MigrationRecord { path: string; data: DocumentData }
export interface MigrationMove extends MigrationRecord { targetPath: string }

/** Refuse conflicting identities rather than choosing which review/publication to discard. */
export function planActionMigration(records: MigrationRecord[], targets: MigrationRecord[]): MigrationMove[] {
  const known = new Map(targets.map(record => [record.path, record.data]));
  return records.map(record => {
    if (!LEGACY_COLLECTIONS.some(collection => record.path.startsWith(`${collection}/`) && record.path.split('/').length === 2)) throw new Error(`Unexpected legacy path: ${record.path}`);
    const identity = typeof record.data.sourceKey === 'string' ? record.data.sourceKey : record.path.split('/')[1];
    if (!identity || identity.includes('/') || Buffer.byteLength(identity) > 1500 || identity === '.' || identity === '..') throw new Error(`Invalid action identity: ${record.path}`);
    const targetPath = `${ACTIONS_COLLECTION}/${identity}`;
    if (known.has(targetPath) && !isDeepStrictEqual(known.get(targetPath), record.data)) throw new Error(`Conflicting records for ${targetPath}; no documents were migrated.`);
    known.set(targetPath, record.data);
    return { ...record, targetPath };
  });
}

export async function migrateActions(db: Firestore, apply: boolean, reportPath: string) {
  const [legacy, destination] = await Promise.all([
    Promise.all(LEGACY_COLLECTIONS.map(collection => db.collection(collection).get())),
    db.collection(ACTIONS_COLLECTION).get(),
  ]);
  const documents = legacy.flatMap(snapshot => snapshot.docs);
  // The deployed review model has no child collections. Stop rather than orphan unknown data.
  for (const document of documents) {
    if ((await document.ref.listCollections()).length) throw new Error(`Legacy subcollections require an explicit migration: ${document.ref.path}`);
  }
  if (documents.length > 200) throw new Error('More than 200 legacy records; a paginated migration is required.');
  const moves = planActionMigration(documents.map(doc => ({ path: doc.ref.path, data: doc.data() })), destination.docs.map(doc => ({ path: doc.ref.path, data: doc.data() })));
  // Persist the complete source data and paths before any deletes. Never overwrite a backup.
  await writeFile(resolve(reportPath), `${JSON.stringify({ database: db.databaseId, mode: apply ? 'apply' : 'dry-run', moves }, null, 2)}\n`, { flag: 'wx' });
  if (apply && moves.length) {
    await db.runTransaction(async tx => {
      const reads = await tx.getAll(...moves.flatMap(move => [db.doc(move.path), db.doc(move.targetPath)]));
      for (const [index, move] of moves.entries()) {
        const source = reads[index * 2]; const target = reads[index * 2 + 1];
        if (!source.exists || !isDeepStrictEqual(source.data(), move.data)) throw new Error(`Source changed during migration: ${move.path}`);
        if (target.exists && !isDeepStrictEqual(target.data(), move.data)) throw new Error(`Target changed during migration: ${move.targetPath}`);
      }
      for (const move of moves) {
        tx.set(db.doc(move.targetPath), move.data);
        tx.delete(db.doc(move.path));
      }
    });
  }
  const [remaining, current] = await Promise.all([
    Promise.all(LEGACY_COLLECTIONS.map(collection => db.collection(collection).get())),
    db.collection(ACTIONS_COLLECTION).get(),
  ]);
  const verification = moves.map(move => {
    const doc = current.docs.find(doc => doc.ref.path === move.targetPath);
    return { from: move.path, to: move.targetPath, verified: !!doc && isDeepStrictEqual(doc.data(), move.data) };
  });
  if (apply && (remaining.some(snapshot => !snapshot.empty) || verification.some(row => !row.verified))) throw new Error('Post-migration verification failed; inspect source/target collections and backup.');
  return { mode: apply ? 'apply' : 'dry-run', migrated: apply ? moves.length : 0, planned: moves.length,
    remainingLegacy: remaining.reduce((sum, snapshot) => sum + snapshot.size, 0), actionCount: current.size, verification, backup: reportPath };
}

export async function main(args = process.argv.slice(2)) {
  const options = new Map<string, string>(); let apply = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply' && !apply) { apply = true; continue; }
    if (!['--project', '--database', '--report'].includes(args[i]) || options.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Use --project <id> --database <id> --report <new-backup.json> [--apply].');
    options.set(args[i], args[++i]);
  }
  const projectId = options.get('--project'); const databaseId = options.get('--database'); const report = options.get('--report');
  if (!projectId || !databaseId || !report) throw new Error('Explicit --project, --database and --report are required.');
  const db = new Firestore({ projectId, databaseId, ...(process.env.GOOGLE_APPLICATION_CREDENTIALS ? { keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS } : {}) });
  try { console.log(JSON.stringify(await migrateActions(db, apply, report), null, 2)); }
  finally { await db.terminate(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
