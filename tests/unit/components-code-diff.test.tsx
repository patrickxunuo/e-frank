// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { CodeDiff } from '../../src/renderer/components/CodeDiff';

/**
 * CMP-CODE-DIFF-001..012 — <CodeDiff> rendering tests.
 *
 * The component renders a <pre><code> block where each line is its own
 * <span> carrying a `data-line-kind` attribute. Add/remove/context/hunk/meta
 * are the five line kinds. When a language is hinted (or auto-detected from
 * `+++ b/foo.ts` headers), the content portion of each line is tokenized
 * via the syntax tokenizer and emitted as <span class="tk-…"> children.
 */

afterEach(() => {
  cleanup();
});

function lineKinds(container: HTMLElement): string[] {
  const nodes = container.querySelectorAll<HTMLElement>('[data-line-kind]');
  return Array.from(nodes).map((n) => n.getAttribute('data-line-kind') ?? '');
}

function lineNodes(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-line-kind]'));
}

describe('<CodeDiff /> — CMP-CODE-DIFF', () => {
  // ---------------------------------------------------------------------------
  // CMP-CODE-DIFF-001 — `+` lines (not `+++`) → add
  // ---------------------------------------------------------------------------
  it('CMP-CODE-DIFF-001: lines starting "+" (not "+++") get data-line-kind="add"', () => {
    const diff = '+const a = 1;\n+const b = 2;\n';
    const { container } = render(<CodeDiff diff={diff} />);
    expect(lineKinds(container)).toEqual(['add', 'add']);
  });

  // ---------------------------------------------------------------------------
  // CMP-CODE-DIFF-002 — `-` lines (not `---`) → remove
  // ---------------------------------------------------------------------------
  it('CMP-CODE-DIFF-002: lines starting "-" (not "---") get data-line-kind="remove"', () => {
    const diff = '-const old = 1;\n-const dead = 2;\n';
    const { container } = render(<CodeDiff diff={diff} />);
    expect(lineKinds(container)).toEqual(['remove', 'remove']);
  });

  // ---------------------------------------------------------------------------
  // CMP-CODE-DIFF-003 — leading-space lines → context
  // ---------------------------------------------------------------------------
  it('CMP-CODE-DIFF-003: lines starting " " get data-line-kind="context"', () => {
    const diff = ' const ctx = 1;\n const other = 2;\n';
    const { container } = render(<CodeDiff diff={diff} />);
    expect(lineKinds(container)).toEqual(['context', 'context']);
  });

  // ---------------------------------------------------------------------------
  // CMP-CODE-DIFF-004 — `@@` lines → hunk
  // ---------------------------------------------------------------------------
  it('CMP-CODE-DIFF-004: lines starting "@@" get data-line-kind="hunk"', () => {
    const diff = '@@ -1,3 +1,4 @@\n const a = 1;\n';
    const { container } = render(<CodeDiff diff={diff} />);
    const kinds = lineKinds(container);
    expect(kinds[0]).toBe('hunk');
  });

  // ---------------------------------------------------------------------------
  // CMP-CODE-DIFF-005 — `diff --git`, `index `, `+++`, `---` → meta
  // ---------------------------------------------------------------------------
  it('CMP-CODE-DIFF-005: diff/index/+++/--- header lines get data-line-kind="meta"', () => {
    const diff =
      'diff --git a/foo.ts b/foo.ts\n' +
      'index 1234567..89abcde 100644\n' +
      '--- a/foo.ts\n' +
      '+++ b/foo.ts\n' +
      '@@ -1,1 +1,2 @@\n' +
      ' const a = 1;\n' +
      '+const b = 2;\n';
    const { container } = render(<CodeDiff diff={diff} />);
    const kinds = lineKinds(container);
    // First four are meta.
    expect(kinds[0]).toBe('meta');
    expect(kinds[1]).toBe('meta');
    expect(kinds[2]).toBe('meta');
    expect(kinds[3]).toBe('meta');
    // Then hunk.
    expect(kinds[4]).toBe('hunk');
    // Then context, add.
    expect(kinds[5]).toBe('context');
    expect(kinds[6]).toBe('add');
  });

  // ---------------------------------------------------------------------------
  // CMP-CODE-DIFF-006 — Add/remove gutters increment independently;
  // hunk/meta lines have blank gutters.
  // ---------------------------------------------------------------------------
  it('CMP-CODE-DIFF-006: add/remove gutters increment independently; hunk/meta gutters are blank', () => {
    const diff =
      'diff --git a/foo.ts b/foo.ts\n' +
      '@@ -1,3 +1,4 @@\n' +
      ' const a = 1;\n' +
      '-const old = 2;\n' +
      '+const b = 2;\n' +
      '+const c = 3;\n' +
      ' const tail = 4;\n';
    const { container } = render(<CodeDiff diff={diff} />);
    const lines = lineNodes(container);

    // The spec mandates a "left gutter showing the line number (1-based,
    // monotonic across the rendered diff). Removed lines and added lines
    // each get their own counter; hunk/meta lines have a blank gutter."
    //
    // We don't pin the exact gutter element's class — but we can inspect
    // the line's text. For meta/hunk lines, the line text either is the
    // raw line or contains the raw line plus blank gutter slots. For
    // add/remove lines, the line text starts with one or two number labels
    // (the gutter values) followed by the content.
    //
    // Rather than coupling to internal class names, we extract the digits
    // appearing BEFORE the line content and assert they form a monotonic
    // counter per side.
    const meta = lines[0];
    const hunk = lines[1];
    expect(meta?.getAttribute('data-line-kind')).toBe('meta');
    expect(hunk?.getAttribute('data-line-kind')).toBe('hunk');
    // hunk and meta lines should NOT begin with extra digit gutters: the
    // raw line text already starts with `diff` / `@@`.
    expect((meta?.textContent ?? '').startsWith('diff')).toBe(true);
    expect((hunk?.textContent ?? '').startsWith('@@')).toBe(true);

    // Helper: extract numeric prefix (whitespace-separated) from a line.
    const numericPrefix = (el: HTMLElement): number[] => {
      const text = el.textContent ?? '';
      const match = text.match(/^\s*(\d+)\s*(\d+)?/);
      if (!match) return [];
      return [match[1], match[2]]
        .filter((s): s is string => typeof s === 'string')
        .map((s) => parseInt(s, 10));
    };

    const addLines = lines.filter(
      (l) => l.getAttribute('data-line-kind') === 'add',
    );
    expect(addLines).toHaveLength(2);
    // Each add line has at least one digit in its gutter.
    const addNums = addLines.map((l) => numericPrefix(l));
    expect(addNums[0]?.length ?? 0).toBeGreaterThan(0);
    expect(addNums[1]?.length ?? 0).toBeGreaterThan(0);
    // The two add lines have DIFFERENT gutter values (counter incremented).
    const addNumStr = addLines.map((l) => (l.textContent ?? '').match(/\d+/g)?.join(',') ?? '');
    expect(addNumStr[0]).not.toBe(addNumStr[1]);

    const removeLines = lines.filter(
      (l) => l.getAttribute('data-line-kind') === 'remove',
    );
    expect(removeLines).toHaveLength(1);
    // Remove line has at least one numeric gutter value.
    expect((removeLines[0]?.textContent ?? '').match(/\d/)).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // CMP-CODE-DIFF-007 — empty diff → no lines, root still present
  // ---------------------------------------------------------------------------
  it('CMP-CODE-DIFF-007: empty diff → no lines rendered (root testid still present)', () => {
    render(<CodeDiff diff="" data-testid="my-diff" />);
    const root = screen.getByTestId('my-diff');
    expect(root).toBeInTheDocument();
    expect(root.querySelectorAll('[data-line-kind]')).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // CMP-CODE-DIFF-008 — non-diff string → every line is context
  // ---------------------------------------------------------------------------
  it('CMP-CODE-DIFF-008: a plain non-diff string is rendered with every line as "context"', () => {
    const plain = 'just some text\nanother line\n';
    const { container } = render(<CodeDiff diff={plain} />);
    const kinds = lineKinds(container);
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds.every((k) => k === 'context')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // CMP-CODE-DIFF-009 — TS hint → tokenized add line has tk-keyword + tk-ident
  // ---------------------------------------------------------------------------
  it('CMP-CODE-DIFF-009: TS-language hint tokenizes the trailing content (tk-keyword, tk-ident)', () => {
    const diff = '+const x = 1;\n';
    const { container } = render(<CodeDiff diff={diff} language="ts" />);
    const keywordSpans = container.querySelectorAll('.tk-keyword');
    const identSpans = container.querySelectorAll('.tk-ident');
    expect(keywordSpans.length).toBeGreaterThan(0);
    expect(identSpans.length).toBeGreaterThan(0);
    // The keyword should be `const`.
    expect(Array.from(keywordSpans).some((s) => s.textContent === 'const')).toBe(true);
    // And `x` is an identifier.
    expect(Array.from(identSpans).some((s) => s.textContent === 'x')).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // CMP-CODE-DIFF-010 — overridable testid
  // ---------------------------------------------------------------------------
  it('CMP-CODE-DIFF-010: data-testid is overridable via prop (default = "code-diff")', () => {
    const diff = '+x\n';
    const { unmount } = render(<CodeDiff diff={diff} />);
    expect(screen.getByTestId('code-diff')).toBeInTheDocument();
    unmount();

    render(<CodeDiff diff={diff} data-testid="custom-diff-testid" />);
    expect(screen.getByTestId('custom-diff-testid')).toBeInTheDocument();
    expect(screen.queryByTestId('code-diff')).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // CMP-CODE-DIFF-011 — auto-detect TS from `+++ b/foo.ts`
  // ---------------------------------------------------------------------------
  it('CMP-CODE-DIFF-011: auto-detects language from "+++ b/foo.ts" header', () => {
    const diff =
      'diff --git a/foo.ts b/foo.ts\n' +
      '--- a/foo.ts\n' +
      '+++ b/foo.ts\n' +
      '@@ -1,1 +1,2 @@\n' +
      ' const a = 1;\n' +
      '+const b = 2;\n';
    const { container } = render(<CodeDiff diff={diff} />);
    // `const` should be tokenized as a keyword in the added line.
    const keywordSpans = container.querySelectorAll('.tk-keyword');
    expect(
      Array.from(keywordSpans).some((s) => s.textContent === 'const'),
    ).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // CMP-CODE-DIFF-012 — preserve trailing whitespace
  // ---------------------------------------------------------------------------
  it('CMP-CODE-DIFF-012: lines preserve trailing whitespace exactly (alignment intact)', () => {
    // Two trailing spaces after `bar`.
    const diff = '+const foo = bar  \n';
    const { container } = render(<CodeDiff diff={diff} language="ts" />);
    const addLine = container.querySelector<HTMLElement>(
      '[data-line-kind="add"]',
    );
    expect(addLine).not.toBeNull();
    // The visible line text (after the `+` marker) should still contain
    // the trailing two spaces.
    const text = addLine?.textContent ?? '';
    // Some implementations include the gutter number in textContent, so we
    // assert presence of "bar  " (two trailing spaces) anywhere in the line.
    expect(text).toMatch(/bar {2}/);
  });
});
