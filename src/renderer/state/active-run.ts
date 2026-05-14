/**
 * Two hooks subscribing to the workflow runner's run-state stream,
 * filtered to a specific projectId.
 *
 *   - `useActiveRun(projectId)` — legacy singular shape. Returns the
 *     most-recently-changed run that targets `projectId` (or null).
 *     Kept for back-compat with the existing single-active-run UI.
 *   - `useActiveRuns(projectId)` — plural counterpart (#GH-79). Returns
 *     every in-flight run targeting `projectId` as a Run[].
 *
 * Both hooks seed via the corresponding singular/plural IPC on mount
 * and subscribe to the matching event stream for updates. The plural
 * hook also picks up per-state transitions via `onListChanged` — the
 * runner emits a fresh list snapshot on every state transition AND on
 * start/terminal (see WorkflowRunner.emitStateChanged + emitRunsChanged).
 */

import { useEffect, useState } from 'react';
import type { Run } from '@shared/ipc';

export function useActiveRun(projectId: string): Run | null {
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
        if (result.ok && result.data.run !== null && result.data.run.projectId === projectId) {
          setRun(result.data.run);
        } else {
          setRun(null);
        }
      } catch {
        if (cancelled) return;
        setRun(null);
      }
    })();

    const off = api.runs.onCurrentChanged((event) => {
      if (cancelled) return;
      const next = event.run;
      if (next !== null && next.projectId === projectId) {
        setRun(next);
      } else {
        setRun(null);
      }
    });

    return () => {
      cancelled = true;
      off();
    };
  }, [projectId]);

  return run;
}

/**
 * Plural counterpart to `useActiveRun` (#GH-79). Returns every in-flight
 * run targeting `projectId`. Empty array (not null) so callers can safely
 * `.map(...)` / `.length` without null guards.
 */
export function useActiveRuns(projectId: string): Run[] {
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
          setRuns(result.data.runs.filter((r) => r.projectId === projectId));
        }
      } catch {
        if (cancelled) return;
        setRuns([]);
      }
    })();

    const off = api.runs.onListChanged((event) => {
      if (cancelled) return;
      setRuns(event.runs.filter((r) => r.projectId === projectId));
    });

    return () => {
      cancelled = true;
      off();
    };
  }, [projectId]);

  return runs;
}
