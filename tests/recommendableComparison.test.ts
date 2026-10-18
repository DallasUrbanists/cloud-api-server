import test from 'node:test';
import assert from 'node:assert/strict';
import { RecommendableComparisonService as Service } from '../src/services/recommendableComparisonService.js';
import type { MatchResult } from '../src/models/recommendableMatch.js';

const action = (id: string, matchProbability: number) => ({ id, summary: id, instructions: 'Contact city', why: 'Report issue', whyNot: 'Other issue', matchProbability }) as MatchResult['eligibleActions'][number];
const run = async (actions: ReturnType<typeof action>[], model = 'jev-latest', signal = new AbortController().signal) => (await Service.filter(actions, { text: 'Issue' }, model, 'test', signal)).actions;
function setup(t: any, judge: (first: string, second: string) => unknown = () => .1) {
  Service.clearCache(); t.after(() => Service.clearCache());
  const pairs: string[] = [];
  const fetch = t.mock.method(globalThis, 'fetch', async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    assert.equal(init.headers.Authorization, 'Bearer test');
    return new Response(JSON.stringify({ answers: Object.fromEntries(Object.entries(body.questions).map(([id, q]: [string, any]) => {
      assert.equal(q.type, 'noul'); assert.ok(q.instructions.question.startsWith(Service.question));
      assert.equal(typeof body.state.text, 'string');
      assert.match(q.criteria.false, /complementary/);
      const first = body.state.action.id; const second = q.instructions.other_action.id;
      pairs.push(`${first}:${second}`);
      return [id, { type: 'noul', noul: judge(first, second) }];
    })) }));
  });
  return { pairs, fetch };
}

test('encapsulation removes the lower score immediately, preserving complementary actions and exact thresholds', async t => {
  const { pairs } = setup(t, (a, b) => a === 'generic' && b === 'specific' ? .90001 : .9);
  const result = await run([action('generic', .95), action('specific', .94), action('complementary', .6), action('low', .20001), action('edge', .2), action('below', .1)]);
  assert.deepEqual(result.map(a => a.id), ['generic', 'complementary', 'low', 'edge', 'below']);
  assert.deepEqual(pairs, ['generic:specific', 'generic:complementary', 'generic:low', 'complementary:low']);
});

test('pair judgments reuse across relevance scores, expire at one hour and invalidate on text/model changes', async t => {
  let now = 1000; t.mock.method(Date, 'now', () => now);
  const { fetch } = setup(t, () => .99);
  const a = action('a', .95), b = action('b', .9);
  assert.equal((await run([a, b])).length, 1);
  // Pair relationship is symmetric; relevance order can change between descriptions.
  assert.deepEqual((await run([{ ...b, matchProbability: .99 }, a])).map(a => a.id), ['b']);
  assert.equal(fetch.mock.callCount(), 1);
  now += 3600000 - 1; await run([a, b]); assert.equal(fetch.mock.callCount(), 1);
  now++; await run([a, b]); assert.equal(fetch.mock.callCount(), 2);
  await run([a, { ...b, whyNot: 'New exclusion' }]); assert.equal(fetch.mock.callCount(), 3);
  await run([a, b], 'another-model'); assert.equal(fetch.mock.callCount(), 4);
});

test('missing, invalid and failed judgments keep actions and are not cached', async t => {
  setup(t);
  const actions = [action('a', .99), action('b', .95)];
  for (const body of ['null', '{}', 'invalid', JSON.stringify({ answers: { pair_0: { type: 'score', noul: .99 } } }), JSON.stringify({ answers: { pair_0: { type: 'noul', noul: 1.1 } } })]) {
    const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(body));
    assert.equal((await run(actions)).length, 2); await run(actions);
    assert.equal(fetch.mock.callCount(), 2); fetch.mock.restore();
  }
  for (const status of [429, 500]) {
    const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('', { status }));
    assert.equal((await run(actions)).length, 2); fetch.mock.restore();
  }
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('network failure'); });
  assert.equal((await run(actions)).length, 2); fetch.mock.restore();
  assert.equal((await run(actions)).length, 2);
});

test('comparison timeout retains actions; caller cancellation aborts matching', async t => {
  setup(t);
  const actions = [action('a', .99), action('b', .95)];
  const timeout = new AbortController();
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { assert.equal(ms, 20000); return timeout.signal; });
  const fetch = t.mock.method(globalThis, 'fetch', async (_url, init: any) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    timeout.abort(new DOMException('timeout', 'TimeoutError'));
  }));
  const timedOut = await Service.filter(actions, { text: 'Issue' }, 'jev-latest', 'test', new AbortController().signal);
  assert.equal(timedOut.actions.length, 2);
  assert.equal(timedOut.diagnostics.pairs[0].failureCode, 'timeout');
  fetch.mock.restore();
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async () => { controller.abort(); throw controller.signal.reason; });
  await assert.rejects(run(actions, 'jev-latest', controller.signal), { name: 'AbortError' });
});

test('comparisons batch at most 40 with at most three requests active', async t => {
  setup(t);
  let active = 0, peak = 0;
  t.mock.method(globalThis, 'fetch', async (_url, init: any) => {
    const body = JSON.parse(init.body); const ids = Object.keys(body.questions);
    assert.ok(ids.length <= 40); peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 1)); active--;
    return new Response(JSON.stringify({ answers: Object.fromEntries(ids.map(id => [id, { type: 'noul', noul: .99 }])) }));
  });
  const result = await run(Array.from({ length: 122 }, (_, i) => action(String(i), 1 - i / 1000)));
  assert.equal(result.length, 1); assert.equal(peak, 3);
});

