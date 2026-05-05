// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Checkbox } from '../../src/renderer/components/Checkbox';

/**
 * CMP-CHK-001..004 — public API of <Checkbox>:
 *   - checked={false} click → onChange(true)
 *   - checked={true} click → onChange(false)
 *   - indeterminate={true} renders the dash glyph; click still fires onChange(true)
 *     (indeterminate is a presentational prop only)
 *   - disabled click → onChange NOT called
 *
 * The component is built on a hidden `<input type="checkbox">`. Click-on-
 * the-visible-box must toggle. We always click via the data-testid
 * (which Agent B will place on either the input or the visible box —
 * either is fine because the click bubbles through the label).
 */

afterEach(() => {
  cleanup();
});

describe('<Checkbox /> — CMP-CHK', () => {
  it('CMP-CHK-001: checked=false clicked → onChange(true)', () => {
    const onChange = vi.fn();
    render(
      <Checkbox
        data-testid="cb"
        checked={false}
        onChange={onChange}
        aria-label="select all"
      />,
    );
    const cb = screen.getByTestId('cb');
    fireEvent.click(cb);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('CMP-CHK-002: checked=true clicked → onChange(false)', () => {
    const onChange = vi.fn();
    render(
      <Checkbox
        data-testid="cb"
        checked={true}
        onChange={onChange}
        aria-label="row"
      />,
    );
    const cb = screen.getByTestId('cb');
    fireEvent.click(cb);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('CMP-CHK-003: indeterminate=true renders dash glyph; click still fires onChange(true)', () => {
    const onChange = vi.fn();
    render(
      <Checkbox
        data-testid="cb-indet"
        checked={false}
        indeterminate
        onChange={onChange}
        aria-label="select all"
      />,
    );

    // The dash glyph is presentational. Per spec the indeterminate state is
    // driven via CSS (data attribute or class), not via the native
    // `.indeterminate` property. Look for an element marked one of:
    //   - data-indeterminate="true"
    //   - data-state="indeterminate"
    //   - a class substring "indeterminate"
    const root = screen.getByTestId('cb-indet');
    // The root or one of its ancestors / descendants should reflect the
    // indeterminate state. Search the rendered subtree by walking up from
    // the testid'd node and through its descendants.
    const dashHost =
      root.closest('[data-indeterminate="true"]') ??
      root.closest('[data-state="indeterminate"]') ??
      root.querySelector('[data-indeterminate="true"]') ??
      root.querySelector('[data-state="indeterminate"]') ??
      // Fallback: the root or any descendant has a className containing
      // "indeterminate" (CSS Modules will hash it but preserve the readable
      // root).
      ([root, ...Array.from(root.querySelectorAll('*'))].find((el) =>
        /indeterminate/i.test((el as HTMLElement).className ?? ''),
      ) ??
        // Last resort: walk up from root to find a labeled ancestor.
        root.parentElement?.closest('[class*="indeterminate" i]') ??
        null);

    expect(dashHost).not.toBeNull();

    // Indeterminate is presentational — clicking should still emit
    // onChange(true). Per spec: "indeterminate is a presentational prop".
    fireEvent.click(root);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('CMP-CHK-004: disabled — click does NOT fire onChange', () => {
    const onChange = vi.fn();
    render(
      <Checkbox
        data-testid="cb-disabled"
        checked={false}
        disabled
        onChange={onChange}
        aria-label="row"
      />,
    );
    const cb = screen.getByTestId('cb-disabled');
    fireEvent.click(cb);
    expect(onChange).not.toHaveBeenCalled();
  });
});
