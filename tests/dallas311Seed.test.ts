import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest, candidateId, entryFingerprint, hash, NO_EXCLUSION, readSeedSources, validateManifest, type SavedAction, type SeedSources, type SeedManifest } from '../src/scripts/dallas311Manifest.js';
import { importManifest, type SeedStore, type StoredSeed } from '../src/scripts/dallas311Import.js';
import { main } from '../src/scripts/seedDallas311Recommendables.js';

const sources = await readSeedSources();
const inventory = buildManifest(sources);
const byFile = (manifest: SeedManifest, file: string) => manifest.entries.filter(entry => entry.members.some(member => member.file === file));
function revise(entry: SeedManifest['entries'][number]): void {
  entry.fingerprint = entryFingerprint(entry); entry.candidateId = candidateId(entry.sourceKey, entry.fingerprint);
}
function fixture(): SeedSources {
  const online: SavedAction = { tagline: 'Report a routine pothole.', why: 'For routine street potholes.', why_not: 'Call 311 for hazardous potholes.', what: 'Submit 311 request', who: 'Public Works', how: 'Choose potholes', how_formatted: '[Choose potholes](https://dallascrm.my.site.com/public/s/)' };
  const phone: SavedAction = { tagline: 'Call about a hazardous pothole.', why: 'For hazardous street potholes.', why_not: null, what: 'Call 311 by phone', who: 'Dallas 311', how: 'Call 311', how_formatted: 'Call [311](tel:311)' };
  const file = 'pot-hole-routine-repair.json';
  return { records: { [file]: { title: 'Potholes', description: 'Report routine potholes online. Call 311 for hazardous potholes.', sourcePortalUrl: 'https://dallascrm.my.site.com/public/s/', actions: [online, phone] } },
    mapping: { schemaVersion: 1, groups: [online, phone].map((action, i) => ({ key: i ? 'hazardous-pothole-phone' : 'routine-pothole-online', decision: 'Separate severity and channel.', primaryMemberId: i ? 'phone' : 'online', members: [{ id: i ? 'phone' : 'online', file, actionHash: hash(action), evidence: [{ file, pointer: '/description' }] }] })) }, questions: '' };
}
function memoryStore(initial: StoredSeed[] = [], catalog: StoredSeed[] = []) {
  const records = new Map([...initial, ...catalog].map(item => [item.id, item]));
  const writes: { key: string; boundaries: number[] }[] = [];
  const store: SeedStore = {
    actions: async () => [...records.values()],
    create: async (entry, input) => {
      writes.push({ key: entry.key, boundaries: input.boundaries });
      const existed = records.has(entry.sourceKey);
      records.set(entry.sourceKey, { id: entry.sourceKey, fingerprint: entry.fingerprint, sourceKey: entry.sourceKey });
      return existed ? 'updated' : 'created';
    },
  };
  return { store, records, writes };
}
function approvedFixture() {
  const manifest = buildManifest(fixture());
  manifest.review.approvedKeys = manifest.entries.map(entry => entry.key);
  return manifest;
}

test('all 368 inventory actions have one traceable disposition; test records are excluded', () => {
  validateManifest(inventory, sources);
  const members = inventory.entries.flatMap(entry => entry.members);
  assert.equal(members.length, 368);
  assert.equal(new Set(members.map(member => `${member.file}${member.actionPointer}`)).size, 368);
  assert.equal(inventory.entries.length, 365);
  assert.ok(!members.some(member => inventory.excludedFiles.includes(member.file)));
  assert.equal(inventory.entries.filter(entry => entry.status === 'ready').length, 198);
  assert.equal(inventory.pilotKeys.length, 6);
});

test('field mapping retains channel, recipient, null exclusion and captured evidence', () => {
  const input = fixture(); const manifest = buildManifest(input);
  const phone = manifest.entries.find(entry => entry.key === 'hazardous-pothole-phone')!;
  assert.equal(phone.input.summary, input.records['pot-hole-routine-repair.json'].actions![1].tagline);
  assert.equal(phone.input.instructions, 'Call Dallas 311 at [311](tel:311).');
  assert.equal(phone.input.whyNot, NO_EXCLUSION);
  assert.equal(phone.members[0].originalAction.why_not, null);
  assert.equal(phone.input.sourceEvidence, input.records['pot-hole-routine-repair.json'].description);
  assert.equal(phone.members[0].observations[0].hash, hash(phone.input.sourceEvidence));
  assert.ok(!('boundaries' in phone.input));
});

