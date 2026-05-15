// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { useTheme, type ResolvedTheme } from '../../src/renderer/state/theme';
import { useAppConfig } from '../../src/renderer/state/app-config';
import type { AppConfig, ThemeMode } from '../../src/shared/ipc';

/**
 * THEME-001..012 — `useTheme` hook tests (#GH-84 rewrite).
 *
 * Post-#GH-84 the hook reads its preference from `useAppConfig()` and
 * writes through to `localStorage['ef.theme']` as a flash-prevention
 * cache for the index.html bootstrap script. System mode resolves
 * via `window.matchMedia('(prefers-color-scheme: dark)')`.
 *
 * The tests:
 *  - Mock `useAppConfig` so we control the persisted config + observe
 *    `update()` calls.
 *  - Mock `window.matchMedia` so we control the system preference + can
 *    fire `change` events to verify the listener wiring.
 *  - Use a tiny `<HookConsumer />` to capture the latest hook return
 *    value into a ref captor (the same pattern used elsewhere in this
 *    codebase since `renderHook` isn't installed).
 */

vi.mock('../../src/renderer/state/app-config', () => ({
  useAppConfig: vi.fn(),
}));

const STORAGE_KEY = 'ef.theme';
const SYSTEM_QUERY = '(prefers-color-scheme: dark)';

interface CapturedHook {
  latest: ReturnType<typeof useTheme> | null;
  resolvedHistory: ResolvedTheme[];
}

function HookConsumer({ capture }: { capture: CapturedHook }): null {
  const value = useTheme();
  useEffect(() => {
    capture.latest = value;
    capture.resolvedHistory.push(value.resolvedTheme);
  }, [value, capture]);
  return null;
}

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

function installStorage(stub: MemoryStorage): void {
  Object.defineProperty(window, 'localStorage', { configurable: true, value: stub });
}

interface MatchMediaStub {
  matches: boolean;
  listeners: Set<(e: MediaQueryListEvent) => void>;
}

function installMatchMedia(stub: MatchMediaStub): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = () =>
    ({
      matches: stub.matches,
      media: SYSTEM_QUERY,
      onchange: null,
      addEventListener: (_t: string, listener: (e: MediaQueryListEvent) => void): void => {
        stub.listeners.add(listener);
      },
      removeEventListener: (_t: string, listener: (e: MediaQueryListEvent) => void): void => {
        stub.listeners.delete(listener);
      },
      addListener: (listener: (e: MediaQueryListEvent) => void): void => {
        stub.listeners.add(listener);
      },
      removeListener: (listener: (e: MediaQueryListEvent) => void): void => {
        stub.listeners.delete(listener);
      },
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}

function makeConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    theme: 'dark',
    claudeCliPath: null,
    defaultWorkflowMode: 'interactive',
    defaultPollingIntervalSec: 60,
    defaultRunTimeoutMin: 60,
    ...over,
  };
}

/**
 * Install the `useAppConfig` mock with the given config + a spy `update`.
 * Returns the spy so tests can assert on call args.
 */
function mockAppConfig(opts: {
  config?: AppConfig | null;
  loading?: boolean;
  error?: string | null;
} = {}): Mock {
  const update = vi.fn().mockResolvedValue(opts.config ?? makeConfig());
  (useAppConfig as unknown as Mock).mockReturnValue({
    config: opts.config ?? makeConfig(),
    loading: opts.loading ?? false,
    error: opts.error ?? null,
    refresh: vi.fn(),
    update,
  });
  return update;
}

let media: MatchMediaStub;

beforeEach(() => {
  document.documentElement.removeAttribute('data-theme');
  installStorage(makeMemoryStorage());
  media = { matches: false, listeners: new Set() };
  installMatchMedia(media);
});

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
  vi.restoreAllMocks();
  (useAppConfig as unknown as Mock).mockReset();
});

