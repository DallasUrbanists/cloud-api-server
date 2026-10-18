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
    return new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'noul', noul: probability(id.slice(7)) }])) }));
  });
}

test('matching validation accepts paired coordinates including zero; rejects invalid input', () => {
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
    assert.ok(keys.length <= 40); assert.equal(body.state.text, 'Raw text');
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 1)); --active;
    return new Response(JSON.stringify({ answers: Object.fromEntries(keys.map(id => [id, { type: 'noul', noul: .95 }])) }));
  });
  const result = await Service.findMatches({ text: 'Raw text' });
  assert.deepEqual(pages.map(p => p.length), [500, 21]);
  assert.equal(peak, 3); assert.equal(result.count, 521); assert.equal(result.diagnostics.catalogCount, 521);
});

test('global and geographic eligibility; threshold inclusive and deterministic ordering', async t => {
  catalog(t, [action('a'), action('b', [20]), action('c', [99]), action('d'), action('e')]);
  t.mock.method(BoundaryService, 'findAll', async () => [{ id: 20, entityName: 'Dallas', bodyName: 'Council', districtName: '1' }] as any);
  jev(t, id => id === 'd' ? .8999 : id === 'b' ? .99 : .9);
  const result = await Service.findMatches({ text: 'x', latitude: 32.7767, longitude: -96.797 });
  assert.deepEqual(result.data.map(a => a.id), ['b', 'a', 'e']);
  assert.deepEqual(result.eligibleActions.map(a => a.id), ['b', 'a', 'e', 'd']);
  assert.equal(result.eligibleActions[3].matchProbability, .8999);
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
  process.env.RECOMMENDABLE_MATCH_THRESHOLD = 'bad';
  await assert.rejects(Service.findMatches({ text: 'x' }), /between 0 and 1/);
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

test('catalog content, eligibility, and model changes invalidate JEV cache; threshold and photos stay fresh', async t => {
  const rows = [{ ...action('a'), photos: ['https://example.org/old.jpg'] }];
  catalog(t, rows); const fetch = jev(t, () => .85);
  const first = await Service.findMatches({ text: 'x' }); assert.equal(first.count, 0);
  rows[0].photos = ['https://example.org/new.jpg']; process.env.RECOMMENDABLE_MATCH_THRESHOLD = '.8';
  const updated = await Service.findMatches({ text: 'X!' });
  assert.equal(updated.count, 1); assert.deepEqual(updated.data[0].photos, ['https://example.org/new.jpg']);
  assert.equal(fetch.mock.callCount(), 1);
  rows[0].instructions = 'Changed instructions';
  await Service.findMatches({ text: 'x' }); assert.equal(fetch.mock.callCount(), 2);
  rows.push({ ...action('b'), photos: [] });
  assert.equal((await Service.findMatches({ text: 'x' })).eligibleActions.length, 2);
  assert.equal(fetch.mock.callCount(), 3);
  rows[0].status = 'closed';
  assert.deepEqual((await Service.findMatches({ text: 'x' })).eligibleActions.map(a => a.id), ['b']);
  assert.equal(fetch.mock.callCount(), 4);
  process.env.TYPESAFE_MODEL = 'another-model';
  await Service.findMatches({ text: 'x' }); assert.equal(fetch.mock.callCount(), 5);
});

test('JEV cache reuses below-threshold scores and evicts least recently used entries', async t => {
  catalog(t, [action('a')]); const fetch = jev(t, () => .1);
  for (let i = 0; i < 128; i++) await Service.findMatches({ text: 'Issue ' + i });
  await Service.findMatches({ text: 'Issue 0' });
  await Service.findMatches({ text: 'Issue 128' });
  const repeated = await Service.findMatches({ text: 'ISSUE 0!' });
  assert.equal(fetch.mock.callCount(), 129); assert.equal(repeated.count, 0);
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

test('public page and API validate requests and cancel classification on disconnect', async t => {
  const calls: any[] = [];
  const match = t.mock.method(Service, 'findMatches', async (input, signal) => { calls.push(input); return { data: [], count: 0, diagnostics: { catalogCount: 0, eligibleCount: 0, threshold: .9, boundaries: [] } }; });
  const server = createApp().listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const page = await fetch(base + '/playground/recommendables'); assert.equal(page.status, 200);
  const html = await page.text(); assert.match(html, /value="32.7767"/); assert.match(html, /value="-96.7970"/);
  for (const asset of ['marked.js', 'purify.js']) {
    const script = await fetch(base + '/playground/recommendables/' + asset);
    assert.equal(script.status, 200); assert.match(script.headers.get('content-type') ?? '', /javascript/);
  }
  assert.match(await (await fetch(base)).text(), /href="\/playground\/recommendables"/);
  const url = base + '/api/recommendables/match';
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' })).status, 415);
  assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x', latitude: 32.7767, longitude: -96.797 }) });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(calls, [{ text: 'x', latitude: 32.7767, longitude: -96.797 }]);
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
  class Element {
    value = ''; hidden = true; checked = false; disabled = false; textContent = ''; className = ''; children: Element[] = []; attrs: any = {}; handler: any;
    append(node: Element) { this.children.push(node); }
    replaceChildren() { this.children = []; }
    setAttribute(key: string, value: string) { this.attrs[key] = value; }
    addEventListener(_name: string, fn: any) { this.handler = fn; }
  }
  const ids = Object.fromEntries(['match-form', 'submit', 'status', 'output', 'results', 'text', 'latitude', 'longitude', 'show-all', 'random-description', 'low-toggle'].map(id => [id, new Element()]));
  ids.text.value = 'Street improvements'; ids.latitude.value = '32.7767'; ids.longitude.value = '-96.7970';
  let sent: any; let failure = false; let eligible = 4; let count = 1; let requests = 0; let withLow = true;
  const hostile = '<img src=x onerror=alert(1)>';
  let sanitized = '';
  vm.runInNewContext(playgroundHtml.match(/<script>([\s\S]*?)<\/script>/)![1], { URL, marked, DOMPurify: { sanitize: (html: string, options: any) => { assert.ok(options.ALLOWED_TAGS.includes('ol')); assert.ok(!options.ALLOWED_TAGS.includes('script')); assert.ok(!options.ALLOWED_ATTR.includes('onclick')); sanitized = html; return html; } }, document: { getElementById: (id: string) => ids[id], createElement: () => new Element() }, fetch: async (_url: string, init: any) => {
    assert.equal(ids.submit.disabled, true); assert.equal(ids.results.attrs['aria-busy'], 'true'); sent = JSON.parse(init.body); requests++;
    const high = { ...action('a'), photos: ['https://example.org/photo.jpg', 'javascript:alert(1)', 'https://example.org/photo.jpg'], instructions: '1. [Go to Dallas 311](https://dallascrm.my.site.com/public/s/)\n2. Choose **Street**', summary: hostile, matchProbability: .8, sourceUrl: 'javascript:alert(1)' };
    return { ok: !failure, json: async () => failure ? { message: 'Try again' } : { data: count ? [high] : [], eligibleActions: eligible ? (count ? [high, { ...high, id: 'b', matchProbability: .5, photos: [] }, { ...high, id: 'c', matchProbability: .49999 }, { ...high, id: 'd', matchProbability: .2 }, { ...high, id: 'e', matchProbability: .19999 }, { ...high, id: 'f', matchProbability: .1 }].filter(action => withLow || action.matchProbability >= .5) : [{ ...high, matchProbability: .1 }]) : [], count, diagnostics: { catalogCount: 4, eligibleCount: eligible, threshold: .9, boundaries: [{ id: 20, name: 'Dallas', representatives: [{ name: 'Jane Doe', title: 'Council Member', phones: [{ label: 'Office', phone: '2145551234', when_to_use: 'Neighborhood concerns' }], emails: [{ label: 'Staff', email: 'office@example.org', when_to_use: 'Written requests' }] }] }] } } };
  } });
  const submit = () => ids['match-form'].handler({ preventDefault() {} });
  await submit(); assert.deepEqual(sent, { text: 'Street improvements', latitude: 32.7767, longitude: -96.797 });
  assert.equal(ids.submit.disabled, false); assert.equal(ids.results.attrs['aria-busy'], 'false');
  const card = ids.output.children[0]; assert.equal(card.children[0].textContent, hostile); assert.equal(card.children.length, 6);
  const gallery = card.children[2];
  assert.equal(gallery.className, 'match-photos');
  assert.equal(gallery.children.length, 1);
  assert.equal(gallery.children[0].href, 'https://example.org/photo.jpg');
  assert.equal(gallery.children[0].children[0].src, 'https://example.org/photo.jpg');
  assert.equal(gallery.children[0].children[0].loading, 'lazy');
  assert.equal(ids.output.children[1].children.length, 5);
  assert.equal(card.className, 'card match-primary');
  assert.equal(ids.output.children[1].className, 'card match-secondary');
  assert.equal(ids.output.children.length, 4);
  assert.equal(ids.output.children[2], ids['low-toggle']);
  assert.equal(ids['low-toggle'].hidden, false);
  assert.match(sanitized, /<ol>/); assert.match(sanitized, /<a href="https:\/\/dallascrm.my.site.com\/public\/s\/">Go to Dallas 311<\/a>/); assert.match(sanitized, /<strong>Street<\/strong>/);
  const table = ids.output.children[3].children[0];
  assert.deepEqual(table.children[1].children[0].children.map(c => c.textContent), ['Boundary', 'Representative']);
  const representative = table.children[2].children[0].children[1].children[0];
  assert.equal(representative.children[0].textContent, 'Jane Doe — Council Member');
  assert.equal(representative.children[1].children[0].textContent, 'Office: ');
  assert.equal(representative.children[1].children[2].textContent, 'Neighborhood concerns');
  assert.equal(representative.children[2].children[1].textContent, 'office@example.org');
  ids['show-all'].checked = true; ids['show-all'].handler();
  assert.equal(requests, 1); assert.equal(ids.output.children.length, 6);
  assert.equal(ids.status.textContent, '');
  assert.equal(ids.output.children[5].className, 'boundaries');
  assert.equal(ids.output.children[3].className, 'card match-tertiary');
  assert.match(ids.output.children[4].children[1].textContent, /20.0% · Tertiary/);
  ids['show-all'].checked = false; ids['show-all'].handler();
  assert.equal(requests, 1); assert.equal(ids.output.children.length, 4);
  withLow = false; await submit();
  assert.equal(ids['low-toggle'].hidden, true);
  assert.equal(ids.output.children.length, 3);
  withLow = true;
  ids.latitude.value = ''; ids.longitude.value = ''; count = 0;
  await submit(); assert.deepEqual(sent, { text: 'Street improvements' }); assert.match(ids.status.textContent, /No actions reached 20%/);
  assert.equal(ids['low-toggle'].hidden, true);
  eligible = 0; await submit(); assert.match(ids.status.textContent, /geographically eligible/);
  failure = true; await submit(); assert.equal(ids.status.textContent, 'Try again'); assert.equal(ids.output.children.length, 0);
  assert.equal(ids.text.value, 'Street improvements');
  ids.latitude.value = '1'; await submit(); assert.match(ids.status.textContent, /both coordinates/);
});
