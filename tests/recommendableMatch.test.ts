import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import vm from 'node:vm';
import { marked } from 'marked';
import { getPublicImprovementsDb } from '../src/config/firestore.js';
import { RecommendableActionService as Service } from '../src/services/recommendableActionService.js';
import { RecommendedActionService } from '../src/services/recommendedActionService.js';
import { BoundaryService } from '../src/services/boundaryService.js';
import { RepresentativesService } from '../src/services/representativesService.js';
import { validateMatchInput } from '../src/models/recommendableMatch.js';
import { playgroundHtml } from '../src/controllers/recommendablePlaygroundController.js';
import { createApp } from '../src/app.js';

const action = (id: string, boundaries: number[] = [], status = 'approved') => ({ id, summary: `Action ${id}`, instructions: 'Call the city', why: 'Helps', whyNot: 'Unrelated issues', boundaries, sourceUrl: 'https://example.org/', sourceEvidence: 'Evidence', sourceDescription: 'Source', status, version: 1 });
function catalog(t: any, rows: ReturnType<typeof action>[], links: string[] = []) {
  Service.clearRelevanceCache();
  t.after(() => Service.clearRelevanceCache());
  const pages: string[][] = [];
  t.mock.method(getPublicImprovementsDb(), 'collection', (path: string) => {
    if (path !== 'recommendableActions') {
      assert.match(path, /^suggestion\/\d+\/recommendedActions$/);
      return { get: async () => ({ docs: links.map(id => ({ get: () => id })) }) };
    }
    let after = ''; let limit = 500;
    const query = {
      where: (field: string, op: string, value: string) => { assert.deepEqual([field, op, value], ['status', '==', 'approved']); return query; },
      orderBy: () => query, limit: (n: number) => { limit = n; return query; },
      startAfter: (id: string) => { after = id; return query; },
      get: async () => {
        const page = rows.filter(a => a.status === 'approved' && a.id > after).sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit);
        pages.push(page.map(a => a.id));
        return { docs: page.map(a => ({ id: a.id, data: () => a })) };
      },
    };
    return query;
  });
  t.mock.method(RecommendedActionService, 'create', () => { throw new Error('Unexpected write'); });
  t.mock.method(getPublicImprovementsDb(), 'runTransaction', () => { throw new Error('Unexpected transaction'); });
  t.mock.method(BoundaryService, 'findAll', async () => []);
  t.mock.method(RepresentativesService, 'findAll', async () => []);
  const oldKey = process.env.TYPESAFE_API_KEY; const oldThreshold = process.env.RECOMMENDABLE_MATCH_THRESHOLD; const oldModel = process.env.TYPESAFE_MODEL;
  process.env.TYPESAFE_API_KEY = 'test'; delete process.env.RECOMMENDABLE_MATCH_THRESHOLD;
  t.after(() => { if (oldModel === undefined) delete process.env.TYPESAFE_MODEL; else process.env.TYPESAFE_MODEL = oldModel; if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = oldKey; if (oldThreshold === undefined) delete process.env.RECOMMENDABLE_MATCH_THRESHOLD; else process.env.RECOMMENDABLE_MATCH_THRESHOLD = oldThreshold; });
  return pages;
}
function jev(t: any, probability: (id: string) => number = () => .95) {
  return t.mock.method(globalThis, 'fetch', async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'noul', noul: id.startsWith('pair_') ? 0 : probability(id.slice(7)) }])) }));
  });
}

test('matching validation accepts paired coordinates including zero; rejects invalid input', () => {
  for (const bypassJevCache of ['true', 1, null, {}, []]) assert.equal(validateMatchInput({ text: 'x', bypassJevCache }).error, 'bypassJevCache must be a boolean.');
  for (const bypassJevCache of [true, false]) assert.deepEqual(validateMatchInput({ text: 'x', bypassJevCache }).data, { text: 'x', bypassJevCache });
  for (const input of [null, [], {}, { text: ' ' }, { text: 'a'.repeat(10001) }, { text: 'x', latitude: 32 }, { text: 'x', latitude: null, longitude: null }, { text: 'x', latitude: '32', longitude: -96 }, { text: 'x', latitude: 91, longitude: 0 }, { text: 'x', latitude: 0, longitude: -181 }, { text: 'x', latitude: NaN, longitude: Infinity }]) assert.ok(validateMatchInput(input).error);
  assert.deepEqual(validateMatchInput({ text: 'x', latitude: 0, longitude: 0 }).data, { text: 'x', latitude: 0, longitude: 0 });
  assert.deepEqual(validateMatchInput({ text: 'x' }).data, { text: 'x' });
});

test('full catalog pagination, approved-only filtering, batches and bounded concurrency', async t => {
  const rows = Array.from({ length: 521 }, (_, i) => action(String(i).padStart(4, '0')));
  const pages = catalog(t, [...rows, action('rejected', [], 'rejected')]);
  let active = 0, peak = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init: any) => {
    const body = JSON.parse(init.body); const keys = Object.keys(body.questions);
    assert.ok(keys.length <= 40); if (keys[0].startsWith('action_')) assert.equal(body.state.text, 'Raw text');
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 1)); --active;
    return new Response(JSON.stringify({ answers: Object.fromEntries(keys.map(id => [id, { type: 'noul', noul: id.startsWith('pair_') ? 0 : .95 }])) }));
  });
  const result = await Service.findMatches({ text: 'Raw text' });
  assert.deepEqual(pages.map(p => p.length), [500, 21]);
  assert.equal(peak, 3); assert.equal(result.count, 521); assert.equal(result.diagnostics.catalogCount, 521);
});

test('global and geographic eligibility; threshold inclusive and deterministic ordering', async t => {
  catalog(t, [action('a'), action('b', [20]), action('c', [99]), action('d'), action('e')]);
  t.mock.method(BoundaryService, 'findAll', async () => [{ id: 20, entityName: 'Dallas', bodyName: 'Council', districtName: '1' }] as any);
  jev(t, id => id === 'd' ? .7999 : id === 'b' ? .99 : .8);
  const result = await Service.findMatches({ text: 'x', latitude: 32.7767, longitude: -96.797 });
  assert.deepEqual(result.data.map(a => a.id), ['b', 'a', 'e']);
  assert.deepEqual(result.eligibleActions.map(a => a.id), ['b', 'a', 'e', 'd']);
  assert.equal(result.eligibleActions[3].matchProbability, .7999);
  assert.equal(result.diagnostics.eligibleCount, 4);
  assert.deepEqual(result.diagnostics.boundaries, [{ id: 20, name: 'Dallas / Council / 1', representatives: [] }]);
  const without = await Service.findMatches({ text: 'x' });
  assert.deepEqual(without.data.map(a => a.id), ['a', 'e']);
});

