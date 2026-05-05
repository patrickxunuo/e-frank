// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ProgressBar } from '../../src/renderer/components/ProgressBar';

/**
 * CMP-PROG-001..002 — public API of <ProgressBar>:
 *   - value=0.5 renders the fill at 50% width
 *   - value=-1 clamps to 0; value=2 clamps to 1
 *
 * Per spec the fill element should be queryable. We try (in order):
 *   1. role="progressbar"  (semantic, preferred)
 *   2. data-testid="progress-fill"
 *   3. fall back to the wrapper testid passed via props.
 *
 * The width assertion reads from `style.width` — Agent B sets it inline as
 * a percentage string ("50%" or "0%" / "100%").
 */

afterEach(() => {
  cleanup();
});

function findFillElement(rootTestId: string): HTMLElement {
  // Try role="progressbar" first — works regardless of which inner element
  // carries the inline width style if the implementation puts it on the
  // role-bearing element.
  const byRole = screen.queryAllByRole('progressbar');
  for (const candidate of byRole) {
    if (candidate.style.width !== '') return candidate;
    // Look inside the role element for an inner fill.
    const inner = candidate.querySelector('[data-testid="progress-fill"]');
    if (inner instanceof HTMLElement && inner.style.width !== '') return inner;
    const innerByClass = Array.from(candidate.querySelectorAll<HTMLElement>('*')).find(
      (el) => el.style.width !== '',
    );
    if (innerByClass) return innerByClass;
  }
  // Fall back to the explicit fill testid.
  const byFillTestId = screen.queryByTestId('progress-fill');
  if (byFillTestId instanceof HTMLElement && byFillTestId.style.width !== '') {
    return byFillTestId;
  }
  // Final fallback — query the wrapper testid and find the first child with
  // a non-empty inline width.
  const wrapper = screen.getByTestId(rootTestId);
  const fill = Array.from(wrapper.querySelectorAll<HTMLElement>('*')).find(
    (el) => el.style.width !== '',
  );
  if (!fill) {
    throw new Error(
      `ProgressBar: could not find fill element with inline width inside [${rootTestId}]`,
    );
  }
  return fill;
}

describe('<ProgressBar /> — CMP-PROG', () => {
  it('CMP-PROG-001: value=0.5 renders the fill at 50% width', () => {
    render(<ProgressBar value={0.5} data-testid="pb" />);
    const fill = findFillElement('pb');
    expect(fill.style.width).toBe('50%');
  });

  it('CMP-PROG-002: value=-1 clamps to 0; value=2 clamps to 1', () => {
    const { unmount } = render(<ProgressBar value={-1} data-testid="pb-low" />);
    const lowFill = findFillElement('pb-low');
    expect(lowFill.style.width).toBe('0%');
    unmount();

    render(<ProgressBar value={2} data-testid="pb-high" />);
    const highFill = findFillElement('pb-high');
    expect(highFill.style.width).toBe('100%');
  });
});
