/**
 * WorkflowRunner — orchestrator for the ticket-to-PR pipeline.
 *
 * After #37 (architectural pivot), the runner is a thin host: it spawns
 * Claude with `/ef-auto-feature <ticketKey>` and lets Claude drive git, PR,
 * and ticket-update via its own Bash tool. The runner only:
 *
 *   1. acquires the per-ticket lock (RunHistory.markRunning),
 *   2. spawns Claude and wires its stdout to the marker parsers,
 *   3. updates `Run.state` when Claude emits a phase marker,
 *   4. pauses on approval markers (interactive mode) and resumes on
 *      approve / reject / modify,
 *   5. on Claude exit, releases the lock (RunHistory.clearRunning) and
 *      lands in a terminal state. Whether the ticket re-appears in the
 *      eligible list is decided by source-side state (issue closed in
 *      Jira/GitHub, PR merged, etc.), not a local processed set.
 *
 *   start()
 *     -> locking          (RunHistory.markRunning)
 *     -> running          (claudeManager.run + marker handling)
 *         <- branching | committing | pushing | creatingPr | updatingTicket
 *            (driven by `<<<EF_PHASE>>>{...}<<<END_EF_PHASE>>>` markers)
 *         <- awaitingApproval (driven by approval markers; resumes to
 *            whatever phase was active before the pause)

 *     -> unlocking        (RunHistory.clearRunning)
 *     -> done | failed | cancelled
 *
 * The collapsed state machine deletes `preparing` from the driven flow.
 * The other legacy states (`branching`, `committing`, `pushing`,
 * `creatingPr`, `updatingTicket`) are now **observed phases** — they
 * appear in `Run.state` only when Claude reports them via a marker.
 *
 * `gitManager`, `prCreator`, and `jiraUpdater` are still in the options
 * for now (back-compat with main.ts wiring + tests) but the runner
 * never invokes them. NodeGitManager stays as a dormant utility for
 * future pre-flight checks (e.g. "is the working tree clean?").
 *
 * Emits two events:
 *   - `state-changed` : every state entry / exit (fine-grained timeline)
 *   - `current-changed`: every transition + once with `null` on completion
 *
 * Marker contracts are documented in `memory-bank/systemPatterns.md`:
 *
 *   <<<EF_APPROVAL_REQUEST>>>{json}<<<END_EF_APPROVAL_REQUEST>>>
 *   <<<EF_PHASE>>>{"phase":"committing"}<<<END_EF_PHASE>>>
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { ProjectInstance } from '../../shared/schema/project-instance.js';
import type {
  ApprovalRequest,
  ApprovalResponse,
  Run,
  RunMode,
  RunState,
  RunStateEvent,
  RunStep,
} from '../../shared/schema/run.js';
import type { ClaudeProcessManager, OutputEvent, ExitEvent } from './claude-process-manager.js';
import type { RunHistory } from './run-history.js';
import type { GitManager } from './git-manager.js';
import type { PrCreator } from './pr-creator.js';
import type { JiraUpdater } from './jira-updater.js';
import type { RunStore } from './run-store.js';
import type { Ticket } from '../../shared/schema/ticket.js';

const TICKET_KEY_REGEX = /^[A-Z][A-Z0-9_]*-\d+$/;

const APPROVAL_START = '<<<EF_APPROVAL_REQUEST>>>';
const APPROVAL_END = '<<<END_EF_APPROVAL_REQUEST>>>';
const PHASE_START = '<<<EF_PHASE>>>';
const PHASE_END = '<<<END_EF_PHASE>>>';

/**
 * Whitelisted phase values from `<<<EF_PHASE>>>` markers. These map 1:1
 * to existing `RunState` values; any other phase string is logged at
 * warn level and ignored (forwards-compatible — newer skills emitting a
 * future phase value won't crash older runners).
 *
 * NB: `running` and `awaitingApproval` are deliberately excluded.
 *   - `running` is the umbrella the runner enters when it spawns Claude;
 *     phase markers narrow it to a sub-phase, not back to itself.
 *   - `awaitingApproval` is driven by approval markers, not phase markers
 *     (per the spec — phase markers MUST NOT transition into a paused
 *     state, otherwise the resume path becomes ambiguous).
 */
const PHASE_VALUES: ReadonlySet<RunState> = new Set<RunState>([
  'branching',
  'committing',
  'pushing',
  'creatingPr',
  'updatingTicket',
]);

/**
 * Parsed payload from a `<<<EF_PHASE>>>{...}<<<END_EF_PHASE>>>` marker.
 * `phase` is required; the optional fields carry per-phase data:
 *
 *   - `branching` → `branchName`: the actual branch Claude created.
 *   - `creatingPr` → `prUrl`: the URL `gh pr create` returned.
 *
 * Other phases ignore the optional fields. Forward-compatible: future
 * phases can extend this without changing the marker sentinel format.
 */
interface PhaseMarker {
  phase: RunState;
  branchName?: string;
  prUrl?: string;
}

/**
 * User-visible labels for each state. `null` means the state is internal
 * plumbing (locking, preparing, branching, unlocking) and shouldn't surface
 * in the UI timeline.
 */
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

// -- Public types ------------------------------------------------------------

