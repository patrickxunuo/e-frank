import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  IpcResult,
  Run,
  RunsListHistoryResponse,
} from '@shared/ipc';

/**
 * `useRunHistory(projectId)` — fetches the project's past runs via the
 * `runs:listHistory` IPC and exposes a single-page result. Mirrors the
 * read-only shape of `useProjectPulls` so the page-level Refresh button on
 * `ProjectDetail` can dispatch to Runs the same way it does for Tickets and
 * Pull Requests (#GH-77).
 *
 * The hook is meant to be called at the **ProjectDetail level** (alongside
 * `useTicketPages` and `useProjectPulls`), NOT inside the Runs-tab body.
 * Keeping it at the parent means switching tabs doesn't unmount the hook and
 * force a fresh fetch — only the Refresh button does.
 *
 * `removeRun(runId)` is the optimistic-update entry point the per-row delete
 * handler in `ProjectDetail` calls after a successful `runs:delete` IPC, so
 * the dropped row disappears without a full re-fetch.
 */
export interface UseRunHistoryResult {
  runs: Run[];
  /** True only on the first fetch for this projectId — drives the table skeleton. */
  loading: boolean;
  /** True after a manual refresh kicks off (post-mount); falsey on initial load. */
  refreshing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  removeRun: (runId: string) => void;
}

const BRIDGE_UNAVAILABLE = 'IPC bridge unavailable';
const HISTORY_LIMIT = 50;

export function useRunHistory(projectId: string): UseRunHistoryResult {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const cancelledRef = useRef<boolean>(false);

  const fetchOnce = useCallback(async (): Promise<IpcResult<RunsListHistoryResponse> | null> => {
    if (typeof window === 'undefined' || !window.api) {
      return null;
    }
    try {
      const res = await window.api.runs.listHistory({
        projectId,
        limit: HISTORY_LIMIT,
      });
      if (res === undefined || res === null) {
        return { ok: false, error: { code: 'NO_RESPONSE', message: 'no response from bridge' } };
      }
      return res;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: { code: 'EXCEPTION', message } };
    }
  }, [projectId]);

  const refresh = useCallback(async (): Promise<void> => {
    if (typeof window === 'undefined' || !window.api) {
      setError(BRIDGE_UNAVAILABLE);
      return;
    }
    setRefreshing(true);
    setError(null);
    const res = await fetchOnce();
    if (cancelledRef.current) return;
    if (res === null) {
      setError(BRIDGE_UNAVAILABLE);
      setRefreshing(false);
      return;
    }
    if (!res.ok) {
      setError(res.error.message || res.error.code);
      setRefreshing(false);
      return;
    }
    setRuns(res.data.runs);
    setRefreshing(false);
  }, [fetchOnce]);

  const removeRun = useCallback((runId: string): void => {
    setRuns((prev) => prev.filter((r) => r.id !== runId));
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    setLoading(true);
    setError(null);
    setRuns([]);

    if (typeof window === 'undefined' || !window.api) {
      setLoading(false);
      setError(BRIDGE_UNAVAILABLE);
      return () => {
        cancelledRef.current = true;
      };
    }

    void (async () => {
      const res = await fetchOnce();
      if (cancelledRef.current) return;
      if (res === null) {
        setError(BRIDGE_UNAVAILABLE);
        setLoading(false);
        return;
      }
      if (!res.ok) {
        setError(res.error.message || res.error.code);
        setLoading(false);
        return;
      }
      setRuns(res.data.runs);
      setLoading(false);
    })();

    return () => {
      cancelledRef.current = true;
    };
  }, [projectId, fetchOnce]);

  return { runs, loading, refreshing, error, refresh, removeRun };
}
