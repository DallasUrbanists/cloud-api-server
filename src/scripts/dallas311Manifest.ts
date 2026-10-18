/** Offline conversion of captured Dallas 311 actions into traceable review drafts. */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateRecommendableInput, type RecommendableInput } from '../models/recommendableAction.js';
import { captured311Photos } from './dallas311Photos.js';
import { formatDallas311Instructions } from './dallas311Instructions.js';

export const NO_EXCLUSION = '';
export const EXCLUDED_FILES = ['test-crm.json', 'test-sr-s-name.json'];
export const BOUNDARY_KEY = 'city:dallas';
export interface SavedAction {
  tagline: string; why: string; why_not: string | null;
  what: string; who: string; how: string; how_formatted: string;
}
export interface SavedRecord {
  photoUrls?: string[];
  title: string; actions?: SavedAction[]; sourcePortalUrl: string; serviceRequestUrl?: string;
  [key: string]: unknown;
}
export interface EvidenceRef { file: string; pointer: string }
export interface MappingMember {
  id: string; file: string; actionHash: string; evidence: EvidenceRef[];
}
export interface MappingGroup {
  key: string; decision: string; primaryMemberId: string; members: MappingMember[];
}
export interface SeedMapping { schemaVersion: 1; groups: MappingGroup[] }
export interface Observation extends EvidenceRef { value: string; hash: string }
export interface ManifestMember extends MappingMember {
  actionPointer: string; originalAction: SavedAction; title: string;
  observations: Observation[]; disposition: 'included' | 'merged' | 'held';
}
export interface ManifestEntry {
  key: string; sourceKey: string; candidateId: string; fingerprint: string;
  decision: string; primaryMemberId: string; members: ManifestMember[];
  input: Omit<RecommendableInput, 'boundaries'>;
  status: 'ready' | 'held'; holdReasons: string[];
}
export interface SeedManifest {
  schemaVersion: 1; boundarySourceKey: typeof BOUNDARY_KEY;
  sources: { file: string; hash: string }[];
  mappingHash: string; questionsHash: string;
  excludedFiles: string[]; entries: ManifestEntry[];
  pilotKeys: string[];
  review: { pilotReviewed: boolean; approvedKeys: string[] };
}
export interface SeedSources { records: Record<string, SavedRecord>; mapping: SeedMapping; questions: string }

