import { describe, expect, it } from 'vitest';
import {
  detectLanguage,
  tokenize,
  type SyntaxLanguage,
  type SyntaxToken,
} from '../../src/renderer/components/syntax';

/**
 * CMP-SYNTAX-001..012 — pure function tests for the hand-rolled
 * syntax tokenizer used by `<CodeDiff>`.
 *
 * All assertions check the SyntaxToken[] shape directly. No DOM, no React.
 *
 * Tokenizer rules (MVP) — see acceptance/approval-interface.md:
 *   - keywords per language tokenize as kind: 'keyword'
 *   - strings (single, double, template) tokenize as kind: 'string'
 *   - comments (`//`, `#`, `/* … *\/`) tokenize as kind: 'comment'
 *   - numbers tokenize as kind: 'number' after a non-identifier boundary
 *   - identifiers tokenize as kind: 'ident'
 *   - whitespace preserved as kind: 'whitespace'
 *   - language === 'plain' → no keyword colorization
 *   - unterminated strings end at EOL (no cross-line state)
 */

function findKinds(tokens: SyntaxToken[], kind: SyntaxToken['kind']): SyntaxToken[] {
  return tokens.filter((t) => t.kind === kind);
}

function reassemble(tokens: SyntaxToken[]): string {
  return tokens.map((t) => t.text).join('');
}