test('equivalent hazardous pothole actions merge while routine and pet-surrender phone purposes stay separate', () => {
  const merged = inventory.entries.find(entry => entry.key === 'hazardous-pothole-phone')!;
  assert.equal(merged.members.length, 2);
  assert.equal(merged.members.filter(member => member.disposition === 'merged').length, 1);
  assert.match(merged.input.why, /Scenario|supported scenarios/);
  const routine = byFile(inventory, 'pot-hole-routine-repair.json').find(entry => entry.input.summary.startsWith('Submit'))!;
  assert.notEqual(merged.sourceKey, routine.sourceKey);
  assert.match(routine.input.whyNot, /driveway approach/);
  const surrender = byFile(inventory, 'animal-owner-surrender.json').find(entry => entry.members.some(member => member.originalAction.what === 'Call 311 by phone'))!;
  assert.notEqual(merged.sourceKey, surrender.sourceKey);
});

test('merges preserve scenario-specific exclusions instead of creating a blanket prohibition', () => {
  const input = fixture();
  const action = { ...input.records['pot-hole-routine-repair.json'].actions![1], why: 'For hazardous alley potholes.', why_not: 'Not for private driveways.' };
  input.records['alley.json'] = { title: 'Alley', description: 'Call 311 for hazardous alley potholes.', sourcePortalUrl: 'https://dallascrm.my.site.com/public/s/', actions: [action] };
  input.mapping.groups[1].members.push({ id: 'alley', file: 'alley.json', actionHash: hash(action), evidence: [{ file: 'alley.json', pointer: '/description' }] });
  const manifest = buildManifest(input); validateManifest(manifest, input);
  const entry = manifest.entries[1];
  assert.doesNotMatch(entry.input.whyNot, /Scenario 1:|No additional exclusion/);
  assert.match(entry.input.whyNot, /Scenario 2: Not for private driveways/);
});

test('new and replacement sidewalks remain distinct and suggested alternatives retain consider wording', () => {
  const entries = byFile(inventory, 'new-alley-sidewalk-street-request.json');
  const replacement = entries.find(entry => entry.input.summary.includes('replacement of an existing residential sidewalk'))!;
  const newlyInstalled = entries.find(entry => entry.input.summary.includes('installing a sidewalk'))!;
  assert.notEqual(newlyInstalled.sourceKey, replacement.sourceKey);
  assert.match(replacement.input.summary, /^Consider /);
  assert.match(newlyInstalled.input.why, /where none exists/);
});

test('conditional signal triggers and known conflicts survive conversion', () => {
  const signals = byFile(inventory, 'traffic-signal-maintenance-report-a-problem.json');
  assert.ok(signals.some(entry => /red (?:signal )?bulb/i.test(entry.input.why) && /fewer than two/i.test(entry.input.why) && /same direction of travel/.test(entry.input.why)));
  for (const file of ['visibility-obstruction.json', 'utility-street-cuts-hazardous.json', 'alley-repair-routine.json']) {
    assert.ok(byFile(inventory, file).every(entry => entry.status === 'held' && entry.holdReasons.some(reason => reason.startsWith('Unanswered City staff question'))));
  }
  const altered = structuredClone(inventory);
  const held = byFile(altered, 'visibility-obstruction.json')[0];
  held.status = 'ready'; held.holdReasons = [];
  held.members.forEach(member => { member.disposition = member.id === held.primaryMemberId ? 'included' : 'merged'; }); revise(held);
  assert.throws(() => validateManifest(altered, sources), /Unresolved City staff question/);
});

test('unsupported evidence, unmapped actions and incompatible merge routes fail generation', () => {
  const input = fixture(); input.mapping.groups[0].members[0].evidence[0].pointer = '/actions/0/why';
  assert.throws(() => buildManifest(input), /Unsupported evidence/);
  const missing = fixture(); missing.mapping.groups.pop();
  assert.throws(() => buildManifest(missing), /Unmapped action/);
  const bad = fixture(); bad.mapping.groups[0].members.push(...bad.mapping.groups[1].members); bad.mapping.groups.pop();
  assert.throws(() => buildManifest(bad), /Incompatible route/);
});

