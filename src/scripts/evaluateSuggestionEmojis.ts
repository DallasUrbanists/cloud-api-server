import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { productionRegressions, mockEmojiExamples } from '../data/emojiEvaluationCases.js';
import { recommendableMockDescriptions } from '../data/recommendableMockDescriptions.js';
import { SuggestionEmojiService, type EmojiDiagnostics } from '../services/suggestionEmojiService.js';

// Explicit opt-in: ordinary tests never call JEV or alter production suggestions.
if (!process.argv.includes('--live')) throw new Error('Pass --live to enable paid JEV calls.');
if (!process.env.TYPESAFE_API_KEY?.trim()) throw new Error('Set TYPESAFE_API_KEY before running live evaluation.');
const cases = productionRegressions.map(item => ({ ...item, id: `submission-${item.id}` }));
if (process.argv.includes('--all')) {
  if (mockEmojiExamples.length !== recommendableMockDescriptions.length) throw new Error('Mock labels need review.');
  cases.push(...recommendableMockDescriptions.map((summary, index) => ({
    id: `mock-${index + 1}`, summary, details: '', expected: [mockEmojiExamples[index]],
  })));
}
const rows: { id: string; mode: string; assigned: boolean; acceptable: boolean; candidateCoverage: boolean; diagnostics?: EmojiDiagnostics }[] = [];
for (const fixture of cases) {
  for (const mode of ['lexical', 'hybrid'] as const) {
    let diagnostics: EmojiDiagnostics | undefined;
    let emoji: string | undefined;
    try {
      emoji = await SuggestionEmojiService.assign(fixture.summary, fixture.details, {
        mode, onDiagnostics: result => { diagnostics = result; },
      });
    } catch { /* Failure category is retained in the diagnostic record. */ }
    rows.push({ id: fixture.id, mode, assigned: !!emoji, acceptable: !!emoji && fixture.expected.includes(emoji),
      candidateCoverage: !!diagnostics?.stages.filter(stage => stage.stage === 'classification')
        .some(stage => stage.scores.some(candidate => fixture.expected.some(expected => candidate.name.startsWith(`${expected} (`)))), diagnostics });
  }
}
const metrics = ['lexical', 'hybrid'].map(mode => {
  const results = rows.filter(row => row.mode === mode);
  const latencies = results.map(row => row.diagnostics?.durationMs ?? 0).sort((a, b) => a - b);
  return { mode, cases: results.length, assignmentRate: results.filter(row => row.assigned).length / results.length,
    acceptableRate: results.filter(row => row.acceptable).length / results.length,
    candidateCoverage: results.filter(row => row.candidateCoverage).length / results.length,
    p95LatencyMs: latencies[Math.ceil(latencies.length * 0.95) - 1] };
});
const report = { createdAt: new Date().toISOString(), rubric: 'Listed acceptable emojis are non-exhaustive; review other assignments manually.', metrics, rows };
await mkdir('.tmp/emoji-evaluation', { recursive: true });
const path = `.tmp/emoji-evaluation/${Date.now()}.json`;
await writeFile(path, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ report: path, metrics }));
if (rows.every(row => !row.assigned)) process.exitCode = 1;
