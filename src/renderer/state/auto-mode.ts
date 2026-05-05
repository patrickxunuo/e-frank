import { useCallback, useEffect, useState } from 'react';

const GLOBAL_KEY = 'auto-mode';

function storageKeyFor(projectId?: string): string {
  return projectId ? `${GLOBAL_KEY}:${projectId}` : GLOBAL_KEY;
}

function readInitial(key: string): boolean {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return false;
  }
  try {
    return window.localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

/**
 * UI-only persisted preference. Backed by `localStorage` so the value
 * survives reloads.
 *
 * - `useAutoMode()` — global default (key `auto-mode`). Preserved for
 *   backward compatibility even though no current caller relies on it.
 * - `useAutoMode(projectId)` — per-project key `auto-mode:${projectId}`.
 *
 * The hook re-reads storage when `projectId` changes so that switching
 * detail views surfaces the right toggle position on mount.
 */
export function useAutoMode(projectId?: string): readonly [boolean, (next: boolean) => void] {
  const key = storageKeyFor(projectId);
  const [autoMode, setAutoModeState] = useState<boolean>(() => readInitial(key));

  // Re-sync state when the key changes (e.g. switching project detail).
  useEffect(() => {
    setAutoModeState(readInitial(key));
  }, [key]);

  const setAutoMode = useCallback(
    (next: boolean): void => {
      setAutoModeState(next);
      if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
        return;
      }
      try {
        window.localStorage.setItem(key, next ? 'true' : 'false');
      } catch {
        // Swallow — quota or disabled storage shouldn't break the toggle.
      }
    },
    [key],
  );

  return [autoMode, setAutoMode] as const;
}
