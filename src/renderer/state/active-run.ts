/**
 * `useActiveRuns(projectId)` — subscribes to every in-flight run targeting
 * `projectId`. Plural shape (#GH-79 backend + #GH-81 UI lift).
 *
 * Seeds via `runs:list-active` on mount (filtered locally to projectId).
 * Subscribes to `runs:list-changed` for updates — the runner emits a
 * fresh list snapshot on every state transition AND on start/terminal
 * (see `WorkflowRunner.emitStateChanged + emitRunsChanged`), so the
 * hook stays in sync without an additional `state-changed` subscription.
 *
 * Returns `[]` (not null) so callers can `.map(...)` / `.length` safely.
 *
 * The singular `useActiveRun(projectId)` predecessor was deleted in
 * #GH-81 — every UI surface migrated to the plural shape (ProjectDetail
 * ActiveExecutionStack consumes this directly; ProjectList + Sidebar
 * use the project-agnostic sibling `useGlobalActiveRuns`).
 */

import { useEffect, useState } from 'react';
import type { Run } from '@shared/ipc';

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
