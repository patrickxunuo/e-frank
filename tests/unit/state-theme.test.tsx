// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { useTheme, type ThemePreference } from '../../src/renderer/state/theme';

/**
 * THEME-001..008 — `useTheme` hook tests.
 *
 * Behaviour under test (from acceptance/ui-polish.md):
 *  - On first render with no localStorage value, returns 'dark' and
 *    writes data-theme="dark" on <html>.
 *  - localStorage 'light' or 'dark' is honoured; anything else falls
 *    back to 'dark'.
 *  - setTheme writes both DOM attribute and localStorage.
 *  - toggle flips dark<->light.
 *  - localStorage that throws on read/write degrades gracefully (no
 *    crash; in-memory state still updates).
 *
 * The tests use a tiny <HookConsumer /> that captures the latest hook
 * value into an out-parameter, so we can assert on state without
 * depending on @testing-library/react-hooks (not installed).
 */

interface CapturedHook {
  latest: ReturnType<typeof useTheme> | null;
  history: ThemePreference[];
}

function HookConsumer({ capture }: { capture: CapturedHook }): null {
  const value = useTheme();
  useEffect(() => {
    capture.latest = value;
    capture.history.push(value.theme);
  }, [value, capture]);
  return null;
}

const STORAGE_KEY = 'ef.theme';

/**
 * Build a fresh in-memory localStorage stub. We REPLACE the global
 * localStorage so getItem/setItem pull from this isolated map.
 */
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
  // Default: a clean memory storage. Individual tests can override.
  installStorage(makeMemoryStorage());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetThemeAttribute();
});

describe('useTheme — THEME', () => {
  // ---------------------------------------------------------------------------
  // THEME-001 — First render, no stored value → 'dark' + html attr
  // ---------------------------------------------------------------------------
  it('THEME-001: first render with no localStorage → returns "dark" and writes data-theme="dark"', async () => {
    const cap: CapturedHook = { latest: null, history: [] };
    render(<HookConsumer capture={cap} />);

    await waitFor(() => {
      expect(cap.latest?.theme).toBe('dark');
    });
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });
  });

  // ---------------------------------------------------------------------------
  // THEME-002 — Stored 'light' is honoured
  // ---------------------------------------------------------------------------
  it('THEME-002: localStorage "light" → returns "light" and writes attribute', async () => {
    installStorage(makeMemoryStorage({ [STORAGE_KEY]: 'light' }));

    const cap: CapturedHook = { latest: null, history: [] };
    render(<HookConsumer capture={cap} />);

    await waitFor(() => {
      expect(cap.latest?.theme).toBe('light');
    });
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });
  });

  // ---------------------------------------------------------------------------
  // THEME-003 — Invalid stored value → fall back to 'dark'
  // ---------------------------------------------------------------------------
  it('THEME-003: invalid localStorage value → falls back to "dark"', async () => {
    installStorage(makeMemoryStorage({ [STORAGE_KEY]: 'system' }));

    const cap: CapturedHook = { latest: null, history: [] };
    render(<HookConsumer capture={cap} />);

    await waitFor(() => {
      expect(cap.latest?.theme).toBe('dark');
    });
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });
  });

  // ---------------------------------------------------------------------------
  // THEME-004 — setTheme updates DOM attribute and localStorage
  // ---------------------------------------------------------------------------
  it('THEME-004: setTheme("light") writes both DOM attribute and localStorage', async () => {
    const storage = makeMemoryStorage();
    installStorage(storage);

    const cap: CapturedHook = { latest: null, history: [] };
    render(<HookConsumer capture={cap} />);

    await waitFor(() => {
      expect(cap.latest).not.toBeNull();
    });

    await act(async () => {
      cap.latest?.setTheme('light');
    });

    await waitFor(() => {
      expect(cap.latest?.theme).toBe('light');
    });
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });
    expect(storage.store.get(STORAGE_KEY)).toBe('light');
  });

  // ---------------------------------------------------------------------------
  // THEME-005 — toggle dark → light updates state, attribute, storage
  // ---------------------------------------------------------------------------
  it('THEME-005: toggle() from dark → light updates state, attribute, storage', async () => {
    const storage = makeMemoryStorage();
    installStorage(storage);

    const cap: CapturedHook = { latest: null, history: [] };
    render(<HookConsumer capture={cap} />);

    await waitFor(() => {
      expect(cap.latest?.theme).toBe('dark');
    });

    await act(async () => {
      cap.latest?.toggle();
    });

    await waitFor(() => {
      expect(cap.latest?.theme).toBe('light');
    });
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });
    expect(storage.store.get(STORAGE_KEY)).toBe('light');
  });

  // ---------------------------------------------------------------------------
  // THEME-006 — toggle light → dark updates state, attribute, storage
  // ---------------------------------------------------------------------------
  it('THEME-006: toggle() from light → dark updates state, attribute, storage', async () => {
    const storage = makeMemoryStorage({ [STORAGE_KEY]: 'light' });
    installStorage(storage);

    const cap: CapturedHook = { latest: null, history: [] };
    render(<HookConsumer capture={cap} />);

    await waitFor(() => {
      expect(cap.latest?.theme).toBe('light');
    });

    await act(async () => {
      cap.latest?.toggle();
    });

    await waitFor(() => {
      expect(cap.latest?.theme).toBe('dark');
    });
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });
    expect(storage.store.get(STORAGE_KEY)).toBe('dark');
  });

  // ---------------------------------------------------------------------------
  // THEME-007 — getItem throws → fall back to 'dark', no crash
  // ---------------------------------------------------------------------------
  it('THEME-007: localStorage.getItem throws → falls back to "dark", does not crash', async () => {
    const throwing: MemoryStorage = makeMemoryStorage();
    throwing.getItem = (): string | null => {
      throw new Error('storage read denied');
    };
    installStorage(throwing);

    const cap: CapturedHook = { latest: null, history: [] };

    expect(() => {
      render(<HookConsumer capture={cap} />);
    }).not.toThrow();

    await waitFor(() => {
      expect(cap.latest?.theme).toBe('dark');
    });
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });
  });

  // ---------------------------------------------------------------------------
  // THEME-008 — setItem throws → state still updates, no crash
  // ---------------------------------------------------------------------------
  it('THEME-008: localStorage.setItem throws → state still updates, no crash', async () => {
    const throwing: MemoryStorage = makeMemoryStorage();
    throwing.setItem = (): void => {
      throw new Error('storage write denied');
    };
    installStorage(throwing);

    const cap: CapturedHook = { latest: null, history: [] };
    render(<HookConsumer capture={cap} />);

    await waitFor(() => {
      expect(cap.latest?.theme).toBe('dark');
    });

    expect(() => {
      act(() => {
        cap.latest?.setTheme('light');
      });
    }).not.toThrow();

    await waitFor(() => {
      expect(cap.latest?.theme).toBe('light');
    });
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });
  });
});
