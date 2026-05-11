/**
 * `useGlobalActiveRun` — subscribes to the workflow runner's current-changed
 * stream, project-agnostic. Returns whatever run is in flight across the
 * whole runner (the runner enforces a single active run at a time, so
 * "global" is always a single Run or null).
 *
 * Powers cross-cutting UI that doesn't have a projectId in scope:
 *   - Sidebar's "Active Project / Active Ticket" pill block
 *   - ProjectList's per-row Status column ("Running" / "Awaiting" / "Idle")
 *
 * Project-SCOPED consumers (the active panel on ProjectDetail) use the
 * sibling `useActiveRun(projectId)` instead — they want null when the
 * active run targets a different project.
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
