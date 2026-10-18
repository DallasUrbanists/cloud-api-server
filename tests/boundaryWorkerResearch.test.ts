import { before, after, beforeEach, test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pool } from '../src/config/db.js';
import { BoundarySyncService } from '../src/services/boundarySyncService.js';
import { runBoundaryWorker } from '../src/services/boundaryWorkerService.js';
import { BoundaryError } from '../src/models/boundary.js';
import { OfficialResearchProvider } from '../src/services/research/official.js';

let db: PGlite;
const keys = ['BOUNDARY_SYNC_ENABLED', 'CONGRESS_GOV_API_KEY', 'GEMINI_API_KEY', 'BOUNDARY_SYNC_RESEARCH_ENQUEUE_LIMIT', 'BOUNDARY_SYNC_GLOBAL_PER_MINUTE', 'BOUNDARY_SYNC_GLOBAL_PER_DAY'] as const;
const environment = new Map(keys.map(key => [key, process.env[key]]));
const descriptor = { file: 'congress.js', function: 'researchMembers', params: { chamber: 'Senate' } };
before(async () => {
  db = new PGlite();
  for (const name of ['004_representatives.sql', '006_boundaries.sql']) await db.exec(await readFile(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  mock.method(pool, 'query', (sql: string, values?: unknown[]) => db.query(sql, values));
  let previous = Promise.resolve();
  mock.method(pool, 'connect', async () => {
    const pending = previous;
    let release!: () => void;
    previous = new Promise<void>(resolve => { release = resolve; });
    await pending;
    return { query: (sql: string, values?: unknown[]) => db.query(sql, values), release };
  });
});
beforeEach(async () => {
  await db.exec('TRUNCATE boundary_research_evidence, boundary_sync_jobs, boundary_sync_budgets, representatives, boundaries RESTART IDENTITY CASCADE');
  process.env.BOUNDARY_SYNC_ENABLED = 'true'; process.env.CONGRESS_GOV_API_KEY = 'fixture-key';
  delete process.env.GEMINI_API_KEY; delete process.env.BOUNDARY_SYNC_RESEARCH_ENQUEUE_LIMIT;
  process.env.BOUNDARY_SYNC_GLOBAL_PER_MINUTE = '10'; process.env.BOUNDARY_SYNC_GLOBAL_PER_DAY = '100';
});
after(async () => {
  mock.restoreAll();
  for (const [key, value] of environment) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await db.close();
});
async function boundary(fields: Record<string, any> = {}) {
  const values = { entity_name: 'United States', research_service: descriptor, ...fields };
  const names = Object.keys(values);
  return (await db.query<any>(`INSERT INTO boundaries(${names.join(',')}) VALUES (${names.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`, Object.values(values).map(value => value && typeof value === 'object' && !(value instanceof Date) ? JSON.stringify(value) : value))).rows[0].id as number;
}
test('worker discovery selects only active, due research and respects TTLs, backoff and null adapters', async () => {
  const never = await boundary();
  const stale = await boundary({ last_research_success: new Date(Date.now() - 61 * 86400000) });
  await boundary({ last_research_success: new Date() });
  await boundary({ research_retry_after: new Date(Date.now() + 3600000) });
  await boundary({ effective_date: '2999-01-01' });
  await boundary({ expiration_date: '2000-01-01' });
  await boundary({ research_service: null });
  assert.deepEqual(await BoundarySyncService.enqueueDueResearch(), { queued: 2, skipped: [] });
  const jobs = (await db.query<any>('SELECT * FROM boundary_sync_jobs ORDER BY id')).rows;
  assert.deepEqual(jobs.map(j => j.scope_id), [never, stale]);
  assert.ok(jobs.every(j => j.target_type === 'boundary' && j.target_id === j.scope_id && j.research_requested && !j.shape_requested && !j.force_sync));
  assert.equal((await db.query<any>('SELECT count(*)::int AS count FROM boundary_sync_budgets')).rows[0].count, 0);
});
test('concurrent discovery and existing representative/shape jobs never duplicate active scopes', async () => {
  const busy = await boundary(); const free = await boundary();
  await db.query("INSERT INTO boundary_sync_jobs(scope_id,target_type,target_id,shape_requested,status) VALUES ($1,'representative',1,true,'running')", [busy]);
  const results = await Promise.all([BoundarySyncService.enqueueDueResearch(), BoundarySyncService.enqueueDueResearch()]);
  assert.equal(results.reduce((n, r) => n + r.queued, 0), 1);
  assert.deepEqual((await db.query<any>('SELECT scope_id FROM boundary_sync_jobs ORDER BY id')).rows.map(j => j.scope_id), [busy, free]);
  assert.equal((await BoundarySyncService.enqueueDueResearch()).queued, 0);
  const fromPublic = await BoundarySyncService.enqueue({ target: 'boundary', id: free, kind: 'research', clientAddress: 'test' });
  assert.equal(fromPublic?.scope_id, free);
  assert.equal((await db.query<any>('SELECT count(*)::int AS count FROM boundary_sync_jobs')).rows[0].count, 2);
});
test('discovery pages past unconfigured providers, bounds each scan and resumes remaining boundaries', async () => {
  const unconfigured = JSON.stringify({ file: 'official.js', function: 'researchRoster', params: {} });
  await db.query("INSERT INTO boundaries(entity_name,research_service) SELECT 'Missing provider ' || n,$1::jsonb FROM generate_series(1,101) n", [unconfigured]);
  const ids = await Promise.all([boundary(), boundary(), boundary()]);
  process.env.BOUNDARY_SYNC_RESEARCH_ENQUEUE_LIMIT = '2';
  const first = await BoundarySyncService.enqueueDueResearch();
  assert.equal(first.queued, 2); assert.equal(first.skipped.length, 101);
  assert.ok(first.skipped.every(row => row.code === 'PROVIDER_NOT_CONFIGURED'));
  assert.equal((await BoundarySyncService.enqueueDueResearch()).queued, 1);
  assert.deepEqual((await db.query<any>('SELECT scope_id FROM boundary_sync_jobs ORDER BY id')).rows.map(j => j.scope_id), ids);
});
test('disabled synchronization and invalid scan limits cannot enqueue work', async () => {
  await boundary(); process.env.BOUNDARY_SYNC_ENABLED = 'false';
  await assert.rejects(BoundarySyncService.enqueueDueResearch(), (e: any) => e.code === 'SYNC_DISABLED');
  process.env.BOUNDARY_SYNC_ENABLED = 'true';
  for (const limit of ['0', '10001', 'oops', '1.5']) {
    process.env.BOUNDARY_SYNC_RESEARCH_ENQUEUE_LIMIT = limit;
    await assert.rejects(BoundarySyncService.enqueueDueResearch(), (e: any) => e.code === 'SYNC_CONFIGURATION_INVALID');
  }
  assert.equal((await db.query<any>('SELECT count(*)::int AS count FROM boundary_sync_jobs')).rows[0].count, 0);
});
test('unapproved adapters are reported without blocking configured research', async () => {
  const invalid = await boundary({ research_service: { file: 'unknown.js', function: 'researchRoster', params: {} } });
  await boundary();
  assert.deepEqual(await BoundarySyncService.enqueueDueResearch(), { queued: 1, skipped: [{ boundaryId: invalid, code: 'SERVICE_INVALID' }] });
});
test('scheduled worker hydrates an empty representative directory and refreshes stale records', async t => {
  const id = await boundary(); let prefix = 'Initial'; let calls = 0;
  t.mock.method(globalThis, 'fetch', async input => {
    calls++; const url = new URL(String(input));
    assert.equal(url.hostname, 'api.congress.gov');
    if (url.pathname.endsWith('/TX')) return Response.json({ members: ['A000001', 'B000002'].map(bioguideId => ({ bioguideId, terms: { item: [{ chamber: 'Senate' }] } })) });
    return Response.json({ member: { currentMember: true, directOrderName: prefix + ' ' + url.pathname.split('/').at(-1), addressInformation: { phoneNumber: '202-555-0100' } } });
  });
  assert.equal(await runBoundaryWorker({ once: true }), true);
  let people = (await db.query<any>('SELECT name,phones FROM representatives ORDER BY id')).rows;
  assert.deepEqual(people.map(p => p.name), ['Initial A000001', 'Initial B000002']);
  assert.equal(people[0].phones[0].phone, '2025550100');
  assert.equal(calls, 3);
  await runBoundaryWorker({ once: true }); assert.equal(calls, 3);
  prefix = 'Updated';
  await db.query("UPDATE boundaries SET last_research_success=CURRENT_TIMESTAMP - INTERVAL '61 days' WHERE id=$1", [id]);
  await runBoundaryWorker({ once: true });
  people = (await db.query<any>('SELECT name FROM representatives ORDER BY id')).rows;
  assert.deepEqual(people.map(p => p.name), ['Updated A000001', 'Updated B000002']);
  assert.equal(calls, 6); assert.equal((await db.query<any>('SELECT count(*)::int AS count FROM boundary_research_evidence')).rows[0].count, 2);
});

test('scheduled official research saves verified routing contacts and preserves them on partial refresh', async t => {
  process.env.GEMINI_API_KEY = 'fixture-only';
  const sourceUrl = 'https://dallascityhall.com/fixture-board';
  const contactUrl = 'https://dallascityhall.com/contact';
  const id = await boundary({ entity_name: 'City of Dallas', body_name: 'Park Board', district_name: 'District 2', research_service: { file: 'official.js', function: 'researchRoster', params: { urls: [sourceUrl], title: 'Board member', useSearch: false } } });
  const oldEmail = { label: 'Existing office', email: 'existing@example.org', when_to_use: 'Previously verified contact' };
  await db.query('INSERT INTO representatives(boundary_id,name,title,emails) VALUES ($1,$2,$3,$4::jsonb)', [id, 'Jane Member', 'Board member', JSON.stringify([oldEmail])]);
  let includeContacts = true;
  t.mock.method(globalThis, 'fetch', async input => new Response(String(input) === contactUrl
    ? '<main>City of Dallas Park Board Office office@example.org 214-555-0100.</main>'
    : `<main>District 2 Jane Member <a href="${contactUrl}">Contact</a></main>`, { headers: { 'content-type': 'text/html' } }));
  t.mock.method(OfficialResearchProvider, 'createClient', () => ({ models: { generateContent: async () => ({ text: JSON.stringify({ people: [{
    name: 'Jane Member', title: 'Board member', sourceUrl, scopeEvidence: 'District 2 Jane Member',
    emailContacts: includeContacts ? [{ kind: 'shared_office', owner: 'Park Board Office', value: 'office@example.org', evidence: { sourceUrl: contactUrl, quote: 'Park Board Office office@example.org 214-555-0100.' }, relationshipEvidence: { sourceUrl: contactUrl, quote: 'City of Dallas Park Board Office office@example.org 214-555-0100.' } }] : [],
    phoneContacts: includeContacts ? [{ kind: 'shared_office', owner: 'Park Board Office', value: '2145550100', evidence: { sourceUrl: contactUrl, quote: 'Park Board Office office@example.org 214-555-0100.' }, relationshipEvidence: { sourceUrl: contactUrl, quote: 'City of Dallas Park Board Office office@example.org 214-555-0100.' } }] : [],
  }], description: null, whenToContact: null, boundaryEvidence: null }) }) } }));
  assert.equal(await runBoundaryWorker({ once: true }), true);
  const first = (await db.query<any>('SELECT * FROM representatives WHERE boundary_id=$1', [id])).rows;
  assert.equal(first.length, 1);
  assert.deepEqual(first[0].emails[0], oldEmail);
  assert.equal(first[0].emails[1].email, 'office@example.org');
  assert.match(first[0].emails[1].label, /shared office/);
  assert.equal(first[0].phones[0].phone, '2145550100');
  assert.equal(first[0].phones[0].can_sms, false);
  const evidence = (await db.query<any>('SELECT * FROM boundary_research_evidence')).rows[0];
  assert.equal(evidence.outcome, 'applied');
  assert.ok(evidence.source_urls.includes(contactUrl));
  assert.equal(evidence.proposal.people[0].emailContacts[0].kind, 'shared_office');
  includeContacts = false;
  await db.query("UPDATE boundaries SET last_research_success=CURRENT_TIMESTAMP - INTERVAL '61 days' WHERE id=$1", [id]);
  assert.equal(await runBoundaryWorker({ once: true }), true);
  const refreshed = (await db.query<any>('SELECT phones,emails FROM representatives WHERE boundary_id=$1', [id])).rows[0];
  assert.deepEqual(refreshed.phones, first[0].phones);
  assert.deepEqual(refreshed.emails, first[0].emails);
});
test('discovery leaves execution budget enforcement to claims', async () => {
  await boundary(); await boundary();
  process.env.BOUNDARY_SYNC_GLOBAL_PER_DAY = '1';
  assert.equal((await BoundarySyncService.enqueueDueResearch()).queued, 2);
  const first = await BoundarySyncService.claim(); assert.ok(first);
  await db.query("UPDATE boundary_sync_jobs SET status='succeeded' WHERE id=$1", [first!.id]);
  await assert.rejects(BoundarySyncService.claim(), (e: any) => e.code === 'SYNC_RATE_LIMITED');
  assert.equal((await db.query<any>("SELECT count(*)::int AS count FROM boundary_sync_jobs WHERE status='queued'")).rows[0].count, 1);
});
test('worker processes existing jobs after discovery failure and reports failure', async t => {
  const events: string[] = [];
  t.mock.method(BoundarySyncService, 'enqueueDueResearch', async () => { events.push('enqueue'); throw new BoundaryError(503, 'SYNC_CONFIGURATION_INVALID', 'bad config'); });
  let claimed = false;
  t.mock.method(BoundarySyncService, 'claim', async () => { events.push('claim'); if (claimed) return null; claimed = true; return { id: '1' } as any; });
  t.mock.method(BoundarySyncService, 'execute', async () => { events.push('execute'); return 'succeeded' as const; });
  assert.equal(await runBoundaryWorker({ once: true }), false);
  assert.deepEqual(events, ['enqueue', 'claim', 'execute', 'claim']);
});
test('long-running drain rescans due work at most once per minute and shutdown prevents new claims', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  let scans = 0, claims = 0;
  t.mock.method(BoundarySyncService, 'enqueueDueResearch', async () => { scans++; return { queued: 0, skipped: [] }; });
  t.mock.method(BoundarySyncService, 'claim', async () => ++claims <= 3 ? { id: String(claims) } as any : null);
  t.mock.method(BoundarySyncService, 'execute', async () => { now += 30000; return 'succeeded' as const; });
  assert.equal(await runBoundaryWorker({ once: true }), true);
  assert.equal(scans, 2); assert.equal(claims, 4);
  await runBoundaryWorker({ once: true, shouldStop: () => true });
  assert.equal(scans, 2); assert.equal(claims, 4);
});
