// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Button } from '../../src/renderer/components/Button';

/**
 * CMP-BTN-001..003 — public API of <Button>:
 *   - emits onClick when clicked (default variant)
 *   - ghost variant has a different className from primary
 *   - disabled blocks onClick
 */

afterEach(() => {
  cleanup();
});

describe('<Button /> — CMP-BTN', () => {
  it('CMP-BTN-001: default variant fires onClick once on click', () => {
    const onClick = vi.fn();
    render(
      <Button data-testid="btn-default" onClick={onClick}>
        Click me
      </Button>,
    );
    const btn = screen.getByTestId('btn-default');
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('CMP-BTN-002: ghost variant has a different className from primary', () => {
    const { unmount } = render(
      <Button data-testid="btn-primary" variant="primary">
        Primary
      </Button>,
    );
    const primaryClass = screen.getByTestId('btn-primary').className;
    unmount();

    render(
      <Button data-testid="btn-ghost" variant="ghost">
        Ghost
      </Button>,
    );
    const ghostClass = screen.getByTestId('btn-ghost').className;

    expect(ghostClass).not.toBe('');
    expect(primaryClass).not.toBe('');
    expect(ghostClass).not.toEqual(primaryClass);
  });

  it('CMP-BTN-003: disabled does not fire onClick when clicked', () => {
    const onClick = vi.fn();
    render(
      <Button data-testid="btn-disabled" onClick={onClick} disabled>
        Disabled
      </Button>,
    );
    const btn = screen.getByTestId('btn-disabled');
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });
});
