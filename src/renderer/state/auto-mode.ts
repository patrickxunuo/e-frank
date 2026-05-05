import { useCallback, useState } from 'react';

const STORAGE_KEY = 'auto-mode';

function readInitial(): boolean {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return false;
  }
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * UI-only persisted preference. Backed by `localStorage` so the value
 * survives reloads. The actual poller hook-up is in #6.
 */
export function useAutoMode(): readonly [boolean, (next: boolean) => void] {
  const [autoMode, setAutoModeState] = useState<boolean>(() => readInitial());

  const setAutoMode = useCallback((next: boolean): void => {
    setAutoModeState(next);
    if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
      return;
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? 'true' : 'false');
    } catch {
      // Swallow — quota or disabled storage shouldn't break the toggle.
    }
  }, []);

  return [autoMode, setAutoMode] as const;
}