test('boundary pagination includes overlaps beyond first 1000', async t => {
  catalog(t, [action('a', [1001])]); jev(t);
  t.mock.method(BoundaryService, 'findAll', async (search: any) => Array.from({ length: search.offset === 0 ? 1000 : 1 }, (_, i) => ({ id: search.offset + i + 1, entityName: 'District' })) as any);
  const result = await Service.findMatches({ text: 'x', latitude: 0, longitude: 0 });
  assert.equal(result.count, 1); assert.equal(result.diagnostics.boundaries.length, 1001);
});

test('dynamic buckets use inclusive floors, cap fallback results, and never backfill weaker matches', async t => {
  const cases = [
    { scores: [.95, .9, .88, .85, .82, .8, .79999, .15, .04], ids: ['0', '1', '2', '3', '4', '5'], threshold: .8 },
    { scores: [.8, .79, .7, .15, .04], ids: ['0'], threshold: .8 },
    { scores: [.79999, .7, .6, .4, .3, .2, .15, .14999, .04], ids: ['0', '1', '2', '3', '4'], threshold: .15 },
    { scores: [.15, .14999, .1, .04], ids: ['0'], threshold: .15 },
    { scores: [.14999, .12, .1, .08, .06, .04, .03999, 0], ids: ['0', '1', '2', '3', '4'], threshold: .04 },
    { scores: [.04, .03999, 0], ids: ['0'], threshold: .04 },
    { scores: [.03999, .01, 0], ids: [], threshold: .04 },
    { scores: [.15, .15, .15, .15, .15, .15], ids: ['0', '1', '2', '3', '4'], threshold: .15 },
    { scores: [], ids: [], threshold: .04 },
  ];
  for (const scenario of cases) await t.test(JSON.stringify(scenario.scores), async t => {
    catalog(t, scenario.scores.map((_, i) => action(String(i))));
    const fetch = jev(t, id => scenario.scores[Number(id)]);
    // Legacy deployments may still have this variable; fixed buckets supersede it.
    process.env.RECOMMENDABLE_MATCH_THRESHOLD = '.99';
    const first = await Service.findMatches({ text: 'Bucket selection' });
    assert.deepEqual(first.data.map(a => a.id), scenario.ids);
    assert.equal(first.count, scenario.ids.length);
    assert.equal(first.diagnostics.threshold, scenario.threshold);
    assert.equal(first.eligibleActions.length, scenario.scores.length);
    assert.ok(first.data.every(a => a.matchProbability >= .04));
    const requests = fetch.mock.callCount();
    const cached = await Service.findMatches({ text: 'Bucket selection' });
    assert.deepEqual(cached.data, first.data);
    assert.equal(cached.diagnostics.threshold, scenario.threshold);
    assert.equal(fetch.mock.callCount(), requests);
  });
});

test('representatives are paginated, current-only, and grouped by boundary', async t => {
  catalog(t, [action('a')]); jev(t);
  t.mock.method(BoundaryService, 'findAll', async () => [{ id: 20, entityName: 'Dallas' }, { id: 21, entityName: 'County' }] as any);
  const reads: any[] = [];
  t.mock.method(RepresentativesService, 'findAll', async search => {
    reads.push(search);
    return (search.offset === 0 ? Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, boundaryId: 20, name: 'Member', title: 'Council', phones: [], emails: [] })) : [{ id: 1001, boundaryId: 21, name: 'Commissioner', title: 'Commissioner', phones: null, emails: [] }]) as any;
  });
  const result = await Service.findMatches({ text: 'x', latitude: 0, longitude: 0 });
  assert.deepEqual(reads.map(r => r.offset), [0, 1000]);
  assert.deepEqual(reads[0].boundaryIds, [20, 21]);
  assert.equal(reads[0].servingAsOf, undefined);
  assert.equal(result.diagnostics.boundaries[0].representatives?.length, 1000);
  assert.equal(result.diagnostics.boundaries[1].representatives?.[0].name, 'Commissioner');
});

test('empty catalog and no eligible actions avoid JEV; configuration errors are explicit', async t => {
  catalog(t, []); const fetch = jev(t);
  assert.equal((await Service.findMatches({ text: 'x' })).count, 0); assert.equal(fetch.mock.callCount(), 0);
  catalog(t, [action('a', [1])]);
  assert.equal((await Service.findMatches({ text: 'x' })).diagnostics.eligibleCount, 0);
  catalog(t, [action('a')]); delete process.env.TYPESAFE_API_KEY;
  await assert.rejects(Service.findMatches({ text: 'x' }), /not configured/);
});

test('empty catalog with Dallas coordinates skips boundaries; boundary failures are actionable', async t => {
  catalog(t, []);
  const boundaries = t.mock.method(BoundaryService, 'findAll', async () => { throw new Error('read ECONNRESET'); });
  const input = { text: 'Pothole', latitude: 32.7767, longitude: -96.797 };
  assert.equal((await Service.findMatches(input)).diagnostics.catalogCount, 0);
  assert.equal(boundaries.mock.callCount(), 0);
  catalog(t, [action('a')]);
  t.mock.method(BoundaryService, 'findAll', async () => { throw new Error('read ECONNRESET'); });
  await assert.rejects(Service.findMatches(input), (error: any) => error.status === 503 && /PostgreSQL/.test(error.message) && !error.message.includes('ECONNRESET'));
});

test('bad JEV JSON and missing, mistyped, out-of-range answers fail the entire run', async t => {
  catalog(t, [action('a')]);
  for (const body of ['not json', 'null', '{}', JSON.stringify({ answers: { action_a: { type: 'score', noul: .99 } } }), JSON.stringify({ answers: { action_a: { type: 'noul', noul: 1.01 } } })]) {
    const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(body));
    await assert.rejects(Service.findMatches({ text: 'x' }), (e: any) => e.status === 502);
    fetch.mock.restore();
  }
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 429 }));
  await assert.rejects(Service.findMatches({ text: 'x' }), (e: any) => e.status === 503);
});

