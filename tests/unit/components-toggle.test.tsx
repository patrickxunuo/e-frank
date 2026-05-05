// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Toggle } from '../../src/renderer/components/Toggle';

/**
 * CMP-TGL-001..002 — public API of <Toggle>:
 *   - clicking when checked=false fires onChange(true)
 *   - disabled blocks onChange even when clicked
 */

afterEach(() => {
  cleanup();
});

describe('<Toggle /> — CMP-TGL', () => {
  it('CMP-TGL-001: checked=false clicked → onChange(true)', () => {
    const onChange = vi.fn();
    render(
      <Toggle
        data-testid="toggle"
        checked={false}
        onChange={onChange}
        label="Auto Mode"
      />,
    );
    const toggle = screen.getByTestId('toggle');
    fireEvent.click(toggle);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('CMP-TGL-002: disabled clicked → onChange NOT called', () => {
    const onChange = vi.fn();
    render(
      <Toggle
        data-testid="toggle-disabled"
        checked={false}
        onChange={onChange}
        disabled
        label="Auto Mode"
      />,
    );
    const toggle = screen.getByTestId('toggle-disabled');
    fireEvent.click(toggle);
    expect(onChange).not.toHaveBeenCalled();
  });
});
