import { productionRegressions, mockEmojiExamples } from '../src/data/emojiEvaluationCases.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { IdeaController } from '../src/controllers/ideaController.js';
import { findEmojiCandidates, IdeaEmojiService } from '../src/services/ideaEmojiService.js';
import { IdeaService } from '../src/services/ideaService.js';
import { RecommendedActionService } from '../src/services/recommendedActionService.js';
import { RecommendableActionService } from '../src/services/recommendableActionService.js';
import { validateCreateIdea, validateUpdateIdea, type Idea } from '../src/models/idea.js';
import { getPublicImprovementsDb } from '../src/config/firestore.js';
import { recommendableMockDescriptions } from '../src/data/recommendableMockDescriptions.js';

const makeIdea = (emoji?: string): Idea => ({
  id: 41,
  ...(emoji ? { emoji } : {}),
  boundaryIds: [],
  creationDate: '2026-01-01T00:00:00.000Z',
  modificationDate: '2026-01-01T00:00:00.000Z',
  status: 'new',
  author: { email: 'resident@example.com', name: 'Resident' },
  content: { summary: 'Add a protected bike lane', details: 'The road feels unsafe for cyclists.' },
  location: { description: '', address: '' },
});

function setupEnv(t: any) {
  const oldMode = process.env.EMOJI_RETRIEVAL_MODE;
  process.env.EMOJI_RETRIEVAL_MODE = 'lexical';
  t.after(() => { if (oldMode === undefined) delete process.env.EMOJI_RETRIEVAL_MODE; else process.env.EMOJI_RETRIEVAL_MODE = oldMode; });
  const oldKey = process.env.TYPESAFE_API_KEY;
  const oldModel = process.env.TYPESAFE_MODEL;
  process.env.TYPESAFE_API_KEY = 'test-key';
  delete process.env.TYPESAFE_MODEL;
  t.after(() => {
    if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = oldKey;
    if (oldModel === undefined) delete process.env.TYPESAFE_MODEL; else process.env.TYPESAFE_MODEL = oldModel;
  });
}

function successResponse(emoji = '🚲') {
  return async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'jev-latest');
    assert.deepEqual(body.state, { summary: 'Add a protected bike lane', details: 'The road feels unsafe for cyclists.' });
    assert.ok(Object.keys(body.questions).length > 0 && Object.keys(body.questions).length <= 32);
    const selected = Object.keys(body.questions).find(id => body.questions[id].instructions.question.includes(`${emoji} (`));
    assert.ok(selected, `Missing JEV candidate ${emoji}`);
    const answers = Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'noul', noul: id === selected ? 0.98 : 0.1 }]));
    return new Response(JSON.stringify({ answers }));
  };
}

function fakeResponse() {
  return {
    statusCode: 200,
    payload: undefined as any,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: any) { this.payload = payload; return this; },
  };
}

test('JEV selects the strongest relevant emoji and validates confidence output', async t => {
  setupEnv(t);
  const fetch = t.mock.method(globalThis, 'fetch', successResponse());
  assert.equal(await IdeaEmojiService.assign('Add a protected bike lane', 'The road feels unsafe for cyclists.'), '🚲');
  assert.equal(fetch.mock.callCount(), 1);
});

test('semantic routing retrieves an emoji absent from lexical candidates and logs no input text', async t => {
  setupEnv(t);
  const summary = 'A place to purchase provisions for supper';
  assert.ok(!findEmojiCandidates(summary).some(entry => entry.emoji === '🛒'));
  let diagnostics: any;
  t.mock.method(console, 'info', () => {});
  t.mock.method(globalThis, 'fetch', async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]: [string, any]) => [id, {
      type: 'noul', noul: question.instructions.question.includes('shopping cart') ? 0.98 : 0.01,
    }]));
    return new Response(JSON.stringify({ answers }));
  });
  assert.equal(await IdeaEmojiService.assign(summary, '', { mode: 'hybrid', ideaId: 36, onDiagnostics: value => { diagnostics = value; } }), '🛒');
  assert.equal(diagnostics.ideaId, 36);
  assert.equal(diagnostics.outcome, 'assigned');
  assert.ok(diagnostics.stages.some((stage: any) => stage.stage === 'routing'));
  assert.ok(!JSON.stringify(diagnostics).includes(summary));
  assert.ok(!JSON.stringify(diagnostics).includes('test-key'));
});

