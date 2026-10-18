/** Adds captured 311 photos without changing action text, eligibility or review status. */
import 'dotenv/config';
import { Firestore, type DocumentData } from '@google-cloud/firestore';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { validateRecommendablePhotos } from '../models/recommendableAction.js';
import { captured311Photos } from './dallas311Photos.js';
import { readSeedSources, type SeedSources } from './dallas311Manifest.js';

export interface PhotoBackfillRecord { id: string; data: DocumentData }
export interface PhotoBackfillPlan extends PhotoBackfillRecord { photos: string[]; sourceFiles: string[]; changed: boolean }

export function planPhotoBackfill(records: PhotoBackfillRecord[], sources: SeedSources): PhotoBackfillPlan[] {
  const groups = new Map(sources.mapping.groups.map(group => [`dallas311:inventory:${group.key}`, group]));
  return records.filter(record => ['candidate', 'approved'].includes(record.data.status)).map(record => {
    const existing = validateRecommendablePhotos(record.data.photos);
    if (existing.error) throw new Error(`${record.id}: ${existing.error}`);
    const imported = record.data.sourceType === 'dallas311' || record.data.sourceKey?.startsWith('dallas311:inventory:');
    const group = imported ? groups.get(record.data.sourceKey) : undefined;
    if (imported && !group) throw new Error(`Unknown imported 311 action: ${record.id}`);
    const sourceFiles = [...new Set(group?.members.map(member => member.file) ?? [])];
    const photos = [...new Set([...existing.photos!, ...captured311Photos(sourceFiles, sources.records)])];
    return { ...record, photos, sourceFiles, changed: !isDeepStrictEqual(record.data.photos, photos) };
  });
}

export async function backfillPhotos(db: Firestore, sources: SeedSources, apply: boolean, reportPath: string) {
  const snapshot = await db.collection('recommendableActions').get();
  const plans = planPhotoBackfill(snapshot.docs.map(doc => ({ id: doc.id, data: doc.data() })), sources);
  // The report doubles as a full pre-change backup and must exist before the first write.
  const report: { mode: string; database: string; plans: PhotoBackfillPlan[]; updated: string[]; retained: string[]; failed: { id: string; error: string }[] } = {
    mode: apply ? 'apply' : 'dry-run', database: db.databaseId, plans, updated: [], retained: [], failed: [],
  };
  await writeFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  if (apply) for (const plan of plans) {
    if (!plan.changed) { report.retained.push(plan.id); continue; }
    try {
      const ref = db.collection('recommendableActions').doc(plan.id);
      await db.runTransaction(async tx => {
        const current = (await tx.get(ref)).data();
        if (!current || !isDeepStrictEqual(current, plan.data)) throw new Error('Action changed after preflight; retry with a new report.');
        const previousVersion = Number(current.version) || 1;
        const previousRef = ref.collection('versions').doc(String(previousVersion));
        const previousSnapshot = await tx.get(previousRef);
        const updatedAt = new Date().toISOString();
        const updated = { ...current, photos: plan.photos, version: previousVersion + 1, updatedAt };
        if (!previousSnapshot.exists) tx.set(previousRef, { ...current, versionCreatedAt: current.updatedAt ?? updatedAt });
        tx.set(ref.collection('versions').doc(String(updated.version)), { ...updated, versionCreatedAt: updatedAt });
        tx.update(ref, { photos: plan.photos, version: updated.version, updatedAt });
      });
      report.updated.push(plan.id);
    } catch (error) { report.failed.push({ id: plan.id, error: error instanceof Error ? error.message : String(error) }); }
  }
  if (apply) await writeFile(resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`);
  return { mode: report.mode, selected: plans.length, plannedUpdates: plans.filter(plan => plan.changed).length,
    withPhotos: plans.filter(plan => plan.photos.length).length, emptyPhotos: plans.filter(plan => !plan.photos.length).length,
    approved: plans.filter(plan => plan.data.status === 'approved').length, candidates: plans.filter(plan => plan.data.status === 'candidate').length,
    updated: report.updated.length, retained: report.retained.length, failed: report.failed, backup: reportPath };
}

export async function main(args = process.argv.slice(2)) {
  const options = new Map<string, string>(); let apply = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply' && !apply) { apply = true; continue; }
    if (!['--project', '--database', '--report'].includes(args[i]) || options.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Use --project <id> --database <id> --report <new.json> [--apply].');
    options.set(args[i], args[++i]);
  }
  const projectId = options.get('--project'); const databaseId = options.get('--database'); const report = options.get('--report');
  if (!projectId || !databaseId || !report) throw new Error('Explicit --project, --database and --report are required.');
  const sources = await readSeedSources();
  const db = new Firestore({ projectId, databaseId, ...(process.env.GOOGLE_APPLICATION_CREDENTIALS ? { keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS } : {}) });
  try {
    const result = await backfillPhotos(db, sources, apply, report);
    console.log(JSON.stringify({ project: projectId, ...result }, null, 2));
    if (result.failed.length) process.exitCode = 1;
  } finally { await db.terminate(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
