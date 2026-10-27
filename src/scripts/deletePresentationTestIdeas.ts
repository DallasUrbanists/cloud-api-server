/** Deletes the reviewed presentation test ideas from the production Firestore database. */
import 'dotenv/config';
import { Firestore, type DocumentData } from '@google-cloud/firestore';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IdeaService } from '../services/ideaService.js';
import { ideasCollectionName } from '../config/ideas.js';

// ID 16 was deliberately excluded because its description could represent a real submission.
export const CANDIDATE_IDS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
  17, 18, 19, 20, 21, 22,
  24, 25, 26, 27, 28, 29, 30,
  33, 37, 39,
] as const;

const EXPECTED_PROJECT = 'urbanists-mixer-slides-helper';
const EXPECTED_DATABASE = 'public-improvements';
const CONFIRMATION = 'DELETE 30 REVIEWED TEST IDEAS FROM PRODUCTION';

export async function deleteCandidates(db: Firestore, apply: boolean, reportPath: string) {
  const collection = ideasCollectionName();
  const refs = CANDIDATE_IDS.map(id => db.collection(collection).doc(String(id)));
  const docs = await db.getAll(...refs);
  const backup: Array<{ id: number; exists: boolean; data?: DocumentData }> = docs.map((doc, index) => ({
    id: CANDIDATE_IDS[index], exists: doc.exists, ...(doc.exists ? { data: doc.data() } : {}),
  }));
  // Save exact parent documents before deletion; create-only avoids overwriting a prior backup.
  await writeFile(resolve(reportPath), `${JSON.stringify({ project: EXPECTED_PROJECT, database: db.databaseId, mode: apply ? 'apply' : 'dry-run', candidateIds: CANDIDATE_IDS, backup }, null, 2)}\n`, { flag: 'wx' });
  const existingIds = docs.flatMap((doc, index) => doc.exists ? [CANDIDATE_IDS[index]] : []);
  if (apply) {
    for (const id of existingIds) await IdeaService.delete(id);
  }
  const remaining = await db.getAll(...existingIds.map(id => db.collection(collection).doc(String(id))));
  const leftovers = remaining.flatMap((doc, index) => doc.exists ? [existingIds[index]] : []);
  if (apply && leftovers.length) throw new Error(`Deletion verification failed for IDs: ${leftovers.join(', ')}`);
  return { mode: apply ? 'apply' : 'dry-run', candidates: CANDIDATE_IDS.length, found: existingIds, missing: CANDIDATE_IDS.filter(id => !existingIds.includes(id)), deleted: apply ? existingIds.length : 0, leftovers, backup: resolve(reportPath) };
}

export async function main(args = process.argv.slice(2)) {
  const options = new Map<string, string>(); let apply = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply' && !apply) { apply = true; continue; }
    if (!['--project', '--database', '--report', '--confirm'].includes(args[i]) || options.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Use --project <id> --database <id> --report <new-backup.json> [--apply --confirm "DELETE 30 REVIEWED TEST IDEAS FROM PRODUCTION"].');
    options.set(args[i], args[++i]);
  }
  const project = options.get('--project'); const database = options.get('--database'); const report = options.get('--report');
  if (project !== EXPECTED_PROJECT || database !== EXPECTED_DATABASE || !report) throw new Error(`Explicit production target required: --project ${EXPECTED_PROJECT} --database ${EXPECTED_DATABASE} --report <new-backup.json>.`);
  if (process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Refusing to run while FIRESTORE_EMULATOR_HOST is set; unset it to target production deliberately.');
  if (apply && options.get('--confirm') !== CONFIRMATION) throw new Error(`Apply requires --confirm "${CONFIRMATION}".`);
  process.env.GOOGLE_CLOUD_PROJECT = project;
  process.env.PUBLIC_IMPROVEMENTS_DB = database;
  const db = new Firestore({ projectId: project, databaseId: database });
  try { console.log(JSON.stringify(await deleteCandidates(db, apply, report), null, 2)); }
  finally { await db.terminate(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