export interface WorkflowRunnerOptions {
  projectStore: { get: (id: string) => Promise<ProjectStoreGetResult> };
  /**
   * Reserved for #10/#11/#13 — real GitManager / PrCreator / JiraUpdater
   * implementations will pull GitHub / Bitbucket / Jira tokens by ref. The
   * stubs in #7 don't read it; the field is here so the constructor
   * contract is stable across the swap.
   */
  secretsManager: { get: (ref: string) => Promise<SecretsGetResult> };
  runHistory: RunHistory;
  runStore: RunStore;
  claudeManager: ClaudeProcessManager;
  gitManager: GitManager;
  prCreator: PrCreator;
  jiraUpdater: JiraUpdater;
  /**
   * Read-only adapter over the ticket poller's per-project cache. The runner
   * uses it ONLY to resolve a ticket's `summary` by `key` so branch + commit
   * derivation reads "feat/GH-31-show-app-version" instead of the previous
   * "feat/GH-31-gh-31" (#35). Optional — runner falls back to using the key
   * as the summary if the ticket isn't in the cache (e.g. a fresh process
   * before the first poll, or a ticket the poller never saw).
   */
  ticketPoller?: { list: (projectId: string) => Ticket[] };
  /** Test injection. Defaults to `Date.now()`. */
  clock?: { now: () => number };
}

/**
 * Adapter shapes for the two stores the runner reads from. Defined as
 * minimal contracts so tests don't need to construct full stores.
 */
type ProjectStoreGetResult =
  | { ok: true; data: ProjectInstance }
  | { ok: false; error: { code: string; message: string } };

type SecretsGetResult =
  | { ok: true; data: { plaintext: string } }
  | { ok: false; error: { code: string; message: string } };

export interface StartRunRequest {
  projectId: string;
  ticketKey: string;
  /** Optional override; defaults to project's `workflow.mode`. */
  modeOverride?: RunMode;
}

export type RunnerErrorCode =
  | 'ALREADY_RUNNING'
  | 'PROJECT_NOT_FOUND'
  | 'INVALID_TICKET_KEY'
  | 'NOT_RUNNING'
  | 'NOT_AWAITING_APPROVAL'
  | 'INVALID_DECISION'
  | 'IO_FAILURE';

export type RunnerResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: RunnerErrorCode; message: string } };

// -- Internals ---------------------------------------------------------------

/**
 * Sentinel error used to short-circuit the pipeline when `cancel()` is
 * invoked. Caught by the outer try/catch in `runPipeline` and routed to the
 * `cancelled` cleanup path.
 */
class CancelledError extends Error {
  constructor() {
    super('run cancelled');
    this.name = 'CancelledError';
  }
}

/** Mutable per-run runtime state. Lives on the runner instance, not in `Run`. */
interface ActiveRunCtx {
  run: Run;
  cancellationToken: { cancelled: boolean };
  /** runId of the underlying `claudeManager.run()` invocation, when active. */
  claudeRunId: string | null;
  /** Approval-pending promise; resolved by approve/reject/modify. */
  approvalDeferred: {
    promise: Promise<ApprovalResponse>;
    resolve: (r: ApprovalResponse) => void;
    reject: (e: Error) => void;
  } | null;
  /** Buffered Claude stdout for marker scanning. */
  outputBuffer: string;
  /** Detached when claude exits. */
  detachOutputListener: (() => void) | null;
  detachExitListener: (() => void) | null;
  /** Resolved when the underlying claude process exits. */
  claudeExitDeferred: {
    promise: Promise<ExitEvent>;
    resolve: (e: ExitEvent) => void;
  } | null;
  /**
   * The phase Claude was in when an approval marker fired. Used to
   * restore `Run.state` on resume — without this, post-approval would
   * always flip back to `running`, even if a phase marker had
   * advanced the state to e.g. `committing`. Null when not paused.
   */
  priorPhase: RunState | null;
}

function deepCloneRun(run: Run): Run {
  // Structured clone of the fields that consumers might mutate. JSON
  // round-trip is fine — `pendingApproval.raw` is plain JSON by construction
  // (parsed from the marker payload) and timestamps are numbers.
  return JSON.parse(JSON.stringify(run)) as Run;
}

function ticketKeyValid(key: string): boolean {
  return TICKET_KEY_REGEX.test(key);
}

function slugifyTicketSummary(summary: string): string {
  // First 6 words, lowercased, strip non-alphanum (preserve `-`), join with `-`.
  const words = summary
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .slice(0, 6);
  const slugWords = words
    .map((w) => w.replace(/[^a-z0-9-]+/g, ''))
    .filter((w) => w.length > 0);
  return slugWords.join('-');
}

/**
 * Substitute `{ticketKey}` and `{slug}` placeholders in `branchFormat`. The
 * project schema enforces that the format contains at least one of these
 * tokens so we always end up with a non-empty branch name.
 */
function deriveBranchName(
  branchFormat: string,
  ticketKey: string,
  ticketSummary: string,
): string {
  const slug = slugifyTicketSummary(ticketSummary);
  return branchFormat.replace(/\{ticketKey\}/g, ticketKey).replace(/\{slug\}/g, slug);
}

// -- Class -------------------------------------------------------------------

export class WorkflowRunner extends EventEmitter {
  private readonly options: WorkflowRunnerOptions;
  private readonly clock: { now: () => number };
  private active: ActiveRunCtx | null = null;