test('JEV cache normalizes description and coordinates but sends original text to JEV', async t => {
  catalog(t, [action('a')]); const fetch = jev(t);
  const original = '  Fix the road! 123. ';
  const first = await Service.findMatches({ text: original, latitude: 32.77671, longitude: -96.79701 });
  first.eligibleActions[0].matchProbability = 0;
  const repeated = await Service.findMatches({ text: 'fix THE ROAD 123', latitude: 32.77672, longitude: -96.79702 });
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(repeated.eligibleActions[0].matchProbability, .95);
  assert.equal(JSON.parse(fetch.mock.calls[0].arguments[1].body).state.text, original);
  await Service.findMatches({ text: original, latitude: 32.7768, longitude: -96.79702 });
  assert.equal(fetch.mock.callCount(), 2);
  await Service.findMatches({ text: 'A different issue', latitude: 32.77671, longitude: -96.79701 });
  assert.equal(fetch.mock.callCount(), 3);
  await Service.findMatches({ text: original });
  assert.equal(fetch.mock.callCount(), 4);
});

test('JEV cache expires after one hour without extending on access', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  catalog(t, [action('a')]); const fetch = jev(t);
  await Service.findMatches({ text: 'x' });
  now += 60 * 60 * 1000 - 1; await Service.findMatches({ text: 'X!' });
  assert.equal(fetch.mock.callCount(), 1);
  now++; await Service.findMatches({ text: 'x' });
  assert.equal(fetch.mock.callCount(), 2);
});

test('fresh runs bypass both caches without overwriting them, and diagnostic counts and timings are exposed', async t => {
  let score = .95;
  catalog(t, [action('a'), action('b')]); const fetch = jev(t, () => score);
  const input = { text: 'Issue', latitude: 32.7767, longitude: -96.797 };
  const boundaries = t.mock.method(BoundaryService, 'findAll', async () => []);
  const first = await Service.findMatches(input);
  assert.equal(first.diagnostics.relevance.cacheHit, false);
  assert.equal(first.diagnostics.relevance.networkRequestCount, 1);
  assert.equal(first.diagnostics.comparisons.networkRequestCount, 1);
  assert.equal(fetch.mock.callCount(), 2);
  const cached = await Service.findMatches(input);
  assert.equal(cached.diagnostics.relevance.cacheHit, true);
  assert.equal(cached.diagnostics.comparisons.cacheHits, 1);
  assert.equal(fetch.mock.callCount(), 2);
  score = .85;
  const fresh = await Service.findMatches({ ...input, bypassJevCache: true });
  assert.equal(fresh.count, 2);
  assert.equal(fresh.data[0].matchProbability, .85);
  assert.equal(fresh.diagnostics.bypassJevCache, true);
  assert.equal(fresh.diagnostics.relevance.cacheHit, false);
  assert.equal(fresh.diagnostics.comparisons.cacheHits, 0);
  assert.equal(fetch.mock.callCount(), 4);
  assert.equal((await Service.findMatches(input)).count, 2); assert.equal(fetch.mock.callCount(), 4);
  assert.equal(boundaries.mock.callCount(), 4);
  await Service.findMatches({ text: 'Other issue', bypassJevCache: true });
  await Service.findMatches({ text: 'Other issue' }); assert.equal(fetch.mock.callCount(), 8);
  assert.ok(first.diagnostics.totalDurationMs >= first.diagnostics.relevance.durationMs + first.diagnostics.comparisons.durationMs);
  assert.equal(first.diagnostics.comparisons.candidateCount, 2);
  assert.equal(first.diagnostics.comparisons.pairCount, 1);
  assert.equal(first.diagnostics.comparisons.removedActionCount, 0);
});

test('empty and single-candidate runs have zero comparison counts', async t => {
  catalog(t, []);
  const empty = await Service.findMatches({ text: 'Issue' });
  assert.equal(empty.diagnostics.comparisons.pairCount, 0);
  assert.equal(empty.diagnostics.comparisons.networkRequestCount, 0);
  assert.equal(empty.diagnostics.relevance.networkRequestCount, 0);
  catalog(t, [action('a')]); jev(t);
  const single = await Service.findMatches({ text: 'Issue' });
  assert.equal(single.diagnostics.comparisons.candidateCount, 1);
  assert.equal(single.diagnostics.comparisons.pairCount, 0);
  assert.equal(single.diagnostics.comparisons.networkRequestCount, 0);
});

test('catalog content, eligibility, and model changes invalidate JEV cache; bucket selection and photos stay fresh', async t => {
  const rows = [{ ...action('a'), photos: ['https://example.org/old.jpg'] }];
  catalog(t, rows); const fetch = jev(t, () => .85);
  const first = await Service.findMatches({ text: 'x' }); assert.equal(first.count, 1);
  assert.equal(first.diagnostics.threshold, .8);
  rows[0].photos = ['https://example.org/new.jpg']; process.env.RECOMMENDABLE_MATCH_THRESHOLD = '.8';
  const updated = await Service.findMatches({ text: 'X!' });
  assert.equal(updated.count, 1); assert.deepEqual(updated.data[0].photos, ['https://example.org/new.jpg']);
  assert.equal(fetch.mock.callCount(), 1);
  rows[0].instructions = 'Changed instructions';
  await Service.findMatches({ text: 'x' }); assert.equal(fetch.mock.callCount(), 2);
  rows.push({ ...action('b'), photos: [] });
  assert.equal((await Service.findMatches({ text: 'x' })).eligibleActions.length, 2);
  assert.equal(fetch.mock.callCount(), 4);
  rows[0].status = 'closed';
  assert.deepEqual((await Service.findMatches({ text: 'x' })).eligibleActions.map(a => a.id), ['b']);
  assert.equal(fetch.mock.callCount(), 5);
  process.env.TYPESAFE_MODEL = 'another-model';
  await Service.findMatches({ text: 'x' }); assert.equal(fetch.mock.callCount(), 6);
});