test('oversized content is held for editorial review without truncation', () => {
  const input = fixture(); const action = input.records['pot-hole-routine-repair.json'].actions![0];
  action.why = 'x'.repeat(4001); input.mapping.groups[0].members[0].actionHash = hash(action);
  const manifest = buildManifest(input);
  assert.equal(manifest.entries[0].input.why.length, 4001);
  assert.equal(manifest.entries[0].status, 'held');
  assert.match(manifest.entries[0].holdReasons.join(), /why is too long/);
  validateManifest(manifest, input);
});

test('inventory drift requires remapping; stable member and catalog identity survive wording edits', () => {
  const input = fixture(); const first = buildManifest(input);
  input.records['pot-hole-routine-repair.json'].actions![1].tagline = 'Call Dallas 311 about a hazardous pothole.';
  assert.throws(() => validateManifest(first, input), /Inventory changed/);
  assert.throws(() => buildManifest(input), /Mapping needs review/);
  input.mapping.groups[1].members[0].actionHash = hash(input.records['pot-hole-routine-repair.json'].actions![1]);
  const changed = buildManifest(input);
  assert.equal(first.entries[1].sourceKey, changed.entries[1].sourceKey);
  assert.equal(first.entries[1].members[0].id, changed.entries[1].members[0].id);
  assert.notEqual(first.entries[1].candidateId, changed.entries[1].candidateId);
});

test('reviewed manifest wording is imported directly; fingerprint and evidence tampering fail', () => {
  const input = fixture(); const manifest = buildManifest(input);
  manifest.entries[0].input.summary = 'A reviewed summary.'; revise(manifest.entries[0]);
  validateManifest(manifest, input);
  manifest.entries[0].input.summary = 'An un-fingerprinted edit.';
  assert.throws(() => validateManifest(manifest, input), /fingerprint/);
  revise(manifest.entries[0]); manifest.entries[0].members[0].observations[0].value = 'Generated evidence'; revise(manifest.entries[0]);
  assert.throws(() => validateManifest(manifest, input), /Evidence changed/);
});

