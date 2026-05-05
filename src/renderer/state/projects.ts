import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectInstanceDto } from '@shared/ipc';

export interface UseProjectsResult {
  projects: ProjectInstanceDto[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const BRIDGE_UNAVAILABLE = 'IPC bridge unavailable';

/**
 * Hook over `window.api.projects.list()`. Tracks loading/error state and
 * exposes `refresh` so screens can re-fetch after mutations.
 *
 * If `window.api` is missing (non-Electron context), the hook resolves to
 * `error: 'IPC bridge unavailable'` rather than throwing — keeps the renderer
 * functional in tests / misconfigured builds.
 */
export function useProjects(): UseProjectsResult {
  const [projects, setProjects] = useState<ProjectInstanceDto[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef<boolean>(true);

  const refresh = useCallback(async (): Promise<void> => {
    if (typeof window === 'undefined' || !window.api) {
      if (mountedRef.current) {
        setLoading(false);
        setError(BRIDGE_UNAVAILABLE);
        setProjects([]);
      }
      return;
    }

    if (mountedRef.current) {
      setLoading(true);
      setError(null);
    }

    try {
      const result = await window.api.projects.list();
      if (!mountedRef.current) return;
      if (result.ok) {
        setProjects(result.data);
        setError(null);
      } else {
        setProjects([]);
        setError(result.error.message || result.error.code || 'Failed to load projects');
      }
    } catch (err) {
      if (!mountedRef.current) return;
      const message = err instanceof Error ? err.message : String(err);
      setProjects([]);
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

  return { projects, loading, error, refresh };
}
