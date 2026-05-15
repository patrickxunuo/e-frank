// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ThemeToggle } from '../../src/renderer/components/ThemeToggle';
import { useTheme } from '../../src/renderer/state/theme';
import type { ResolvedTheme } from '../../src/renderer/state/theme';
import type { ThemeMode } from '../../src/shared/ipc';

/**
 * CMP-THEME-001..008 — `<ThemeToggle />` component tests (#GH-84 rewrite).
 *
 * After the #GH-84 migration, the toggle reads `resolvedTheme` (effective)
 * from `useTheme` and calls `toggle()` on click. The underlying
 * app-config / matchMedia machinery is exercised by `state-theme.test.tsx`;
 * here we mock `useTheme` directly so these tests focus purely on the
 * toggle's UI behavior.
 */

vi.mock('../../src/renderer/state/theme', () => ({
  useTheme: vi.fn(),
}));

function mockTheme(opts: {
  theme: ThemeMode;
  resolvedTheme: ResolvedTheme;
  toggle?: Mock;
  setTheme?: Mock;
}): Mock {
  const toggle = opts.toggle ?? vi.fn().mockResolvedValue(undefined);
  const setTheme = opts.setTheme ?? vi.fn().mockResolvedValue(undefined);
  (useTheme as unknown as Mock).mockReturnValue({
    theme: opts.theme,
    resolvedTheme: opts.resolvedTheme,
    loading: false,
    setTheme,
    toggle,
  });
  return toggle;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  (useTheme as unknown as Mock).mockReset();
});

describe('<ThemeToggle /> — CMP-THEME (#GH-84)', () => {
  it('CMP-THEME-001: resolvedTheme="dark" → renders the moon icon + "Switch to light theme" aria-label', () => {
    mockTheme({ theme: 'dark', resolvedTheme: 'dark' });
    render(<ThemeToggle />);
    const btn = screen.getByTestId('theme-toggle');
    expect(btn).toHaveAttribute('aria-label', 'Switch to light theme');
    // Moon icon path starts with `M21 12.79A9 9 0 1 1` — distinguishes from sun.
    expect(btn.querySelector('svg path')?.getAttribute('d')).toMatch(/A9 9 0 1 1/);
  });

  it('CMP-THEME-002: resolvedTheme="light" → renders the sun icon + "Switch to dark theme" aria-label', () => {
    mockTheme({ theme: 'light', resolvedTheme: 'light' });
    render(<ThemeToggle />);
    const btn = screen.getByTestId('theme-toggle');
    expect(btn).toHaveAttribute('aria-label', 'Switch to dark theme');
    // Sun icon has a <circle> child; moon doesn't.
    expect(btn.querySelector('svg circle')).not.toBeNull();
  });

  it('CMP-THEME-003: click calls toggle() on the hook exactly once', () => {
    const toggle = mockTheme({ theme: 'dark', resolvedTheme: 'dark' });
    render(<ThemeToggle />);
    fireEvent.click(screen.getByTestId('theme-toggle'));
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('CMP-THEME-004: in system mode with resolved=dark, button still shows moon ("Switch to light")', () => {
    mockTheme({ theme: 'system', resolvedTheme: 'dark' });
    render(<ThemeToggle />);
    // The toggle reflects the EFFECTIVE state, not the preference — even
    // when preference is 'system', the user sees a toggle aligned with what
    // they're currently looking at.
    expect(screen.getByTestId('theme-toggle')).toHaveAttribute(
      'aria-label',
      'Switch to light theme',
    );
  });

  it('CMP-THEME-005: in system mode with resolved=light, button shows sun ("Switch to dark")', () => {
    mockTheme({ theme: 'system', resolvedTheme: 'light' });
    render(<ThemeToggle />);
    expect(screen.getByTestId('theme-toggle')).toHaveAttribute(
      'aria-label',
      'Switch to dark theme',
    );
  });

  it('CMP-THEME-006: data-testid prop overrides the default testid', () => {
    mockTheme({ theme: 'dark', resolvedTheme: 'dark' });
    render(<ThemeToggle data-testid="custom-toggle" />);
    expect(screen.getByTestId('custom-toggle')).toBeInTheDocument();
    expect(screen.queryByTestId('theme-toggle')).toBeNull();
  });

  it('CMP-THEME-007: rapid clicks call toggle() each time (no debounce in the component)', () => {
    const toggle = mockTheme({ theme: 'dark', resolvedTheme: 'dark' });
    render(<ThemeToggle />);
    const btn = screen.getByTestId('theme-toggle');
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(toggle).toHaveBeenCalledTimes(3);
  });

  it('CMP-THEME-008: button is a real <button> element (focusable, keyboard-actionable)', () => {
    mockTheme({ theme: 'dark', resolvedTheme: 'dark' });
    render(<ThemeToggle />);
    const btn = screen.getByTestId('theme-toggle');
    expect(btn.tagName).toBe('BUTTON');
    expect(btn).toHaveAttribute('type', 'button');
  });
});
