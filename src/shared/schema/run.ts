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
 * Internal state machine. The pipeline transitions through these states in
 * the order documented in `acceptance/workflow-runner.md`:
 *
 *   idle -> locking -> preparing -> branching -> running
 *     (-> awaitingApproval, interactive only — pauses until approve/reject/modify)
 *   -> committing -> pushing -> creatingPr -> updatingTicket -> unlocking -> done
 *
 * Failure / cancel paths transition to `failed` or `cancelled` after running
 * the `unlocking` cleanup state.
 */
export type RunState =
  | 'idle'
  | 'locking'
  | 'preparing'
  | 'branching'
  | 'running'
  | 'awaitingApproval'
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
