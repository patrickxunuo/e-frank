import { useCallback, useEffect, useRef, useState } from 'react';
import type { TicketDto } from '@shared/ipc';

export interface UseTicketsResult {
  tickets: TicketDto[];
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const BRIDGE_UNAVAILABLE = 'IPC bridge unavailable';

/**
 * Subscribes to the Jira poller for a single project.
 *
 *   - On mount: seed via `jira.list({ projectId })` (cached eligible tickets)
 *   - Subscribe to `onTicketsChanged` + `onError`, filtered by projectId
 *   - `refresh()` calls `jira.refresh({ projectId })` and toggles `refreshing`
 *   - Unsubscribes on unmount
 *
 * If `window.api` isn't bridged in (non-Electron context), resolves to an
 * empty list with `error: 'IPC bridge unavailable'` rather than throwing —
 * the renderer stays usable in tests / misconfigured builds.
 */
export function useTickets(projectId: string): UseTicketsResult {
  const [tickets, setTickets] = useState<TicketDto[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef<boolean>(true);

  const refresh = useCallback(async (): Promise<void> => {
    if (typeof window === 'undefined' || !window.api) {
      if (mountedRef.current) {
        setRefreshing(false);
        setError(BRIDGE_UNAVAILABLE);
      }
      return;
    }
    if (mountedRef.current) {
      setRefreshing(true);
      setError(null);
    }
    try {
      const result = await window.api.jira.refresh({ projectId });
      if (!mountedRef.current) return;
      if (result.ok) {
        setTickets(result.data.tickets);
      } else {
        setError(result.error.message || result.error.code || 'Failed to refresh tickets');
      }
    } catch (err) {
      if (!mountedRef.current) return;
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      if (mountedRef.current) {
        setRefreshing(false);
      }
    }
  }, [projectId]);

  useEffect(() => {
    // Per-effect cancellation flag. Using a closure rather than the shared
    // `mountedRef` so an in-flight `jira.list` from a stale projectId can't
    // setState on the current render: when projectId changes, this effect's
    // cleanup flips `cancelled = true` and the next effect starts with its
    // own fresh `cancelled = false`.
    let cancelled = false;
    mountedRef.current = true;

    if (typeof window === 'undefined' || !window.api) {
      setLoading(false);
      setTickets([]);
      setError(BRIDGE_UNAVAILABLE);
      return () => {
        cancelled = true;
        mountedRef.current = false;
      };
    }

    const api = window.api;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const result = await api.jira.list({ projectId });
        if (cancelled) return;
        if (result.ok) {
          setTickets(result.data.tickets);
          setError(null);
        } else {
          setTickets([]);
          setError(result.error.message || result.error.code || 'Failed to load tickets');
        }
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setTickets([]);
        setError(message);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    const offTickets = api.jira.onTicketsChanged((event) => {
      if (cancelled) return;
      if (event.projectId !== projectId) return;
      setTickets(event.tickets);
      setError(null);
    });
    const offError = api.jira.onError((event) => {
      if (cancelled) return;
      if (event.projectId !== projectId) return;
      setError(event.message || event.code);
    });

    return () => {
      cancelled = true;
      mountedRef.current = false;
      offTickets();
      offError();
    };
  }, [projectId]);

  return { tickets, loading, refreshing, error, refresh };
}