test('semantic failure falls back to lexical candidates and records the failure category', async t => {
  setupEnv(t);
  let diagnostics: any;
  t.mock.method(console, 'info', () => {});
  t.mock.method(globalThis, 'fetch', async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    if (Object.values(body.questions).some((q: any) => q.instructions.question.includes('Does this group'))) return new Response('', { status: 503 });
    return successResponse()(url, init);
  });
  assert.equal(await IdeaEmojiService.assign('Add a protected bike lane', 'The road feels unsafe for cyclists.', {
    mode: 'hybrid', onDiagnostics: value => { diagnostics = value; },
  }), '🚲');
  assert.equal(diagnostics.semanticFailure, 'http_error');
  assert.equal(diagnostics.outcome, 'assigned');
});

test('malformed probabilities are diagnosed separately from low confidence', async t => {
  setupEnv(t);
  let diagnostics: any;
  t.mock.method(console, 'info', () => {});
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ answers: { emoji_0: { type: 'noul', noul: 2 } } })));
  await assert.rejects(IdeaEmojiService.assign('Bicycle lane', '', { onDiagnostics: value => { diagnostics = value; } }), /valid probability/);
  assert.equal(diagnostics.outcome, 'malformed_response');
});

test('emoji classification rejects unavailable configuration and low-confidence answers', async t => {
  const oldKey = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  t.after(() => { if (oldKey !== undefined) process.env.TYPESAFE_API_KEY = oldKey; });
  await assert.rejects(IdeaEmojiService.assign('A idea', ''), /not configured/);
  process.env.TYPESAFE_API_KEY = 'test-key';
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ answers: { emoji_0: { type: 'noul', noul: 0.5 } } })));
  await assert.rejects(IdeaEmojiService.assign('Add a bike lane', ''), /sufficiently relevant/);
});

test('candidate retrieval supports the complete Unicode Emoji 18.0 catalog with a bounded JEV shortlist', () => {
  const bicycle = findEmojiCandidates('Create a protected bicycle lane');
  const pickle = findEmojiCandidates('Install pickle-shaped neighborhood art');
  assert.ok(bicycle.some(entry => entry.emoji === '🚲'));
  assert.ok(pickle.some(entry => entry.emoji === '🥒'));
  assert.ok(bicycle.length <= 32);
  assert.ok(pickle.length > 0);
});

test('submission 38 retrieves crossing, walking, and signal options despite incidental details', () => {
  const summary = 'Install safety measures at this dangerous street crossing to help pedestrians avoid potential vehicle accidents.';
  const details = "Many people try to cross the street here, which can be dangerous. I've seen families with several little kids and a man with a cane that walked very slowly, and many other young men and women getting groceries while in their restaurant uniform before heading home. Several have gotten hit because they move slowly, like the man with the cane. Something that helps them cross safely should help reduce crashes that look inevitable";
  const candidates = findEmojiCandidates(summary, details);
  assert.ok(candidates.slice(0, 5).some(entry => entry.emoji === '🚸'));
  for (const emoji of ['🚶', '🚦', '🚥']) assert.ok(candidates.some(entry => entry.emoji === emoji), `Missing ${emoji}`);
  assert.ok(candidates.length <= 32);
  assert.equal(candidates.filter(entry => /^(?:person|man|woman) walking/.test(entry.name)).length, 1);
  assert.equal(candidates.filter(entry => /^(?:person|man|woman) with white cane/.test(entry.name)).length, 1);
  assert.ok(candidates.every(entry => !entry.name.includes('skin tone')));
});

test('summary topic takes precedence over several competing detail topics', () => {
  const candidates = findEmojiCandidates(
    'Confirm whether the ducks are still living there.',
    'People getting a haircut and a massage beside cars, traffic lights, pedestrians, families walking with a cane, and a restaurant.',
  );
  assert.equal(candidates[0].emoji, '🦆');
});


for (const fixture of productionRegressions) {
  test(`submission ${fixture.id} retrieves relevant topic candidates`, () => {
    const candidates = findEmojiCandidates(fixture.summary, fixture.details);
    assert.ok(candidates.length <= 32);
    for (const emoji of fixture.expected) {
      assert.ok(candidates.slice(0, 5).some(entry => entry.emoji === emoji), `Missing top-five ${emoji}: ${candidates.map(entry => entry.emoji).join(' ')}`);
    }
  });
}

