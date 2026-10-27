#!/usr/bin/env node
/** Report-only by default, resumable Firestore and owned-photo migration. */
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { Firestore, Timestamp, FieldValue } from '@google-cloud/firestore';
import { Storage, type File } from '@google-cloud/storage';
import dotenv from 'dotenv';

dotenv.config();

type Environment = 'staging' | 'production';
interface Args { environment: Environment; apply: boolean; maintenanceConfirmed: boolean; manifestPath?: string; }
interface MediaEntry { source: string; destination: string; md5Hash: string | null; crc32c: string | null; contentType: string | null; cacheControl: string | null; contentDisposition: string | null; contentEncoding: string | null; contentLanguage: string | null; customMetadata: Record<string, unknown> | null; storageClass: string | null; copied: boolean; }
interface MigrationReport {
  environment: Environment; project: string; database: string; mode: 'report-only' | 'apply';
  sourceCollection: string; destinationCollection: string; documents: number; orphanParents: number;
  documentWrites: number; identicalDestinations: number; documentDeletions: number; documentCollisions: string[];
  mediaObjects: number; destinationMediaObjects: number; mediaWrites: number; mediaCollisions: string[]; mediaManifest: MediaEntry[];
  mediaReferencesToRewrite: number; counterHighWaterMark: number; presentationSnapshotsUpdated: number;
  errors: string[];
}

export function argsFrom(argv: string[]): Args {
  const raw = new Map<string, string>();
  const flags = new Set<string>();
  for (const arg of argv) {
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const [name, value] = arg.slice(2).split('=', 2);
    if (value === undefined) flags.add(name); else raw.set(name, value);
  }
  const environment = raw.get('environment');
  if (environment !== 'staging' && environment !== 'production') throw new Error('Set --environment=staging or --environment=production.');
  const unknown = [...raw.keys(), ...flags].filter(name => !['environment', 'apply', 'maintenance-confirmed', 'manifest'].includes(name));
  if (unknown.length) throw new Error(`Unknown option: --${unknown[0]}`);
  if (raw.has('apply') || raw.has('maintenance-confirmed')) throw new Error('Use --apply and --maintenance-confirmed as flags, not key=value options.');
  const apply = flags.has('apply'), maintenanceConfirmed = flags.has('maintenance-confirmed');
  if (apply && !maintenanceConfirmed) throw new Error('Apply requires --maintenance-confirmed after the maintenance gate is active and writers are paused.');
  if (!apply && maintenanceConfirmed) throw new Error('--maintenance-confirmed is only valid with --apply.');
  const manifestPath = raw.get('manifest');
  return { environment, apply, maintenanceConfirmed, ...(manifestPath ? { manifestPath } : {}) };
}

export function targets(environment: Environment) {
  if (environment === 'staging') return {
    project: 'urbanists-mixer-slides-helper', database: 'public-improvements-staging',
    sourceBucket: 'urbanists-suggestion-photos-staging-143738155808',
    destinationBucket: 'urbanists-idea-photos-staging-143738155808',
  };
  return {
    project: 'urbanists-mixer-slides-helper', database: 'public-improvements',
    sourceBucket: 'urbanists-suggestion-photos', destinationBucket: 'urbanists-idea-photos',
  };
}

function normalizeData(value: any): any {
    if (value === null || value === undefined || typeof value !== 'object') return value;
    if (value instanceof Date) return { $date: value.toISOString() };
    if (value instanceof Timestamp) return { $timestamp: value.toMillis() };
    if (Buffer.isBuffer(value)) return { $bytes: value.toString('base64') };
    if (Array.isArray(value)) return value.map(normalizeData);
    if (typeof value.toMillis === 'function') return { $timestamp: value.toMillis() };
    if (typeof value.latitude === 'number' && typeof value.longitude === 'number' && value.constructor?.name === 'GeoPoint') {
      return { $geoPoint: [value.latitude, value.longitude] };
    }
    if (typeof value.path === 'string' && value.constructor?.name === 'DocumentReference') return { $reference: value.path };
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalizeData(value[key])]));
}

export function dataEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizeData(left)) === JSON.stringify(normalizeData(right));
}

function dataHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(normalizeData(value))).digest('hex');
}

function mediaObjectMap(manifest: MediaEntry[]): Map<string, string> {
  return new Map(manifest.map(entry => [entry.source, entry.destination]));
}