describe('useTheme — THEME (#GH-84 3-mode + app-config + matchMedia)', () => {
  it('THEME-001: app-config.theme="dark" → returns dark, resolves dark, writes data-theme + localStorage', async () => {
    mockAppConfig({ config: makeConfig({ theme: 'dark' }) });
    const cap: CapturedHook = { latest: null, resolvedHistory: [] };
    render(<HookConsumer capture={cap} />);
    await waitFor(() => {
      expect(cap.latest?.theme).toBe('dark');
    });
    expect(cap.latest?.resolvedTheme).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect((window.localStorage as unknown as MemoryStorage).store.get(STORAGE_KEY)).toBe('dark');
  });

  it('THEME-002: app-config.theme="light" → returns light, resolves light', async () => {
    mockAppConfig({ config: makeConfig({ theme: 'light' }) });
    const cap: CapturedHook = { latest: null, resolvedHistory: [] };
    render(<HookConsumer capture={cap} />);
    await waitFor(() => {
      expect(cap.latest?.theme).toBe('light');
    });
    expect(cap.latest?.resolvedTheme).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('THEME-003: app-config.theme="system" + matchMedia dark → resolves dark, writes resolved value (not "system") to localStorage', async () => {
    media.matches = true; // OS prefers dark
    mockAppConfig({ config: makeConfig({ theme: 'system' }) });
    const cap: CapturedHook = { latest: null, resolvedHistory: [] };
    render(<HookConsumer capture={cap} />);
    await waitFor(() => {
      expect(cap.latest?.theme).toBe('system');
    });
    expect(cap.latest?.resolvedTheme).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    // CRITICAL: localStorage carries the RESOLVED concrete value, not 'system'
    // — so the index.html bootstrap script's binary check works unchanged.
    const stored = (window.localStorage as unknown as MemoryStorage).store.get(STORAGE_KEY);
    expect(stored).toBe('dark');
    expect(stored).not.toBe('system');
  });

  it('THEME-004: app-config.theme="system" + matchMedia light → resolves light, localStorage="light"', async () => {
    media.matches = false; // OS prefers light
    mockAppConfig({ config: makeConfig({ theme: 'system' }) });
    const cap: CapturedHook = { latest: null, resolvedHistory: [] };
    render(<HookConsumer capture={cap} />);
    await waitFor(() => {
      expect(cap.latest?.resolvedTheme).toBe('light');
    });
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('THEME-005: matchMedia change while in system mode → resolved theme updates live', async () => {
    media.matches = true; // start dark
    mockAppConfig({ config: makeConfig({ theme: 'system' }) });
    const cap: CapturedHook = { latest: null, resolvedHistory: [] };
    render(<HookConsumer capture={cap} />);
    await waitFor(() => {
      expect(cap.latest?.resolvedTheme).toBe('dark');
    });

    // Simulate OS theme change to light.
    await act(async () => {
      for (const listener of media.listeners) {
        listener({ matches: false } as MediaQueryListEvent);
      }
    });
    await waitFor(() => {
      expect(cap.latest?.resolvedTheme).toBe('light');
    });
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect((window.localStorage as unknown as MemoryStorage).store.get(STORAGE_KEY)).toBe('light');
  });

  it('THEME-006: setTheme("light") calls appConfig.update + updates DOM + localStorage', async () => {
    const update = mockAppConfig({ config: makeConfig({ theme: 'dark' }) });
    const cap: CapturedHook = { latest: null, resolvedHistory: [] };
    render(<HookConsumer capture={cap} />);
    await waitFor(() => {
      expect(cap.latest).not.toBeNull();
    });

    await act(async () => {
      await cap.latest?.setTheme('light');
    });

    expect(update).toHaveBeenCalledWith({ theme: 'light' });
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    });
    expect((window.localStorage as unknown as MemoryStorage).store.get(STORAGE_KEY)).toBe('light');
  });

  it('THEME-007: toggle() from dark → setTheme("light")', async () => {
    const update = mockAppConfig({ config: makeConfig({ theme: 'dark' }) });
    const cap: CapturedHook = { latest: null, resolvedHistory: [] };
    render(<HookConsumer capture={cap} />);
    await waitFor(() => {
      expect(cap.latest?.resolvedTheme).toBe('dark');
    });
    await act(async () => {
      await cap.latest?.toggle();
    });
    expect(update).toHaveBeenCalledWith({ theme: 'light' });
  });

  it('THEME-008: toggle() from light → setTheme("dark")', async () => {
    const update = mockAppConfig({ config: makeConfig({ theme: 'light' }) });
    const cap: CapturedHook = { latest: null, resolvedHistory: [] };
    render(<HookConsumer capture={cap} />);
    await waitFor(() => {
      expect(cap.latest?.resolvedTheme).toBe('light');
    });
    await act(async () => {
      await cap.latest?.toggle();
    });
    expect(update).toHaveBeenCalledWith({ theme: 'dark' });
  });

  it('THEME-009: toggle() from system + matchMedia dark → setTheme("light") (escapes system to opposite of resolved)', async () => {
    media.matches = true;
    const update = mockAppConfig({ config: makeConfig({ theme: 'system' }) });
    const cap: CapturedHook = { latest: null, resolvedHistory: [] };
    render(<HookConsumer capture={cap} />);
    await waitFor(() => {
      expect(cap.latest?.resolvedTheme).toBe('dark');
    });
    await act(async () => {
      await cap.latest?.toggle();
    });
    expect(update).toHaveBeenCalledWith({ theme: 'light' });
  });

  it('THEME-010: toggle() from system + matchMedia light → setTheme("dark")', async () => {
    media.matches = false;
    const update = mockAppConfig({ config: makeConfig({ theme: 'system' }) });
    const cap: CapturedHook = { latest: null, resolvedHistory: [] };
    render(<HookConsumer capture={cap} />);
    await waitFor(() => {
      expect(cap.latest?.resolvedTheme).toBe('light');
    });
    await act(async () => {
      await cap.latest?.toggle();
    });
    expect(update).toHaveBeenCalledWith({ theme: 'dark' });
  });

  it('THEME-011: migration — app-config.theme=default ("dark") + localStorage="light" → promotes via update', async () => {
    installStorage(makeMemoryStorage({ [STORAGE_KEY]: 'light' }));
    const update = mockAppConfig({ config: makeConfig({ theme: 'dark' }) });
    render(<HookConsumer capture={{ latest: null, resolvedHistory: [] }} />);
    await waitFor(() => {
      expect(update).toHaveBeenCalledWith({ theme: 'light' });
    });
  });

  it('THEME-012: migration does NOT fire when app-config.theme is non-default (user already chose)', async () => {
    installStorage(makeMemoryStorage({ [STORAGE_KEY]: 'dark' }));
    const update = mockAppConfig({ config: makeConfig({ theme: 'light' }) });
    render(<HookConsumer capture={{ latest: null, resolvedHistory: [] }} />);
    // Give the migration effect a chance to run; assert it did NOT call update.
    await new Promise((r) => setTimeout(r, 20));
    expect(update).not.toHaveBeenCalled();
  });

  it('THEME-013: setTheme persisted error doesn\'t crash — DOM still updates optimistically', async () => {
    const failedUpdate = vi.fn().mockResolvedValue(null);
    (useAppConfig as unknown as Mock).mockReturnValue({
      config: makeConfig({ theme: 'dark' }),
      loading: false,
      error: null,
      refresh: vi.fn(),
      update: failedUpdate,
    });

    const cap: CapturedHook = { latest: null, resolvedHistory: [] };
    render(<HookConsumer capture={cap} />);
    await waitFor(() => {
      expect(cap.latest).not.toBeNull();
    });

    let threw = false;
    await act(async () => {
      try {
        await cap.latest?.setTheme('light' as ThemeMode);
      } catch {
        threw = true;
      }
    });
    expect(threw).toBe(false);
    // Optimistic update applied to local state + DOM even though persist returned null.
    expect(cap.latest?.theme).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});