test('high and low qualifiers do not introduce unrelated grocery candidates', () => {
  const fixture = productionRegressions.find(item => item.id === 36)!;
  const candidates = findEmojiCandidates(fixture.summary, fixture.details);
  for (const emoji of ['🪫', '🔈', '⚡', '👠', '🚄', '🔊']) {
    assert.ok(!candidates.some(entry => entry.emoji === emoji), `Unrelated candidate ${emoji}`);
  }
  assert.deepEqual(findEmojiCandidates('high low'), []);
  for (const [topic, emoji] of [['high voltage', '⚡'], ['low battery', '🪫'], ['high-speed train', '🚄'], ['low volume speaker', '🔈']]) {
    assert.ok(findEmojiCandidates(topic).some(entry => entry.emoji === emoji), `Lost specific topic ${topic}`);
  }
});

test('submission 36 sends grocery candidates to JEV and accepts its shopping-cart choice', async t => {
  setupEnv(t);
  const fixture = productionRegressions.find(item => item.id === 36)!;
  t.mock.method(globalThis, 'fetch', async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.state, { summary: fixture.summary, details: fixture.details });
    const selected = Object.keys(body.questions).find(id => body.questions[id].instructions.question.includes('🛒 ('));
    assert.ok(selected, 'Shopping cart must reach JEV');
    return new Response(JSON.stringify({ answers: { [selected]: { type: 'noul', noul: 0.95 } } }));
  });
  assert.equal(await IdeaEmojiService.assign(fixture.summary, fixture.details), '🛒');
});

test('plural pedestrians expand like pedestrian, with one neutral representative per walking family', () => {
  const singular = findEmojiCandidates('Pedestrian crossing');
  assert.deepEqual(findEmojiCandidates('Pedestrians crossing'), singular);
  const walking = singular.filter(entry => /^(?:person|man|woman) walking/.test(entry.name));
  assert.deepEqual(walking.map(entry => entry.emoji), ['🚶']);
  const explicit = findEmojiCandidates('A man walking with dark skin tone facing right');
  assert.deepEqual(explicit.filter(entry => /^(?:person|man|woman) walking/.test(entry.name)).map(entry => entry.emoji), ['🚶🏿‍♂️‍➡️']);
});

test('generic City references do not select country flags, and occupational variants share one slot', () => {
  const candidates = findEmojiCandidates('City construction workers repairing the street');
  assert.ok(candidates.every(entry => !entry.name.startsWith('flag: ')));
  assert.deepEqual(candidates.filter(entry => entry.name.includes('construction worker')).map(entry => entry.emoji), ['👷']);
  assert.ok(findEmojiCandidates('Install a flag of Vatican City').some(entry => entry.emoji === '🇻🇦'));
});

test('every playground mock description retrieves a relevant topic emoji', () => {
  // One acceptable topic icon per input, not a requirement that JEV choose this exact icon.
  const examples = mockEmojiExamples;
  assert.equal(examples.length, recommendableMockDescriptions.length, 'Review the topic examples when mock descriptions change.');
  const missing = recommendableMockDescriptions.flatMap((description, index) => {
    const candidates = findEmojiCandidates(description);
    assert.ok(candidates.length <= 32);
    return candidates.some(entry => entry.emoji === examples[index]) ? [] : [{ index: index + 1, expected: examples[index], description, candidates: candidates.map(entry => entry.emoji).join(' ') }];
  });
  assert.deepEqual(missing, []);
});

test('legacy Firestore ideas map without emoji and stored emojis are exposed', async t => {
  const database = getPublicImprovementsDb();
  let stored: any = { id: 41, status: 'new', author: {}, content: {}, location: {} };
  t.mock.method(database, 'collection', (name: string) => {
    assert.equal(name, 'idea');
    return { doc: (id: string) => ({ get: async () => ({ exists: true, id, data: () => stored }) }) } as any;
  });
  const legacy = await IdeaService.getById(41);
  assert.equal(legacy && 'emoji' in legacy, false);
  stored = { ...stored, emoji: '🚲' };
  assert.equal((await IdeaService.getById(41))?.emoji, '🚲');
});