export function remapMediaUrl(value: string, objectMap: Map<string, string>, sourceBucket: string, destinationBucket: string): string {
  try {
    if (value.startsWith('gs://')) {
      const slash = value.indexOf('/', 5);
      if (slash < 0) return value;
      const bucket = value.slice(5, slash), object = decodeURIComponent(value.slice(slash + 1));
      if (bucket !== sourceBucket) return value;
      const target = objectMap.get(object);
      return target ? `gs://${destinationBucket}/${target}` : value;
    }
    const url = new URL(value);
    let bucket: string, objectPath: string;
    if (url.hostname === 'storage.googleapis.com' || url.hostname === 'storage.cloud.google.com') {
      const slash = url.pathname.indexOf('/', 1);
      if (slash < 0) return value;
      bucket = decodeURIComponent(url.pathname.slice(1, slash));
      objectPath = decodeURIComponent(url.pathname.slice(slash + 1));
    } else if (url.hostname === `${sourceBucket}.storage.googleapis.com`) {
      bucket = sourceBucket; objectPath = decodeURIComponent(url.pathname.slice(1));
    } else return value;
    if (bucket !== sourceBucket) return value;
    const target = objectMap.get(objectPath);
    if (!target) return value;
    const next = new URL(value);
    if (next.hostname === `${sourceBucket}.storage.googleapis.com`) next.hostname = `${destinationBucket}.storage.googleapis.com`;
    else next.pathname = `/${destinationBucket}/${target.split('/').map(encodeURIComponent).join('/')}`;
    return next.toString();
  } catch { return value; }
}

const MEDIA_FIELD = /(?:url|uri|image|photo|thumbnail|media)/i;
export function rewriteMediaFields(value: any, objectMap: Map<string, string>, sourceBucket: string, destinationBucket: string, fieldName = ''): { value: any; changes: number } {
  if (typeof value === 'string') {
    if (!MEDIA_FIELD.test(fieldName)) return { value, changes: 0 };
    const next = remapMediaUrl(value, objectMap, sourceBucket, destinationBucket);
    return { value: next, changes: next === value ? 0 : 1 };
  }
  if (value === null || typeof value !== 'object' || value instanceof Date || value instanceof Timestamp || value instanceof FieldValue) return { value, changes: 0 };
  if (Array.isArray(value)) {
    let changes = 0;
    const items = value.map(item => { const mapped = rewriteMediaFields(item, objectMap, sourceBucket, destinationBucket, fieldName); changes += mapped.changes; return mapped.value; });
    return { value: items, changes };
  }
  const output: Record<string, any> = {};
  let changes = 0;
  for (const [key, child] of Object.entries(value)) {
    const mapped = rewriteMediaFields(child, objectMap, sourceBucket, destinationBucket, key);
    output[key] = mapped.value; changes += mapped.changes;
  }
  return { value: output, changes };
}

export function presentationSnapshotRewrite(original: Record<string, any>, data: Record<string, any>, objectMap: Map<string, string>, sourceBucket: string, destinationBucket: string): boolean {
  const snapshot = data.contentSnapshot, oldSnapshot = original.contentSnapshot;
  if (!snapshot || !Array.isArray(snapshot.album) || !oldSnapshot || !Array.isArray(oldSnapshot.album) || !data.state) return false;
  const selected = new Map<string, string>();
  const seen = new Map<string, number>();
  let changed = false;
  for (let index = 0; index < snapshot.album.length; index++) {
    const item = snapshot.album[index], oldItem = oldSnapshot.album[index];
    if (!item || item.kind !== 'photo' || typeof item.url !== 'string') continue;
    const mappedUrl = remapMediaUrl(String(oldItem?.url ?? ''), objectMap, sourceBucket, destinationBucket);
    if (mappedUrl === String(oldItem?.url ?? '')) continue;
    let safeUrl: string;
    try {
      const parsed = new URL(mappedUrl);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) continue;
      parsed.search = ''; parsed.hash = ''; safeUrl = parsed.toString();
    } catch { continue; }
    const oldId = item.id;
    const identity = createHash('sha256').update(safeUrl).digest('hex').slice(0, 24);
    const duplicate = (seen.get(identity) ?? 0) + 1; seen.set(identity, duplicate);
    item.url = safeUrl;
    item.id = `photo:${identity}${duplicate > 1 ? `:${duplicate}` : ''}`;
    if (typeof oldItem?.id === 'string') selected.set(oldItem.id, item.id);
    changed = true;
  }
  if (!changed) return false;
  if (typeof data.state.albumItemId === 'string' && selected.has(data.state.albumItemId)) data.state.albumItemId = selected.get(data.state.albumItemId);
  const { contentVersion: _ignored, ...rawSnapshot } = snapshot;
  snapshot.contentVersion = createHash('sha256').update(JSON.stringify(rawSnapshot)).digest('hex');
  data.contentVersion = snapshot.contentVersion;
  const nextRevision = Math.max(Number(data.state.revision) || 0, Number(data.revision) || 0) + 1;
  data.state.revision = nextRevision;
  data.revision = nextRevision;
  data.contentRefreshUntilMs = 0;
  data.contentRefreshLeaseId = null;
  return true;
}

