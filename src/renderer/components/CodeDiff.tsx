/**
 * `<CodeDiff>` — renders a unified-diff string with per-line gutters and
 * lightweight, hand-rolled syntax highlighting.
 *
 * Line classification (priority order):
 *   1. meta:    `diff --git`, `index `, `+++ `, `--- `
 *   2. hunk:    `@@`
 *   3. add:     starts with a single `+`
 *   4. remove:  starts with a single `-`
 *   5. context: starts with ` `
 *   6. fallback for any other non-empty line: `context`
 *
 * Only add / remove / context lines have their content tokenized.
 */

import { useMemo } from 'react';
import {
  detectLanguage,
  tokenize,
  type SyntaxLanguage,
  type SyntaxToken,
} from './syntax';
import styles from './CodeDiff.module.css';

export type CodeDiffLineKind = 'add' | 'remove' | 'context' | 'hunk' | 'meta';

export interface CodeDiffProps {
  /**
   * Raw diff string. Unified-diff style ('+'/'-'/' ' line prefixes, optional
   * '@@ ... @@' hunk markers). Any line that doesn't match falls back to
   * `context` rendering.
   */
  diff: string;
  /**
   * Optional language hint for syntax tokenization. When omitted, we scan
   * for a `+++ b/<path>` header and pick a language by file extension.
   */
  language?: SyntaxLanguage;
  'data-testid'?: string;
}

interface ParsedLine {
  kind: CodeDiffLineKind;
  /** Content portion (after the 1-char marker for add/remove/context). */
  content: string;
  /** Original (full) line — preserved for meta / hunk rendering. */
  raw: string;
  /** 1-based line number on the "remove" side, or null for add/hunk/meta. */
  removeNo: number | null;
  /** 1-based line number on the "add" side, or null for remove/hunk/meta. */
  addNo: number | null;
}

const META_PREFIXES: readonly string[] = ['diff --git', 'index ', '+++ ', '--- '];

function classify(line: string): CodeDiffLineKind {
  for (const prefix of META_PREFIXES) {
    if (line.startsWith(prefix)) return 'meta';
  }
  if (line.startsWith('@@')) return 'hunk';
  // `+` add line: starts with a single '+' followed by something other than
  // '+' (or by EOL — `+` alone is still an add line). The meta check above
  // already eliminated `+++ ...`.
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'remove';
  if (line.startsWith(' ')) return 'context';
  // Empty lines and anything unrecognized fall back to `context`.
  return 'context';
}

function splitLines(diff: string): string[] {
  if (diff.length === 0) return [];
  const lines = diff.split('\n');
  // Drop a single trailing empty line caused by a trailing '\n' so we don't
  // emit a phantom row.
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function parseDiff(diff: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  let removeNo = 0;
  let addNo = 0;
  for (const raw of splitLines(diff)) {
    const kind = classify(raw);
    let content: string;
    let rNo: number | null = null;
    let aNo: number | null = null;
    switch (kind) {
      case 'add':
        addNo += 1;
        aNo = addNo;
        content = raw.slice(1);
        break;
      case 'remove':
        removeNo += 1;
        rNo = removeNo;
        content = raw.slice(1);
        break;
      case 'context':
        // A bare empty line (no leading space) still increments both
        // counters so alignment stays sensible.
        removeNo += 1;
        addNo += 1;
        rNo = removeNo;
        aNo = addNo;
        content = raw.startsWith(' ') ? raw.slice(1) : raw;
        break;
      case 'hunk':
      case 'meta':
        content = raw;
        break;
    }
    out.push({ kind, content, raw, removeNo: rNo, addNo: aNo });
  }
  return out;
}

/**
 * Auto-detect language from a `+++ b/<path>` header in the diff. Returns
 * `'plain'` if no recognizable header is present.
 */
function detectFromHeader(diff: string): SyntaxLanguage {
  for (const raw of splitLines(diff)) {
    if (raw.startsWith('+++ ')) {
      const rest = raw.slice(4).trim();
      // Strip a leading `a/` or `b/` if present.
      const path = rest.startsWith('a/') || rest.startsWith('b/') ? rest.slice(2) : rest;
      const lang = detectLanguage(path);
      if (lang !== 'plain') return lang;
    }
  }
  return 'plain';
}

function tokenClass(token: SyntaxToken): string {
  return `tk-${token.kind}`;
}

function renderTokens(content: string, language: SyntaxLanguage): JSX.Element[] {
  const toks = tokenize(content, language);
  return toks.map((t, i) => (
    <span key={i} className={tokenClass(t)}>
      {t.text}
    </span>
  ));
}

export function CodeDiff({
  diff,
  language,
  'data-testid': testId = 'code-diff',
}: CodeDiffProps): JSX.Element {
  const resolvedLanguage: SyntaxLanguage = useMemo(() => {
    if (language !== undefined) return language;
    return detectFromHeader(diff);
  }, [diff, language]);

  const lines = useMemo<ParsedLine[]>(() => parseDiff(diff), [diff]);

  return (
    <pre className={styles.root} data-testid={testId}>
      <code>
        {lines.map((line, idx) => {
          const removeLabel = line.removeNo === null ? '' : String(line.removeNo);
          const addLabel = line.addNo === null ? '' : String(line.addNo);
          const showRaw = line.kind === 'meta' || line.kind === 'hunk';
          return (
            <span
              key={idx}
              className={styles.line}
              data-line-kind={line.kind}
              data-testid={`code-diff-line-${idx}`}
            >
              <span className={styles.gutter} aria-hidden="true">
                {removeLabel}
              </span>
              <span className={styles.gutter} aria-hidden="true">
                {addLabel}
              </span>
              <span className={styles.text}>
                {showRaw
                  ? line.raw
                  : renderTokens(line.content, resolvedLanguage)}
              </span>
            </span>
          );
        })}
      </code>
    </pre>
  );
}