test('JEV cache reuses below-threshold scores and evicts least recently used entries', async t => {
  catalog(t, [action('a')]); const fetch = jev(t, () => .1);
  for (let i = 0; i < 128; i++) await Service.findMatches({ text: 'Issue ' + i });
  await Service.findMatches({ text: 'Issue 0' });
  await Service.findMatches({ text: 'Issue 128' });
  const repeated = await Service.findMatches({ text: 'ISSUE 0!' });
  assert.equal(fetch.mock.callCount(), 129); assert.equal(repeated.count, 1);
  assert.equal(repeated.diagnostics.threshold, .04);
  assert.equal(repeated.eligibleActions[0].matchProbability, .1);
  await Service.findMatches({ text: 'Issue 1' }); assert.equal(fetch.mock.callCount(), 130);
});

test('caller cancellation aborts in-flight JEV and prevents further batches', async t => {
  catalog(t, Array.from({ length: 200 }, (_, i) => action(String(i))));
  const controller = new AbortController(); let started = 0;
  t.mock.method(globalThis, 'fetch', (_url, init: any) => new Promise((_resolve, reject) => {
    started++; init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    if (started === 3) controller.abort();
  }));
  await assert.rejects(Service.findMatches({ text: 'x' }, controller.signal));
  assert.equal(started, 3);
});

test('20 second batch timeout maps to 504', async t => {
  catalog(t, [action('a')]);
  const controller = new AbortController();
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { assert.equal(ms, 20000); return controller.signal; });
  t.mock.method(globalThis, 'fetch', (_url, init: any) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    controller.abort(new DOMException('timeout', 'TimeoutError'));
  }));
  await assert.rejects(Service.findMatches({ text: 'x' }), (e: any) => e.status === 504);
});

test('120 second overall deadline covers stalled database reads', async t => {
  catalog(t, []);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(getPublicImprovementsDb(), 'collection', () => {
    const q = { where: () => q, orderBy: () => q, limit: () => q, get: () => new Promise(() => {}) }; return q as any;
  });
  const pending = Service.findMatches({ text: 'x' });
  t.mock.timers.tick(120000);
  await assert.rejects(pending, (e: any) => e.status === 504);
});

test('shared matching removes encapsulated actions from playground results and saved recommendations', async t => {
  catalog(t, [action('b'), action('c'), action('a')]);
  const comparisons: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url, init: any) => {
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify({ answers: Object.fromEntries(Object.entries(body.questions).map(([id, q]: [string, any]) => {
      const pair = id.startsWith('pair_');
      if (pair) comparisons.push(`${body.state.action.id}:${q.instructions.other_action.id}`);
      return [id, { type: 'noul', noul: pair ? (q.instructions.other_action.id === 'b' ? .99 : .1) : .95 }];
    })) }));
  });
  const result = await Service.findMatches({ text: 'Issue' });
  assert.deepEqual(result.data.map(a => a.id), ['a', 'c']);
  assert.deepEqual(result.eligibleActions.map(a => a.id), ['a', 'c']);
  assert.equal(result.count, 2); assert.equal(result.diagnostics.eligibleCount, 3);
  assert.deepEqual(comparisons, ['a:b', 'a:c']);
  const create = t.mock.method(RecommendedActionService, 'create', async () => ({} as any));
  const saved = await Service.matchSuggestion({ id: 7, content: { summary: 'Issue' }, location: {} } as any);
  assert.deepEqual(saved.map(a => a.id), ['a', 'c']);
  assert.deepEqual(create.mock.calls.map(call => call.arguments[2]), ['recommendable-a', 'recommendable-c']);
  assert.deepEqual(comparisons, ['a:b', 'a:c']);
});

test('a failed comparison retries on a relevance cache hit without caching the failed exclusion', async t => {
  catalog(t, [action('a'), action('b')]);
  let relevanceCalls = 0, comparisonCalls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init: any) => {
    const body = JSON.parse(init.body); const ids = Object.keys(body.questions);
    if (ids[0].startsWith('pair_')) {
      comparisonCalls++;
      return new Response(JSON.stringify(comparisonCalls === 1 ? {} : { answers: { pair_0: { type: 'noul', noul: .99 } } }));
    }
    relevanceCalls++;
    return new Response(JSON.stringify({ answers: Object.fromEntries(ids.map(id => [id, { type: 'noul', noul: .95 }])) }));
  });
  assert.equal((await Service.findMatches({ text: 'Issue' })).count, 2);
  assert.equal((await Service.findMatches({ text: 'ISSUE!' })).count, 1);
  assert.equal(relevanceCalls, 1); assert.equal(comparisonCalls, 2);
});

test('saved-suggestion wrapper skips existing links and returns only newly created entries', async t => {
  catalog(t, [], ['old']);
  t.mock.method(Service, 'findMatches', async input => {
    assert.equal(input.text, 'Summary\n\nDetails');
    return { data: [action('old'), action('new')].map(a => ({ ...a, matchProbability: .95 })), count: 2, diagnostics: {} } as any;
  });
  const create = t.mock.method(RecommendedActionService, 'create', async () => ({} as any));
  const result = await Service.matchSuggestion({ id: 7, content: { summary: 'Summary', details: 'Details' }, location: {} } as any);
  assert.deepEqual(result.map(a => a.id), ['new']);
  assert.equal(create.mock.callCount(), 1);
  assert.equal(create.mock.calls[0].arguments[2], 'recommendable-new');
  assert.equal(create.mock.calls[0].arguments[1].matchProbability, .95);
});

test('saved suggestions persist only the top five actions from the fallback bucket', async t => {
  const scores = [.14, .12, .1, .08, .04, .04, .03999];
  catalog(t, scores.map((_, i) => action(String(i))));
  jev(t, id => scores[Number(id)]);
  const create = t.mock.method(RecommendedActionService, 'create', async () => ({} as any));
  const saved = await Service.matchSuggestion({ id: 42, content: { summary: 'Geofence policy request' }, location: {} } as any);
  assert.deepEqual(saved.map(a => a.id), ['0', '1', '2', '3', '4']);
  assert.deepEqual(create.mock.calls.map(call => call.arguments[1].matchProbability), [.14, .12, .1, .08, .04]);
});