async function listFiles(bucket: ReturnType<Storage['bucket']>, prefix: string): Promise<File[]> {
  const result: File[] = [];
  let query: Record<string, unknown> | undefined = { prefix, autoPaginate: false, maxResults: 500 };
  while (query) {
    const [files, nextQuery] = await bucket.getFiles(query as any);
    result.push(...files);
    query = nextQuery as Record<string, unknown> | undefined;
  }
  return result;
}

async function walkCollection(collectionPath: string, visit: (path: string, exists: boolean, data?: Record<string, any>) => Promise<void>): Promise<void> {
  const db = activeDb;
  const collection = db.collection(collectionPath);
  // listDocuments includes missing parent refs that can still own orphaned descendants.
  const refs = await collection.listDocuments();
  for (const ref of refs) {
    const snapshot = await ref.get();
    await visit(ref.path, snapshot.exists, snapshot.exists ? snapshot.data() as Record<string, any> : undefined);
    for (const child of await ref.listCollections()) await walkCollection(child.path, visit);
  }
}

let activeDb: Firestore;

async function main(): Promise<void> {
  const args = argsFrom(process.argv.slice(2));
  const target = targets(args.environment);
  if (process.env.GOOGLE_CLOUD_PROJECT && process.env.GOOGLE_CLOUD_PROJECT !== target.project) throw new Error('GOOGLE_CLOUD_PROJECT does not match the explicit migration environment.');
  if (args.environment === 'production' && process.env.DEPLOY_ENV === 'staging') throw new Error('A staging process cannot target production.');
  if (args.environment === 'staging' && process.env.DEPLOY_ENV === 'production') throw new Error('A production process cannot target staging.');
  const firestoreOptions: ConstructorParameters<typeof Firestore>[0] = { projectId: target.project, databaseId: target.database };
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) firestoreOptions.keyFilename = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  activeDb = new Firestore(firestoreOptions);
  const storage = new Storage({ projectId: target.project, ...(process.env.GOOGLE_APPLICATION_CREDENTIALS ? { keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS } : {}) });
  const sourceBucket = storage.bucket(target.sourceBucket), destinationBucket = storage.bucket(target.destinationBucket);
  const [sourceBucketExists] = await sourceBucket.exists(), [destinationBucketExists] = await destinationBucket.exists();
  if (!sourceBucketExists) throw new Error('The explicit environment source photo bucket is unavailable.');
  if (!destinationBucketExists) throw new Error('The Ideas photo bucket must be provisioned and verified before migration.');
  const [sourceCounterSnap, destinationCounterSnap] = await Promise.all([activeDb.doc('_metadata/counters').get(), activeDb.doc('_metadata/counters').get()]);
  const sourceCounter = Number(sourceCounterSnap.data()?.lastSuggestionId ?? 0);
  let maxIdeaId = 0;
  const manifest: MediaEntry[] = [];
  const report: MigrationReport = {
    environment: args.environment, project: target.project, database: target.database,
    mode: args.apply ? 'apply' : 'report-only', sourceCollection: 'suggestion', destinationCollection: 'idea',
    documents: 0, orphanParents: 0, documentWrites: 0, identicalDestinations: 0, documentDeletions: 0, documentCollisions: [],
    mediaObjects: 0, destinationMediaObjects: 0, mediaWrites: 0, mediaCollisions: [], mediaManifest: manifest,
    mediaReferencesToRewrite: 0, counterHighWaterMark: 0, presentationSnapshotsUpdated: 0, errors: [],
  };
  const checkpoint = activeDb.doc('_metadata/ideaMigration');
  const saveCheckpoint = async (phase: string, extra: Record<string, unknown> = {}) => {
    if (!args.apply) return;
    await checkpoint.set({ environment: args.environment, phase, updatedAt: FieldValue.serverTimestamp(), ...extra }, { merge: true });
  };

  // Inventory owned media and detect all destination collisions before any writes.
  const sourceFiles = await listFiles(sourceBucket, 'suggestions/');
  const destinationFiles = await listFiles(destinationBucket, 'ideas/');
  const expectedDestinationObjects = new Set(sourceFiles.filter(file => file.name.startsWith('suggestions/'))
    .map(file => `ideas/${file.name.slice('suggestions/'.length)}`));
  for (const file of destinationFiles) if (!expectedDestinationObjects.has(file.name)) report.mediaCollisions.push(`destination-only:${file.name}`);
  report.mediaObjects = sourceFiles.length;
  report.destinationMediaObjects = destinationFiles.length;
  for (const file of sourceFiles) {
    const object = file.name;
    if (!object.startsWith('suggestions/')) continue;
    const destinationName = `ideas/${object.slice('suggestions/'.length)}`;
    const [sourceMeta] = await file.getMetadata();
    const destination = destinationBucket.file(destinationName);
    const [exists] = await destination.exists();
    let copied = false;
    let destinationMeta: Record<string, any> | undefined;
    if (exists) {
      [destinationMeta] = await destination.getMetadata();
      const checksumMatches = !!sourceMeta.md5Hash && sourceMeta.md5Hash === destinationMeta.md5Hash
        || !!sourceMeta.crc32c && sourceMeta.crc32c === destinationMeta.crc32c;
      if (!checksumMatches) report.mediaCollisions.push(object);
    } else if (!args.apply) report.mediaWrites++;
    const metadataMatches = !exists || ((sourceMeta.contentType ?? null) === (destinationMeta?.contentType ?? null)
      && (sourceMeta.cacheControl ?? null) === (destinationMeta?.cacheControl ?? null)
      && (sourceMeta.contentDisposition ?? null) === (destinationMeta?.contentDisposition ?? null)
      && (sourceMeta.contentEncoding ?? null) === (destinationMeta?.contentEncoding ?? null)
      && (sourceMeta.contentLanguage ?? null) === (destinationMeta?.contentLanguage ?? null)
      && (sourceMeta.storageClass ?? null) === (destinationMeta?.storageClass ?? null)
      && dataEqual(sourceMeta.metadata ?? null, destinationMeta?.metadata ?? null));
    if (exists && !metadataMatches) report.mediaCollisions.push(object);
    manifest.push({ source: object, destination: destinationName, md5Hash: sourceMeta.md5Hash ?? null,
      crc32c: sourceMeta.crc32c ?? null, contentType: sourceMeta.contentType ?? null,
      cacheControl: sourceMeta.cacheControl ?? null, contentDisposition: sourceMeta.contentDisposition ?? null,
      contentEncoding: sourceMeta.contentEncoding ?? null, contentLanguage: sourceMeta.contentLanguage ?? null,
      customMetadata: sourceMeta.metadata ?? null, storageClass: sourceMeta.storageClass ?? null, copied });
  }
  const objectMap = mediaObjectMap(manifest);
  const pendingDeletes: string[] = [];
  const ledgerRef = (path: string) => activeDb.doc(`_metadata/ideaMigrationDocuments/records/${createHash('sha256').update(path).digest('hex')}`);

  // Preflight every source document, including orphaned descendants and target collisions.
  const inspectCopy = async (path: string, exists: boolean, data?: Record<string, any>) => {
    if (exists) {
      report.documents++;
      const match = /^suggestion\/(\d+)$/.exec(path);
      if (match) {
        const id = Number(data?.id ?? match[1]); if (Number.isSafeInteger(id) && id > maxIdeaId) maxIdeaId = id;
      }
    } else report.orphanParents++;
    const targetPath = `idea/${path.slice('suggestion/'.length)}`;
    const destination = activeDb.doc(targetPath), targetSnapshot = await destination.get();
    if (!exists) return;
    const transformed = rewriteMediaFields(data, objectMap, target.sourceBucket, target.destinationBucket).value;
    report.mediaReferencesToRewrite += rewriteMediaFields(data, objectMap, target.sourceBucket, target.destinationBucket).changes;
    if (targetSnapshot.exists) {
      if (dataEqual(targetSnapshot.data(), transformed)) { if (!args.apply) report.identicalDestinations++; }
      else report.documentCollisions.push(path);
    } else if (!args.apply) report.documentWrites++;
  };
  await walkCollection('suggestion', inspectCopy);
  // Reconcile stale destinations only when a prior run's ledger proves ownership and unchanged content.
  await walkCollection('idea', async (path, exists, data) => {
    if (!exists || !data) return;
    const sourcePath = `suggestion/${path.slice('idea/'.length)}`;
    if ((await activeDb.doc(sourcePath).get()).exists) return;
    const ledger = await ledgerRef(path).get();
    if (ledger.exists && ledger.get('destinationHash') === dataHash(data) && ledger.get('destinationPath') === path) {
      pendingDeletes.push(path); report.documentDeletions++;
    } else report.documentCollisions.push(`destination-only:${path}`);
  });
  const existingIdeaCounter = Number(destinationCounterSnap.data()?.lastIdeaId ?? 0);
  report.counterHighWaterMark = Math.max(sourceCounter, maxIdeaId, existingIdeaCounter);
  report.mediaCollisions = [...new Set(report.mediaCollisions)];
  report.documentCollisions = [...new Set(report.documentCollisions)];
  if (report.mediaCollisions.length || report.documentCollisions.length) {
    report.errors.push('Destination collisions must be resolved before applying this migration. No writes were attempted.');
  }

  if (args.apply && report.errors.length === 0) {
    await saveCheckpoint('media-copy-started', { sourceObjects: report.mediaObjects, sourceDocuments: report.documents });
    for (let index = 0; index < sourceFiles.length; index++) {
      const source = sourceFiles[index];
      if (!source.name.startsWith('suggestions/')) continue;
      const entry = manifest.find(item => item.source === source.name)!;
      const destination = destinationBucket.file(entry.destination);
      const [alreadyExists] = await destination.exists();
      if (alreadyExists) {
        const [meta] = await destination.getMetadata();
        const checksumMatches = (entry.md5Hash && meta.md5Hash === entry.md5Hash) || (entry.crc32c && meta.crc32c === entry.crc32c);
        if (!checksumMatches || (entry.contentType && meta.contentType !== entry.contentType)
          || (entry.cacheControl && meta.cacheControl !== entry.cacheControl)
          || (entry.contentDisposition && meta.contentDisposition !== entry.contentDisposition)
          || (entry.contentEncoding && meta.contentEncoding !== entry.contentEncoding)
          || (entry.contentLanguage && meta.contentLanguage !== entry.contentLanguage)
          || (entry.storageClass && meta.storageClass !== entry.storageClass)
          || !dataEqual(meta.metadata ?? null, entry.customMetadata)) throw new Error(`Media collision appeared during apply at ${entry.source}; stop and investigate.`);
        entry.copied = true;
      } else {
        await source.copy(destination, { preconditionOpts: { ifGenerationMatch: 0 } });
        let [meta] = await destination.getMetadata();
        if (entry.storageClass && meta.storageClass !== entry.storageClass) {
          await destination.setStorageClass(entry.storageClass);
          [meta] = await destination.getMetadata();
        }
        const checksumMatches = (entry.md5Hash && meta.md5Hash === entry.md5Hash) || (entry.crc32c && meta.crc32c === entry.crc32c);
        if (!checksumMatches || (entry.contentType && meta.contentType !== entry.contentType)
          || (entry.cacheControl && meta.cacheControl !== entry.cacheControl)
          || (entry.contentDisposition && meta.contentDisposition !== entry.contentDisposition)
          || (entry.contentEncoding && meta.contentEncoding !== entry.contentEncoding)
          || (entry.contentLanguage && meta.contentLanguage !== entry.contentLanguage)
          || (entry.storageClass && meta.storageClass !== entry.storageClass)
          || !dataEqual(meta.metadata ?? null, entry.customMetadata)) throw new Error(`Copied media verification failed for ${entry.source}.`);
        entry.copied = true; report.mediaWrites++;
      }
    }
    for (const entry of manifest) {
      const sourceObject = entry.source, destinationObject = entry.destination;
      const manifestId = createHash('sha256').update(`${target.sourceBucket}/${sourceObject}`).digest('hex');
      await activeDb.doc(`_metadata/ideaMediaManifest/records/${manifestId}`).set({
        sourceBucket: target.sourceBucket, sourceObject, destinationBucket: target.destinationBucket,
        destinationObject, destinationUrl: `https://storage.googleapis.com/${target.destinationBucket}/${destinationObject.split('/').map(encodeURIComponent).join('/')}`,
        md5Hash: entry.md5Hash, crc32c: entry.crc32c,
      }, { merge: true });
    }
    await saveCheckpoint('media-copy-verified', { mediaObjects: report.mediaObjects });

    const copyDoc = async (path: string, exists: boolean, data?: Record<string, any>) => {
      if (!exists) return;
      const targetPath = `idea/${path.slice('suggestion/'.length)}`;
      const transformed = rewriteMediaFields(data, objectMap, target.sourceBucket, target.destinationBucket).value;
      const destination = activeDb.doc(targetPath), existing = await destination.get();
      if (!existing.exists) { await destination.create(transformed); report.documentWrites++; }
      else if (!dataEqual(existing.data(), transformed)) throw new Error(`Document collision appeared during apply at ${path}; stop and investigate.`);
      else report.identicalDestinations++;
      await ledgerRef(targetPath).set({ sourcePath: path, destinationPath: targetPath, destinationHash: dataHash(transformed), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    };
    await saveCheckpoint('firestore-copy-started');
    await walkCollection('suggestion', copyDoc);
    await saveCheckpoint('firestore-copy-verified');

    // Leaf-first deletion removes only unchanged destination documents recorded by this migration.
    for (const path of pendingDeletes.sort((left, right) => right.split('/').length - left.split('/').length)) {
      const current = await activeDb.doc(path).get(), ledger = await ledgerRef(path).get();
      if (current.exists && ledger.exists && ledger.get('destinationHash') === dataHash(current.data()) && ledger.get('destinationPath') === path) {
        await activeDb.doc(path).delete();
        await ledgerRef(path).delete();
      } else if (current.exists) throw new Error(`Reconciliation collision appeared during apply at ${path}; stop and investigate.`);
    }
    await saveCheckpoint('deletions-reconciled', { documentDeletions: report.documentDeletions });

    // Rewrite owned media references across the database, but keep the source tree untouched for rollback.
    const topLevel = await activeDb.listCollections();
    for (const collection of topLevel) {
      if (collection.id === 'suggestion') continue;
      await walkCollection(collection.path, async (path, exists, data) => {
        if (!exists || !data) return;
        const rewritten = rewriteMediaFields(data, objectMap, target.sourceBucket, target.destinationBucket);
        if (!rewritten.changes) return;
        if (path.startsWith('presentationSessions/')) {
          if (presentationSnapshotRewrite(data, rewritten.value, objectMap, target.sourceBucket, target.destinationBucket)) report.presentationSnapshotsUpdated++;
        }
        await activeDb.doc(path).set(rewritten.value);
        report.mediaReferencesToRewrite += rewritten.changes;
      });
    }
    await saveCheckpoint('references-rewritten', { mediaReferencesToRewrite: report.mediaReferencesToRewrite, presentationSnapshotsUpdated: report.presentationSnapshotsUpdated });
    const counterRef = activeDb.doc('_metadata/counters');
    await counterRef.set({ lastIdeaId: report.counterHighWaterMark }, { merge: true });
    await saveCheckpoint('complete', { counterHighWaterMark: report.counterHighWaterMark, mediaReferencesToRewrite: report.mediaReferencesToRewrite });
  } else {
    // Estimate external URL changes without modifying any data; source-tree changes were counted in preflight.
    const topLevel = await activeDb.listCollections();
    for (const collection of topLevel) {
      if (collection.id === 'suggestion') continue;
      await walkCollection(collection.path, async (path, exists, data) => {
        if (!exists || !data) return;
        const rewritten = rewriteMediaFields(data, objectMap, target.sourceBucket, target.destinationBucket);
        if (!rewritten.changes) return;
        report.mediaReferencesToRewrite += rewritten.changes;
        if (path.startsWith('presentationSessions/') && presentationSnapshotRewrite(data, rewritten.value, objectMap, target.sourceBucket, target.destinationBucket)) report.presentationSnapshotsUpdated++;
      });
    }
    if (args.manifestPath) await writeFile(args.manifestPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  if (args.manifestPath && args.apply) await writeFile(args.manifestPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
  await activeDb.terminate();
  if (report.errors.length) process.exitCode = 2;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Idea migration failed.');
    if (activeDb) void activeDb.terminate().catch(() => undefined);
    process.exitCode = 1;
  });
}
