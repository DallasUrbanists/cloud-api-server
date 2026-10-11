import { parse } from 'acorn';
import { DefaultAbbrMarkerOptions, split } from 'sentence-splitter';

export const GRAMMAR_INPUT_LIMIT = 5000;
export const GRAMMAR_OUTPUT_LIMIT = 10000;

export const SUMMARY_SENTENCE_TYPES = ['declarative', 'imperative', 'interrogative', 'exclamatory', 'auto'] as const;
export type SummarySentenceType = typeof SUMMARY_SENTENCE_TYPES[number];

export interface SummaryOptions {
  type: SummarySentenceType;
  max_sentences: number;
  target_sentences: number;
  max_characters: number;
}

export interface SummaryInput extends SummaryOptions {
  text: string;
}

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

export function summarySentences(text: string): string[] {
  return split(text, sentenceParserOptions).filter((part) => part.type === 'Sentence').map((part) => part.raw.trim()).filter(Boolean);
}

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