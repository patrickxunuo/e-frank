/**
 * Hand-rolled syntax tokenizer for diff lines.
 *
 * Single-pass, single-line scanner. Supports TS / TSX / JS / JSX / Python /
 * Go. Anything else is `'plain'` — the consumer collapses the whole line into
 * one token and skips colorization.
 *
 * Strings and comments end at end-of-line — the diff renderer never reasons
 * about cross-line state, which keeps this module free of allocation-heavy
 * lexer state and trivially tree-shakable.
 *
 * No runtime deps. Used by `<CodeDiff>` (#9).
 */

export type SyntaxLanguage = 'ts' | 'tsx' | 'js' | 'jsx' | 'py' | 'go' | 'plain';

export interface SyntaxToken {
  kind: 'keyword' | 'string' | 'comment' | 'number' | 'punct' | 'ident' | 'whitespace';
  text: string;
}

const TS_JS_KEYWORDS: ReadonlySet<string> = new Set<string>([
  'const',
  'let',
  'var',
  'function',
  'class',
  'extends',
  'return',
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'break',
  'continue',
  'new',
  'this',
  'typeof',
  'instanceof',
  'import',
  'from',
  'export',
  'default',
  'async',
  'await',
  'try',
  'catch',
  'finally',
  'throw',
  'void',
  'null',
  'undefined',
  'true',
  'false',
  'interface',
  'type',
  'enum',
  'as',
  'is',
  'in',
  'of',
  'keyof',
  'readonly',
  'public',
  'private',
  'protected',
  'static',
]);

const PY_KEYWORDS: ReadonlySet<string> = new Set<string>([
  'def',
  'class',
  'return',
  'if',
  'elif',
  'else',
  'for',
  'while',
  'break',
  'continue',
  'pass',
  'import',
  'from',
  'as',
  'try',
  'except',
  'finally',
  'raise',
  'with',
  'lambda',
  'yield',
  'global',
  'nonlocal',
  'True',
  'False',
  'None',
  'and',
  'or',
  'not',
  'is',
  'in',
]);

const GO_KEYWORDS: ReadonlySet<string> = new Set<string>([
  'func',
  'package',
  'import',
  'var',
  'const',
  'type',
  'struct',
  'interface',
  'map',
  'chan',
  'return',
  'if',
  'else',
  'for',
  'range',
  'switch',
  'case',
  'default',
  'break',
  'continue',
  'go',
  'defer',
  'select',
  'nil',
  'true',
  'false',
]);

function keywordsFor(language: SyntaxLanguage): ReadonlySet<string> {
  switch (language) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
      return TS_JS_KEYWORDS;
    case 'py':
      return PY_KEYWORDS;
    case 'go':
      return GO_KEYWORDS;
    case 'plain':
      return new Set<string>();
  }
}

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch);
}

function isIdentCont(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch);
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isWhitespace(ch: string): boolean {
  // Spaces and tabs only — newlines never appear inside a single line.
  return ch === ' ' || ch === '\t';
}

/**
 * Detect language from a filename or path. Returns 'plain' when uncertain.
 */
export function detectLanguage(filename: string | undefined): SyntaxLanguage {
  if (filename === undefined) return 'plain';
  const lower = filename.toLowerCase();
  // Match the longest extension first to avoid `.ts` matching `.tsx`.
  if (lower.endsWith('.tsx')) return 'tsx';
  if (lower.endsWith('.jsx')) return 'jsx';
  if (lower.endsWith('.ts')) return 'ts';
  if (lower.endsWith('.js')) return 'js';
  if (lower.endsWith('.py')) return 'py';
  if (lower.endsWith('.go')) return 'go';
  return 'plain';
}

/**
 * Tokenize a single line of source. Comments and strings that span lines are
 * closed at end-of-line — adequate for diff rendering and avoids cross-line
 * state.
 */
export function tokenize(line: string, language: SyntaxLanguage): SyntaxToken[] {
  if (language === 'plain') {
    if (line.length === 0) return [];
    const onlyWhitespace = /^[ \t]+$/.test(line);
    return [{ kind: onlyWhitespace ? 'whitespace' : 'ident', text: line }];
  }

  const tokens: SyntaxToken[] = [];
  const keywords = keywordsFor(language);
  const supportsSlashComment =
    language === 'ts' ||
    language === 'tsx' ||
    language === 'js' ||
    language === 'jsx' ||
    language === 'go';
  const supportsHashComment = language === 'py';
  const supportsBacktick =
    language === 'ts' ||
    language === 'tsx' ||
    language === 'js' ||
    language === 'jsx';

  let i = 0;
  const len = line.length;

  while (i < len) {
    const ch = line.charAt(i);

    // Whitespace
    if (isWhitespace(ch)) {
      let j = i + 1;
      while (j < len && isWhitespace(line.charAt(j))) j += 1;
      tokens.push({ kind: 'whitespace', text: line.slice(i, j) });
      i = j;
      continue;
    }

    // Line comment
    if (supportsSlashComment && ch === '/' && line.charAt(i + 1) === '/') {
      tokens.push({ kind: 'comment', text: line.slice(i) });
      i = len;
      continue;
    }
    if (supportsHashComment && ch === '#') {
      tokens.push({ kind: 'comment', text: line.slice(i) });
      i = len;
      continue;
    }

    // Block comment (single-line only — close at */ or EOL)
    if (supportsSlashComment && ch === '/' && line.charAt(i + 1) === '*') {
      const close = line.indexOf('*/', i + 2);
      const end = close === -1 ? len : close + 2;
      tokens.push({ kind: 'comment', text: line.slice(i, end) });
      i = end;
      continue;
    }

    // Strings
    if (ch === '"' || ch === "'" || (supportsBacktick && ch === '`')) {
      const quote = ch;
      let j = i + 1;
      while (j < len) {
        const c = line.charAt(j);
        if (c === '\\' && j + 1 < len) {
          j += 2;
          continue;
        }
        if (c === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      // If closing quote not found, j === len → string ends at EOL.
      tokens.push({ kind: 'string', text: line.slice(i, j) });
      i = j;
      continue;
    }

    // Numbers
    if (isDigit(ch)) {
      let j = i + 1;
      while (j < len && isDigit(line.charAt(j))) j += 1;
      if (j < len && line.charAt(j) === '.' && isDigit(line.charAt(j + 1))) {
        j += 1;
        while (j < len && isDigit(line.charAt(j))) j += 1;
      }
      tokens.push({ kind: 'number', text: line.slice(i, j) });
      i = j;
      continue;
    }

    // Identifiers / keywords
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < len && isIdentCont(line.charAt(j))) j += 1;
      const text = line.slice(i, j);
      tokens.push({ kind: keywords.has(text) ? 'keyword' : 'ident', text });
      i = j;
      continue;
    }

    // Punctuation — single char
    tokens.push({ kind: 'punct', text: ch });
    i += 1;
  }

  return tokens;
}