  constructor(options: WorkflowRunnerOptions) {
    super();
    this.options = options;
    this.clock = options.clock ?? { now: () => Date.now() };
  }

  // -- Public API ----------------------------------------------------------

  current(): Run | null {
    if (this.active === null) return null;
    return deepCloneRun(this.active.run);
  }

  async start(req: StartRunRequest): Promise<RunnerResult<{ run: Run }>> {
    if (this.active !== null) {
      return {
        ok: false,
        error: {
          code: 'ALREADY_RUNNING',
          message: `a run is already active (runId=${this.active.run.id})`,
        },
      };
    }
    if (!ticketKeyValid(req.ticketKey)) {
      return {
        ok: false,
        error: {
          code: 'INVALID_TICKET_KEY',
          message:
            'ticketKey must match /^[A-Z][A-Z0-9_]*-\\d+$/ (e.g. "ABC-123"); ' +
            `got "${req.ticketKey}"`,
        },
      };
    }
    const projectRes = await this.options.projectStore.get(req.projectId);
    if (!projectRes.ok) {
      return {
        ok: false,
        error: {
          code: 'PROJECT_NOT_FOUND',
          message: `no project with id "${req.projectId}"`,
        },
      };
    }
    const project = projectRes.data;
    const mode: RunMode = req.modeOverride ?? project.workflow.mode;

    // Resolve the ticket summary from the poller's cached list. Without
    // this, branch + commit + PR title all use the ticket key as the
    // summary, producing nonsense like `feat/GH-31-gh-31` and
    // `feat(GH-31): GH-31`. The poller's `list()` is an in-memory snapshot
    // (cheap). Defensive fallback to ticketKey if not in cache (#35).
    let ticketSummary = req.ticketKey;
    if (this.options.ticketPoller !== undefined) {
      const cachedTickets = this.options.ticketPoller.list(req.projectId);
      const found = cachedTickets.find((t) => t.key === req.ticketKey);
      if (found !== undefined && found.summary !== '') {
        ticketSummary = found.summary;
      }
    }
    const branchName = deriveBranchName(
      project.workflow.branchFormat,
      req.ticketKey,
      ticketSummary,
    );

    const startedAt = this.clock.now();
    const run: Run = {
      id: randomUUID(),
      projectId: req.projectId,
      ticketKey: req.ticketKey,
      mode,
      branchName,
      state: 'idle',
      status: 'running',
      steps: [],
      pendingApproval: null,
      startedAt,
    };
    const ctx: ActiveRunCtx = {
      run,
      cancellationToken: { cancelled: false },
      claudeRunId: null,
      approvalDeferred: null,
      outputBuffer: '',
      detachOutputListener: null,
      detachExitListener: null,
      claudeExitDeferred: null,
      priorPhase: null,
    };
    this.active = ctx;

    // Fire-and-forget: drive the pipeline asynchronously so `start()` returns
    // immediately with the initial Run snapshot. Consumers track progress
    // via state-changed / current-changed events.
    void this.runPipeline(ctx, project, ticketSummary).catch((err) => {

      console.error('[workflow-runner] pipeline crashed unexpectedly:', err);
    });

    return { ok: true, data: { run: deepCloneRun(run) } };
  }

  async cancel(runId: string): Promise<RunnerResult<{ runId: string }>> {
    const ctx = this.active;
    if (ctx === null || ctx.run.id !== runId) {
      return {
        ok: false,
        error: {
          code: 'NOT_RUNNING',
          message:
            ctx === null
              ? 'no active run to cancel'
              : `runId mismatch: active runId is ${ctx.run.id}, got ${runId}`,
        },
      };
    }
    if (ctx.cancellationToken.cancelled) {
      // Idempotent — already cancelled, just return ok.
      return { ok: true, data: { runId } };
    }
    ctx.cancellationToken.cancelled = true;
    // If we're paused on an approval, kick the deferred to unblock so the
    // pipeline notices the cancellation flag.
    if (ctx.approvalDeferred !== null) {
      ctx.approvalDeferred.reject(new CancelledError());
      ctx.approvalDeferred = null;
    }
    // Kill the underlying claude process if one is active. The exit event
    // will resolve the claudeExitDeferred; runPipeline checks the
    // cancellation flag after each await and throws CancelledError.
    if (ctx.claudeRunId !== null) {
      this.options.claudeManager.cancel(ctx.claudeRunId);
    }
    return { ok: true, data: { runId } };
  }

  async approve(req: { runId: string }): Promise<RunnerResult<{ runId: string }>> {
    return this.resolveApproval(req.runId, { runId: req.runId, decision: 'approve' });
  }

  async reject(req: { runId: string }): Promise<RunnerResult<{ runId: string }>> {
    return this.resolveApproval(req.runId, { runId: req.runId, decision: 'reject' });
  }

  async modify(req: { runId: string; text: string }): Promise<RunnerResult<{ runId: string }>> {
    if (typeof req.text !== 'string' || req.text.length === 0) {
      return {
        ok: false,
        error: {
          code: 'INVALID_DECISION',
          message: 'modify requires a non-empty text',
        },
      };
    }
    return this.resolveApproval(req.runId, {
      runId: req.runId,
      decision: 'modify',
      text: req.text,
    });
  }

