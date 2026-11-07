import { test } from 'node:test';
import assert from 'node:assert/strict';
import { swaggerDocument } from '../src/docs/swagger.js';

test('walk-audit OpenAPI composes all verbs with explicit public and private security', () => {
  const expected: Record<string, string[]> = {
    '/contributors/me': ['get', 'post', 'patch', 'delete'], '/contributors': ['get'], '/contributors/{id}': ['get', 'patch', 'delete'],
    '/studies': ['get', 'post'], '/studies/{id}': ['get', 'patch', 'delete'], '/studies/{id}/thumbnail': ['get'], '/studies/{id}/progress': ['get'],
    '/worksheets': ['get', 'post'], '/worksheets/{id}': ['get', 'patch', 'delete'], '/studies/{id}/audits': ['get', 'post'],
    '/audits/{id}': ['get', 'patch', 'delete'], '/studies/{id}/drafts': ['get', 'post'], '/drafts/{id}': ['get', 'patch', 'delete'],
    '/drafts/{id}/submit': ['post'], '/studies/{id}/reports': ['get', 'post'], '/reports/{id}': ['get', 'patch', 'delete'],
  };
  for (const [path, verbs] of Object.entries(expected)) for (const verb of verbs) {
    const operation = swaggerDocument.paths[`/api/walk-audits${path}`]?.[verb];
    assert.ok(operation, `${verb} ${path}`);
    const privateRead = path.startsWith('/contributors') || path.startsWith('/drafts') || path.endsWith('/drafts');
    assert.deepEqual(operation.security, verb === 'get' && !privateRead ? [] : [{ BearerAuth: [], AppCheckAuth: [] }]);
  }
  const deletion = swaggerDocument.paths['/api/walk-audits/studies/{id}'].delete;
  assert.ok(deletion.parameters.some((item: any) => item.name === 'confirmPermanentDelete' && item.required));
  assert.ok(swaggerDocument.components.schemas.WalkAuditReportPatch.required.includes('expectedVersion'));
});
