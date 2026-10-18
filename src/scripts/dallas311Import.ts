/** Preflight and resumable import of a selected, reviewed 311 seed artifact. */
import { validateRecommendableInput, type RecommendableInput } from '../models/recommendableAction.js';
import type { ManifestEntry, SeedManifest } from './dallas311Manifest.js';

export interface StoredSeed {
  id: string; sourceKey?: string; sourceTitle?: string; sourceType?: string;
  fingerprint?: string; summary?: string; status?: string;
}
export interface SeedStore {
  actions(): Promise<StoredSeed[]>;
  /** Upserts the same action in place; an unchanged fingerprint preserves its status. */
  create(entry: ManifestEntry, input: RecommendableInput): Promise<'created' | 'updated' | 'retained'>;
}
export interface ImportReport {
  created: string[]; updated: string[]; retained: string[]; held: string[]; skipped: string[];
  failed: { key: string; error: string }[];
  legacyOverlaps: { key: string; collection: 'recommendableActions'; id: string }[];
}

/** All validation, capacity, collision and pilot checks finish before the first write. */
export async function importManifest(manifest: SeedManifest, boundaryId: number, store: SeedStore, pilot = false): Promise<ImportReport> {
  if (!Number.isSafeInteger(boundaryId) || boundaryId < 1) throw new Error('An active Dallas citywide boundary is required.');
  const readyPilot = manifest.entries.filter(entry => entry.status === 'ready' && manifest.pilotKeys.includes(entry.key));
  const approved = new Set(manifest.review.approvedKeys);
  const selected = manifest.entries.filter(entry => entry.status === 'ready' && approved.has(entry.key) && (!pilot || manifest.pilotKeys.includes(entry.key)));
  if (!selected.length) throw new Error('No reviewed, eligible entries selected. Set review.approvedKeys in the manifest.');
  if (pilot && readyPilot.some(entry => !approved.has(entry.key))) throw new Error('Review every eligible pilot entry before importing the pilot.');
  if (!pilot && !manifest.review.pilotReviewed) throw new Error('Import and review the representative pilot first; then set review.pilotReviewed to true.');
  const inputs = new Map<string, RecommendableInput>();
  // Validate all eligible entries, including ones not selected in this batch.
  for (const entry of manifest.entries.filter(entry => entry.status === 'ready')) {
    const result = validateRecommendableInput({ ...entry.input, boundaries: [boundaryId] });
    if (!result.data) throw new Error(`${entry.key}: ${result.error}`);
    inputs.set(entry.key, result.data);
  }
  const actions = await store.actions();
  const existing = new Map(actions.map(item => [item.id, item]));
  if (!pilot && readyPilot.some(entry => {
    const stored = existing.get(entry.sourceKey);
    // Independently approved pilot edits must not force a bulk import to reset them.
    // Only excluded pilots may use this path; selected records still follow revision matching.
    return !stored || stored.sourceKey !== entry.sourceKey
      || (stored.fingerprint !== entry.fingerprint && !(stored.status === 'approved' && !approved.has(entry.key)));
  })) throw new Error('The current pilot revisions must be imported before a bulk import.');
  for (const entry of selected) {
    const stored = existing.get(entry.sourceKey);
    if (stored && stored.sourceKey !== entry.sourceKey) throw new Error(`Existing action identity conflict: ${entry.key}`);
  }
  const newActions = selected.filter(entry => !existing.has(entry.sourceKey)).length;
  if (actions.length + newActions > 500) throw new Error('Seed would exceed the current 500-record action listing limit. Add pagination before importing.');
  const report: ImportReport = { created: [], updated: [], retained: [], held: manifest.entries.filter(entry => entry.status === 'held').map(entry => entry.key),
    skipped: manifest.entries.filter(entry => entry.status === 'ready' && !selected.includes(entry)).map(entry => entry.key), failed: [], legacyOverlaps: [] };
  for (const entry of selected) {
    const titles = new Set(entry.members.map(member => member.title));
    for (const item of actions) {
      const legacy = (item.sourceKey?.startsWith('dallas311:') && !item.sourceKey.startsWith('dallas311:inventory:')) || (item.id.startsWith('dallas311-') && !item.sourceKey?.startsWith('dallas311:inventory:'));
      if (legacy && (titles.has(item.sourceTitle ?? '') || item.summary === entry.input.summary || !item.sourceTitle)) report.legacyOverlaps.push({ key: entry.key, collection: 'recommendableActions', id: item.id });
    }
  }
  for (const entry of selected) {
    if (existing.get(entry.sourceKey)?.fingerprint === entry.fingerprint) { report.retained.push(entry.key); continue; }
    try { report[await store.create(entry, inputs.get(entry.key)!)].push(entry.key); }
    catch (error) { report.failed.push({ key: entry.key, error: error instanceof Error ? error.message : String(error) }); }
  }
  return report;
}
