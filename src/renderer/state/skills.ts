import { useCallback, useEffect, useRef, useState } from 'react';
import type { SkillSummary } from '@shared/ipc';

export interface RemoveSkillResult {
  ok: boolean;
  error?: string;
}

export interface UseSkillsResult {
  skills: SkillSummary[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /**
   * Removes a skill via `npx skills remove <ref>` and refreshes the list
   * on success. Returns `{ ok: false, error }` on any failure path
   * (IPC unavailable, invalid ref, npm error) so the UI can surface it.
   */
  remove: (ref: string) => Promise<RemoveSkillResult>;
}

const BRIDGE_UNAVAILABLE = 'IPC bridge unavailable';

/**
 * Hook over `window.api.skills.list()`. Mirrors `useConnections` — tracks
 * loading/error state and exposes `refresh` so the Skills page can re-fetch
 * after installs.
 *
 * If `window.api` is missing (non-Electron context / misconfigured build),
 * resolves to `error: 'IPC bridge unavailable'` rather than throwing.
 */
export function useSkills(): UseSkillsResult {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef<boolean>(true);

  const refresh = useCallback(async (): Promise<void> => {
    if (typeof window === 'undefined' || !window.api) {
      if (mountedRef.current) {
        setLoading(false);
        setError(BRIDGE_UNAVAILABLE);
        setSkills([]);
      }
      return;
    }

    if (mountedRef.current) {
      setLoading(true);
      setError(null);
    }

    try {
      const result = await window.api.skills.list();
      if (!mountedRef.current) return;
      if (result.ok) {
        setSkills(result.data.skills);
        setError(null);
      } else {
        setSkills([]);
        setError(result.error.message || result.error.code || 'Failed to load skills');
      }
    } catch (err) {
      if (!mountedRef.current) return;
      const message = err instanceof Error ? err.message : String(err);
      setSkills([]);
      setError(message);
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  const remove = useCallback(
    async (ref: string): Promise<RemoveSkillResult> => {
      if (typeof window === 'undefined' || !window.api) {
        return { ok: false, error: BRIDGE_UNAVAILABLE };
      }
      try {
        const result = await window.api.skills.remove({ ref });
        if (!result.ok) {
          return {
            ok: false,
            error: result.error.message || result.error.code || 'Remove failed',
          };
        }
        if (result.data.status === 'failed') {
          const tail = result.data.stderr.trim() || result.data.stdout.trim() || 'remove failed';
          return { ok: false, error: tail };
        }
        // Success — refresh the list so the row disappears.
        await refresh();
        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message };
      }
    },
    [refresh],
  );

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  return { skills, loading, error, refresh, remove };
}