  // -- Pipeline ------------------------------------------------------------

  private async runPipeline(
    ctx: ActiveRunCtx,
    project: ProjectInstance,
    _ticketSummary: string,
  ): Promise<void> {
    const repoCwd = project.repo.localPath;
    let pipelineError: string | null = null;
    let cancelled = false;

    try {
      // -- locking -- (acquire the per-ticket lock so concurrent runs
      //               can't race on the same ticket)
      await this.runState(ctx, 'locking', async () => {
        const res = await this.options.runHistory.markRunning(
          ctx.run.projectId,
          ctx.run.ticketKey,
        );
        if (!res.ok) {
          throw new Error(`run-history.markRunning failed: ${res.error.code} - ${res.error.message}`);
        }
      });

      // -- running -- (Claude takes over: spawns the skill, drives git/
      //               PR/ticket via its own Bash tool, emits phase markers
      //               so the runner can keep `Run.state` honest, emits
      //               approval markers to pause for human review.)
      await this.runState(ctx, 'running', async () => {
        await this.runClaudeWithApprovals(ctx, repoCwd);
      });
    } catch (err) {
      if (err instanceof CancelledError) {
        cancelled = true;
      } else {
        const message = err instanceof Error ? err.message : String(err);
        pipelineError = message;
        // Mark the in-flight step as failed.
        const idx = ctx.run.steps.length - 1;
        const step = ctx.run.steps[idx];
        if (step !== undefined && step.status === 'running') {
          step.status = 'failed';
          step.finishedAt = this.clock.now();
          step.error = message;
        }
        ctx.run.error = message;
      }
    }

    // -- unlocking -- (always runs, even on failure / cancel)
    try {
      await this.runState(ctx, 'unlocking', async () => {
        // The runner used to also call `runHistory.markProcessed` on the
        // success path so a freshly-finished ticket would drop out of the
        // eligible list. That filter was leaky semantics: source-side
        // status (Jira closed, GitHub merged-PR auto-close) is the real
        // source of truth for "this ticket is done." We now release only
        // the per-ticket lock; whether the ticket re-appears in the list
        // is decided by the source query.
        const cr = await this.options.runHistory.clearRunning(
          ctx.run.projectId,
          ctx.run.ticketKey,
        );
        if (!cr.ok) {
          console.warn(
            `[workflow-runner] run-history.clearRunning failed: ${cr.error.code} - ${cr.error.message}`,
          );
        }
      });
    } catch (err) {
      // unlocking shouldn't throw, but if it does (e.g. fs failure), record
      // it on the run before we transition to a terminal state.
      const message = err instanceof Error ? err.message : String(err);

      console.warn(`[workflow-runner] unlocking step threw: ${message}`);
    }

    // -- terminal state --
    let finalState: RunState;
    let finalStatus: Run['status'];
    if (cancelled) {
      finalState = 'cancelled';
      finalStatus = 'cancelled';
    } else if (pipelineError !== null) {
      finalState = 'failed';
      finalStatus = 'failed';
    } else {
      finalState = 'done';
      finalStatus = 'done';
    }

    ctx.run.state = finalState;
    ctx.run.status = finalStatus;
    ctx.run.finishedAt = this.clock.now();
    ctx.run.pendingApproval = null;
    ctx.run.steps.push({
      state: finalState,
      userVisibleLabel: USER_VISIBLE_LABELS[finalState],
      status: finalStatus,
      startedAt: ctx.run.finishedAt,
      finishedAt: ctx.run.finishedAt,
    });

    this.emitStateChanged(ctx);
    await this.persist(ctx);

    // Emit current-changed with the final run snapshot, then clear active
    // and emit current-changed(null) so subscribers can reset their UI.
    this.emit('current-changed', { run: deepCloneRun(ctx.run) });
    this.active = null;
    // Detach any lingering claude listeners.
    if (ctx.detachOutputListener !== null) {
      ctx.detachOutputListener();
      ctx.detachOutputListener = null;
    }
    if (ctx.detachExitListener !== null) {
      ctx.detachExitListener();
      ctx.detachExitListener = null;
    }
    this.emit('current-changed', { run: null });
  }

