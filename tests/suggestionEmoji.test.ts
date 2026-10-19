import test from 'node:test';
import assert from 'node:assert/strict';
import { SuggestionController } from '../src/controllers/suggestionController.js';
import { SuggestionEmojiService } from '../src/services/suggestionEmojiService.js';
import { SuggestionService } from '../src/services/suggestionService.js';
import { RecommendedActionService } from '../src/services/recommendedActionService.js';
import { RecommendableActionService } from '../src/services/recommendableActionService.js';
import { validateCreateSuggestion, validateUpdateSuggestion, type Suggestion } from '../src/models/suggestion.js';
import { getPublicImprovementsDb } from '../src/config/firestore.js';

const makeSuggestion = (emoji?: string): Suggestion => ({
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
    assert.ok(Object.keys(body.questions).length > 10);
    const answers = Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'noul', noul: id === 'emoji_0' && emoji === '🚲' ? 0.98 : 0.1 }]));
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
  assert.equal(await SuggestionEmojiService.assign('Add a protected bike lane', 'The road feels unsafe for cyclists.'), '🚲');
  assert.equal(fetch.mock.callCount(), 1);
});

test('emoji classification rejects unavailable configuration and low-confidence answers', async t => {
  const oldKey = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  t.after(() => { if (oldKey !== undefined) process.env.TYPESAFE_API_KEY = oldKey; });
  await assert.rejects(SuggestionEmojiService.assign('A suggestion', ''), /not configured/);
  process.env.TYPESAFE_API_KEY = 'test-key';
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ answers: { emoji_0: { type: 'noul', noul: 0.5 } } })));
  await assert.rejects(SuggestionEmojiService.assign('A suggestion', ''), /sufficiently relevant/);
});

test('legacy Firestore suggestions map without emoji and stored emojis are exposed', async t => {
  const database = getPublicImprovementsDb();
  let stored: any = { id: 41, status: 'new', author: {}, content: {}, location: {} };
  t.mock.method(database, 'collection', (name: string) => {
    assert.equal(name, 'suggestion');
    return { doc: (id: string) => ({ get: async () => ({ exists: true, id, data: () => stored }) }) } as any;
  });
  const legacy = await SuggestionService.getById(41);
  assert.equal(legacy && 'emoji' in legacy, false);
  stored = { ...stored, emoji: '🚲' };
  assert.equal((await SuggestionService.getById(41))?.emoji, '🚲');
});

test('emoji cannot be supplied through create or update validation', () => {
  const created = validateCreateSuggestion({ emoji: '💣', author: { email: 'resident@example.com', name: 'Resident' }, content: { summary: 'Idea' } });
  assert.equal(created.data && 'emoji' in created.data, false);
  const updated = validateUpdateSuggestion({ emoji: '💣' });
  assert.equal(updated.error, undefined);
  assert.deepEqual(updated.data, {});
});

test('creation persists and returns an assigned emoji when JEV succeeds', async t => {
  setupEnv(t);
  t.mock.method(SuggestionService, 'create', async () => makeSuggestion());
  t.mock.method(SuggestionService, 'assignEmojiIfMissing', async (_id: number, emoji: string) => makeSuggestion(emoji));
  t.mock.method(RecommendableActionService, 'matchSuggestion', async () => [] as any);
  t.mock.method(globalThis, 'fetch', successResponse());
  const res = fakeResponse();
  await SuggestionController.create({ body: {
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
  t.mock.method(SuggestionService, 'create', async () => makeSuggestion());
  t.mock.method(RecommendableActionService, 'matchSuggestion', async () => [] as any);
  const res = fakeResponse();
  await SuggestionController.create({ body: {
    author: { email: 'resident@example.com', name: 'Resident' },
    content: { summary: 'Add a protected bike lane' },
  } } as any, res as any, error => { throw error; });
  assert.equal(res.statusCode, 201);
  assert.equal('emoji' in res.payload.data, false);
});

test('individual GET assigns a missing emoji and persists it before returning', async t => {
  setupEnv(t);
  t.mock.method(SuggestionService, 'getById', async () => makeSuggestion());
  t.mock.method(SuggestionService, 'assignEmojiIfMissing', async (_id: number, emoji: string) => makeSuggestion(emoji));
  t.mock.method(RecommendedActionService, 'getLog', async () => ({ data: [], nextCursor: null, hasMore: false }));
  t.mock.method(globalThis, 'fetch', successResponse());
  const res = fakeResponse();
  await SuggestionController.getById({ params: { id: '41' } } as any, res as any, error => { throw error; });
  assert.equal(res.payload.data.emoji, '🚲');
});

test('individual GET skips classification when an emoji already exists', async t => {
  t.mock.method(SuggestionService, 'getById', async () => makeSuggestion('🌳'));
  t.mock.method(SuggestionService, 'assignEmojiIfMissing', () => { throw new Error('Unexpected emoji write'); });
  t.mock.method(RecommendedActionService, 'getLog', async () => ({ data: [], nextCursor: null, hasMore: false }));
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected JEV request'); });
  const res = fakeResponse();
  await SuggestionController.getById({ params: { id: '41' } } as any, res as any, error => { throw error; });
  assert.equal(res.payload.data.emoji, '🌳');
});

test('individual GET returns without an emoji when JEV is unavailable', async t => {
  const oldKey = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  t.after(() => { if (oldKey !== undefined) process.env.TYPESAFE_API_KEY = oldKey; });
  t.mock.method(SuggestionService, 'getById', async () => makeSuggestion());
  t.mock.method(RecommendedActionService, 'getLog', async () => ({ data: [], nextCursor: null, hasMore: false }));
  const warn = t.mock.method(console, 'warn', () => {});
  const missing = fakeResponse();
  await SuggestionController.getById({ params: { id: '41' } } as any, missing as any, error => { throw error; });
  assert.equal(missing.statusCode, 200);
  assert.equal('emoji' in missing.payload.data, false);
  assert.equal(warn.mock.callCount(), 1);
});
