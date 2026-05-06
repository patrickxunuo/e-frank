/**
 * Per-connection resource hooks: the AddProject view uses these to populate
 * the repo picker and the Jira-project picker.
 *
 * Behavior:
 *  - When `connectionId === null`, the hook stays idle (no IPC call).
 *  - When a non-null `connectionId` lands, the hook hits the IPC channel
 *    once and caches the result. Subsequent renders / new hook instances
 *    with the same id render from the cache without re-fetching.
 *  - `refresh()` invalidates the cached entry and re-fetches.
 *
 * The cache is module-level (per JS realm) so it survives unmounts within
 * the same renderer session but resets when the renderer reloads. Memory
 * footprint is small (an array of `{ slug, defaultBranch, private }` or
 * `{ key, name }` per connection); we don't bother with an eviction policy.
 *
 * `window.api === undefined` is treated as a soft failure — `loading` flips
 * to `false` and `error` is set to the bridge-unavailable message.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface RepoSummary {
  slug: string;
  defaultBranch: string;
  private: boolean;
}

export interface JiraProjectSummary {
  key: string;
  name: string;
}

export interface UseConnectionResourceState<T> {
  data: ReadonlyArray<T>;
  loading: boolean;
  error: string | null;
  /** Re-fetches; clears the cached entry first. */
  refresh: () => Promise<void>;
}

const BRIDGE_UNAVAILABLE = 'IPC bridge unavailable';

// Per-session caches keyed by connection id. Module-level so all hook
// instances share them.
const repoCache = new Map<string, ReadonlyArray<RepoSummary>>();
const jiraProjectCache = new Map<string, ReadonlyArray<JiraProjectSummary>>();

interface FetchCtx<T> {
  cache: Map<string, ReadonlyArray<T>>;
  fetcher: (
    connectionId: string,
  ) => Promise<{ ok: true; data: ReadonlyArray<T> } | { ok: false; message: string }>;
}

function repoFetchCtx(): FetchCtx<RepoSummary> {
  return {
    cache: repoCache,
    fetcher: async (connectionId) => {
      if (typeof window === 'undefined' || !window.api) {
        return { ok: false, message: BRIDGE_UNAVAILABLE };
      }
      try {
        const result = await window.api.connections.listRepos({ connectionId });
        if (result.ok) {
          return { ok: true, data: result.data.repos };
        }
        return {
          ok: false,
          message: result.error.message || result.error.code || 'Failed to list repositories',
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, message };
      }
    },
  };
}

function jiraProjectFetchCtx(): FetchCtx<JiraProjectSummary> {
  return {
    cache: jiraProjectCache,
    fetcher: async (connectionId) => {
      if (typeof window === 'undefined' || !window.api) {
        return { ok: false, message: BRIDGE_UNAVAILABLE };
      }
      try {
        const result = await window.api.connections.listJiraProjects({ connectionId });
        if (result.ok) {
          return { ok: true, data: result.data.projects };
        }
        return {
          ok: false,
          message: result.error.message || result.error.code || 'Failed to list Jira projects',
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, message };
      }
    },
  };
}

/**
 * Generic hook implementation shared by `useConnectionRepos` /
 * `useConnectionJiraProjects`. The two public hooks differ only in which
 * cache + IPC channel they read from.
 */
function useConnectionResource<T>(
  connectionId: string | null,
  ctx: FetchCtx<T>,
): UseConnectionResourceState<T> {
  const [data, setData] = useState<ReadonlyArray<T>>(() =>
    connectionId !== null ? ctx.cache.get(connectionId) ?? [] : [],
  );
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // Capture the latest connectionId in a ref so `refresh` can re-read it
  // without becoming stale across renders.
  const connectionIdRef = useRef<string | null>(connectionId);
  connectionIdRef.current = connectionId;

  const runFetch = useCallback(
    async (id: string, signal: { cancelled: boolean }): Promise<void> => {
      setLoading(true);
      setError(null);
      const res = await ctx.fetcher(id);
      if (signal.cancelled) return;
      if (res.ok) {
        ctx.cache.set(id, res.data);
        setData(res.data);
        setError(null);
      } else {
        setData([]);
        setError(res.message);
      }
      setLoading(false);
    },
    [ctx],
  );

  // Effect: when `connectionId` flips to non-null, populate from the cache
  // (synchronously) or fetch (when no entry exists). Per-effect `cancelled`
  // closure flag swallows late results after a teardown / id change.
  useEffect(() => {
    if (connectionId === null) {
      setData([]);
      setLoading(false);
      setError(null);
      return;
    }
    const cached = ctx.cache.get(connectionId);
    if (cached !== undefined) {
      setData(cached);
      setLoading(false);
      setError(null);
      return;
    }
    const signal = { cancelled: false };
    void runFetch(connectionId, signal);
    return () => {
      signal.cancelled = true;
    };
  }, [connectionId, ctx, runFetch]);

  const refresh = useCallback(async (): Promise<void> => {
    const id = connectionIdRef.current;
    if (id === null) return;
    ctx.cache.delete(id);
    const signal = { cancelled: false };
    await runFetch(id, signal);
  }, [ctx, runFetch]);

  return { data, loading, error, refresh };
}

export function useConnectionRepos(
  connectionId: string | null,
): UseConnectionResourceState<RepoSummary> {
  // Build the ctx once per hook instance — `useConnectionResource` depends
  // on it identity-wise, so we keep it stable via useRef.
  const ctxRef = useRef<FetchCtx<RepoSummary>>();
  if (!ctxRef.current) {
    ctxRef.current = repoFetchCtx();
  }
  return useConnectionResource(connectionId, ctxRef.current);
}

export function useConnectionJiraProjects(
  connectionId: string | null,
): UseConnectionResourceState<JiraProjectSummary> {
  const ctxRef = useRef<FetchCtx<JiraProjectSummary>>();
  if (!ctxRef.current) {
    ctxRef.current = jiraProjectFetchCtx();
  }
  return useConnectionResource(connectionId, ctxRef.current);
}

/** Test-only: clear the per-session caches between vitest cases. */
export function __resetConnectionResourceCaches(): void {
  repoCache.clear();
  jiraProjectCache.clear();
}
