import { useCallback, useEffect, useRef, useState } from 'react';
import type { IpcResult, PullDto, PullsListResponse } from '@shared/ipc';

/**
 * `useProjectPulls(projectId)` — fetches the project's PRs from the
 * `pulls:list` IPC and exposes a single-page result. Mirrors the read-only
 * shape of `useTicketPages` minus the cursor/loadMore plumbing because
 * #GH-67 caps the v1 list at 50 most-recently-updated PRs.
 *
 * The hook is meant to be called at the **ProjectDetail level** (alongside
 * `useTicketPages`), NOT inside the per-tab body. That way switching tabs
 * doesn't unmount the hook and force a refetch — the issue requires that
 * `tab switches don't refetch unless the user hits Refresh`.
 *
 * `errorCode` is exposed alongside `error` so the renderer can branch the
 * banner UX on AUTH (Reconnect button) vs RATE_LIMITED (no action — just
 * wait + show reset time).
 */
export interface UseProjectPullsResult {
  rows: PullDto[];
  /** True only on the first fetch for this projectId — drives the table skeleton. */
  loading: boolean;
  /** True after a manual refresh kicks off (post-mount); falsey on initial load. */
  refreshing: boolean;
  error: string | null;
  /** Discriminates AUTH / RATE_LIMITED / NOT_FOUND / etc. when `error !== null`. */
  errorCode: string | null;
  refresh: () => Promise<void>;
}

const BRIDGE_UNAVAILABLE = 'IPC bridge unavailable';

export function useProjectPulls(projectId: string): UseProjectPullsResult {
  const [rows, setRows] = useState<PullDto[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  /** Per-effect cancellation; flips on unmount and on every projectId change. */
  const cancelledRef = useRef<boolean>(false);

  const fetchOnce = useCallback(async (): Promise<IpcResult<PullsListResponse> | null> => {
    if (typeof window === 'undefined' || !window.api) {
      return null;
    }
    try {
      const res = await window.api.pulls.list({ projectId });
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
      setErrorCode('NO_BRIDGE');
      return;
    }
    setRefreshing(true);
    setError(null);
    setErrorCode(null);
    const res = await fetchOnce();
    if (cancelledRef.current) return;
    if (res === null) {
      setError(BRIDGE_UNAVAILABLE);
      setErrorCode('NO_BRIDGE');
      setRefreshing(false);
      return;
    }
    if (!res.ok) {
      setError(res.error.message || res.error.code);
      setErrorCode(res.error.code);
      setRefreshing(false);
      return;
    }
    setRows(res.data.rows);
    setRefreshing(false);
  }, [fetchOnce]);

  useEffect(() => {
    cancelledRef.current = false;
    setLoading(true);
    setError(null);
    setErrorCode(null);
    setRows([]);

    if (typeof window === 'undefined' || !window.api) {
      setLoading(false);
      setError(BRIDGE_UNAVAILABLE);
      setErrorCode('NO_BRIDGE');
      return () => {
        cancelledRef.current = true;
      };
    }

    void (async () => {
      const res = await fetchOnce();
      if (cancelledRef.current) return;
      if (res === null) {
        setError(BRIDGE_UNAVAILABLE);
        setErrorCode('NO_BRIDGE');
        setLoading(false);
        return;
      }
      if (!res.ok) {
        setError(res.error.message || res.error.code);
        setErrorCode(res.error.code);
        setLoading(false);
        return;
      }
      setRows(res.data.rows);
      setLoading(false);
    })();

    return () => {
      cancelledRef.current = true;
    };
  }, [projectId, fetchOnce]);

  return { rows, loading, refreshing, error, errorCode, refresh };
}