  /**
   * Run a single state: append a `running` step, save, run `body`, mark
   * `done`, save, emit `state-changed` + `current-changed` after each
   * mutation. Throws on body failure so the outer pipeline routes to the
   * `failed` cleanup path.
   *
   * Cancellation: checks `cancellationToken` BEFORE entering the state and
   * AFTER `body` resolves. If cancelled, throws `CancelledError`.
   */
  private async runState(
    ctx: ActiveRunCtx,
    state: RunState,
    body: () => Promise<void>,
  ): Promise<void> {
    // `unlocking` is the cleanup state — it MUST run to release ticket locks
    // and persist the final run snapshot, even when the pipeline was cancelled
    // before this state was entered. Every other state honors the
    // cancellation token and short-circuits.
    if (ctx.cancellationToken.cancelled && state !== 'unlocking') {
      throw new CancelledError();
    }
    // Enter — append a running step and emit. `current-changed` fires once
    // per state transition (entry); `state-changed` fires on both entry
    // and exit (finer-grained timeline for #8).
    const step: RunStep = {
      state,
      userVisibleLabel: USER_VISIBLE_LABELS[state],
      status: 'running',
      startedAt: this.clock.now(),
    };
    ctx.run.state = state;
    ctx.run.steps.push(step);
    this.emitStateChanged(ctx);
    this.emit('current-changed', { run: deepCloneRun(ctx.run) });
    await this.persist(ctx);

    try {
      await body();
    } catch (err) {
      // Cancellation may have been requested while body was awaiting.
      if (ctx.cancellationToken.cancelled) {
        step.status = 'cancelled';
        step.finishedAt = this.clock.now();
        this.emitStateChanged(ctx);
        await this.persist(ctx);
        throw new CancelledError();
      }
      throw err;
    }

    // Post-body cancellation check. `unlocking` is exempt — it's the
    // cleanup state and must always close as `done` even when the run was
    // cancelled (matches the entry-guard exception above).
    if (ctx.cancellationToken.cancelled && state !== 'unlocking') {
      step.status = 'cancelled';
      step.finishedAt = this.clock.now();
      this.emitStateChanged(ctx);
      await this.persist(ctx);
      throw new CancelledError();
    }

    // Exit — mark step done if it isn't already. Two callers compete:
    //   1. Our own wrapping `step` may already be 'done' because
    //      `transitionToPhase` (driven by phase markers) closed it
    //      when opening the first phase step.
    //   2. The LAST phase step inserted by `transitionToPhase` is
    //      orphaned — nothing else closes it, because phase
    //      transitions only close the *previous* phase step (the
    //      next transition's predecessor), and after the final phase
    //      no further marker arrives.
    // So: close every step that's still 'running' at body-exit time.
    // This catches both our own wrapping step and any phase
    // straggler. Without this, the user sees "still working" persist
    // on the final phase (e.g. `creatingPr`) after the run is done.
    const finishedAt = this.clock.now();
    for (const s of ctx.run.steps) {
      if (s.status === 'running') {
        s.status = 'done';
        s.finishedAt = finishedAt;
      }
    }
    this.emitStateChanged(ctx);
    await this.persist(ctx);
  }

  // -- Claude integration with approval markers ----------------------------

  private async runClaudeWithApprovals(ctx: ActiveRunCtx, cwd: string): Promise<void> {
    const startRes = this.options.claudeManager.run({
      ticketKey: ctx.run.ticketKey,
      cwd,
    });
    if (!startRes.ok) {
      throw new Error(
        `claude.run failed: ${startRes.error.code} - ${startRes.error.message}`,
      );
    }
    ctx.claudeRunId = startRes.data.runId;

    // Build the exit-deferred so `body` can await the underlying process.
    let resolveExit!: (e: ExitEvent) => void;
    const exitPromise = new Promise<ExitEvent>((r) => {
      resolveExit = r;
    });
    ctx.claudeExitDeferred = { promise: exitPromise, resolve: resolveExit };

    const onOutput = (e: OutputEvent): void => {
      if (e.runId !== ctx.claudeRunId) return;
      if (e.stream !== 'stdout') return;
      this.handleClaudeLine(ctx, e.line);
    };
    const onExit = (e: ExitEvent): void => {
      if (e.runId !== ctx.claudeRunId) return;
      resolveExit(e);
    };
    this.options.claudeManager.on('output', onOutput);
    this.options.claudeManager.on('exit', onExit);
    ctx.detachOutputListener = () => {
      this.options.claudeManager.off('output', onOutput);
    };
    ctx.detachExitListener = () => {
      this.options.claudeManager.off('exit', onExit);
    };

    try {
      const exitEvent = await exitPromise;
      // Detach immediately on exit — no further events expected.
      if (ctx.detachOutputListener !== null) {
        ctx.detachOutputListener();
        ctx.detachOutputListener = null;
      }
      if (ctx.detachExitListener !== null) {
        ctx.detachExitListener();
        ctx.detachExitListener = null;
      }
      ctx.claudeRunId = null;
      ctx.claudeExitDeferred = null;

      if (ctx.cancellationToken.cancelled) {
        throw new CancelledError();
      }
      // `cancelled` reason wins even without our local flag (e.g. user cancelled
      // at OS level). Treat it as cancellation.
      if (exitEvent.reason === 'cancelled') {
        ctx.cancellationToken.cancelled = true;
        throw new CancelledError();
      }
      if (exitEvent.reason !== 'completed' || (exitEvent.exitCode !== null && exitEvent.exitCode !== 0)) {
        throw new Error(
          `claude exited with reason="${exitEvent.reason}" exitCode=${String(exitEvent.exitCode)}`,
        );
      }
    } catch (err) {
      if (ctx.detachOutputListener !== null) {
        ctx.detachOutputListener();
        ctx.detachOutputListener = null;
      }
      if (ctx.detachExitListener !== null) {
        ctx.detachExitListener();
        ctx.detachExitListener = null;
      }
      throw err;
    }
  }

