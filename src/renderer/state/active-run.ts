/**
 * `useActiveRun` — subscribes to the workflow runner's current-changed
 * stream, scoped to a specific projectId.
 *
 *   - On mount: seed via `runs.current()`, accept iff `projectId` matches
 *   - Subscribe to `onCurrentChanged`; update only for matching projectId
 *   - Returns `null` for non-matching project, idle runner, or
 *     missing `window.api`
 *   - Unsubscribes on unmount
 *
 * The hook returns the full `Run` snapshot (per #7's runner) — the
 * Active Execution panel adapts the fields it actually renders.
 */

import { useEffect, useState } from 'react';
import type { Run } from '@shared/ipc';

export function useActiveRun(projectId: string): Run | null {
  const [run, setRun] = useState<Run | null>(null);

  useEffect(() => {
    // Per-effect cancellation flag (matches `useTickets`). When projectId
    // changes, this effect's cleanup flips `cancelled = true` and the next
    // effect starts with its own fresh flag.
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
