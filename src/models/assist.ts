/**
 * Prose screening, summary options, sentence splitting, and output-shape validation.
 *
 * Let's imagine writing a note about a broken sidewalk. These helpers check that it
 * is a message people can read and describe how short a helpful summary should be.
 *
 * @remarks
 * Pure local validation does not execute submitted text or contact the model. Code
 * detection is heuristic screening, not a general proof that text is safe or faithful.
 * @module
 */
import { parse } from 'acorn';
import { DefaultAbbrMarkerOptions, split } from 'sentence-splitter';

/** Maximum input length in Unicode code points for all assistance modes. */
export const GRAMMAR_INPUT_LIMIT = 5000;
/** Shared returned-prose code-point ceiling, also bounding individual summary option values. */
export const GRAMMAR_OUTPUT_LIMIT = 10000;

/** Allowed final-sentence styles; auto is an input choice, never an output sentence label. */
export const SUMMARY_SENTENCE_TYPES = ['declarative', 'imperative', 'interrogative', 'exclamatory', 'auto'] as const;
/** Requested final-sentence style, distinct from the style of every sentence in a summary. */
export type SummarySentenceType = typeof SUMMARY_SENTENCE_TYPES[number];

/**
 * Summary goals: hard upper limits and a soft sentence-count target.
 *
 * Let's imagine asking a friend to turn a long note into one short sentence.
 * These choices describe how small that note should be and how it should sound.
 */
export interface SummaryOptions {
  type: SummarySentenceType;
  max_sentences: number;
  target_sentences: number;
  max_characters: number;
}

/** Validated prose together with fully populated summary settings. */
export interface SummaryInput extends SummaryOptions {
  text: string;
}

/** Server defaults copied before request-specific options are applied. */
export const DEFAULT_SUMMARY_OPTIONS: Readonly<SummaryOptions> = {
  type: 'auto', max_sentences: 1, target_sentences: 1, max_characters: 140,
};

const sentenceParserOptions = {
  AbbrMarker: { language: {
    ...DefaultAbbrMarkerOptions.language,
    ABBREVIATIONS: [...DefaultAbbrMarkerOptions.language.ABBREVIATIONS, 'a.m.', 'p.m.'],
  } },
  SeparatorParser: { separatorCharacters: ['.', '!', '?', '\u3002', '\uFF01', '\uFF1F', '\u061F', '\u0964', '\u0965'] },
};

/** Splits prose using abbreviation-aware punctuation rules shared by summary-output checks. */
export function summarySentences(text: string): string[] {
  return split(text, sentenceParserOptions).filter((part) => part.type === 'Sentence').map((part) => part.raw.trim()).filter(Boolean);
}

/** A screening reason and one-based source line to help locate rejected content. */
export interface CodeFeedback {
  reason: string;
  line: number;
}

const codePatterns: Array<{ reason: string; pattern: RegExp }> = [
  { reason: 'Code block', pattern: /```|~~~/ },
  { reason: 'HTML markup or executable URL', pattern: /<\s*\/?[a-z][^>]*>|\b(?:javascript|vbscript)\s*:|\bdata\s*:\s*text\/html/i },
  { reason: 'JavaScript-like code', pattern: /\b(?:const|let|var)\s+[\w$]+\s*=|\bfunction\s*(?:[\w$]+\s*)?\(|=>|\b(?:eval|alert|require|setTimeout|setInterval)\s*\(|\b[a-z_$][\w$]*(?:\.[a-z_$][\w$]*)*\([^\r\n)]*\)|\b(?:console|document|window|process)\s*\.|\bimport\s+.+\s+from\s+['"]|\bon[a-z]+\s*=/i },
  { reason: 'Shell-like command', pattern: /(?:^|[\n\r;`])\s*(?:\$\s*)?(?:sudo|bash|sh|powershell|pwsh|cmd|curl|wget|chmod|rm|npm|npx|node|python\d*)\b|\$\(|\b(?:curl|wget)\b[^\n]*\|/i },
  { reason: 'Python-like code', pattern: /\b(?:def|class)\s+\w+\s*(?:\([^\n]*\))?\s*:|(?:^|[\n\r])\s*(?:from\s+[\w.]+\s+import|import\s+[\w.]+)|\b(?:print|exec|__import__)\s*\(/i },
  { reason: 'SQL-like statement', pattern: /\bselect\s+(?:\*|[\w".]+(?:\s*,\s*[\w".]+)*)\s+from\s+[\w"]+|\binsert\s+into\s+|\bdelete\s+from\s+|\b(?:drop|alter|create)\s+(?:table|database)\s+|\bupdate\s+\w+\s+set\s+/i },
];

/**
 * Screens normalized text for recognizable code/markup/control characters without executing it.
 * @remarks Pattern checks precede a parser fallback; quoted code can still be flagged.
 * An empty result is a heuristic decision, not a sandbox or semantic safety guarantee.
 */
export function findExecutableContent(text: string): CodeFeedback[] {
  const scanned = text.normalize('NFKC');
  const feedback: CodeFeedback[] = [];
  for (const { reason, pattern } of codePatterns) {
    const match = pattern.exec(scanned);
    if (match) feedback.push({ reason, line: scanned.slice(0, match.index).split(/\r\n|\r|\n/).length });
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u.test(scanned)) {
    feedback.push({ reason: 'Unsupported control character', line: 1 });
  }
  if (feedback.length === 0) {
    const fragments = [scanned, ...scanned.split(/\r\n|\r|\n/)];
    for (const fragment of fragments) {
      try {
        const program = parse(fragment, { ecmaVersion: 'latest', sourceType: 'module' });
        const executable = program.body.some((statement) => {
          if (statement.type === 'ExpressionStatement') {
            return !['Identifier', 'Literal'].includes(statement.expression.type);
          }
          return statement.type !== 'EmptyStatement';
        });
        if (executable) {
          feedback.push({ reason: 'JavaScript-like code', line: scanned.slice(0, scanned.indexOf(fragment)).split(/\r\n|\r|\n/).length });
          break;
        }
      } catch {
        continue;
      }
    }
  }
  return feedback;
}

/**
 * Accepts only nonblank Unicode prose while preserving the original whitespace.
 * @returns Input data, a shape/length error, or screening feedback; failures are returned, not thrown.
 * @example
 * Let's imagine a neighbor writes a note about a sidewalk. This checks that there
 * is a message to work on before the writing helper starts reading it.
 */
export function validateGrammarInput(body: unknown): { data?: { text: string }; error?: string; feedback?: CodeFeedback[] } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Request body must be a JSON object.' };
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== 'text')) return { error: 'Only the text field is accepted.' };
  if (typeof input.text !== 'string' || input.text.trim() === '') return { error: 'text must be a non-empty string.' };
  if (Array.from(input.text).length > GRAMMAR_INPUT_LIMIT) return { error: 'text cannot exceed 5000 Unicode code points.' };
  if (/[\uD800-\uDFFF]/u.test(input.text)) return { error: 'text must contain valid Unicode.' };
  const feedback = findExecutableContent(input.text);
  if (feedback.length > 0) return { error: 'Only prose is accepted. Remove code and executable content.', feedback };
  return { data: { text: input.text } };
}

