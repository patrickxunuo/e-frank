// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ThemeToggle } from '../../src/renderer/components/ThemeToggle';

/**
 * CMP-THEME-001..005 — <ThemeToggle /> component tests.
 *
 * Stable testid: `theme-toggle` (default; overridable via prop).
 *
 * Behaviour:
 *  - Renders a moon icon when current theme is dark.
 *  - Renders a sun icon when current theme is light.
 *  - aria-label reflects the *next* state ("Switch to light theme" when
 *    currently dark; "Switch to dark theme" when currently light).
 *  - Click toggles the theme — flipping the html data-theme attribute
 *    AND persisting to localStorage.
 *  - data-testid prop overrides the default.
 */

const STORAGE_KEY = 'ef.theme';

interface MemoryStorage {
  store: Map<string, string>;
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  clear: () => void;
  length: number;
  key: (index: number) => string | null;
}

function makeMemoryStorage(seed?: Record<string, string>): MemoryStorage {
  const store = new Map<string, string>(Object.entries(seed ?? {}));
  return {
    store,
    getItem: (k) => (store.has(k) ? (store.get(k) ?? null) : null),
    setItem: (k, v) => {
      store.set(k, String(v));
    },
    removeItem: (k) => {
      store.delete(k);
    },
    clear: () => {
      store.clear();
    },
    get length(): number {
      return store.size;
    },
    key: (i) => Array.from(store.keys())[i] ?? null,
  };
}

function installStorage(stub: MemoryStorage | Storage): void {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: stub,
  });
}

function resetThemeAttribute(): void {
  document.documentElement.removeAttribute('data-theme');
}

beforeEach(() => {
  resetThemeAttribute();
  installStorage(makeMemoryStorage());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetThemeAttribute();
});

describe('<ThemeToggle /> — CMP-THEME', () => {
  // ---------------------------------------------------------------------------
  // CMP-THEME-001 — Moon icon when theme is dark
  // ---------------------------------------------------------------------------
  it('CMP-THEME-001: renders moon icon when current theme is dark', async () => {
    // Default: no stored value → useTheme resolves to 'dark'.
    render(<ThemeToggle />);

    const toggle = await screen.findByTestId('theme-toggle');
    // The moon variant is identified by an aria-label flipping to "Switch to light theme",
    // since aria-label reflects the NEXT state.
    await waitFor(() => {
      expect(toggle.getAttribute('aria-label')).toMatch(/switch to light theme/i);
    });
  });

  // ---------------------------------------------------------------------------
  // CMP-THEME-002 — Sun icon when theme is light
  // ---------------------------------------------------------------------------
  it('CMP-THEME-002: renders sun icon when current theme is light', async () => {
    installStorage(makeMemoryStorage({ [STORAGE_KEY]: 'light' }));

    render(<ThemeToggle />);

    const toggle = await screen.findByTestId('theme-toggle');
    await waitFor(() => {
      expect(toggle.getAttribute('aria-label')).toMatch(/switch to dark theme/i);
    });
  });

  // ---------------------------------------------------------------------------
  // CMP-THEME-003 — aria-label reflects the next state
  // ---------------------------------------------------------------------------
  it('CMP-THEME-003: aria-label reflects the *next* state', async () => {
    // Dark by default → aria says "Switch to light theme".
    const { unmount } = render(<ThemeToggle />);
    const toggleA = await screen.findByTestId('theme-toggle');
    await waitFor(() => {
      expect(toggleA.getAttribute('aria-label')).toMatch(/switch to light theme/i);
    });
    unmount();

    // Now seed light and re-render → aria says "Switch to dark theme".
    installStorage(makeMemoryStorage({ [STORAGE_KEY]: 'light' }));
    render(<ThemeToggle />);
    const toggleB = await screen.findByTestId('theme-toggle');
    await waitFor(() => {
      expect(toggleB.getAttribute('aria-label')).toMatch(/switch to dark theme/i);
    });
  });

  // ---------------------------------------------------------------------------
  // CMP-THEME-004 — Click toggles theme (storage + html attribute)
  // ---------------------------------------------------------------------------
  it('CMP-THEME-004: click toggles theme — localStorage updated and data-theme flipped', async () => {
    const storage = makeMemoryStorage();
    installStorage(storage);

    render(<ThemeToggle />);

    const toggle = await screen.findByTestId('theme-toggle');
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });
    expect(storage.store.get(STORAGE_KEY)).toBe('light');

    // Toggle again — flips back to dark.
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });
    expect(storage.store.get(STORAGE_KEY)).toBe('dark');
  });

  // ---------------------------------------------------------------------------
  // CMP-THEME-005 — testid default + override
  // ---------------------------------------------------------------------------
  it('CMP-THEME-005: data-testid defaults to "theme-toggle" and is overridable', async () => {
    const { unmount } = render(<ThemeToggle />);
    expect(await screen.findByTestId('theme-toggle')).toBeInTheDocument();
    unmount();

    render(<ThemeToggle data-testid="custom-toggle" />);
    expect(await screen.findByTestId('custom-toggle')).toBeInTheDocument();
    expect(screen.queryByTestId('theme-toggle')).not.toBeInTheDocument();
  });
});
