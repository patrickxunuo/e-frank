/**
 * Run schema — types only, no Node imports. Renderer-safe.
 *
 * The single source of truth for the workflow runner state machine (#7).
 * Both main (`workflow-runner`, `run-store`, IPC handlers) and renderer
 * (`useActiveRun`, `ProjectDetail`) import these types.
 *
 * Re-exported from `shared/ipc` so renderer code can import everything from
 * a single place without reaching into the schema folder directly.
 */

export type RunMode = 'interactive' | 'yolo';

/**
 * Internal state machine. After GH-52 the pipeline mirrors the skill's own
 * phase decomposition, so the user-facing timeline reads as a story:
 *
 *   idle
 *   -> locking                (runner-internal — hidden in UI)
 *   -> running                (runner-internal umbrella — hidden in UI;
 *                              the skill is alive but hasn't yet emitted
 *                              its first phase marker)
 *   -> fetchingTicket         (skill phase 1)
 *   -> branching              (skill phase 0)
 *   -> understandingContext   (skill phase 2)
 *   -> planning               (skill phase 3)
 *     (-> awaitingApproval, interactive only — pauses until approve/reject/modify)
 *   -> implementing           (skill phase 4)
 *   -> evaluatingTests        (skill phase 5)
 *   -> reviewingCode          (skill phase 6)
 *   -> committing             (skill phase 7.1)
 *   -> pushing                (skill phase 7.2)
 *   -> creatingPr             (skill phase 7.3)
 *   -> updatingTicket         (skill phase 7.4)
 *   -> unlocking              (runner-internal — hidden in UI)
 *   -> done | failed | cancelled
 *
 * Phase markers from the skill drive every transition between `running`
 * and `unlocking`. The runner does not invent any of those transitions
 * itself — see `PHASE_VALUES` in workflow-runner.ts.
 *
 * `preparing` is retained for backward-compat with persisted runs but
 * the runner never enters it after GH-37.
 */
export type RunState =
  | 'idle'
  | 'locking'
  | 'preparing'
  | 'fetchingTicket'
  | 'branching'
  | 'understandingContext'
  | 'planning'
  | 'running'
  | 'awaitingApproval'
  | 'implementing'
  | 'evaluatingTests'
  | 'reviewingCode'
  | 'committing'
  | 'pushing'
  | 'creatingPr'
  | 'updatingTicket'
  | 'unlocking'
  | 'done'
  | 'failed'
  | 'cancelled';

export type RunStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface RunStep {
  /** Internal state name. */
  state: RunState;
  /**
   * User-visible step name (matches design vocabulary), or `null` for
   * non-user-visible states (locking, preparing, branching, unlocking).
   */
  userVisibleLabel: string | null;
  status: RunStatus;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

export interface ApprovalRequest {
  /** Free-form payload from Claude (parsed from the marker JSON). */
  plan?: string;
  filesToModify?: string[];
  diff?: string;
  options?: string[];
  /** Raw JSON from the marker, in case the renderer needs it for #9 UI. */
  raw: unknown;
}

export interface Run {
  id: string;
  projectId: string;
  ticketKey: string;
  /**
   * Resolved ticket summary at run-start (from the poller's cached list).
   * Used by the ExecutionView title and downstream surfaces that want to
   * show "ABC-123 — Add login validation" instead of just the bare key.
   * Falls back to `ticketKey` when the poller doesn't have it cached.
   */
  ticketSummary?: string;
  mode: RunMode;
  branchName: string;
  /** Current state of the run. */
  state: RunState;
  /** Overall status: 'running' until done/failed/cancelled. */
  status: RunStatus;
  /** Timeline of every state we've entered, in order. */
  steps: RunStep[];
  /** Awaiting-approval payload, set during state='awaitingApproval'; null otherwise. */
  pendingApproval: ApprovalRequest | null;
  /** Result fields set as states complete. */
  prUrl?: string;
  startedAt: number;
  finishedAt?: number;
  /** Final error if status='failed'. */
  error?: string;
  /**
   * Non-fatal note attached when the run finished with a tail-end issue
   * (#GH-95). Today the only producer is the workflow runner's
   * "timeout-after-PR" reclassification: when Claude times out AFTER the
   * `creatingPr` phase has stamped `prUrl`, the run lands in `done`
   * (the user-visible work shipped) but the renderer surfaces this as
   * a yellow chip so the user knows the tail (ticket update / memory-
   * bank refresh) may not have completed.
   */
  terminalWarning?: string | null;
}

export interface RunStateEvent {
  runId: string;
  /** Snapshot of the run AFTER the transition. */
  run: Run;
}

export interface ApprovalResponse {
  runId: string;
  /**
   * 'approve': continue with original plan;
   * 'reject':  fail the run;
   * 'modify':  continue with edited plan text.
   */
  decision: 'approve' | 'reject' | 'modify';
  /** Required when decision === 'modify'; ignored otherwise. */
  text?: string;
}

/**
 * One line of streamed Claude output, persisted as NDJSON in
 * `userData/runs/{runId}.log` (#8). The renderer reads these back via
 * `runs.readLog` for completed runs and buckets them into per-state steps
 * by their `state` tag.
 */
export interface RunLogEntry {
  runId: string;
  stream: 'stdout' | 'stderr';
  line: string;
  /** Epoch ms when the line was received in main. */
  timestamp: number;
  /**
   * Workflow state at the time the line was received (best-effort tagging
   * so the renderer can bucket lines without re-deriving from timestamps).
   */
  state: RunState;
}
