import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  IpcResult,
  TicketDto,
  TicketsListResponse,
  TicketsSortBy,
  TicketsSortDir,
} from '@shared/ipc';

export interface TicketPagesQuery {
  sortBy: TicketsSortBy | undefined;
  sortDir: TicketsSortDir | undefined;
  search: string | undefined;
}

export interface UseTicketPagesResult {
  rows: TicketDto[];
  /** True only on the first page fetch for a fresh query — drives the table skeleton. */
  loading: boolean;
  /** True while a load-more request is in flight. */
  loadingMore: boolean;
  /** True after a manual refresh kicks off (post-mount); falsey on initial load. */
  refreshing: boolean;
  /** Undefined when no fetch has resolved yet OR when `nextCursor` was undefined on the last page. */
  hasMore: boolean;
  error: string | null;
  /**
   * Fetch the next page using the current query. No-op when `loadingMore` is
   * already true or when there are no more pages.
   */
  loadMore: () => Promise<void>;
  /**
   * Restart pagination from cursor=undefined under the same query — used by
   * the "Refresh" button. Existing rows clear immediately so the user sees
   * the table reset.
   */
  refresh: () => Promise<void>;
}

const PAGE_SIZE = 20;
const BRIDGE_UNAVAILABLE = 'IPC bridge unavailable';

/**
 * Server-paginated ticket reads, replacing the cache-backed `useTickets`.
 *
 * Lifecycle:
 *   - Mount or query change → reset state, fetch first page.
 *   - `loadMore()` → fetch next page using `nextCursor` from the previous response.
 *   - `refresh()` → reset state, fetch first page (under the same query).
 *
 * Per-effect `cancelled` flag pattern (matches `useTickets`/`useActiveRun`):
 * when the query changes mid-flight, the in-flight request's setState calls
 * are ignored so a stale page can't land on top of a fresh query.
 *
 * `hasMore` is `true` until a page returns without a `nextCursor`. Initial
 * value is `false` so the renderer doesn't trigger an infinite-scroll
 * sentinel before the first response lands.
 */
export function useTicketPages(
  projectId: string,
  query: TicketPagesQuery,
): UseTicketPagesResult {
  const [rows, setRows] = useState<TicketDto[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Latest cursor + cancellation flag, kept in refs so `loadMore`/`refresh`
   * can read the live values without re-binding callbacks on every render.
   * The cancellation ref flips on unmount and on every query change so
   * stale fetches can't apply state updates after a newer query started.
   */
  const cursorRef = useRef<string | undefined>(undefined);
  const cancelledRef = useRef<boolean>(false);
  const queryRef = useRef<TicketPagesQuery>(query);
  queryRef.current = query;

  const buildRequest = useCallback(
    (cursor: string | undefined): Parameters<NonNullable<typeof window.api>['tickets']['list']>[0] => {
      const q = queryRef.current;
      const req: Parameters<NonNullable<typeof window.api>['tickets']['list']>[0] = {
        projectId,
        limit: PAGE_SIZE,
      };
      if (cursor !== undefined) req.cursor = cursor;
      if (q.sortBy !== undefined) req.sortBy = q.sortBy;
      if (q.sortDir !== undefined) req.sortDir = q.sortDir;
      if (q.search !== undefined && q.search.trim() !== '') {
        req.search = q.search.trim();
      }
      return req;
    },
    [projectId],
  );

  const fetchPage = useCallback(
    async (
      cursor: string | undefined,
    ): Promise<IpcResult<TicketsListResponse> | null> => {
      if (typeof window === 'undefined' || !window.api) {
        return null;
      }
      try {
        const res = await window.api.tickets.list(buildRequest(cursor));
        // Some test stubs return `undefined` from a bare `vi.fn()`; surface
        // that as a soft failure rather than crashing the renderer when the
        // hook tries to read `res.ok`.
        if (res === undefined || res === null) {
          return { ok: false, error: { code: 'NO_RESPONSE', message: 'no response from bridge' } };
        }
        return res;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: { code: 'EXCEPTION', message } };
      }
    },
    [buildRequest],
  );

  const loadMore = useCallback(async (): Promise<void> => {
    if (cancelledRef.current) return;
    if (loadingMore) return;
    if (!hasMore) return;
    const cursor = cursorRef.current;
    if (cursor === undefined) return; // first page hasn't landed yet
    setLoadingMore(true);
    const res = await fetchPage(cursor);
    if (cancelledRef.current) return;
    if (res === null) {
      setError(BRIDGE_UNAVAILABLE);
      setLoadingMore(false);
      return;
    }
    if (!res.ok) {
      setError(res.error.message || res.error.code);
      setLoadingMore(false);
      return;
    }
    setRows((prev) => [...prev, ...res.data.rows]);
    cursorRef.current = res.data.nextCursor;
    setHasMore(res.data.nextCursor !== undefined);
    setError(null);
    setLoadingMore(false);
  }, [fetchPage, hasMore, loadingMore]);

  const refresh = useCallback(async (): Promise<void> => {
    if (typeof window === 'undefined' || !window.api) {
      setError(BRIDGE_UNAVAILABLE);
      return;
    }
    setRefreshing(true);
    setError(null);
    setRows([]);
    cursorRef.current = undefined;
    setHasMore(false);
    const res = await fetchPage(undefined);
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
    setRows(res.data.rows);
    cursorRef.current = res.data.nextCursor;
    setHasMore(res.data.nextCursor !== undefined);
    setRefreshing(false);
  }, [fetchPage]);

  useEffect(() => {
    cancelledRef.current = false;
    cursorRef.current = undefined;
    setLoading(true);
    setError(null);
    setRows([]);
    setHasMore(false);

    if (typeof window === 'undefined' || !window.api) {
      setLoading(false);
      setError(BRIDGE_UNAVAILABLE);
      return () => {
        cancelledRef.current = true;
      };
    }

    void (async () => {
      const res = await fetchPage(undefined);
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
      setRows(res.data.rows);
      cursorRef.current = res.data.nextCursor;
      setHasMore(res.data.nextCursor !== undefined);
      setLoading(false);
    })();

    return () => {
      cancelledRef.current = true;
    };
    // Re-run when the projectId or query changes. We intentionally read
    // `query` via the ref inside callbacks but DEPEND on the discrete
    // fields here so a new query restarts the page chain.
  }, [projectId, query.sortBy, query.sortDir, query.search, fetchPage]);

  return { rows, loading, loadingMore, refreshing, hasMore, error, loadMore, refresh };
}
