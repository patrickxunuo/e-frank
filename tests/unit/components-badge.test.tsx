// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Badge } from '../../src/renderer/components/Badge';

/**
 * CMP-BDG-001..002 — public API of <Badge>:
 *   - variant="idle" renders with a class containing "idle" (CSS-modules
 *     scope it, so we assert the substring rather than equality)
 *   - variant="running" pulse renders an element with data-pulse-dot
 */

afterEach(() => {
  cleanup();
});

describe('<Badge /> — CMP-BDG', () => {
  it('CMP-BDG-001: variant="idle" renders with a badge-idle class', () => {
    render(
      <Badge variant="idle" data-testid="badge-idle">
        Idle
      </Badge>,
    );
    const el = screen.getByTestId('badge-idle');
    // CSS Modules will hash the class but should preserve the readable
    // root (e.g. "Badge_idle__abc123" or similar). Match case-insensitively
    // on the substring.
    expect(el.className.toLowerCase()).toMatch(/idle/);
  });

  it('CMP-BDG-002: variant="running" pulse renders an element with data-pulse-dot', () => {
    render(
      <Badge variant="running" pulse data-testid="badge-running">
        Running
      </Badge>,
    );
    const root = screen.getByTestId('badge-running');
    const dot = root.querySelector('[data-pulse-dot]');
    expect(dot).not.toBeNull();
  });
});
