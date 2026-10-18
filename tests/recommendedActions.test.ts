import test from 'node:test';
import assert from 'node:assert/strict';
import { RECOMMENDED_ACTION_STATUSES, validateActionInput, validateLogInput } from '../src/models/recommendedAction.js';
import { isActionExpired } from '../src/services/recommendedActionService.js';
import { anyBoundaryOverlap, validateRecommendableInput } from '../src/models/recommendableAction.js';

test('Recommended Action validation applies defaults at the service boundary and accepts every status', () => {
  assert.deepEqual(RECOMMENDED_ACTION_STATUSES, ['open', 'ignored', 'started', 'paused', 'cancelled', 'finished']);
  for (const status of RECOMMENDED_ACTION_STATUSES) {
    const result = validateActionInput({ summary: ' Crossing ', instructions: ' Inspect it ', reason: ' Safety ', status });
    assert.equal(result.error, undefined);
    assert.equal(result.data?.summary, 'Crossing');
    assert.equal(result.data?.status, status);
  }
  assert.equal(validateActionInput({ summary: 'x', instructions: 'y', reason: 'z' }).data?.status, undefined);
});

test('Recommended Action validation rejects empty text, invalid status, representative IDs, and unzoned dates', () => {
  assert.ok(validateActionInput({ summary: ' ', instructions: 'x', reason: 'z' }).error);
  assert.ok(validateActionInput({ summary: 'x', instructions: 'y', reason: 'z', status: 'done' }).error);
  assert.ok(validateActionInput({ summary: 'x', instructions: 'y', reason: 'z', representativeId: 0 }).error);
  assert.ok(validateActionInput({ summary: 'x', instructions: 'y', reason: 'z', expirationDate: '2027-06-01T00:00:00' }).error);
});

test('Recommended Action accepts nullable fields and normalizes offset dates to UTC', () => {
  const result = validateActionInput({ summary: 'x', instructions: 'y', reason: 'z', representativeId: null, expirationDate: '2027-06-01T05:00:00-05:00' });
  assert.equal(result.data?.representativeId, null);
  assert.equal(result.data?.expirationDate, '2027-06-01T10:00:00.000Z');
  assert.deepEqual(validateActionInput({ expirationDate: null, representativeId: null }, true).data, { expirationDate: null, representativeId: null });
});

test('manual log input only accepts summary and description', () => {
  assert.deepEqual(validateLogInput({ summary: ' Update ', description: ' Changed status ' }).data, { summary: 'Update', description: 'Changed status' });
  assert.ok(validateLogInput({ summary: 'Update', description: 'Changed', actor: { email: 'spoof@example.com' } }).error);
});

test('expiration boundary is inclusive and actions without expiration remain active', () => {
  const expirationDate = '2027-06-01T00:00:00.000Z';
  const now = Date.parse(expirationDate);
  assert.equal(isActionExpired({ expirationDate }, now), true);
  assert.equal(isActionExpired({ expirationDate }, now - 1), false);
  assert.equal(isActionExpired({ expirationDate: null }, now), false);
});

test('Recommendable Action boundary applicability uses any overlap, with empty boundaries global', () => {
  assert.equal(anyBoundaryOverlap([10, 20, 30], [99, 20]), true);
  assert.equal(anyBoundaryOverlap([10, 20], [99]), false);
  assert.equal(anyBoundaryOverlap([], []), true);
  assert.equal(anyBoundaryOverlap([10, 20], [20, 99]), true);
  assert.equal(anyBoundaryOverlap([10, 20], []), false);
});

test('park-feedback documentation example normalizes without persisting', () => {
  const result = validateRecommendableInput({
    summary: ' Share park feedback ',
    instructions: 'Use the feedback channel described by the source.',
    why: 'The city is collecting ideas for the proposed park redesign.',
    whyNot: 'This opportunity does not apply to unrelated topics.',
    boundaries: [20, 10, 20],
    sourceUrl: 'https://example.org/park-feedback',
    sourceEvidence: 'Invitation to share park feedback.',
    sourceDescription: 'Park consultation.',
  });
  assert.equal(result.error, undefined);
  assert.equal(result.data?.summary, 'Share park feedback');
  assert.deepEqual(result.data?.boundaries, [10, 20]);
  assert.ok(validateRecommendableInput({ summary: 'Incomplete' }).error);
});

test('Recommendable Action input normalizes boundary IDs and rejects invalid source URLs or boundary IDs', () => {
  const base = { summary: ' Call 311 ', instructions: ' Report the issue ', why: ' City service request ', whyNot: ' Not for unrelated requests. ', boundaries: [20, 10, 20], sourceUrl: 'https://dallascityhall.com/service', sourceEvidence: 'Submit a service request.', sourceDescription: 'A Dallas 311 path.' };
  const result = validateRecommendableInput(base);
  assert.deepEqual(result.data?.boundaries, [10, 20]);
  assert.equal(validateRecommendableInput({ ...base, sourceUrl: 'http://dallascityhall.com/service' }).error, 'sourceUrl must be a public HTTPS URL.');
  assert.ok(validateRecommendableInput({ ...base, boundaries: [0] }).error);
});

test('Recommendable Action accepts empty whyNot but rejects null and non-string exclusions', () => {
  const base = { summary: 'Report issue', instructions: 'Call 311.', why: 'Relevant issue', whyNot: '', boundaries: [], sourceUrl: 'https://dallascityhall.com/', sourceEvidence: 'Call 311.', sourceDescription: 'City source' };
  assert.equal(validateRecommendableInput(base).data?.whyNot, '');
  assert.equal(validateRecommendableInput({ ...base, whyNot: '  ' }).data?.whyNot, '');
  for (const whyNot of [null, undefined, 1, []]) assert.ok(validateRecommendableInput({ ...base, whyNot }).error);
  assert.ok(validateRecommendableInput({ ...base, whyNot: 'x'.repeat(4001) }).error);
});
