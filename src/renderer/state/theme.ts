/**
 * Theme state.
 *
 * Hard-defaults to dark. Persists in localStorage under `ef.theme`.
 * The DOM attribute `<html data-theme="...">` drives the token scope.
 *
 * The renderer's index.html sets `data-theme="dark"` at parse time, plus a
 * tiny inline script that reads localStorage to override before paint, so
 * useTheme's effect is in charge of *changes* and authoritative writes —
 * the first paint is always handled by the bootstrap script.
 */
import { useCallback, useEffect, useState } from 'react';

export type ThemePreference = 'light' | 'dark';

export interface UseThemeResult {
  theme: ThemePreference;
  setTheme: (next: ThemePreference) => void;
  toggle: () => void;
}

const STORAGE_KEY = 'ef.theme';
const DEFAULT_THEME: ThemePreference = 'dark';

function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark';
}

/**
 * Read a stored preference. Returns `null` if unavailable, missing, or
 * invalid. Wrapped in try/catch so sandboxed/quota-exceeded environments
 * don't crash the app.
 */
function readStoredTheme(): ThemePreference | null {
  try {
    if (typeof window === 'undefined') return null;
    const raw: unknown = window.localStorage.getItem(STORAGE_KEY);
    return isThemePreference(raw) ? raw : null;
  } catch {
    return null;
  }
}

function writeStoredTheme(theme: ThemePreference): void {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // No-op: localStorage may be unavailable in private/sandboxed envs.
  }
}

function applyDomTheme(theme: ThemePreference): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', theme);
}

export function useTheme(): UseThemeResult {
  // Lazy initializer: read storage once on first render.
  const [theme, setThemeState] = useState<ThemePreference>(() => {
    return readStoredTheme() ?? DEFAULT_THEME;
  });

  // Sync DOM + storage on every change. Note: this also runs on first
  // render to authoritatively claim the attribute even if the bootstrap
  // script wrote a different value.
  useEffect(() => {
    applyDomTheme(theme);
    writeStoredTheme(theme);
  }, [theme]);

  const setTheme = useCallback((next: ThemePreference): void => {
    setThemeState(next);
  }, []);

  const toggle = useCallback((): void => {
    setThemeState((prev) => (prev === 'dark' ? 'light' : 'dark'));
  }, []);

  return { theme, setTheme, toggle };
}
