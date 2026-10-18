/** Offline 311 seed generation; import requires an explicitly selected reviewed artifact. */
import 'dotenv/config';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildManifest, hash, readSeedSources, validateManifest, type SeedManifest } from './dallas311Manifest.js';
import { importManifest, type SeedStore, type StoredSeed } from './dallas311Import.js';

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = new Set(['--output', '--manifest', '--report', '--apply', '--pilot', '--force']);
  const values = new Map<string, string>(); const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!options.has(arg) || flags.has(arg) || values.has(arg)) throw new Error(`Unknown or repeated option: ${arg}`);
    if (['--output', '--manifest', '--report'].includes(arg)) {
      const value = args[++i]; if (!value || value.startsWith('--')) throw new Error(`${arg} requires a path.`);
      values.set(arg, value);
    } else flags.add(arg);
  }
  const apply = flags.has('--apply');
  if (apply && (!values.has('--manifest') || !values.has('--report'))) throw new Error('--apply requires --manifest <reviewed.json> and --report <new-report.json>.');
  if (!apply && (values.has('--manifest') || values.has('--report') || flags.has('--pilot'))) throw new Error('--manifest, --report and --pilot require --apply.');
  if (apply && (values.has('--output') || flags.has('--force'))) throw new Error('Generation/output replacement cannot be combined with import.');
  const sources = await readSeedSources();
  if (!apply) {
    const manifest = buildManifest(sources);
    validateManifest(manifest, sources);
    if (values.has('--output')) await writeFile(resolve(values.get('--output')!), `${JSON.stringify(manifest, null, 2)}\n`, { flag: flags.has('--force') ? 'w' : 'wx' });
    console.log(JSON.stringify({ mode: 'draft', sourceActions: manifest.entries.reduce((sum, entry) => sum + entry.members.length, 0),
      groups: manifest.entries.length, ready: manifest.entries.filter(entry => entry.status === 'ready').length,
      held: manifest.entries.filter(entry => entry.status === 'held').length, pilotKeys: manifest.pilotKeys,
      output: values.get('--output') ?? null, databaseWrites: 0 }, null, 2));
    return;
  }
  const manifestPath = resolve(values.get('--manifest')!);
  const reportPath = resolve(values.get('--report')!);
  if (manifestPath === reportPath) throw new Error('Report must not replace the manifest.');
  const manifest: SeedManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  validateManifest(manifest, sources);
  // Reserve the report before any database writes, including when the destination already exists.
  const { open } = await import('node:fs/promises');
  const reportFile = await open(reportPath, 'wx');
  let db: ReturnType<typeof import('../config/firestore.js')['getPublicImprovementsDb']> | undefined;
  let pool: typeof import('../config/db.js')['pool'] | undefined;
  try {
    const [{ getPublicImprovementsDb }, dbConfig, { BoundaryService }] = await Promise.all([
      import('../config/firestore.js'), import('../config/db.js'), import('../services/boundaryService.js'),
    ]);
    pool = dbConfig.pool; db = getPublicImprovementsDb();
    const cityBoundaries = (await BoundaryService.findAll({ entity: 'City of Dallas', limit: 500 }))
      .filter(boundary => boundary.entityName === 'City of Dallas' && boundary.bodyName === null && boundary.districtName === null && boundary.shape !== null && !boundary.shapePending && boundary.isInEffect);
    if (cityBoundaries.length !== 1) throw new Error('Expected exactly one active City of Dallas municipal boundary with a shape. Run/review the boundary seed first.');
    const database = db;
    const list = async (collection: string): Promise<StoredSeed[]> => (await database.collection(collection).get()).docs.map(doc => ({ ...doc.data(), id: doc.id }));
    const store: SeedStore = {
      actions: () => list('recommendableActions'),
      create: async (entry, input) => {
        const ref = database.collection('recommendableActions').doc(entry.sourceKey);
        const now = new Date().toISOString();
        return database.runTransaction(async tx => {
          const current = (await tx.get(ref)).data();
          if (current && current.sourceKey !== entry.sourceKey) throw new Error(`Action identity conflict: ${entry.key}`);
          if (current?.fingerprint === entry.fingerprint) return 'retained';
          const version = current ? (Number(current.version) || 1) + 1 : 1;
          const previousRef = ref.collection('versions').doc(String(current?.version ?? 1));
          const previousSnapshot = current ? await tx.get(previousRef) : undefined;
          const data = { ...current, ...input, sourceKey: entry.sourceKey, sourceType: 'dallas311', fingerprint: entry.fingerprint,
            sourceTitle: entry.members.find(member => member.id === entry.primaryMemberId)!.title,
            seedRevisionId: entry.candidateId,
            seedManifestHash: hash(manifest), seedProvenance: entry.members, consolidationDecision: entry.decision,
            status: 'candidate', version, createdAt: current?.createdAt ?? now, updatedAt: now };
          if (current && !previousSnapshot?.exists) tx.set(previousRef, current);
          tx.set(ref, data);
          tx.set(ref.collection('versions').doc(String(version)), { ...data, versionCreatedAt: now });
          return current ? 'updated' : 'created';
        });
      },
    };
    const report = await importManifest(manifest, cityBoundaries[0].id, store, flags.has('--pilot'));
    await reportFile.writeFile(`${JSON.stringify({ manifestPath, manifestHash: hash(manifest), boundaryId: cityBoundaries[0].id, ...report }, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
    if (report.failed.length) process.exitCode = 1;
  } catch (error) {
    await reportFile.writeFile(`${JSON.stringify({ manifestPath, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
    throw error;
  } finally {
    await reportFile.close();
    await Promise.all([db?.terminate(), pool?.end()]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
