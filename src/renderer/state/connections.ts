import { useCallback, useEffect, useRef, useState } from 'react';
import type { Connection } from '@shared/ipc';

export interface UseConnectionsResult {
  connections: Connection[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const BRIDGE_UNAVAILABLE = 'IPC bridge unavailable';

/**
 * Hook over `window.api.connections.list()`. Mirrors `useProjects` exactly
 * — tracks loading/error state and exposes `refresh` so screens can
 * re-fetch after mutations.
 *
 * If `window.api` is missing (non-Electron context), the hook resolves to
 * `error: 'IPC bridge unavailable'` rather than throwing — keeps the
 * renderer functional in tests / misconfigured builds.
 */
export function useConnections(): UseConnectionsResult {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef<boolean>(true);

  const refresh = useCallback(async (): Promise<void> => {
    if (typeof window === 'undefined' || !window.api) {
      if (mountedRef.current) {
        setLoading(false);
        setError(BRIDGE_UNAVAILABLE);
        setConnections([]);
      }
      return;
    }

    if (mountedRef.current) {
      setLoading(true);
      setError(null);
    }

    try {
      const result = await window.api.connections.list();
      if (!mountedRef.current) return;
      if (result.ok) {
        setConnections(result.data);
        setError(null);
      } else {
        setConnections([]);
        setError(result.error.message || result.error.code || 'Failed to load connections');
      }
    } catch (err) {
      if (!mountedRef.current) return;
      const message = err instanceof Error ? err.message : String(err);
      setConnections([]);
      setError(message);
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  return { connections, loading, error, refresh };
}
