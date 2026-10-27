import test from 'node:test';
import assert from 'node:assert/strict';
import { swaggerDocument } from '../src/docs/swagger.js';

test('Ideas OpenAPI publishes both canonical prefixes and deprecated Suggestions path aliases', () => {
  const paths = swaggerDocument.paths as Record<string, any>;
  const canonical = Object.keys(paths).filter(path => path === '/api/ideas' || path.startsWith('/api/ideas/'));
  assert.ok(canonical.length > 0);
  for (const path of canonical) {
    const shortLegacy = path.replace('/api/ideas', '/api/suggestions').replaceAll('{ideaId}', '{suggestionId}');
    const namespaced = path.replace('/api/ideas', '/api/public-improvements/ideas');
    const namespacedLegacy = path.replace('/api/ideas', '/api/public-improvements/suggestions').replaceAll('{ideaId}', '{suggestionId}');
    for (const alias of [namespaced, shortLegacy, namespacedLegacy]) assert.ok(paths[alias], `Missing ${alias}`);
    for (const [method, operation] of Object.entries(paths[shortLegacy])) {
      if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) assert.equal((operation as any).deprecated, true, `${method} ${shortLegacy}`);
    }
  }
  assert.match(paths['/api/ideas/ws'].get.description, /protocolVersion:2.*ideaId/);
  assert.equal(paths['/api/suggestions/ws'].get.deprecated, true);
});

test('Ideas schema names are canonical with temporary deprecated schema aliases', () => {
  const schemas = swaggerDocument.components.schemas as Record<string, any>;
  for (const name of ['Idea', 'IdeaDetail', 'IdeaPhoto', 'IdeaContent', 'CreateIdeaDTO', 'UpdateIdeaDTO', 'IdeaStreetmix', 'IdeaStreetmixWorkflow']) assert.ok(schemas[name], name);
  for (const name of ['Suggestion', 'SuggestionDetail', 'SuggestionPhoto', 'SuggestionContent', 'CreateSuggestionDTO', 'UpdateSuggestionDTO', 'SuggestionStreetmix', 'SuggestionStreetmixWorkflow']) assert.ok(schemas[name], name);
  assert.ok(swaggerDocument.tags.some(tag => tag.name === 'Ideas'));
  assert.ok(swaggerDocument.tags.some(tag => tag.name === 'Suggestions'));
});