test('public page and API validate requests and cancel classification on disconnect', async t => {
  const calls: any[] = [];
  const match = t.mock.method(Service, 'findMatches', async (input, signal) => { calls.push(input); return { data: [], count: 0, diagnostics: { catalogCount: 0, eligibleCount: 0, threshold: .9, boundaries: [] } }; });
  const server = createApp().listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const page = await fetch(base + '/playground/recommendables'); assert.equal(page.status, 200);
  const html = await page.text(); assert.match(html, /value="32.781162"/); assert.match(html, /value="-96.794861"/);
  assert.match(html, /value="1902 Main St, Dallas, TX 75201"/);
  for (const asset of ['marked.js', 'purify.js']) {
    const script = await fetch(base + '/playground/recommendables/' + asset);
    assert.equal(script.status, 200); assert.match(script.headers.get('content-type') ?? '', /javascript/);
  }
  assert.match(await (await fetch(base)).text(), /href="\/playground\/recommendables"/);
  const url = base + '/api/recommendables/match';
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' })).status, 415);
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"x","bypassJevCache":"true"}' })).status, 400);
  assert.equal((await fetch(base + '/api/recommendables/locations?input=ab&sessionToken=test-session-1234')).status, 400);
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x', latitude: 32.7767, longitude: -96.797, bypassJevCache: true }) });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(calls, [{ text: 'x', latitude: 32.7767, longitude: -96.797, bypassJevCache: true }]);
  let began!: () => void; const started = new Promise<void>(r => began = r);
  let cancelled!: () => void; const stopped = new Promise<void>(r => cancelled = r);
  match.mock.restore();
  t.mock.method(Service, 'findMatches', async (_input, signal) => { began(); return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => { cancelled(); reject(signal!.reason); }, { once: true })); });
  const abort = new AbortController();
  const request = fetch(url, { method: 'POST', signal: abort.signal, headers: { 'Content-Type': 'application/json' }, body: '{"text":"x"}' });
  await started; abort.abort(); await assert.rejects(request); await stopped;
});