test('construction example compares practical next steps in the original description and reports the removal', async t => {
  const { fetch } = setup(t, () => .97);
  const text = 'The builders behind my property are adding a second structure that I cannot find on the approved plans. I watched the framing go up and am unsure whether their permit covers it.';
  const actions = [
    { ...action('permit-violation', .92), summary: 'Submit a 311 request about construction that violates a building permit.', instructions: 'Open Dallas 311. Choose Building Permits Violation.', whyNot: 'Small accessory structures may not require a permit.' },
    { ...action('outside-scope', .88), summary: 'Submit a 311 request to report construction outside the scope of a building permit.', instructions: 'Open Dallas 311. Choose Building Permits Violation.', whyNot: '' },
  ];
  const result = await Service.filter(actions, { text }, 'jev-latest', 'test', new AbortController().signal);
  assert.equal(JSON.parse(fetch.mock.calls[0].arguments[1].body).state.text, text);
  assert.deepEqual(result.actions.map(a => a.id), ['permit-violation']);
  assert.deepEqual(result.diagnostics.actions, actions);
  assert.deepEqual(result.diagnostics.pairs, [{ actionIds: ['permit-violation', 'outside-scope'], probability: .97, cacheHit: false, decision: 'remove_lower', removedActionId: 'outside-scope' }]);
  assert.equal(result.diagnostics.policyVersion, 'same-practical-next-step-v2');
  assert.equal(result.diagnostics.removedActionCount, 1); assert.equal(result.diagnostics.pairCount, 1);
  assert.equal(result.diagnostics.failures, 0); assert.ok(result.diagnostics.durationMs >= 0);
});

test('comparison cache is scoped to normalized description and rounded coordinates; bypass neither reads nor writes', async t => {
  let probability = .99;
  const { fetch } = setup(t, () => probability);
  const actions = [action('a', .95), action('b', .9)];
  const input = { text: 'Permit question!', latitude: 32.77671, longitude: -96.79701 };
  const filter = (input: any) => Service.filter(actions, input, 'jev-latest', 'test', new AbortController().signal);
  await filter(input);
  const cached = await filter({ ...input, text: 'PERMIT QUESTION', latitude: 32.77672 });
  assert.equal(fetch.mock.callCount(), 1); assert.equal(cached.diagnostics.cacheHits, 1);
  assert.equal(cached.diagnostics.networkRequestCount, 0); assert.equal(cached.diagnostics.pairs[0].cacheHit, true);
  await filter({ ...input, text: 'Different issue' });
  await filter({ ...input, latitude: 32.7768 });
  assert.equal(fetch.mock.callCount(), 3);
  probability = .1;
  assert.equal((await filter({ ...input, bypassJevCache: true })).actions.length, 2); assert.equal(fetch.mock.callCount(), 4);
  assert.equal((await filter(input)).actions.length, 1); assert.equal(fetch.mock.callCount(), 4);
  await filter({ text: 'Fresh issue', bypassJevCache: true });
  await filter({ text: 'Fresh issue' }); assert.equal(fetch.mock.callCount(), 6);
});

test('failure diagnostics distinguish malformed responses, invalid answers, HTTP and network without leaking errors', async t => {
  setup(t);
  for (const [failureCode, response] of [
    ['malformed_response', () => new Response('secret upstream body')],
    ['invalid_answer', () => new Response('{}')],
    ['http', () => new Response('secret upstream body', { status: 503 })],
    ['network', () => { throw new Error('secret credentials in error'); }],
  ] as const) {
    const fetch = t.mock.method(globalThis, 'fetch', async () => response());
    const result = await Service.filter([action('a', .95), action('b', .9)], { text: 'Issue' }, 'jev-latest', 'test', new AbortController().signal);
    assert.equal(result.actions.length, 2); assert.equal(result.diagnostics.failures, 1);
    assert.equal(result.diagnostics.pairs[0].failureCode, failureCode);
    assert.equal(result.diagnostics.pairs[0].decision, 'keep_on_failure');
    assert.equal(result.diagnostics.pairs[0].probability, null);
    assert.ok(!JSON.stringify(result.diagnostics).includes('secret'));
    fetch.mock.restore();
  }
});

test('pair diagnostics retain matchup order when concurrent requests finish out of order', async t => {
  setup(t);
  t.mock.method(globalThis, 'fetch', async (_url, init: any) => {
    const body = JSON.parse(init.body);
    await new Promise(resolve => setTimeout(resolve, body.questions.pair_0.instructions.other_action.id === '1' ? 8 : 0));
    return new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'noul', noul: .99 }])) }));
  });
  const result = await Service.filter(Array.from({ length: 82 }, (_, i) => action(String(i), 1 - i / 1000)), { text: 'Issue' }, 'jev-latest', 'test', new AbortController().signal);
  assert.deepEqual(result.diagnostics.pairs.map(p => p.actionIds[1]), Array.from({ length: 81 }, (_, i) => String(i + 1)));
  assert.equal(result.diagnostics.networkRequestCount, 3); assert.equal(result.diagnostics.removedActionCount, 81);
});
