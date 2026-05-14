/**
 * Two hooks subscribing to the workflow runner's run-state stream,
 * project-agnostic.
 *
 *   - `useGlobalActiveRun()` — legacy singular shape. Returns the
 *     most-recently-changed run (or null). Kept for back-compat with
 *     callers that only care whether *something* is running (#GH-79
 *     dropped the runner's app-wide single-active lock, but legacy
 *     subscribers still get a coherent "most recent" view).
 *   - `useGlobalActiveRuns()` — plural counterpart (#GH-79). Returns
 *     every in-flight run as a Run[]. Empty array = idle.
 *
 * Project-SCOPED consumers (the active panel on ProjectDetail) use the
 * sibling `useActiveRun(projectId)` / `useActiveRuns(projectId)` hooks
 * instead — they want the filter applied at the hook level so
 * subscribers don't re-render for unrelated projects' transitions.
 */

import { useEffect, useState } from 'react';
import type { Run } from '@shared/ipc';

export function useGlobalActiveRun(): Run | null {
  const [run, setRun] = useState<Run | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (typeof window === 'undefined' || !window.api) {
      setRun(null);
      return () => {
        cancelled = true;
      };
    }
    const api = window.api;
    void (async () => {
      try {
        const result = await api.runs.current();
        if (cancelled) return;
        if (result.ok) {
          setRun(result.data.run);
        }
      } catch {
        if (cancelled) return;
      }
    })();
    const off = api.runs.onCurrentChanged((event) => {
      if (cancelled) return;
      setRun(event.run);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return run;
}

/**
 * Plural counterpart to `useGlobalActiveRun` (#GH-79). Subscribes to
 * `runs:list-changed` events and returns every in-flight run. Seeds via
 * `runs:list-active` on mount so the first render is accurate even
 * without an event firing.
 *
 * Default to empty array (not null) so callers can do `.map(...)` /
 * `.length` without null guards.
 */
export function useGlobalActiveRuns(): Run[] {
  const [runs, setRuns] = useState<Run[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (typeof window === 'undefined' || !window.api) {
      setRuns([]);
      return () => {
        cancelled = true;
      };
    }
    const api = window.api;
    void (async () => {
      try {
        const result = await api.runs.listActive();
        if (cancelled) return;
        if (result.ok) {
          setRuns(result.data.runs);
        }
      } catch {
        if (cancelled) return;
      }
    })();
    const off = api.runs.onListChanged((event) => {
      if (cancelled) return;
      setRuns(event.runs);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return runs;
}