describe('syntax tokenizer — CMP-SYNTAX', () => {
  // ---------------------------------------------------------------------------
  // CMP-SYNTAX-001 — detectLanguage by extension
  // ---------------------------------------------------------------------------
  it('CMP-SYNTAX-001: detectLanguage maps known extensions and falls back to plain', () => {
    expect(detectLanguage('foo.ts')).toBe<SyntaxLanguage>('ts');
    expect(detectLanguage('foo.tsx')).toBe<SyntaxLanguage>('tsx');
    expect(detectLanguage('foo.js')).toBe<SyntaxLanguage>('js');
    expect(detectLanguage('foo.jsx')).toBe<SyntaxLanguage>('jsx');
    expect(detectLanguage('foo.py')).toBe<SyntaxLanguage>('py');
    expect(detectLanguage('foo.go')).toBe<SyntaxLanguage>('go');
    // Path forms (with directories) should still resolve.
    expect(detectLanguage('src/util/helpers.ts')).toBe<SyntaxLanguage>('ts');
    expect(detectLanguage('a/b/c/main.go')).toBe<SyntaxLanguage>('go');
    // Unknown / undefined → 'plain'.
    expect(detectLanguage('README.md')).toBe<SyntaxLanguage>('plain');
    expect(detectLanguage('Makefile')).toBe<SyntaxLanguage>('plain');
    expect(detectLanguage(undefined)).toBe<SyntaxLanguage>('plain');
    expect(detectLanguage('')).toBe<SyntaxLanguage>('plain');
  });

  // ---------------------------------------------------------------------------
  // CMP-SYNTAX-002 — TS keywords
  // ---------------------------------------------------------------------------
  it('CMP-SYNTAX-002: TS keywords tokenize as kind: "keyword"', () => {
    const tokens = tokenize('const foo = 1;', 'ts');
    const keywords = findKinds(tokens, 'keyword');
    expect(keywords.some((t) => t.text === 'const')).toBe(true);

    const fnTokens = tokenize('function bar() {}', 'ts');
    expect(findKinds(fnTokens, 'keyword').some((t) => t.text === 'function')).toBe(true);

    const ifaceTokens = tokenize('interface Foo {}', 'ts');
    expect(
      findKinds(ifaceTokens, 'keyword').some((t) => t.text === 'interface'),
    ).toBe(true);

    // tsx should also recognize TS keywords.
    const tsxTokens = tokenize('return <div />;', 'tsx');
    expect(findKinds(tsxTokens, 'keyword').some((t) => t.text === 'return')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // CMP-SYNTAX-003 — TS strings
  // ---------------------------------------------------------------------------
  it('CMP-SYNTAX-003: TS strings tokenize as kind: "string" (single, double, template)', () => {
    const dbl = tokenize('const s = "hello";', 'ts');
    expect(findKinds(dbl, 'string').some((t) => t.text === '"hello"')).toBe(true);

    const sgl = tokenize("const s = 'world';", 'ts');
    expect(findKinds(sgl, 'string').some((t) => t.text === "'world'")).toBe(true);

    const tpl = tokenize('const s = `tpl`;', 'ts');
    expect(findKinds(tpl, 'string').some((t) => t.text === '`tpl`')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // CMP-SYNTAX-004 — TS line comments
  // ---------------------------------------------------------------------------
  it('CMP-SYNTAX-004: TS // line comments tokenize as kind: "comment" to EOL', () => {
    const tokens = tokenize('const x = 1; // trailing comment', 'ts');
    const comments = findKinds(tokens, 'comment');
    expect(comments.length).toBeGreaterThan(0);
    // The comment span starts at `//` and runs to EOL.
    expect(comments[0]?.text.startsWith('//')).toBe(true);
    expect(comments[0]?.text).toContain('trailing comment');

    // Block comments on a single line are also recognized.
    const block = tokenize('const x = /* inline */ 1;', 'ts');
    expect(findKinds(block, 'comment').some((t) => t.text === '/* inline */')).toBe(
      true,
    );
  });

  // ---------------------------------------------------------------------------
  // CMP-SYNTAX-005 — Python keywords
  // ---------------------------------------------------------------------------
  it('CMP-SYNTAX-005: Python keywords (def, class, True, None) tokenize as keyword', () => {
    const def = tokenize('def foo():', 'py');
    expect(findKinds(def, 'keyword').some((t) => t.text === 'def')).toBe(true);

    const cls = tokenize('class Foo:', 'py');
    expect(findKinds(cls, 'keyword').some((t) => t.text === 'class')).toBe(true);

    const tru = tokenize('x = True', 'py');
    expect(findKinds(tru, 'keyword').some((t) => t.text === 'True')).toBe(true);

    const nul = tokenize('x = None', 'py');
    expect(findKinds(nul, 'keyword').some((t) => t.text === 'None')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // CMP-SYNTAX-006 — Python comments
  // ---------------------------------------------------------------------------
  it('CMP-SYNTAX-006: Python "# comment" tokenizes as kind: "comment"', () => {
    const tokens = tokenize('x = 1  # trailing comment', 'py');
    const comments = findKinds(tokens, 'comment');
    expect(comments.length).toBeGreaterThan(0);
    expect(comments[0]?.text.startsWith('#')).toBe(true);
    expect(comments[0]?.text).toContain('trailing comment');
  });

  // ---------------------------------------------------------------------------
  // CMP-SYNTAX-007 — Go keywords
  // ---------------------------------------------------------------------------
  it('CMP-SYNTAX-007: Go keywords (func, package, chan) tokenize as keyword', () => {
    const fn = tokenize('func main() {}', 'go');
    expect(findKinds(fn, 'keyword').some((t) => t.text === 'func')).toBe(true);

    const pkg = tokenize('package main', 'go');
    expect(findKinds(pkg, 'keyword').some((t) => t.text === 'package')).toBe(true);

    const ch = tokenize('var c chan int', 'go');
    expect(findKinds(ch, 'keyword').some((t) => t.text === 'chan')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // CMP-SYNTAX-008 — Numbers
  // ---------------------------------------------------------------------------
  it('CMP-SYNTAX-008: numbers tokenize as kind: "number" after non-identifier boundary', () => {
    const tokens = tokenize('const x = 42;', 'ts');
    expect(findKinds(tokens, 'number').some((t) => t.text === '42')).toBe(true);

    const decimal = tokenize('const y = 3.14;', 'ts');
    expect(findKinds(decimal, 'number').some((t) => t.text === '3.14')).toBe(true);

    // A number embedded inside an identifier should NOT be tokenized as a
    // number — `foo42` is a single identifier.
    const inIdent = tokenize('const foo42 = 1;', 'ts');
    const numberTokens = findKinds(inIdent, 'number');
    expect(numberTokens.some((t) => t.text === '42')).toBe(false);
    // But `1` (after `=`) is still a number.
    expect(numberTokens.some((t) => t.text === '1')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // CMP-SYNTAX-009 — Identifiers
  // ---------------------------------------------------------------------------
  it('CMP-SYNTAX-009: identifiers tokenize as kind: "ident" (not keyword)', () => {
    const tokens = tokenize('const myVar = 1;', 'ts');
    const idents = findKinds(tokens, 'ident');
    expect(idents.some((t) => t.text === 'myVar')).toBe(true);
    // And `myVar` is NOT a keyword.
    const keywords = findKinds(tokens, 'keyword');
    expect(keywords.some((t) => t.text === 'myVar')).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // CMP-SYNTAX-010 — Whitespace preserved
  // ---------------------------------------------------------------------------
  it('CMP-SYNTAX-010: whitespace is preserved as kind: "whitespace" so tokens reassemble to the original line', () => {
    const line = 'const   x   =   1;';
    const tokens = tokenize(line, 'ts');
    expect(findKinds(tokens, 'whitespace').length).toBeGreaterThan(0);
    expect(reassemble(tokens)).toBe(line);
  });

  it('CMP-SYNTAX-010 (alt): leading indentation is preserved verbatim', () => {
    const line = '    return foo;';
    const tokens = tokenize(line, 'ts');
    expect(reassemble(tokens)).toBe(line);
    // Leading whitespace is its own token.
    expect(tokens[0]?.kind).toBe('whitespace');
    expect(tokens[0]?.text).toBe('    ');
  });

  // ---------------------------------------------------------------------------
  // CMP-SYNTAX-011 — language='plain' → no keyword colorization
  // ---------------------------------------------------------------------------
  it('CMP-SYNTAX-011: language: "plain" returns no keyword tokens (no colorization)', () => {
    const tokens = tokenize('const x = 1;', 'plain');
    // No tokens should be classified as keywords for plain language.
    expect(findKinds(tokens, 'keyword')).toHaveLength(0);
    // And the line still reassembles to the original.
    expect(reassemble(tokens)).toBe('const x = 1;');
  });

  // ---------------------------------------------------------------------------
  // CMP-SYNTAX-012 — Unterminated strings end at EOL
  // ---------------------------------------------------------------------------
  it('CMP-SYNTAX-012: unterminated string ends at EOL (no cross-line state)', () => {
    const tokens = tokenize('const s = "abc', 'ts');
    const strings = findKinds(tokens, 'string');
    expect(strings.length).toBeGreaterThan(0);
    // Whatever the tokenizer chose to keep, the string token should start
    // with `"` and run to the end of the line ("abc).
    expect(strings[0]?.text.startsWith('"')).toBe(true);
    expect(strings[0]?.text.endsWith('abc')).toBe(true);
    // Reassembly is still complete.
    expect(reassemble(tokens)).toBe('const s = "abc');
  });
});
