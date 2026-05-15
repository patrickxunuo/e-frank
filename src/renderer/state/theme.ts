/**
 * Theme state (#GH-84 — promoted from binary to 3-mode app-config-backed).
 *
 * Source of truth: `useAppConfig().config.theme` (`'light' | 'dark' | 'system'`).
 *
 * `system` mode resolves at runtime via
 * `window.matchMedia('(prefers-color-scheme: dark)')` and re-renders on the
 * media query's `change` event. The DOM attribute `<html data-theme="...">`
 * always carries a CONCRETE value (`'light'` or `'dark'`) so tokens.css can
 * key off it without a "system" branch.
 *
 * `localStorage['ef.theme']` survives as a **write-through cache for the
 * pre-React bootstrap script** in `index.html` (which reads it
 * synchronously to set `<html data-theme>` before the React tree mounts,
 * avoiding the dreaded theme flash on first paint). The cache always
 * stores a CONCRETE value — never the literal `'system'` — so the
 * bootstrap script's binary check works unchanged.
 *
 * Migration: when this hook mounts and finds the user has the default
 * `app-config.theme === 'dark'` but `localStorage` carries `'light'` from
 * the pre-#GH-84 binary era, it promotes the localStorage value into
 * app-config via `update({ theme })`. Idempotent — after migration, the
 * two conditions don't both hold simultaneously again.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppConfig } from './app-config';
import type { ThemeMode, AppConfig } from '@shared/ipc';

/** Concrete, paintable theme value. `'system'` always resolves to one of these before reaching the DOM. */
export type ResolvedTheme = 'light' | 'dark';

export interface UseThemeResult {
  /** User preference. `'system'` means "follow OS prefers-color-scheme". */
  theme: ThemeMode;
  /** Effective theme actually applied to the DOM. `'system'` is resolved here. */
  resolvedTheme: ResolvedTheme;
  /** True while `useAppConfig` is loading the persisted value on first mount. */
  loading: boolean;
  /** Persist a new preference (writes through to localStorage cache too). */
  setTheme: (next: ThemeMode) => Promise<void>;
  /**
   * Quick light↔dark flip used by the Sidebar's ThemeToggle.
   * - `light` → `dark`
   * - `dark` → `light`
   * - `system` → opposite of the current `resolvedTheme` (escapes system mode
   *   so the user's intent ("I want it the other way") survives).
   */
  toggle: () => Promise<void>;
}

const LEGACY_STORAGE_KEY = 'ef.theme';
const SYSTEM_QUERY = '(prefers-color-scheme: dark)';
const DEFAULT_RESOLVED: ResolvedTheme = 'dark';

function isResolvedTheme(v: unknown): v is ResolvedTheme {
  return v === 'light' || v === 'dark';
}

function readBootstrapCache(): ResolvedTheme | null {
  try {
    if (typeof window === 'undefined') return null;
    const raw: unknown = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    return isResolvedTheme(raw) ? raw : null;
  } catch {
    return null;
  }
}

function writeBootstrapCache(resolved: ResolvedTheme): void {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(LEGACY_STORAGE_KEY, resolved);
  } catch {
    // localStorage may be unavailable in sandboxed / quota-exceeded envs.
  }
}

function applyDomTheme(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', resolved);
}

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return DEFAULT_RESOLVED === 'dark';
  }
  return window.matchMedia(SYSTEM_QUERY).matches;
}

function resolve(theme: ThemeMode): ResolvedTheme {
  if (theme === 'system') {
    return systemPrefersDark() ? 'dark' : 'light';
  }
  return theme;
}

export function useTheme(): UseThemeResult {
  const appConfig = useAppConfig();
  /**
   * Local `theme` state tracks the preference (mirrors app-config). We seed
   * it from the bootstrap cache so the FIRST render of the hook (before
   * app-config loads) returns a sensible value matching what the bootstrap
   * script already painted, rather than `'dark'` flashing through.
   */
  const [theme, setThemeState] = useState<ThemeMode>(() => {
    const cached = readBootstrapCache();
    return cached ?? 'dark';
  });
  /**
   * `'system'` resolution is recomputed on every matchMedia change. Kept
   * separate from `theme` so consumers can render based on the EFFECTIVE
   * value (resolvedTheme) without knowing about the preference layer.
   */
  const [systemPrefers, setSystemPrefers] = useState<ResolvedTheme>(() =>
    systemPrefersDark() ? 'dark' : 'light',
  );

  // Sync `theme` to app-config once it loads. This overrides the bootstrap
  // seed if the user has explicitly chosen something different (e.g. they
  // picked 'system' in Settings but the bootstrap painted 'dark' from
  // legacy localStorage).
  useEffect(() => {
    if (appConfig.loading) return;
    if (appConfig.config === null) return;
    const persisted = appConfig.config.theme;
    if (persisted !== theme) {
      setThemeState(persisted);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appConfig.loading, appConfig.config?.theme]);

  /**
   * One-time legacy migration: if app-config is at its default value
   * (`'dark'`) AND localStorage carries `'light'` from the pre-#GH-84
   * binary era, promote the localStorage value into app-config so the
   * user's prior preference survives the upgrade. After the first
   * `update({ theme: 'light' })` call, app-config no longer matches its
   * default — the condition becomes false and the migration won't
   * re-fire.
   */
  const migrationRanRef = useRef<boolean>(false);
  useEffect(() => {
    if (migrationRanRef.current) return;
    if (appConfig.loading || appConfig.config === null) return;
    const cached = readBootstrapCache();
    if (
      cached !== null &&
      appConfig.config.theme === 'dark' &&
      cached === 'light'
    ) {
      migrationRanRef.current = true;
      void appConfig.update({ theme: 'light' } satisfies Partial<AppConfig>);
    } else {
      migrationRanRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appConfig.loading, appConfig.config?.theme]);

  // matchMedia subscription — only active while preference is 'system'.
  // Updates `systemPrefers` so the resolved theme tracks OS changes.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    if (theme !== 'system') return;
    const mq = window.matchMedia(SYSTEM_QUERY);
    const onChange = (e: MediaQueryListEvent): void => {
      setSystemPrefers(e.matches ? 'dark' : 'light');
    };
    // Modern browsers expose `addEventListener`; older Safari only has the
    // legacy `addListener`. Use the modern path first, fall back.
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    mq.addListener(onChange);
    return () => mq.removeListener(onChange);
  }, [theme]);

  // Compute the resolved (effective) theme and push it to the DOM +
  // bootstrap cache on every change.
  const resolvedTheme: ResolvedTheme = useMemo(
    () => (theme === 'system' ? systemPrefers : theme),
    [theme, systemPrefers],
  );

  useEffect(() => {
    applyDomTheme(resolvedTheme);
    writeBootstrapCache(resolvedTheme);
  }, [resolvedTheme]);

  const setTheme = useCallback(
    async (next: ThemeMode): Promise<void> => {
      // Optimistic local update so the DOM reacts immediately, then persist.
      setThemeState(next);
      await appConfig.update({ theme: next });
    },
    [appConfig],
  );

  const toggle = useCallback(async (): Promise<void> => {
    // Use the LATEST resolvedTheme to decide the toggle direction even when
    // the preference is `'system'` — clicking the toggle in system mode
    // should land on "the other one of what I'm currently seeing".
    const target: ResolvedTheme = resolvedTheme === 'dark' ? 'light' : 'dark';
    await setTheme(target);
  }, [resolvedTheme, setTheme]);

  return {
    theme,
    resolvedTheme,
    loading: appConfig.loading,
    setTheme,
    toggle,
  };
}