test('emoji cannot be supplied through create or update validation', () => {
  const created = validateCreateIdea({ emoji: '💣', author: { email: 'resident@example.com', name: 'Resident' }, content: { summary: 'Idea' } });
  assert.equal(created.data && 'emoji' in created.data, false);
  const updated = validateUpdateIdea({ emoji: '💣' });
  assert.equal(updated.error, undefined);
  assert.deepEqual(updated.data, {});
});

test('unbound creation handler persists and returns an assigned emoji when JEV succeeds', async t => {
  setupEnv(t);
  t.mock.method(IdeaService, 'create', async () => makeIdea());
  t.mock.method(IdeaService, 'assignEmojiIfMissing', async (_id: number, emoji: string) => makeIdea(emoji));
  t.mock.method(RecommendableActionService, 'matchIdea', async () => [] as any);
  t.mock.method(globalThis, 'fetch', successResponse());
  const res = fakeResponse();
  const create = IdeaController.create;
  await create({ body: {
    author: { email: 'resident@example.com', name: 'Resident' },
    content: { summary: 'Add a protected bike lane', details: 'The road feels unsafe for cyclists.' },
  } } as any, res as any, error => { throw error; });
  assert.equal(res.statusCode, 201);
  assert.equal(res.payload.data.emoji, '🚲');
});

test('creation remains successful when JEV fails', async t => {
  const oldWarn = console.warn;
  t.after(() => { console.warn = oldWarn; });
  console.warn = () => {};
  const oldKey = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  t.after(() => { if (oldKey !== undefined) process.env.TYPESAFE_API_KEY = oldKey; });
  t.mock.method(IdeaService, 'create', async () => makeIdea());
  t.mock.method(RecommendableActionService, 'matchIdea', async () => [] as any);
  const res = fakeResponse();
  await IdeaController.create({ body: {
    author: { email: 'resident@example.com', name: 'Resident' },
    content: { summary: 'Add a protected bike lane' },
  } } as any, res as any, error => { throw error; });
  assert.equal(res.statusCode, 201);
  assert.equal('emoji' in res.payload.data, false);
});

test('unbound individual GET assigns a missing emoji and persists it before returning', async t => {
  setupEnv(t);
  t.mock.method(IdeaService, 'getById', async () => makeIdea());
  t.mock.method(IdeaService, 'assignEmojiIfMissing', async (_id: number, emoji: string) => makeIdea(emoji));
  t.mock.method(RecommendedActionService, 'getLog', async () => ({ data: [], nextCursor: null, hasMore: false }));
  t.mock.method(globalThis, 'fetch', successResponse());
  const res = fakeResponse();
  const getById = IdeaController.getById;
  await getById({ params: { id: '41' } } as any, res as any, error => { throw error; });
  assert.equal(res.payload.data.emoji, '🚲');
});

test('individual GET skips classification when an emoji already exists', async t => {
  t.mock.method(IdeaService, 'getById', async () => makeIdea('🌳'));
  t.mock.method(IdeaService, 'assignEmojiIfMissing', () => { throw new Error('Unexpected emoji write'); });
  t.mock.method(RecommendedActionService, 'getLog', async () => ({ data: [], nextCursor: null, hasMore: false }));
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected JEV request'); });
  const res = fakeResponse();
  await IdeaController.getById({ params: { id: '41' } } as any, res as any, error => { throw error; });
  assert.equal(res.payload.data.emoji, '🌳');
});

test('individual GET returns without an emoji when JEV is unavailable', async t => {
  const oldKey = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  t.after(() => { if (oldKey !== undefined) process.env.TYPESAFE_API_KEY = oldKey; });
  t.mock.method(IdeaService, 'getById', async () => makeIdea());
  t.mock.method(RecommendedActionService, 'getLog', async () => ({ data: [], nextCursor: null, hasMore: false }));
  const warn = t.mock.method(console, 'warn', () => {});
  const missing = fakeResponse();
  await IdeaController.getById({ params: { id: '41' } } as any, missing as any, error => { throw error; });
  assert.equal(missing.statusCode, 200);
  assert.equal('emoji' in missing.payload.data, false);
  assert.equal(warn.mock.callCount(), 1);
});