/** Canonical JSON makes fingerprints insensitive to object property ordering. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function hash(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }

export function atPointer(value: unknown, pointer: string): unknown {
  if (!pointer.startsWith('/')) throw new Error(`Invalid evidence pointer: ${pointer}`);
  return pointer.slice(1).split('/').reduce<unknown>((node, part) => {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    return node && typeof node === 'object' && Object.hasOwn(node, key) ? (node as Record<string, unknown>)[key] : undefined;
  }, value);
}

export async function readSeedSources(root = process.cwd()): Promise<SeedSources> {
  const dir = resolve(root, 'data/311');
  const records: Record<string, SavedRecord> = {};
  for (const file of (await readdir(dir)).filter(file => file.endsWith('.json')).sort()) {
    records[file] = JSON.parse(await readFile(resolve(dir, file), 'utf8'));
  }
  return { records,
    mapping: JSON.parse(await readFile(resolve(root, 'data/dallas311-seed-mapping.json'), 'utf8')),
    questions: await readFile(resolve(root, 'data/311-city-staff-questions.md'), 'utf8'),
  };
}

/** Conservative record-level holds: every cited record in an unanswered question stays blocked. */
export function questionHolds(questions: string): Map<string, string[]> {
  const holds = new Map<string, string[]>();
  for (const section of questions.split(/(?=^### \d+\.)/m).slice(1)) {
    const heading = section.split(/\r?\n/, 1)[0].replace(/^### /, '');
    // Stop before the answers table; it does not resolve any question implicitly.
    const body = section.split(/^## /m)[0];
    for (const match of body.matchAll(/\]\((?:\.\/)?311\/([^/)]+\.json)\)/g)) {
      const reasons = holds.get(match[1]) ?? [];
      reasons.push(`Unanswered City staff question ${heading}`);
      holds.set(match[1], reasons);
    }
  }
  return holds;
}

function assertAction(action: SavedAction, label: string): void {
  for (const field of ['tagline', 'why', 'what', 'who', 'how', 'how_formatted'] as const) {
    if (typeof action[field] !== 'string' || !action[field].trim()) throw new Error(`${label}: missing ${field}`);
  }
  if (action.why_not !== null && typeof action.why_not !== 'string') throw new Error(`${label}: invalid why_not`);
}

export function entryFingerprint(entry: Omit<ManifestEntry, 'candidateId' | 'fingerprint'> | ManifestEntry): string {
  const { candidateId: _id, fingerprint: _hash, ...content } = entry as ManifestEntry;
  return hash({ boundarySourceKey: BOUNDARY_KEY, ...content });
}
export function candidateId(sourceKey: string, fingerprint: string): string { return `${sourceKey}:${fingerprint}`; }

/** Keep only recorded exclusions, preserving the original scenario numbering. */
export function formatDallas311Exclusions(scenarios: { why_not: string | null }[]): string {
  if (scenarios.length === 1) return scenarios[0].why_not ?? '';
  return scenarios.flatMap((scenario, index) => scenario.why_not?.trim() ? [`Scenario ${index + 1}: ${scenario.why_not}`] : []).join('\n');
}

export function buildManifest({ records, mapping, questions }: SeedSources): SeedManifest {
  if (mapping.schemaVersion !== 1 || !Array.isArray(mapping.groups)) throw new Error('Unsupported seed mapping.');
  const holds = questionHolds(questions);
  const seenKeys = new Set<string>(); const seenMembers = new Set<string>(); const covered = new Set<string>();
  const entries: ManifestEntry[] = [];
  for (const group of mapping.groups) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(group.key) || seenKeys.has(group.key)) throw new Error(`Invalid or duplicate canonical key: ${group.key}`);
    seenKeys.add(group.key);
    if (!group.decision?.trim() || !group.members.length) throw new Error(`Missing consolidation decision: ${group.key}`);
    const holdReasons: string[] = [];
    const members = group.members.map(member => {
      if (!member.id || seenMembers.has(member.id)) throw new Error(`Duplicate member identity: ${member.id}`);
      seenMembers.add(member.id);
      const record = records[member.file];
      if (!record || EXCLUDED_FILES.includes(member.file)) throw new Error(`Invalid mapped file: ${member.file}`);
      const matches = (record.actions ?? []).map((action, index) => ({ action, index })).filter(({ action }) => hash(action) === member.actionHash);
      if (matches.length !== 1) throw new Error(`Mapping needs review for changed or ambiguous action ${member.id} (${member.file}). Retain its id/key when updating its actionHash.`);
      const { action, index } = matches[0]; assertAction(action, member.id);
      const ref = `${member.file}/actions/${index}`;
      if (covered.has(ref)) throw new Error(`Action mapped twice: ${ref}`);
      covered.add(ref);
      holdReasons.push(...(holds.get(member.file) ?? []));
      if (!member.evidence.length) holdReasons.push(`No evidence selected for ${member.id}`);
      const observations = member.evidence.map(evidence => {
        // Only captured source fields may be evidence; generated actions cannot prove themselves.
        if (!/^\/(description|instructions|instructionLinks|detailsForm)(\/|$)/.test(evidence.pointer)) throw new Error(`Unsupported evidence field: ${evidence.pointer}`);
        const value = atPointer(records[evidence.file], evidence.pointer);
        if (typeof value !== 'string' || !value.trim()) throw new Error(`Evidence must select a saved string: ${evidence.file}${evidence.pointer}`);
        holdReasons.push(...(holds.get(evidence.file) ?? []));
        return { ...evidence, value, hash: hash(value) };
      });
      return { ...member, title: record.title, actionPointer: `/actions/${index}`, originalAction: action, observations, disposition: 'included' as ManifestMember['disposition'] };
    });
    const primary = members.find(member => member.id === group.primaryMemberId);
    if (!primary) throw new Error(`Missing primary member: ${group.key}`);
    // A merge cannot silently change channel, recipient, or destination.
    if (members.some(member => member.originalAction.what !== primary.originalAction.what || member.originalAction.who !== primary.originalAction.who || member.originalAction.how_formatted !== primary.originalAction.how_formatted)) {
      throw new Error(`Incompatible route in ${group.key}; keep separate groups.`);
    }
    const scenarios = [...new Map(members.map(member => [hash([member.originalAction.why, member.originalAction.why_not]), member.originalAction])).values()];
    const observations = [...new Map(members.flatMap(member => member.observations).map(obs => [`${obs.file}${obs.pointer}`, obs])).values()];
    const action = primary.originalAction;
    const input: ManifestEntry['input'] = {
      summary: action.tagline,
      photos: captured311Photos(members.map(member => member.file), records),
      instructions: formatDallas311Instructions(action),
      why: scenarios.length === 1 ? action.why : `Applies in any of these supported scenarios:\n${scenarios.map((scenario, i) => `${i + 1}. ${scenario.why}`).join('\n')}`,
      whyNot: formatDallas311Exclusions(scenarios),
      sourceUrl: records[primary.file].serviceRequestUrl || records[primary.file].sourcePortalUrl,
      sourceEvidence: [...new Set(observations.map(obs => obs.value))].join('\n\n'),
      sourceDescription: `Captured Dallas 311 inventory; canonical group ${group.key}.\n${members.map(member => `data/311/${member.file}${member.actionPointer} [${member.id}]`).join('\n')}\nEvidence pointers and hashes are retained in the seed manifest and candidate metadata.`,
      confidence: null,
    };
    const validation = validateRecommendableInput({ ...input, boundaries: [1] });
    if (validation.error) holdReasons.push(`Editorial validation: ${validation.error}`);
    const reasons = [...new Set(holdReasons)].sort();
    const status = reasons.length ? 'held' as const : 'ready' as const;
    for (const member of members) member.disposition = status === 'held' ? 'held' : member.id === group.primaryMemberId ? 'included' : 'merged';
    const base = { key: group.key, sourceKey: `dallas311:inventory:${group.key}`, decision: group.decision, primaryMemberId: group.primaryMemberId, members, input, status, holdReasons: reasons };
    const fingerprint = entryFingerprint(base);
    entries.push({ ...base, fingerprint, candidateId: candidateId(base.sourceKey, fingerprint) });
  }
  for (const [file, record] of Object.entries(records)) {
    if (EXCLUDED_FILES.includes(file)) continue;
    if (!Array.isArray(record.actions) || !record.actions.length) throw new Error(`Missing actions: ${file}`);
    record.actions.forEach((_, index) => { if (!covered.has(`${file}/actions/${index}`)) throw new Error(`Unmapped action: ${file}/actions/${index}`); });
  }
  return { schemaVersion: 1, boundarySourceKey: BOUNDARY_KEY,
    sources: Object.entries(records).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([file, record]) => ({ file, hash: hash(record) })),
    mappingHash: hash(mapping), questionsHash: hash(questions), excludedFiles: EXCLUDED_FILES,
    entries, pilotKeys: selectPilotKeys(entries), review: { pilotReviewed: false, approvedKeys: [] },
  };
}