  /**
   * Inspect a single line of Claude stdout for markers. Two contracts are
   * recognized in interleaved order — whichever appears first in the
   * buffer is consumed first:
   *
   *   <<<EF_APPROVAL_REQUEST>>>{...}<<<END_EF_APPROVAL_REQUEST>>>
   *   <<<EF_PHASE>>>{"phase":"..."}<<<END_EF_PHASE>>>
   *
   * The line splitter in ClaudeProcessManager already gives us individual
   * lines, so each marker fits on one line. We still buffer in case a
   * marker is ever split across lines (defensive).
   */
  private handleClaudeLine(ctx: ActiveRunCtx, line: string): void {
    // Append to scan buffer in case markers ever straddle lines (defensive).
    ctx.outputBuffer += line + '\n';

    // Bound the buffer so we don't accumulate indefinitely on long-running
    // claude sessions. Keep the last ~64 KiB, which is far more than any
    // realistic single marker payload.
    const MAX_BUFFER = 64 * 1024;
    if (ctx.outputBuffer.length > MAX_BUFFER) {
      ctx.outputBuffer = ctx.outputBuffer.slice(-MAX_BUFFER);
    }

    // Scan for as many complete markers as the buffer contains. Each
    // iteration finds the earliest marker (approval or phase), consumes
    // it, and dispatches. Order-preserving so a phase marker emitted
    // before an approval marker fires first.
    while (true) {
      const apprStart = ctx.outputBuffer.indexOf(APPROVAL_START);
      const phaseStart = ctx.outputBuffer.indexOf(PHASE_START);
      if (apprStart === -1 && phaseStart === -1) return;

      const approvalFirst =
        apprStart !== -1 && (phaseStart === -1 || apprStart < phaseStart);

      if (approvalFirst) {
        const afterStart = apprStart + APPROVAL_START.length;
        const endIdx = ctx.outputBuffer.indexOf(APPROVAL_END, afterStart);
        if (endIdx === -1) return; // wait for more output
        const json = ctx.outputBuffer.slice(afterStart, endIdx);
        ctx.outputBuffer = ctx.outputBuffer.slice(endIdx + APPROVAL_END.length);

        let parsed: unknown;
        try {
          parsed = JSON.parse(json);
        } catch (err) {
          console.warn(
            `[workflow-runner] malformed approval marker JSON: ${err instanceof Error ? err.message : String(err)}`,
          );
          continue; // treat as regular output
        }

        const approval = this.parseApprovalRequest(parsed);
        // Detached from the line-handling callback; CancelledError comes
        // through normally (pipeline handles via `cancellationToken` +
        // claudeManager.cancel). Anything else is a bug we want to see.
        void this.dispatchApproval(ctx, approval).catch((err) => {
          if (err instanceof CancelledError) {
            return;
          }
          console.error('[workflow-runner] dispatchApproval threw:', err);
        });
      } else {
        const afterStart = phaseStart + PHASE_START.length;
        const endIdx = ctx.outputBuffer.indexOf(PHASE_END, afterStart);
        if (endIdx === -1) return; // wait for more output
        const json = ctx.outputBuffer.slice(afterStart, endIdx);
        ctx.outputBuffer = ctx.outputBuffer.slice(endIdx + PHASE_END.length);

        const marker = this.parsePhaseMarker(json);
        if (marker === null) continue; // bad JSON / unknown phase — ignored
        // Phase markers can't fire while paused on approval (per spec).
        // If a marker arrives during awaitingApproval (shouldn't happen
        // with a well-behaved skill but is possible if Claude emits a
        // phase right before the approval round-trip finishes), drop it.
        if (ctx.run.state === 'awaitingApproval') {
          console.warn(
            `[workflow-runner] phase marker "${marker.phase}" arrived during awaitingApproval; ignored`,
          );
          continue;
        }
        // Apply per-phase payload BEFORE the state transition so a UI
        // observer that subscribes to `current-changed` sees a coherent
        // snapshot (new state + new branchName / prUrl together).
        if (marker.phase === 'branching' && marker.branchName !== undefined) {
          ctx.run.branchName = marker.branchName;
        }
        if (marker.phase === 'creatingPr' && marker.prUrl !== undefined) {
          ctx.run.prUrl = marker.prUrl;
        }
        this.transitionToPhase(ctx, marker.phase);
      }
    }
  }

