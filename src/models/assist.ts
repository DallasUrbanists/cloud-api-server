import { parse } from 'acorn';

export const GRAMMAR_INPUT_LIMIT = 5000;
export const GRAMMAR_OUTPUT_LIMIT = 10000;

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