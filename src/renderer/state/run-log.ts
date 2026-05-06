/**
 * `useRunLog` — bucket Claude's streamed output (or persisted log) into
 * per-state steps, driven by the workflow runner's state-machine events.
 *
 * Two modes, picked from `run.status`:
 *   - **Live** (`pending` / `running`): subscribe to `claude.onOutput` and
 *     `runs.onStateChanged`. Each output line lands in the step matching
 *     the run's CURRENT state at the time the line arrives. New states
 *     append fresh steps to the timeline.
 *   - **Terminal** (`done` / `failed` / `cancelled`): single shot —
 *     `runs.readLog` to load the persisted NDJSON, distribute lines into
 *     steps using each entry's `state` tag.
 *
 * Pause buffers incoming lines locally without updating `steps`; resume
 * flushes the buffer through the same per-state bucketing.
 *
 * Per-effect `cancelled` flag pattern (matches `useTickets` / `useActiveRun`).
 */

import { useEffect, useRef, useState } from 'react';
import type { Run, RunLogEntry, RunState, RunStatus, RunStateEvent } from '@shared/ipc';

// ----- Types -------------------------------------------------------------

export interface ExecLogStep {
  state: RunState;
  /** User-visible label, or `null` for non-user-visible internal states. */
  label: string | null;
  status: RunStatus;
  startedAt?: number;
  finishedAt?: number;
  lines: RunLogEntry[];
}

export interface UseRunLogResult {
  steps: ExecLogStep[];
  /** Total user-visible steps in `steps` (used by the progress counter). */
  totalUserVisibleSteps: number;
  /** Index (into `steps`) of the current user-visible step. */
  currentUserVisibleIndex: number;
  paused: boolean;
  setPaused: (b: boolean) => void;
  /** Lines buffered while paused, not yet flushed (test hook). */
  bufferedLineCount: number;
}

// ----- State labels (mirrors workflow-runner USER_VISIBLE_LABELS) ---------
//
// Kept in sync manually rather than imported from main — pulling main-side
// types into the renderer breaks the IPC boundary. The runner also tags
// each step with `userVisibleLabel` so we could derive from `run.steps`,
// but state-changed events arrive faster than `steps` updates, so the
// renderer needs its own table for newly-entered states.

const USER_VISIBLE_LABELS: Record<RunState, string | null> = {
  idle: null,
  locking: null,
  preparing: null,
  branching: null,
  running: 'Implementing feature',
  awaitingApproval: 'Awaiting approval',
  committing: 'Committing changes',
  pushing: 'Pushing branch',
  creatingPr: 'Creating pull request',
  updatingTicket: 'Updating ticket',
  unlocking: null,
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'done',
  'failed',
  'cancelled',
]);

function isTerminal(run: Run | null): boolean {
  return run !== null && TERMINAL_STATUSES.has(run.status);
}

/**
 * Build a fresh `steps` array from a Run snapshot's recorded `steps`.
 * Used to seed live runs (whose runner may already have transitioned)
 * and terminal runs alike.
 */
function stepsFromRun(run: Run): ExecLogStep[] {
  return run.steps.map((s) => {
    const step: ExecLogStep = {
      state: s.state,
      label: s.userVisibleLabel,
      status: s.status,
      lines: [],
    };
    if (s.startedAt !== undefined) step.startedAt = s.startedAt;
    if (s.finishedAt !== undefined) step.finishedAt = s.finishedAt;
    return step;
  });
}

/**
 * Insert `entry` into `steps`. Looks up by state — if no step matches,
 * falls back to the most recent step (defensive: a line for a future or
 * unknown state shouldn't be dropped silently).
 */
function appendEntryToSteps(steps: ExecLogStep[], entry: RunLogEntry): ExecLogStep[] {
  // Walk from the end so we hit the most recent step matching `state`
  // first (a state can appear more than once in the timeline if the
  // runner re-enters it, though that's rare for our pipeline).
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step !== undefined && step.state === entry.state) {
      const next = steps.slice();
      next[i] = { ...step, lines: [...step.lines, entry] };
      return next;
    }
  }
  // Fallback — append to the last step. If even the timeline is empty,
  // synthesize a single step for `entry.state` so the UI has somewhere
  // to render the line.
  if (steps.length === 0) {
    return [
      {
        state: entry.state,
        label: USER_VISIBLE_LABELS[entry.state],
        status: 'running',
        lines: [entry],
      },
    ];
  }
  const last = steps[steps.length - 1];
  if (last === undefined) return steps;
  const next = steps.slice();
  next[next.length - 1] = { ...last, lines: [...last.lines, entry] };
  return next;
}

