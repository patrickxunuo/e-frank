/**
 * `useGlobalActiveRuns()` — subscribes to every in-flight run from the
 * workflow runner, project-agnostic. Returns `Run[]` (#GH-79 backend +
 * #GH-81 UI lift).
 *
 * Seeds via `runs:list-active` on mount so the first render is accurate
 * even without an event firing. Subscribes to `runs:list-changed` for
 * updates (fired on start, terminal, AND every state transition — see
 * `WorkflowRunner.emitStateChanged + emitRunsChanged`).
 *
 * Default to empty array (not null) so callers can do `.map(...)` /
 * `.length` without null guards.
 *
 * The singular `useGlobalActiveRun` predecessor was deleted in #GH-81
 * — every UI surface migrated to the plural shape (Sidebar pill,
 * ProjectList Status column, ProjectDetail ActiveExecutionStack).
 *
 * Project-SCOPED consumers use the sibling `useActiveRuns(projectId)`
 * instead — they want the projectId filter applied inside the hook so
 * subscribers don't re-render for unrelated projects' transitions.
 */

import { useEffect, useState } from 'react';
import type { Run } from '@shared/ipc';

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