  /**
   * Parse a `<<<EF_PHASE>>>{...}<<<END_EF_PHASE>>>` JSON body into a
   * `PhaseMarker`. Returns `null` (ignored) for malformed JSON or an
   * unknown `phase` value, with a warn log. Optional fields
   * (`branchName`, `prUrl`) are extracted when present and well-typed;
   * other fields are silently dropped (forward-compatible).
   */
  private parsePhaseMarker(json: string): PhaseMarker | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      console.warn(
        `[workflow-runner] malformed phase marker JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      console.warn('[workflow-runner] phase marker body is not an object');
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    const phaseRaw = obj['phase'];
    if (typeof phaseRaw !== 'string') {
      console.warn('[workflow-runner] phase marker missing string `phase` field');
      return null;
    }
    if (!PHASE_VALUES.has(phaseRaw as RunState)) {
      console.warn(`[workflow-runner] phase marker has unknown phase "${phaseRaw}"; ignored`);
      return null;
    }
    const marker: PhaseMarker = { phase: phaseRaw as RunState };
    const branchNameRaw = obj['branchName'];
    if (typeof branchNameRaw === 'string' && branchNameRaw !== '') {
      marker.branchName = branchNameRaw;
    }
    const prUrlRaw = obj['prUrl'];
    if (typeof prUrlRaw === 'string' && prUrlRaw !== '') {
      marker.prUrl = prUrlRaw;
    }
    return marker;
  }

  /**
   * Close the in-flight step and open a new one for `phase`. Used by the
   * phase-marker handler (and could be called by approval-resume for
   * symmetry, but that path uses inline mutation today).
   */
  private transitionToPhase(ctx: ActiveRunCtx, phase: RunState): void {
    const lastIdx = ctx.run.steps.length - 1;
    const lastStep = ctx.run.steps[lastIdx];
    if (lastStep !== undefined && lastStep.status === 'running') {
      lastStep.status = 'done';
      lastStep.finishedAt = this.clock.now();
    }
    ctx.run.state = phase;
    ctx.run.steps.push({
      state: phase,
      userVisibleLabel: USER_VISIBLE_LABELS[phase],
      status: 'running',
      startedAt: this.clock.now(),
    });
    this.emitStateChanged(ctx);
    this.emit('current-changed', { run: deepCloneRun(ctx.run) });
    // Persist async — same rationale as dispatchApproval. The state
    // transition is already complete in memory; on-disk catches up.
    void this.persist(ctx);
  }

  private parseApprovalRequest(raw: unknown): ApprovalRequest {
    if (typeof raw !== 'object' || raw === null) {
      return { raw };
    }
    const obj = raw as Record<string, unknown>;
    const result: ApprovalRequest = { raw };
    if (typeof obj['plan'] === 'string') result.plan = obj['plan'];
    if (Array.isArray(obj['filesToModify'])) {
      result.filesToModify = obj['filesToModify'].filter(
        (v): v is string => typeof v === 'string',
      );
    }
    if (typeof obj['diff'] === 'string') result.diff = obj['diff'];
    if (Array.isArray(obj['options'])) {
      result.options = obj['options'].filter((v): v is string => typeof v === 'string');
    }
    return result;
  }

  private async dispatchApproval(
    ctx: ActiveRunCtx,
    approval: ApprovalRequest,
  ): Promise<void> {
    if (ctx.run.mode === 'yolo') {
      // Auto-approve — write 'approve\n' to claude stdin immediately. The
      // run state stays `running`; we never enter `awaitingApproval`.
      if (ctx.claudeRunId !== null) {
        this.options.claudeManager.write({ runId: ctx.claudeRunId, text: 'approve\n' });
      }
      return;
    }

    // Interactive: enter awaitingApproval, wait for approve/reject/modify.
    // Set up the deferred BEFORE emitting state-changed so external observers
    // (and tests' `waitForState('awaitingApproval')`) that immediately call
    // `approve()` find the deferred ready — otherwise there's a tiny race
    // where the state shows `awaitingApproval` but `approvalDeferred` is
    // still null until the await persist resolves.
    let resolveApproval!: (r: ApprovalResponse) => void;
    let rejectApproval!: (e: Error) => void;
    const approvalPromise = new Promise<ApprovalResponse>((res, rej) => {
      resolveApproval = res;
      rejectApproval = rej;
    });
    ctx.approvalDeferred = {
      promise: approvalPromise,
      resolve: resolveApproval,
      reject: rejectApproval,
    };

    // Remember which phase we were in so resume can flip back to it.
    // Without this, post-approval would always restore `running`, even
    // if a phase marker had advanced the run to e.g. `committing` before
    // Claude emitted the approval marker.
    ctx.priorPhase = ctx.run.state;

    ctx.run.pendingApproval = approval;
    ctx.run.state = 'awaitingApproval';
    ctx.run.steps.push({
      state: 'awaitingApproval',
      userVisibleLabel: USER_VISIBLE_LABELS['awaitingApproval'],
      status: 'running',
      startedAt: this.clock.now(),
    });
    this.emitStateChanged(ctx);
    this.emit('current-changed', { run: deepCloneRun(ctx.run) });
    // Fire-and-forget the persist on entering awaitingApproval. Awaiting it
    // here would insert an extra microtask boundary before `await
    // approvalPromise`, which causes a subtle race: when an external caller
    // does `await runner.approve(...)`, their continuation runs before
    // dispatchApproval gets back to the post-approval `claudeManager.write`,
    // making the stdin write invisible to the caller. The state transition
    // is already complete in memory; on-disk persistence catches up
    // asynchronously.
    void this.persist(ctx);

    let response: ApprovalResponse;
    let cancelledFromCallback = false;
    try {
      response = await approvalPromise;
    } catch (err) {
      // Cancellation reaches here via `cancel()` rejecting the deferred.
      // Cleanup state, then re-throw so the running-state body propagates
      // cancellation.
      cancelledFromCallback = true;
      const lastIdx = ctx.run.steps.length - 1;
      const lastStep = ctx.run.steps[lastIdx];
      if (lastStep !== undefined && lastStep.state === 'awaitingApproval') {
        lastStep.status = 'done';
        lastStep.finishedAt = this.clock.now();
      }
      ctx.run.pendingApproval = null;
      // Restore the phase we were in before the pause; default to
      // 'running' for the legacy single-phase case.
      ctx.run.state = ctx.priorPhase ?? 'running';
      ctx.priorPhase = null;
      ctx.approvalDeferred = null;
      this.emitStateChanged(ctx);
      this.emit('current-changed', { run: deepCloneRun(ctx.run) });
      await this.persist(ctx);
      throw err instanceof Error ? err : new Error(String(err));
    }
    void cancelledFromCallback;

    // Translate decision -> claude stdin message SYNCHRONOUSLY before any
    // further awaits. Tests that `await runner.approve(...)` need to see the
    // stdin write reflected immediately on the next line — if we await
    // `persist` first, the test resumes before the write fires.
    if (response.decision === 'approve') {
      if (ctx.claudeRunId !== null) {
        this.options.claudeManager.write({ runId: ctx.claudeRunId, text: 'approve\n' });
      }
    } else if (response.decision === 'reject') {
      // Kill claude immediately. The cancellation flag is set so the
      // running-state body throws CancelledError on the next claude-exit
      // observation, routing through the cleanup -> 'cancelled' path.
      ctx.cancellationToken.cancelled = true;
      if (ctx.claudeRunId !== null) {
        this.options.claudeManager.cancel(ctx.claudeRunId);
      }
    } else if (response.decision === 'modify') {
      if (ctx.claudeRunId !== null) {
        const text = response.text ?? '';
        this.options.claudeManager.write({
          runId: ctx.claudeRunId,
          text: text.endsWith('\n') ? text : `${text}\n`,
        });
      }
    }

    // Cleanup state AFTER the write. Persist runs last and yields to
    // microtasks; observers awaiting approve() have already seen the write.
    // Guard the in-place state mutation against a race where the pipeline
    // already advanced past `awaitingApproval` (e.g. a marker fired moments
    // before claude exited). If state has moved on, we do not overwrite it.
    if (ctx.run.state === 'awaitingApproval') {
      const lastIdx = ctx.run.steps.length - 1;
      const lastStep = ctx.run.steps[lastIdx];
      if (lastStep !== undefined && lastStep.state === 'awaitingApproval') {
        lastStep.status = 'done';
        lastStep.finishedAt = this.clock.now();
      }
      ctx.run.pendingApproval = null;
      // Restore the phase we were in before the pause. Falls back to
      // 'running' (the umbrella state for Claude-driven work) when no
      // phase marker had advanced state yet.
      const restored: RunState = ctx.priorPhase ?? 'running';
      ctx.run.state = restored;
      ctx.priorPhase = null;
      ctx.approvalDeferred = null;
      // Push a fresh running step for the restored phase so the
      // timeline reflects "resumed `committing`" instead of having the
      // approval step bleed into the next phase marker without a clear
      // boundary.
      ctx.run.steps.push({
        state: restored,
        userVisibleLabel: USER_VISIBLE_LABELS[restored],
        status: 'running',
        startedAt: this.clock.now(),
      });
      this.emitStateChanged(ctx);
      this.emit('current-changed', { run: deepCloneRun(ctx.run) });
      await this.persist(ctx);
    } else {
      // Already moved on — at minimum clear the deferred + pending approval
      // so subsequent calls see a coherent state, but don't touch
      // run.state / steps.
      ctx.run.pendingApproval = null;
      ctx.priorPhase = null;
      ctx.approvalDeferred = null;
    }
  }