/**
 * Apply a state-changed event to `steps`. The event's snapshot is
 * authoritative for both the new step and any prior step's status —
 * the runner may have closed out the previous step in the same tick.
 */
function applyStateChange(steps: ExecLogStep[], event: RunStateEvent): ExecLogStep[] {
  // Use the runner's `steps` array as the structural source of truth, but
  // preserve our accumulated `lines` per state.
  const existingLines = new Map<RunState, RunLogEntry[]>();
  for (const s of steps) {
    if (s.lines.length > 0) {
      existingLines.set(s.state, s.lines);
    }
  }
  return event.run.steps.map((s) => {
    const lines = existingLines.get(s.state) ?? [];
    const step: ExecLogStep = {
      state: s.state,
      label: s.userVisibleLabel,
      status: s.status,
      lines,
    };
    if (s.startedAt !== undefined) step.startedAt = s.startedAt;
    if (s.finishedAt !== undefined) step.finishedAt = s.finishedAt;
    return step;
  });
}

// ----- Hook --------------------------------------------------------------

export function useRunLog(run: Run | null): UseRunLogResult {
  const [steps, setSteps] = useState<ExecLogStep[]>(() =>
    run !== null ? stepsFromRun(run) : [],
  );
  const [paused, setPaused] = useState<boolean>(false);
  // Buffered output lines that arrived while paused. Held in a ref so the
  // pause/resume effect can flush without listing `paused` as a dep.
  const bufferRef = useRef<RunLogEntry[]>([]);
  const [bufferedLineCount, setBufferedLineCount] = useState<number>(0);
  // Mirror `paused` into a ref so the live subscription's stable closure
  // can read the latest value without re-subscribing on every toggle.
  // Updated synchronously during render so a line arriving immediately
  // after pause toggles flips into the buffer rather than the timeline.
  const pausedRef = useRef<boolean>(paused);
  pausedRef.current = paused;

  // Mirror the run snapshot into a ref so the live-output listener can
  // read fresh `state` / `id` values without re-subscribing on every
  // parent re-render. We update synchronously during render (not via
  // useEffect) so the subscription effect — which keys on `runId` /
  // `runStatus` — sees the newest snapshot when it fires.
  const runRef = useRef<Run | null>(run);
  runRef.current = run;

  // Track the run's identity. When we move from one run to another the
  // accumulated `steps` from the previous run must NOT bleed through.
  const runIdRef = useRef<string | null>(run?.id ?? null);

  // Effect-key the subscription on (id, status) — re-running on every
  // mid-flight state transition would thrash the subscription. Closures
  // read fresh values via `runRef`.
  const runId = run?.id ?? null;
  const runStatus = run?.status ?? null;

  useEffect(() => {
    let cancelled = false;
    const currentRun = runRef.current;
    const isNewRun = runIdRef.current !== runId;
    runIdRef.current = runId;
    bufferRef.current = [];
    setBufferedLineCount(0);

    if (currentRun === null) {
      setSteps([]);
      return () => {
        cancelled = true;
      };
    }

    if (isNewRun) {
      // Reset the timeline to the run's own recorded steps. Live runs
      // may immediately overwrite this when state-changed events arrive,
      // but terminal runs need this baseline before readLog distributes
      // lines into it.
      setSteps(stepsFromRun(currentRun));
    }

    if (typeof window === 'undefined' || !window.api) {
      // No IPC bridge — leave `steps` seeded from the run snapshot. Don't
      // crash; matches the graceful-degradation pattern in `useActiveRun`.
      return () => {
        cancelled = true;
      };
    }

    const api = window.api;

    if (isTerminal(currentRun)) {
      // Terminal: load persisted lines once, distribute into the
      // run-snapshot's steps. No subscriptions.
      const terminalRun = currentRun;
      void (async () => {
        try {
          const result = await api.runs.readLog({ runId: terminalRun.id });
          if (cancelled) return;
          if (!result.ok) return;
          // Re-seed from the run snapshot then layer in the persisted
          // entries. We use the functional setter purely to avoid a
          // stale-closure read; the previous value is intentionally
          // discarded because terminal runs are read-once.
          setSteps(() => {
            let next = stepsFromRun(terminalRun);
            for (const entry of result.data.entries) {
              next = appendEntryToSteps(next, entry);
            }
            return next;
          });
        } catch {
          // Read failure — leave `steps` as the run-snapshot seed.
          if (cancelled) return;
        }
      })();
      return () => {
        cancelled = true;
      };
    }

    // -- Live run --

    let claudeRunId: string | null = null;

    void (async () => {
      try {
        const result = await api.claude.status();
        if (cancelled) return;
        if (result.ok) {
          claudeRunId = result.data.active?.runId ?? null;
        }
      } catch {
        // No active claude — only state-machine steps, no streamed output.
      }
    })();

    const offOutput = api.claude.onOutput((event) => {
      if (cancelled) return;
      // Filter: only accept lines belonging to the active claude run.
      // If we haven't resolved `claudeRunId` yet, accept everything —
      // the claude.status() call may still be in flight and we'd rather
      // briefly over-include than drop early lines.
      if (claudeRunId !== null && event.runId !== claudeRunId) {
        return;
      }
      // Use the LATEST run snapshot at line-arrival time, not the one
      // captured when the effect first ran. `runRef` is updated on every
      // parent re-render so `state` / `id` reflect the current truth.
      const currentRun = runRef.current;
      if (currentRun === null) return;
      setSteps((prev) => {
        // The current state is the most recent step in the timeline (the
        // runner emits a state-changed event each transition, so by the
        // time output arrives `prev` reflects the right step).
        const lastStep = prev[prev.length - 1];
        const state: RunState = lastStep?.state ?? currentRun.state;
        const entry: RunLogEntry = {
          runId: currentRun.id,
          stream: event.stream,
          line: event.line,
          timestamp: event.timestamp,
          state,
        };
        if (pausedRef.current) {
          bufferRef.current = [...bufferRef.current, entry];
          setBufferedLineCount(bufferRef.current.length);
          return prev;
        }
        return appendEntryToSteps(prev, entry);
      });
    });

    const offState = api.runs.onStateChanged((event) => {
      if (cancelled) return;
      const currentRun = runRef.current;
      if (currentRun === null || event.runId !== currentRun.id) return;
      setSteps((prev) => applyStateChange(prev, event));
    });

    return () => {
      cancelled = true;
      offOutput();
      offState();
    };
    // Re-subscribe ONLY when the run identity or terminal-vs-live status
    // changes. Mid-run state transitions and step accumulations don't need
    // a fresh subscription — they propagate via the listener closures'
    // `runRef` access.
  }, [runId, runStatus]);

  // Flush the buffer when the user un-pauses.
  useEffect(() => {
    if (paused) return;
    if (bufferRef.current.length === 0) return;
    const buffered = bufferRef.current;
    bufferRef.current = [];
    setBufferedLineCount(0);
    setSteps((prev) => {
      let next = prev;
      for (const entry of buffered) {
        next = appendEntryToSteps(next, entry);
      }
      return next;
    });
  }, [paused]);

  // Derive progress counter values from `steps`. User-visible steps are
  // the ones whose state has a non-null label (running, committing, ...).
  const userVisibleSteps = steps.filter((s) => s.label !== null);
  const totalUserVisibleSteps = userVisibleSteps.length;

  // The "current" user-visible step is the index in `steps` of the
  // newest non-pending user-visible step that is running, or the latest
  // user-visible step if everything is done.
  let currentUserVisibleIndex = -1;
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s !== undefined && s.label !== null) {
      currentUserVisibleIndex = i;
      break;
    }
  }

  return {
    steps,
    totalUserVisibleSteps,
    currentUserVisibleIndex,
    paused,
    setPaused,
    bufferedLineCount,
  };
}
