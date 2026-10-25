import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalDescriptionPages, effectiveCaptionVisible, initialPresentationState, normalizeStateForIdea, publicPresentationIdea } from '../src/models/presentation.js';
import { makeFixture, idea as ideaRecord, writableState } from './helpers/presentationFixture.js';

test('description pages use paragraph and word boundaries and cap Unicode code points at 320', () => {
  const paragraphText = `${'a'.repeat(310)}\n\n${'b'.repeat(40)}`;
  const paragraphPages = canonicalDescriptionPages(paragraphText);
  assert.deepEqual(paragraphPages, ['a'.repeat(310), 'b'.repeat(40)]);
  const wordPages = canonicalDescriptionPages(`${'x'.repeat(315)} next words`);
  assert.equal(wordPages[0], 'x'.repeat(315));
  assert.equal(wordPages[1], 'next words');
  const unicode = `${'🌳'.repeat(319)} a ${'🚲'.repeat(400)}`;
  const pages = canonicalDescriptionPages(unicode);
  assert.ok(pages.every(page => Array.from(page).length <= 320));
  assert.ok(pages.join('').includes('🌳'.repeat(319)));
  assert.equal(canonicalDescriptionPages('   ').length, 1);
  assert.equal(canonicalDescriptionPages('   ')[0], '');
});

test('pagination conserves long unbroken tokens and preserves words across page boundaries', () => {
  const token = `${'界'.repeat(325)}${'🙂'.repeat(355)}`;
  assert.equal(canonicalDescriptionPages(token).join(''), token);
  const source = `${'one two three four five six seven eight nine ten '.repeat(40)}tail`;
  const pages = canonicalDescriptionPages(source);
  assert.ok(pages.every(page => Array.from(page).length <= 320));
  assert.equal(pages.join(' ').replace(/\s+/g, ' ').trim(), source.replace(/\s+/g, ' ').trim());
});

test('public DTO is narrow, media identity is stable, and duplicate URLs are deterministic', () => {
  const source = ideaRecord(41, { content: { summary: 'Summary', details: 'Details', photos: [
    { url: 'https://images.example/photo.jpg?token=secret', caption: 'First', internal: 'private' },
    { url: 'https://images.example/photo.jpg?token=other', caption: 'Second' },
    { url: 'http://insecure.example/photo.jpg', caption: 'Drop insecure URL' },
  ] }, author: { email: 'private@example.com', name: 'Resident' }, uid: 'private-uid', logs: [{ email: 'log@example.com' }], workflow: { prompt: 'private request' } });
  const idea = publicPresentationIdea(source, '11111111-1111-4111-8111-111111111111');
  assert.deepEqual(idea.album.map(item => item.id), [idea.album[0].id, `${idea.album[0].id.split(':').slice(0, 2).join(':')}:2`]);
  assert.ok(idea.album[0].url.startsWith('https://images.example/photo.jpg'));
  assert.equal(new URL(idea.album[0].url).search, '');
  assert.deepEqual(Object.keys(idea).sort(), ['album', 'authorName', 'contentVersion', 'creationDate', 'descriptionPages', 'details', 'id', 'location', 'status', 'summary']);
  assert.equal(idea.authorName, 'Resident');
  assert.equal(JSON.stringify(idea).includes('private@example.com'), false);
  assert.equal(JSON.stringify(idea).includes('private-uid'), false);
  assert.equal(JSON.stringify(idea).includes('private request'), false);
  assert.equal(JSON.stringify(idea).includes('log@example.com'), false);
  assert.equal(publicPresentationIdea(source, '11111111-1111-4111-8111-111111111111').contentVersion, idea.contentVersion);
});

test('state normalization advances idea epoch only for a new idea and enforces Streetmix framing', async () => {
  const fixture = makeFixture({ initialIdeas: [ideaRecord(41, { content: { summary: 'Mixed album', details: '', photos: [{ url: 'https://images.example/a.jpg', caption: 'Photo' }] }, streetmix: { streetmixId: 'c13a6af0-8888-4444-8888-0bbee0cc1122', streetmixUrl: 'https://streetmix.net/-/123', stale: true } })] });
  const idea = publicPresentationIdea(fixture.ideas.get(41));
  const initial = initialPresentationState();
  const choose = writableState(initial);
  choose.selectedIdeaId = '41';
  choose.mode = 'photo';
  const selected = normalizeStateForIdea(choose, initial, idea);
  assert.equal(selected.albumItemId, idea.album[0].id);
  const streetmixState = { ...selected, albumItemId: idea.album[1].id, photoFrame: { scale: 4, centerX: 0.1, centerY: 0.9 }, captionVisible: true };
  const normalized = normalizeStateForIdea(streetmixState, { ...initial, ...selected, revision: 1, ideaEpoch: 1 }, idea);
  assert.deepEqual(normalized.photoFrame, { scale: 1, centerX: 0.5, centerY: 0.5 });
  assert.equal(effectiveCaptionVisible({ ...normalized, revision: 2, ideaEpoch: 1 }, idea), false);
  assert.equal(normalized.captionVisible, true);
  const sameIdea = normalizeStateForIdea({ ...normalized, mode: 'map' }, { ...initial, ...normalized, revision: 2, ideaEpoch: 1 }, idea);
  assert.equal(sameIdea.albumItemId, idea.album[1].id);
  assert.equal(fixture.service.effectiveCaption({ state: { ...initial, ...normalized }, contentSnapshot: idea }), false);
});

test('selecting an idea with an empty album starts on its explicit description page', () => {
  const idea = publicPresentationIdea(ideaRecord(51, { content: { summary: 'No photos', details: '', photos: [] } }));
  const initial = initialPresentationState(), requested = writableState(initial);
  requested.selectedIdeaId = '51';
  const selected = normalizeStateForIdea(requested, initial, idea);
  assert.equal(selected.mode, 'description');
  assert.equal(selected.albumItemId, null);
  assert.equal(selected.descriptionPage, 0);
  assert.deepEqual(idea.descriptionPages, ['']);
  assert.deepEqual(idea.album, []);
});
