/**
 * `useAppInfo()` — one-shot fetch of the diagnostic snapshot for the
 * Settings About section (#GH-87). Read-only; the hook never refetches
 * after mount because none of the values change at runtime.
 *
 * On a missing IPC bridge (dev / test envs), the hook degrades to a
 * locally-resolvable fallback so the About section still renders
 * something sensible — appVersion + buildCommit come from the build-time
 * defines, runtime versions surface as `'unknown'`.
 */

import { useEffect, useState } from 'react';
import type { AppInfoResponse } from '@shared/ipc';

export interface UseAppInfoResult {
  info: AppInfoResponse | null;
  loading: boolean;
  error: string | null;
}

const BRIDGE_UNAVAILABLE = 'IPC bridge unavailable';

/** Build-time fallback when window.api isn't available. Renderer-only. */
function localFallback(): AppInfoResponse {
  return {
    appVersion: __APP_VERSION__,
    buildCommit: __BUILD_COMMIT__,
    platform: 'unknown',
    release: 'unknown',
    electronVersion: 'unknown',
    nodeVersion: 'unknown',
    chromeVersion: 'unknown',
  };
}

export function useAppInfo(): UseAppInfoResult {
  // Detect a missing bridge synchronously during render so the first
  // paint already shows the fallback values instead of flashing the
  // "Loading diagnostics…" hint for one tick before useEffect settles.
  const bridgeMissing = typeof window === 'undefined' || !window.api;
  const [info, setInfo] = useState<AppInfoResponse | null>(
    bridgeMissing ? localFallback() : null,
  );
  const [loading, setLoading] = useState<boolean>(!bridgeMissing);
  const [error, setError] = useState<string | null>(
    bridgeMissing ? BRIDGE_UNAVAILABLE : null,
  );

  useEffect(() => {
    let cancelled = false;
    if (typeof window === 'undefined' || !window.api) {
      return () => {
        cancelled = true;
      };
    }
    const api = window.api;
    void (async () => {
      try {
        const result = await api.app.info();
        if (cancelled) return;
        if (result.ok) {
          setInfo(result.data);
          setError(null);
        } else {
          setInfo(localFallback());
          setError(result.error.message || result.error.code);
        }
      } catch (err) {
        if (cancelled) return;
        setInfo(localFallback());
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { info, loading, error };
}