/** Representative review set, selected by behavior rather than mutable array offsets. */
function selectPilotKeys(entries: ManifestEntry[]): string[] {
  const selectors: ((entry: ManifestEntry) => boolean)[] = [
    e => e.status === 'ready' && e.members.some(m => m.file === 'pot-hole-routine-repair.json' && m.originalAction.what === 'Submit 311 request'),
    e => e.status === 'ready' && e.key === 'hazardous-pothole-phone',
    e => e.status === 'ready' && e.members.some(m => m.originalAction.who === 'Atmos Energy'),
    e => e.status === 'ready' && e.members.some(m => /View 311 guidance|Visit website/.test(m.originalAction.what)),
    e => e.status === 'ready' && e.members.some(m => /911/.test(m.originalAction.how)),
    e => e.status === 'held',
  ];
  return [...new Set(selectors.map(select => entries.find(select)?.key).filter((key): key is string => !!key))];
}

/** Verify the selected artifact without regenerating its candidate wording. */
export function validateManifest(manifest: SeedManifest, sources: SeedSources): void {
  if (manifest.schemaVersion !== 1 || manifest.boundarySourceKey !== BOUNDARY_KEY) throw new Error('Unsupported manifest or boundary scope.');
  const currentSources = Object.entries(sources.records).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([file, record]) => ({ file, hash: hash(record) }));
  if (hash(manifest.sources) !== hash(currentSources)) throw new Error('Inventory changed; regenerate and review the manifest.');
  if (manifest.mappingHash !== hash(sources.mapping) || manifest.questionsHash !== hash(sources.questions)) throw new Error('Mapping or staff questions changed; regenerate and review.');
  if (!Array.isArray(manifest.entries) || manifest.entries.length !== sources.mapping.groups.length || hash(manifest.excludedFiles) !== hash(EXCLUDED_FILES)) throw new Error('Manifest coverage differs from mapping.');
  const holds = questionHolds(sources.questions);
  const covered = new Set<string>(); const identities = new Set<string>();
  for (const entry of manifest.entries) {
    const group = sources.mapping.groups.find(item => item.key === entry.key);
    if (!group || entry.sourceKey !== `dallas311:inventory:${group.key}` || entry.primaryMemberId !== group.primaryMemberId || entry.decision !== group.decision || entry.members.length !== group.members.length) throw new Error(`Manifest differs from mapping: ${entry.key}`);
    if (!['ready', 'held'].includes(entry.status) || !Array.isArray(entry.holdReasons) || entry.holdReasons.some(reason => typeof reason !== 'string') || (entry.status === 'ready' && entry.holdReasons.length) || (entry.status === 'held' && !entry.holdReasons.length)) throw new Error(`Invalid hold state: ${entry.key}`);
    for (const member of entry.members) {
      const mapped = group.members.find(item => item.id === member.id);
      if (!mapped || identities.has(member.id) || member.file !== mapped.file || member.actionHash !== mapped.actionHash || hash(member.evidence) !== hash(mapped.evidence)) throw new Error(`Invalid source member: ${member.id}`);
      identities.add(member.id);
      const record = sources.records[member.file];
      if (!record || EXCLUDED_FILES.includes(member.file) || member.title !== record.title || !/^\/actions\/\d+$/.test(member.actionPointer)) throw new Error(`Invalid source record: ${member.id}`);
      const action = atPointer(record, member.actionPointer);
      if (!action || hash(action) !== member.actionHash || hash(action) !== hash(member.originalAction)) throw new Error(`Source action changed: ${member.id}`);
      assertAction(member.originalAction, member.id);
      const ref = `${member.file}${member.actionPointer}`;
      if (covered.has(ref)) throw new Error(`Action mapped twice: ${ref}`);
      covered.add(ref);
      if (member.disposition !== (entry.status === 'held' ? 'held' : member.id === group.primaryMemberId ? 'included' : 'merged')) throw new Error(`Incorrect disposition: ${ref}`);
      if (member.observations.length !== mapped.evidence.length) throw new Error(`Missing observations: ${ref}`);
      for (const [i, observation] of member.observations.entries()) {
        const evidence = mapped.evidence[i];
        if (observation.file !== evidence.file || observation.pointer !== evidence.pointer || !/^\/(description|instructions|instructionLinks|detailsForm)(\/|$)/.test(evidence.pointer)) throw new Error(`Invalid evidence reference: ${ref}`);
        const value = atPointer(sources.records[evidence.file], evidence.pointer);
        if (typeof value !== 'string' || !value.trim() || observation.value !== value || observation.hash !== hash(value)) throw new Error(`Evidence changed: ${ref}`);
      }
      const requiredHolds = [...(holds.get(member.file) ?? []), ...member.evidence.flatMap(evidence => holds.get(evidence.file) ?? []), ...(!member.evidence.length ? [`No evidence selected for ${member.id}`] : [])];
      if (requiredHolds.some(reason => entry.status !== 'held' || !entry.holdReasons.includes(reason))) throw new Error(`Unresolved City staff question or missing evidence: ${entry.key}`);
    }
    const primary = entry.members.find(member => member.id === group.primaryMemberId);
    if (!primary) throw new Error(`Missing primary member: ${entry.key}`);
    if (entry.input.photos !== undefined && hash(entry.input.photos) !== hash(captured311Photos(entry.members.map(member => member.file), sources.records))) throw new Error(`Photos differ from saved 311 captures: ${entry.key}`);
    if (entry.members.some(member => member.originalAction.what !== primary.originalAction.what || member.originalAction.who !== primary.originalAction.who || member.originalAction.how_formatted !== primary.originalAction.how_formatted)) throw new Error(`Incompatible route: ${entry.key}`);
    if (entry.fingerprint !== entryFingerprint(entry) || entry.candidateId !== candidateId(entry.sourceKey, entry.fingerprint)) throw new Error(`Invalid content fingerprint: ${entry.key}`);
    if (entry.status === 'ready') {
      const result = validateRecommendableInput({ ...entry.input, boundaries: [1] });
      if (result.error) throw new Error(`${entry.key}: ${result.error}`);
      const observations = [...new Map(entry.members.flatMap(member => member.observations).map(obs => [`${obs.file}${obs.pointer}`, obs])).values()];
      const record = sources.records[primary.file];
      if (entry.input.sourceUrl !== (record.serviceRequestUrl || record.sourcePortalUrl) || entry.input.sourceEvidence !== [...new Set(observations.map(obs => obs.value))].join('\n\n') || entry.members.some(member => !entry.input.sourceDescription.includes(`data/311/${member.file}${member.actionPointer} [${member.id}]`))) throw new Error(`Source evidence was edited: ${entry.key}`);
    }
  }
  for (const [file, record] of Object.entries(sources.records)) {
    if (EXCLUDED_FILES.includes(file)) continue;
    if (!Array.isArray(record.actions) || !record.actions.length) throw new Error(`Missing actions: ${file}`);
    record.actions.forEach((_, index) => { if (!covered.has(`${file}/actions/${index}`)) throw new Error(`Unmapped action: ${file}/actions/${index}`); });
  }
  if (new Set(manifest.entries.map(entry => entry.key)).size !== manifest.entries.length) throw new Error('Duplicate manifest keys.');
  if (hash(manifest.pilotKeys) !== hash(selectPilotKeys(manifest.entries))) throw new Error('Invalid pilot selection.');
  if (!manifest.review || typeof manifest.review.pilotReviewed !== 'boolean' || !Array.isArray(manifest.review.approvedKeys) || manifest.review.approvedKeys.some(key => !manifest.entries.some(entry => entry.key === key && entry.status === 'ready'))) throw new Error('Invalid review selection.');
}