  // -- Helpers -------------------------------------------------------------

  private async resolveApproval(
    runId: string,
    response: ApprovalResponse,
  ): Promise<RunnerResult<{ runId: string }>> {
    const ctx = this.active;
    if (ctx === null || ctx.run.id !== runId) {
      return {
        ok: false,
        error: {
          code: 'NOT_RUNNING',
          message:
            ctx === null
              ? 'no active run'
              : `runId mismatch: active runId is ${ctx.run.id}, got ${runId}`,
        },
      };
    }
    if (ctx.approvalDeferred === null || ctx.run.state !== 'awaitingApproval') {
      return {
        ok: false,
        error: {
          code: 'NOT_AWAITING_APPROVAL',
          message: 'no approval is currently pending',
        },
      };
    }
    ctx.approvalDeferred.resolve(response);
    return { ok: true, data: { runId } };
  }

  private emitStateChanged(ctx: ActiveRunCtx): void {
    const event: RunStateEvent = {
      runId: ctx.run.id,
      run: deepCloneRun(ctx.run),
    };
    this.emit('state-changed', event);
  }

  /**
   * Persist the run to RunStore. Failures here are logged but do NOT crash
   * the runner — incremental persistence is a nice-to-have, the in-memory
   * state machine is the source of truth while a run is live.
   */
  private async persist(ctx: ActiveRunCtx): Promise<void> {
    try {
      const res = await this.options.runStore.save(deepCloneRun(ctx.run));
      if (!res.ok) {

        console.warn(
          `[workflow-runner] run-store.save failed: ${res.error.code} - ${res.error.message}`,
        );
      }
    } catch (err) {

      console.warn(
        `[workflow-runner] run-store.save threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // -- Typed event listener overloads --------------------------------------

  override on(event: 'state-changed', listener: (e: RunStateEvent) => void): this;
  override on(event: 'current-changed', listener: (e: { run: Run | null }) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override on(event: string | symbol, listener: (...args: any[]) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  override emit(event: 'state-changed', e: RunStateEvent): boolean;
  override emit(event: 'current-changed', e: { run: Run | null }): boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override emit(event: string | symbol, ...args: any[]): boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override emit(event: string | symbol, ...args: any[]): boolean {
    return super.emit(event, ...args);
  }
}