// Execute the actual page script against a minimal DOM to exercise submissions and safe rendering.
test('playground script sends numeric Dallas coordinates, omits cleared inputs, handles states and safe text', async () => {
  let reducedMotion = true;
  const animations: Array<{ node: Element; options: any; finish: () => void }> = [];
  class Element {
    value = ''; hidden = true; checked = false; disabled = false; textContent = ''; className = ''; children: Element[] = []; attrs: any = {}; handler: any;
    style: any = {}; scrollHeight = 110; handlers: Record<string, any> = {}; open = false;
    focus() {} showModal() { this.open = true; } close() { this.open = false; }
    append(node: Element) { this.children.push(node); }
    replaceChildren() { this.children = []; }
    setAttribute(key: string, value: string) { this.attrs[key] = value; }
    querySelectorAll() { return Array.from(((this as any).innerHTML ?? '').matchAll(/<a href="([^"]+)"/g), (match: any) => ({ getAttribute: () => match[1] })); }
    addEventListener(name: string, fn: any) { this.handler = fn; this.handlers[name] = fn; }
    getBoundingClientRect() { return { height: 200 }; }
    animate(_frames: any, options: any) {
      let finish!: () => void, cancel!: (error: Error) => void;
      const finished = new Promise<void>((resolve, reject) => { finish = resolve; cancel = reject; });
      animations.push({ node: this, options, finish });
      return { finished, cancel: () => cancel(new Error('Animation cancelled')) };
    }
  }
  const ids = Object.fromEntries(['match-form', 'submit', 'status', 'output', 'results', 'text', 'latitude', 'longitude', 'show-all', 'random-description', 'low-toggle', 'results-heading', 'form-controls', 'bypass-jev-cache', 'address', 'address-options', 'location-status', 'maps-attribution', 'sample-dialog', 'choose-sample', 'sample-filter', 'sample-list', 'sample-count', 'close-samples', 'testing-options', 'testing-options-button', 'testing-options-panel', 'set-location', 'set-location-button', 'set-location-options', 'current-location', 'default-location', 'clear-location', 'location-mode', 'coordinate-fields', 'address-fields'].map(id => [id, new Element()]));
  ids.text.value = 'Street improvements'; ids.latitude.value = '32.7767'; ids.longitude.value = '-96.7970';
  let sent: any; let failure = false; let eligible = 4; let count = 1; let requests = 0; let withLow = true; let customActions: any[] | undefined; let customBoundaries: any[] | undefined;
  const hostile = '<img src=x onerror=alert(1)>';
  let sanitized = '';
  let geoSuccess: any, geoError: any;
  const addressCalls: URL[] = []; let delayedAddress: ((value: any) => void) | undefined; let delayAddress = false;
  vm.runInNewContext(playgroundHtml.match(/<script>([\s\S]*?)<\/script>/)![1], { URL, URLSearchParams, AbortController, setTimeout, clearTimeout, crypto: { randomUUID: () => 'a'.repeat(32) }, navigator: { geolocation: { getCurrentPosition(success: any, error: any) { geoSuccess = success; geoError = error; } } }, getComputedStyle: () => ({ paddingTop: '24px', paddingBottom: '24px', marginTop: '16px', marginBottom: '16px', borderTopWidth: '1px', borderBottomWidth: '1px' }), window: { addEventListener() {}, matchMedia: () => ({ matches: reducedMotion }) }, marked, DOMPurify: { sanitize: (html: string, options: any) => { assert.ok(options.ALLOWED_TAGS.includes('ol')); assert.ok(!options.ALLOWED_TAGS.includes('script')); assert.ok(!options.ALLOWED_ATTR.includes('onclick')); sanitized = html; return html; } }, document: { getElementById: (id: string) => ids[id], createElement: () => new Element() }, fetch: async (_url: string, init: any) => {
    if (_url.startsWith('/api/recommendables/locations?')) {
      const url = new URL(_url, 'http://localhost'); addressCalls.push(url);
      if (delayAddress) return new Promise(resolve => { delayedAddress = resolve; });
      return { ok: true, json: async () => url.searchParams.has('placeId') ? { address: 'Dallas City Hall', latitude: 32.7767, longitude: -96.797 } : { suggestions: [{ placeId: 'city-hall', text: 'Dallas City Hall' }] } };
    }
    assert.equal(ids.submit.disabled, true); assert.equal(ids['form-controls'].disabled, true); assert.equal(ids.submit.children[0].className, 'spinner'); assert.equal(ids.results.attrs['aria-busy'], 'true'); sent = JSON.parse(init.body); requests++;
    const high = { ...action('a'), photos: ['https://example.org/photo.jpg', 'javascript:alert(1)', 'https://example.org/photo.jpg'], instructions: '1. [Go to Dallas 311](https://dallascrm.my.site.com/public/s/)\n2. Choose **Street**', summary: hostile, matchProbability: .8, sourceUrl: 'javascript:alert(1)' };
    return { ok: !failure, json: async () => failure ? { message: 'Try again' } : { data: customActions ?? (count ? [high, { ...high, id: 'b', matchProbability: .8, photos: [], whyNot: '  ', sourceUrl: 'https://dallascrm.my.site.com/public/s/#top' }] : []), eligibleActions: customActions ?? (eligible ? (count ? [high, { ...high, id: 'b', matchProbability: .8, photos: [], whyNot: '  ', sourceUrl: 'https://dallascrm.my.site.com/public/s/#top' }, { ...high, id: 'c', matchProbability: .49999, sourceUrl: 'https://example.org/source' }, { ...high, id: 'd', matchProbability: .2 }, { ...high, id: 'e', matchProbability: .19999 }, { ...high, id: 'f', matchProbability: .1 }, { ...high, id: 'g', matchProbability: 0 }].filter(action => withLow || action.matchProbability >= .5).reverse() : [{ ...high, matchProbability: .03 }]) : []), count, diagnostics: { catalogCount: 4, eligibleCount: eligible, threshold: .9, boundaries: customBoundaries ?? [{ id: 20, name: 'Dallas / Council', representatives: [{ name: 'Jane Doe', title: 'Council Member', phones: [{ label: 'Alex Staff — Council Liaison', phone: '2145559999', when_to_use: 'Staff assistance' }, { label: 'Council Member Jane Doe', phone: '2145551234', when_to_use: 'Neighborhood concerns' }], emails: [{ label: 'JANE DOE - Council member', email: 'office@example.org', when_to_use: 'Written requests for neighborhood concerns' }] }] }] } } };
  } });
  const submit = () => ids['match-form'].handler({ preventDefault() {} });
  assert.equal(ids['show-all'].disabled, true); assert.equal(ids['show-all'].checked, false);
  assert.match(playgroundHtml, /id="low-toggle" class="result-toggle"><input id="show-all" type="checkbox" disabled>/);
  assert.equal(ids['location-mode'].value, 'address'); assert.equal(ids['coordinate-fields'].hidden, true);
  assert.equal(ids['set-location-options'].hidden, true);
  ids['set-location-button'].handler(); assert.equal(ids['set-location-options'].hidden, false);
  assert.equal(ids['set-location-button'].attrs['aria-expanded'], 'true');
  ids['set-location'].handlers.keydown({ key: 'Escape', preventDefault() {} });
  assert.equal(ids['set-location-options'].hidden, true);
  ids['set-location-button'].handler(); ids['default-location'].handler();
  assert.equal(ids['set-location-options'].hidden, true);
  ids['location-mode'].handler({ target: { value: 'coordinates' } });
  assert.equal(ids['coordinate-fields'].hidden, false); assert.equal(ids.latitude.disabled, false);
  assert.equal(ids['address-fields'].hidden, true);
  ids['location-mode'].handler({ target: { value: 'address' } });
  assert.equal(ids['coordinate-fields'].hidden, true); assert.equal(ids.latitude.disabled, true);
  assert.equal(ids.address.value, '1902 Main St, Dallas, TX 75201');
  await submit(); assert.deepEqual(sent, { text: 'Street improvements', bypassJevCache: false, latitude: 32.781162, longitude: -96.794861 });
  assert.equal(ids.submit.disabled, false); assert.equal(ids['form-controls'].disabled, false); assert.equal(ids.submit.textContent, 'Search'); assert.equal(ids.results.attrs['aria-busy'], 'false');
  assert.equal(ids['results-heading'].hidden, false);
  const card = ids.output.children[0]; assert.equal(card.children[0].textContent, hostile + ' '); assert.equal(card.children.length, 5);
  const gallery = card.children[1];
  assert.equal(gallery.className, 'match-photos');
  assert.equal(gallery.children.length, 1);
  assert.equal(gallery.children[0].href, 'https://example.org/photo.jpg');
  assert.equal(gallery.children[0].children[0].src, 'https://example.org/photo.jpg');
  assert.equal(gallery.children[0].children[0].loading, 'lazy');
  assert.equal(ids.output.children[1].children.length, 3);
  assert.equal(card.children[0].children[0].textContent, '80% match');
  assert.match(playgroundHtml, /\.probability\{white-space:nowrap\}/);
  assert.equal(card.children[3].children[0].textContent, 'Why: ');
  assert.equal(card.children[4].children[0].textContent, 'Why not: ');
  assert.equal(ids.output.children[1].children[2].children.length, 1);
  assert.equal(ids.output.children[1].children[2].children[0].textContent, 'Helps');
  assert.equal(card.className, 'card match-primary');
  assert.equal(ids.output.children[1].className, 'card match-primary');
  assert.equal(ids.output.children.length, 3);
  assert.ok(!ids.output.children.includes(ids['low-toggle']));
  assert.match(playgroundHtml, /<details id="testing-options" class="testing-options">[\s\S]*?id="low-toggle"[\s\S]*?<\/details>/);
  assert.equal(ids['show-all'].disabled, false);
  assert.match(sanitized, /<ol>/); assert.match(sanitized, /<a href="https:\/\/dallascrm.my.site.com\/public\/s\/">Go to Dallas 311<\/a>/); assert.match(sanitized, /<strong>Street<\/strong>/);
  const table = ids.output.children[2].children[0];
  assert.equal(table.children[0].textContent, 'Boundary matches');
  assert.deepEqual(table.children[1].children[0].children.map(c => c.textContent), ['Representative', 'Contact']);
  const identity = table.children[2].children[0].children[0];
  assert.equal(identity.children[0].textContent, 'Jane Doe — Council Member');
  assert.deepEqual(identity.children[1].children.map(level => level.textContent), ['Dallas', ' › Council']);
  const representative = table.children[2].children[0].children[1].children[0];
  assert.equal(representative.children[0].children[0].textContent, 'Phone: ');
  assert.equal(representative.children.length, 3);
  assert.equal(representative.children[2].textContent, 'Written requests for neighborhood concerns');
  assert.equal(representative.children[1].children[1].textContent, 'office@example.org');
  assert.equal(table.children[2].children[0].children[1].children[1].children[0].textContent, 'Alex Staff — Council Liaison');
  ids['show-all'].checked = true; ids['show-all'].handler();
  assert.equal(requests, 1); assert.equal(ids.output.children.length, 9);
  assert.equal(ids.status.textContent, '');
  assert.equal(ids.output.children[8].className, 'boundaries');
  assert.deepEqual(ids.output.children.filter(node => node.className.startsWith('card ')).map(node => node.children[0].children[0].textContent), ['80% match', '80% match', '50% match', '20% match', '20% match', '10% match', '0% match']);
  assert.equal(ids.output.children[3].className, 'card match-tertiary');
  assert.equal(ids.output.children[4].children[0].children[0].textContent, '20% match');
  assert.equal(ids.output.children[3].children.at(-1)?.textContent, 'View source');
  const more311 = ids.output.children[2];
  assert.equal(more311.textContent, 'Show more');
  assert.equal(more311.attrs['aria-expanded'], 'false');
  assert.equal(ids.output.children[3].hidden, true); assert.equal(ids.output.children[4].hidden, true);
  more311.handler(); assert.equal(more311.textContent, 'Show less');
  assert.equal(ids.output.children[3].hidden, false); assert.equal(ids.output.children[4].hidden, false);
  more311.handler(); assert.equal(more311.textContent, 'Show more'); assert.equal(ids.output.children[3].hidden, true);
  assert.equal(requests, 1);
  ids['show-all'].checked = false; ids['show-all'].handler();
  assert.equal(requests, 1); assert.equal(ids.output.children.length, 3);
  ids['show-all'].checked = true;
  withLow = false; await submit();
  assert.equal(ids['show-all'].disabled, true); assert.equal(ids['show-all'].checked, false);
  assert.equal(ids.output.children.length, 3);
  withLow = true;
  ids['clear-location'].handler(); count = 0;
  await submit(); assert.deepEqual(sent, { text: 'Street improvements', bypassJevCache: false }); assert.match(ids.status.textContent, /No actions reached 4%/);
  assert.equal(ids['show-all'].disabled, false); assert.equal(ids['show-all'].checked, false);
  ids['show-all'].checked = true; ids['show-all'].handler();
  assert.equal(ids.output.children[0].children[0].children[0].textContent, '3% match');
  assert.equal(ids.status.textContent, '');
  customActions = [{ ...action('fallback'), matchProbability: .04 }];
  await submit();
  assert.equal(ids['show-all'].checked, false);
  assert.equal(ids.output.children[0].children[0].children[0].textContent, '4% match');
  assert.equal(ids.status.textContent, '');
  customActions = undefined;
  eligible = 0; await submit(); assert.match(ids.status.textContent, /geographically eligible/);
  failure = true; await submit(); assert.equal(ids.status.textContent, 'Try again'); assert.equal(ids.output.children.length, 0);
  assert.equal(ids['results-heading'].hidden, true);
  assert.equal(ids.text.value, 'Street improvements');
  ids.latitude.value = '1'; await submit(); assert.match(ids.status.textContent, /both coordinates/);
  ids.text.value = ''; ids.text.scrollHeight = 450; ids.text.handler();
  assert.equal(ids.submit.disabled, true); assert.equal(ids.text.style.height, '452px');
  ids['random-description'].handler(); assert.ok(ids.text.value.length); assert.equal(ids.submit.disabled, false);
  ids['choose-sample'].handler(); assert.equal(ids['sample-dialog'].open, true); assert.ok(ids['sample-list'].children.length > 100);
  ids['sample-filter'].value = 'gas'; ids['sample-filter'].handler();
  const choice = ids['sample-list'].children[0].children[0]; choice.handler();
  assert.equal(ids.text.value, choice.textContent); assert.equal(ids['sample-dialog'].open, false);
  ids['location-mode'].handler({ target: { value: 'address' } }); assert.equal(ids['coordinate-fields'].hidden, true);
  ids['current-location'].handler(); assert.equal(ids.submit.disabled, true);
  geoSuccess({ coords: { latitude: 32.8, longitude: -96.8 } });
  assert.equal(ids.latitude.value, '32.8'); assert.match(ids.address.value, /Current location/);
  assert.equal(ids.submit.disabled, false);
  ids['current-location'].handler(); ids['clear-location'].handler();
  geoSuccess({ coords: { latitude: 5, longitude: 6 } });
  assert.equal(ids.latitude.value, ''); assert.equal(ids.address.value, '');
  assert.match(ids['location-status'].textContent, /unrestricted/);
  ids['current-location'].handler(); geoError({ code: 1 });
  assert.match(ids['location-status'].textContent, /denied/); assert.equal(ids.submit.disabled, false);
  ids.address.value = 'Dallas'; ids.address.handlers.input();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(addressCalls.length, 1); assert.equal(ids['address-options'].children[0].children[0].textContent, 'Dallas City Hall');
  await ids['address-options'].children[0].children[0].handler();
  assert.equal(addressCalls[1].searchParams.get('sessionToken'), addressCalls[0].searchParams.get('sessionToken'));
  assert.equal(ids.latitude.value, '32.7767'); assert.equal(ids.address.value, 'Dallas City Hall');
  assert.equal(ids['location-status'].textContent, '');
  failure = false; eligible = count = 1; await submit();
  assert.equal(sent.latitude, 32.7767); assert.equal(sent.longitude, -96.797);
  delayAddress = true; ids.address.value = 'another address'; ids.address.handlers.input();
  await new Promise(resolve => setTimeout(resolve, 300));
  ids['clear-location'].handler();
  delayedAddress!({ ok: true, json: async () => ({ suggestions: [{ placeId: 'old', text: 'Stale response' }] }) });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(ids['address-options'].children.length, 0); assert.equal(ids.latitude.value, '');
  await submit(); assert.deepEqual(sent, { text: ids.text.value, bypassJevCache: false });
  ids['bypass-jev-cache'].checked = true; await submit(); assert.equal(sent.bypassJevCache, true);
  assert.equal(ids['bypass-jev-cache'].checked, true);
  ids['current-location'].handler(); ids['default-location'].handler();
  geoSuccess({ coords: { latitude: 5, longitude: 6 } });
  assert.equal(ids.latitude.value, '32.781162'); assert.equal(ids.longitude.value, '-96.794861');
  assert.equal(ids.address.value, '1902 Main St, Dallas, TX 75201');
  await submit(); assert.equal(sent.latitude, 32.781162); assert.equal(sent.longitude, -96.794861);
  customActions = ['311 first', 'Contact Atmos', '311 second', '311 third', 'Contact council', '311 fourth'].map((summary, i) => ({ ...action(String(i)), summary, matchProbability: .95 - i * .01 }));
  await submit();
  assert.equal(ids.output.children[3].textContent, 'Show more');
  assert.equal(ids.output.children[4].hidden, true); assert.equal(ids.output.children[6].hidden, true);
  assert.equal(ids.output.children[1].hidden, false); assert.equal(ids.output.children[5].hidden, false);
  const requestsBeforeToggle = requests;
  ids.output.children[3].handler();
  assert.equal(ids.output.children[4].hidden, false); assert.equal(ids.output.children[6].hidden, false);
  assert.equal(requests, requestsBeforeToggle);
  customActions = customActions.slice(0, 3); await submit();
  assert.ok(ids.output.children.every(child => child.className !== 'secondary-button more-311'));
  assert.equal(animations.length, 0);
  reducedMotion = false;
  customActions.push({ ...action('extra'), summary: 'Submit another 311 request', matchProbability: .8 });
  await submit();
  assert.equal(animations.filter(animation => animation.node === ids.submit).length, 2);
  assert.ok(animations.some(animation => animation.options.delay === 35));
  const animatedToggle = ids.output.children[3], animatedCard = ids.output.children[4];
  animatedToggle.handler(); assert.equal(animatedCard.hidden, false);
  animations.at(-1)!.finish(); await Promise.resolve();
  animatedToggle.handler(); assert.equal(animatedCard.hidden, false);
  animations.at(-1)!.finish(); await Promise.resolve(); assert.equal(animatedCard.hidden, true);
  animatedToggle.handler(); animatedToggle.handler(); animatedToggle.handler();
  animations.at(-1)!.finish(); await Promise.resolve(); assert.equal(animatedCard.hidden, false);
  reducedMotion = true; const animationCount = animations.length;
  animatedToggle.handler(); assert.equal(animatedCard.hidden, true); assert.equal(animations.length, animationCount);
  reducedMotion = false;
  ids['choose-sample'].handler(); assert.equal(ids['sample-dialog'].open, true);
  ids['close-samples'].handler(); assert.equal(ids['sample-dialog'].open, true);
  animations.at(-1)!.finish(); await Promise.resolve(); assert.equal(ids['sample-dialog'].open, false);
  ids['choose-sample'].handler(); let prevented = false;
  ids['sample-dialog'].handlers.cancel({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  animations.at(-1)!.finish(); await Promise.resolve(); assert.equal(ids['sample-dialog'].open, false);
  const requestsBeforeRandomize = requests;
  ids['random-description'].handler();
  assert.ok(ids.text.value.length); assert.equal(animations.at(-1)!.node, ids.text);
  assert.equal(animations.at(-1)!.options.duration, 360);
  ids['random-description'].handler();
  ids.text.value = 'My own description'; ids.text.handler();
  assert.equal(ids.text.value, 'My own description'); assert.equal(requests, requestsBeforeRandomize);
  reducedMotion = true; const countBeforeRandomize = animations.length;
  ids['random-description'].handler(); assert.equal(animations.length, countBeforeRandomize);
  customBoundaries = [
    { id: 1, name: 'No representative', representatives: [] },
    { id: 2, name: 'Empty contacts', representatives: [{ name: 'No Contacts', title: 'Member', phones: [{ label: 'Office', phone: ' ' }], emails: [] }] },
    { id: 3, name: 'Has contacts', representatives: [{ name: 'Office Member', title: 'Member', phones: [{ label: 'Office', phone: '2145551111' }], emails: [{ label: 'Office', email: 'office@example.org' }] }] },
    { id: 4, name: 'Also empty', representatives: [{ name: 'Also No Contacts', title: 'Member', phones: [], emails: [] }] },
  ];
  await submit();
  const sortedRows = ids.output.children.find(child => child.className === 'boundaries')!.children[0].children[2].children;
  assert.deepEqual(sortedRows.slice(0, 3).map(row => row.children[0].children[0].textContent), ['Office Member — Member', 'No Contacts — Member', 'Also No Contacts — Member']);
  const singleGroup = sortedRows[0].children[1].children[0];
  assert.equal(singleGroup.children.length, 2);
  assert.equal(singleGroup.children[0].children[0].textContent, 'Phone: ');
  assert.equal(singleGroup.children[1].children[0].textContent, 'Email: ');
  assert.equal(sortedRows[1].children[1].children[0].className, 'empty-contact');
  assert.equal(sortedRows[3].children[1].children[0].textContent, 'No current representative on file.');
  reducedMotion = false;
  ids['set-location-button'].handler();
  assert.equal(ids['set-location-options'].hidden, false);
  ids['set-location'].handlers.keydown({ key: 'Escape', preventDefault() {} });
  assert.equal(ids['set-location-options'].hidden, false);
  assert.equal((ids['set-location-options'] as any).inert, true);
  animations.at(-1)!.finish(); await Promise.resolve();
  assert.equal(ids['set-location-options'].hidden, true);
  ids['set-location-button'].handler(); ids['set-location-button'].handler(); ids['set-location-button'].handler();
  animations.at(-1)!.finish(); await Promise.resolve();
  assert.equal(ids['set-location-button'].attrs['aria-expanded'], 'true');
  assert.equal(ids['set-location-options'].hidden, false);
  const clickTesting = () => ids['testing-options-button'].handler({ preventDefault() {} });
  clickTesting(); assert.equal(ids['testing-options'].open, true);
  clickTesting(); assert.equal(ids['testing-options'].open, true);
  assert.equal(ids['testing-options-button'].attrs['aria-expanded'], 'false');
  animations.at(-1)!.finish(); await Promise.resolve();
  assert.equal(ids['testing-options'].open, false);
  clickTesting(); clickTesting(); clickTesting();
  animations.at(-1)!.finish(); await Promise.resolve();
  assert.equal(ids['testing-options'].open, true);
  reducedMotion = true; const beforeClosing = animations.length;
  clickTesting(); ids['set-location-button'].handler();
  assert.equal(ids['testing-options'].open, false);
  assert.equal(ids['set-location-options'].hidden, true);
  assert.equal(animations.length, beforeClosing);
});