/** Combines prose screening with copied defaults and compatible summary goals, returning the first failure. */
export function validateSummaryInput(body: unknown): { data?: SummaryInput; error?: string; feedback?: CodeFeedback[] } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Request body must be a JSON object.' };
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some((key) => !['text', 'type', 'max_sentences', 'target_sentences', 'max_characters'].includes(key))) {
    return { error: 'Only text, type, max_sentences, target_sentences, and max_characters are accepted.' };
  }
  const textValidation = validateGrammarInput({ text: input.text });
  if (!textValidation.data) return { error: textValidation.error, feedback: textValidation.feedback };
  const options: SummaryOptions = { ...DEFAULT_SUMMARY_OPTIONS };
  if (input.type !== undefined) {
    if (typeof input.type !== 'string' || !SUMMARY_SENTENCE_TYPES.includes(input.type as SummarySentenceType)) {
      return { error: 'type must be declarative, imperative, interrogative, exclamatory, or auto.' };
    }
    options.type = input.type as SummarySentenceType;
  }
  for (const name of ['max_sentences', 'target_sentences', 'max_characters'] as const) {
    if (input[name] === undefined) continue;
    const value = input[name];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > GRAMMAR_OUTPUT_LIMIT) {
      return { error: `${name} must be an integer between 1 and 10000.` };
    }
    options[name] = value;
  }
  if (options.target_sentences > options.max_sentences) return { error: 'target_sentences cannot exceed max_sentences.' };
  return { data: { text: textValidation.data.text, ...options } };
}

/**
 * Joins structured summary sentences only after shape, count, Unicode, and final-style checks.
 * @remarks target_sentences is not a minimum. This verifies mechanical constraints,
 * not that the summary is faithful; service-level code screening is a separate final check.
 */
export function validateSummaryOutput(body: unknown, options: SummaryOptions): { data?: string; error?: string } {
  const invalid = { error: 'Summary output does not satisfy the requested constraints.' };
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1) return invalid;
  const sentences = (body as { sentences?: unknown }).sentences;
  if (!Array.isArray(sentences) || sentences.length === 0 || sentences.length > options.max_sentences) return invalid;
  const texts: string[] = [];
  for (const sentence of sentences) {
    if (!sentence || typeof sentence !== 'object' || Array.isArray(sentence) || Object.keys(sentence).some((key) => !['text', 'type'].includes(key))) return invalid;
    if (typeof sentence.text !== 'string' || sentence.text.trim() === '' || sentence.type === 'auto' || !SUMMARY_SENTENCE_TYPES.includes(sentence.type)) return invalid;
    if (sentence.text.length > GRAMMAR_OUTPUT_LIMIT * 2 || /[\uD800-\uDFFF]/u.test(sentence.text)) return invalid;
    if (summarySentences(sentence.text).length !== 1) return invalid;
    texts.push(sentence.text.trim());
  }
  const text = texts.join(' ');
  if (Array.from(text).length > options.max_characters || summarySentences(text).length > options.max_sentences) return invalid;
  const finalType = sentences[sentences.length - 1].type;
  if (options.type !== 'auto' && finalType !== options.type) return invalid;
  const ending = texts[texts.length - 1].replace(/["'\u2019\u201D\u00BB)\]}]+$/u, '').trimEnd();
  if (finalType === 'interrogative' && !/[?\uFF1F\u061F]$/u.test(ending)) return invalid;
  if (finalType === 'exclamatory' && !/[!\uFF01]$/u.test(ending)) return invalid;
  if (['declarative', 'imperative'].includes(finalType) && /[?!\uFF1F\uFF01\u061F]$/u.test(ending)) return invalid;
  return { data: text };
}