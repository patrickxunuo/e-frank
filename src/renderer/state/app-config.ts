/**
 * `useAppConfig()` — hook over `window.api.appConfig.{ get(), set() }` (#GH-69
 * Foundation). Mirrors `useConnections` exactly — tracks loading/error,
 * exposes a `refresh` for manual re-fetch and an `update(partial)` for
 * field-granular writes.
 *
 * `config` is `null` while loading (and on IPC failure). Consumers should
 * either gate UI behind `loading === false` or render placeholder content
 * until the first successful read.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppConfig } from '@shared/ipc';

const BRIDGE_UNAVAILABLE = 'IPC bridge unavailable';

export interface UseAppConfigResult {
  config: AppConfig | null;
  loading: boolean;
  error: string | null;
  /** Re-fetch the config from the main process. */
  refresh: () => Promise<void>;
  /** Shallow-merge a partial into the persisted config. Returns the post-merge config. */
  update: (partial: Partial<AppConfig>) => Promise<AppConfig | null>;
}

export function useAppConfig(): UseAppConfigResult {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef<boolean>(true);

  const refresh = useCallback(async (): Promise<void> => {
    if (typeof window === 'undefined' || !window.api) {
      if (mountedRef.current) {
        setLoading(false);
        setError(BRIDGE_UNAVAILABLE);
        setConfig(null);
      }
      return;
    }
    if (mountedRef.current) {
      setLoading(true);
      setError(null);
    }
    try {
      const result = await window.api.appConfig.get();
      if (!mountedRef.current) return;
      if (result.ok) {
        setConfig(result.data.config);
        setError(null);
      } else {
        setConfig(null);
        setError(result.error.message || result.error.code);
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setConfig(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  /**
   * Shallow-merge `partial` into the persisted config. Returns the post-
   * merge config on success, or `null` on failure (with `error` set).
   * Doesn't toggle `loading` — UI typically wants the existing config to
   * stay visible during a save.
   */
  const update = useCallback(
    async (partial: Partial<AppConfig>): Promise<AppConfig | null> => {
      if (typeof window === 'undefined' || !window.api) {
        if (mountedRef.current) setError(BRIDGE_UNAVAILABLE);
        return null;
      }
      try {
        const result = await window.api.appConfig.set({ partial });
        if (!mountedRef.current) return null;
        if (result.ok) {
          setConfig(result.data.config);
          setError(null);
          return result.data.config;
        }
        setError(result.error.message || result.error.code);
        return null;
      } catch (err) {
        if (!mountedRef.current) return null;
        setError(err instanceof Error ? err.message : String(err));
        return null;
      }
    },
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  return { config, loading, error, refresh, update };
}