test('reader ignores backup JSON and explicitly allows the excluded test records without actions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dallas311-seed-'));
  try {
    await mkdir(join(root, 'data/311'), { recursive: true });
    const input = fixture();
    await writeFile(join(root, 'data/311/pot-hole-routine-repair.json'), JSON.stringify(input.records['pot-hole-routine-repair.json']));
    await writeFile(join(root, 'data/311/test-crm.json'), JSON.stringify({ title: 'Test' }));
    await writeFile(join(root, 'data/311/ignored.json.bak'), 'not json');
    await writeFile(join(root, 'data/dallas311-seed-mapping.json'), JSON.stringify(input.mapping));
    await writeFile(join(root, 'data/311-city-staff-questions.md'), '');
    const loaded = await readSeedSources(root);
    assert.deepEqual(Object.keys(loaded.records).sort(), ['pot-hole-routine-repair.json', 'test-crm.json']);
    assert.equal(buildManifest(loaded).entries.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('pilot import assigns the city boundary and reruns retain records', async () => {
  const manifest = approvedFixture(); const { store, writes } = memoryStore();
  const first = await importManifest(manifest, 42, store, true);
  assert.equal(first.created.length, 2); assert.deepEqual(writes.map(write => write.boundaries), [[42], [42]]);
  const second = await importManifest(manifest, 42, store, true);
  assert.equal(second.retained.length, 2); assert.equal(writes.length, 2);
});

test('changed seed content updates the same action instead of making a separate draft', async () => {
  const manifest = approvedFixture(); const memory = memoryStore();
  await importManifest(manifest, 42, memory.store, true);
  manifest.entries[0].input.summary = 'Updated pothole guidance.'; revise(manifest.entries[0]);
  const report = await importManifest(manifest, 42, memory.store, true);
  assert.equal(report.updated.length, 1);
  assert.equal(report.created.length, 0);
  assert.equal(memory.records.size, 2);
});

test('bulk import requires pilot review and persisted current pilot revisions', async () => {
  const manifest = approvedFixture(); const { store, writes } = memoryStore();
  await assert.rejects(importManifest(manifest, 42, store), /review the representative pilot/);
  manifest.review.pilotReviewed = true;
  await assert.rejects(importManifest(manifest, 42, store), /current pilot revisions/);
  assert.equal(writes.length, 0);
  await importManifest(manifest, 42, store, true);
  assert.equal((await importManifest(manifest, 42, store)).retained.length, 2);
});

test('bulk import leaves independently approved pilot edits untouched when excluded', async () => {
  const manifest = approvedFixture();
  const pilot = manifest.entries[0]; const remaining = manifest.entries[1];
  manifest.pilotKeys = [pilot.key];
  manifest.review = { pilotReviewed: true, approvedKeys: [remaining.key] };
  const memory = memoryStore([{ id: pilot.sourceKey, sourceKey: pilot.sourceKey, fingerprint: 'approved-editorial-revision', status: 'approved' }]);
  const before = structuredClone(memory.records.get(pilot.sourceKey));
  const report = await importManifest(manifest, 42, memory.store);
  assert.deepEqual(report.created, [remaining.key]);
  assert.deepEqual(memory.records.get(pilot.sourceKey), before);
  assert.equal(memory.writes.length, 1);
  // An unapproved pilot edit still fails preflight.
  const pending = memoryStore([{ ...before!, status: 'candidate' }]);
  await assert.rejects(importManifest(manifest, 42, pending.store), /current pilot revisions/);
  assert.equal(pending.writes.length, 0);
});

test('capacity preflight counts every status in the single action collection before writes', async () => {
  const manifest = approvedFixture();
  for (const collection of ['candidates', 'catalog']) {
    const rows = Array.from({ length: 499 }, (_, i) => ({ id: `existing-${i}` }));
    const { store, writes } = memoryStore(collection === 'candidates' ? rows : [], collection === 'catalog' ? rows : []);
    await assert.rejects(importManifest(manifest, 42, store, true), /500-record/);
    assert.equal(writes.length, 0);
  }
});

test('entire eligible set validates before writes, even beyond the selected pilot', async () => {
  const manifest = approvedFixture(); const { store, writes } = memoryStore();
  manifest.entries[1].input.summary = ' ';
  await assert.rejects(importManifest(manifest, 42, store, true), /summary must/);
  assert.equal(writes.length, 0);
  await assert.rejects(importManifest(approvedFixture(), 0, store, true), /boundary/);
});

test('legacy overlap is reported and conflicting action identities are never overwritten', async () => {
  const manifest = approvedFixture();
  const legacy = { id: 'dallas311-potholes-primary', sourceKey: 'dallas311:potholes:primary', sourceTitle: 'Potholes' };
  const { store, records } = memoryStore([legacy], [legacy]);
  const report = await importManifest(manifest, 42, store, true);
  assert.equal(report.legacyOverlaps.length, 2); assert.deepEqual(records.get(legacy.id), legacy);
  const entry = manifest.entries[0];
  const conflicting = memoryStore([{ id: entry.sourceKey, fingerprint: 'different' }]);
  await assert.rejects(importManifest(manifest, 42, conflicting.store, true), /identity conflict/);
  assert.equal(conflicting.writes.length, 0);
});

test('partial failure produces a resumable report and atomic race winners are retained', async () => {
  const manifest = approvedFixture(); const memory = memoryStore(); const create = memory.store.create;
  memory.store.create = async (entry, input) => { if (entry.key === manifest.entries[1].key) throw new Error('transient failure'); return create(entry, input); };
  const first = await importManifest(manifest, 42, memory.store, true);
  assert.equal(first.created.length, 1); assert.equal(first.failed.length, 1);
  memory.store.create = create;
  const second = await importManifest(manifest, 42, memory.store, true);
  assert.equal(second.created.length, 1); assert.equal(second.retained.length, 1);
  const racing = memoryStore(); racing.store.create = async () => 'retained';
  assert.equal((await importManifest(manifest, 42, racing.store, true)).retained.length, 2);
});

test('CLI refuses implicit regeneration during import and checks selected artifact without database initialization', async () => {
  await assert.rejects(main(['--apply']), /requires --manifest/);
  await assert.rejects(main(['--apply', '--manifest', 'x', '--report', 'y', '--output', 'z']), /cannot be combined/);
  await assert.rejects(main(['--output']), /requires a path/);
  const manifest = JSON.parse(await readFile('data/dallas311-seed-manifest.json', 'utf8'));
  validateManifest(manifest, sources);
  assert.deepEqual(manifest.review, { pilotReviewed: false, approvedKeys: [] });
});
