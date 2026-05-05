/**
 * `useActiveRun` — placeholder for #6.
 *
 * In #6 the workflow runner isn't wired up yet, so this hook always returns
 * `null`. The interface and call site are set up so #7 can swap the body
 * for a real subscription to `runs:current-changed` (or similar) without
 * touching the consumer.
 *
 * Tests that need to exercise the Active Execution panel mock this hook.
 */

export interface ActiveRun {
  ticketKey: string;
  ticketTitle: string;
  /** 0..1 — derived from currentStep / totalSteps. */
  progress: number;
  currentStep: string;
  totalSteps: number;
  stepIndex: number;
  /** Last few log lines (max 5). Older lines are truncated. */
  recentLines: string[];
  runId: string;
}

// TODO(#7): replace with real subscription to runs:current-changed
export function useActiveRun(_projectId: string): ActiveRun | null {
  return null;
}
