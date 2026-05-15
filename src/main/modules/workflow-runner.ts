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
import type { WorktreeManager } from './worktree-manager.js';

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
 * GH-52 expanded the set so the timeline mirrors the full skill workflow
 * — fetchingTicket, understandingContext, planning, implementing,
 * evaluatingTests, reviewingCode are all visible phases driven by the
 * skill, alongside the original ship-time phases.
 *
 * NB: `running` and `awaitingApproval` are deliberately excluded.
 *   - `running` is the runner-internal umbrella state entered before the
 *     skill emits its first phase marker; phase markers narrow it to a
 *     sub-phase, not back to itself.
 *   - `awaitingApproval` is driven by approval markers, not phase markers
 *     (per the spec — phase markers MUST NOT transition into a paused
 *     state, otherwise the resume path becomes ambiguous).
 */
const PHASE_VALUES: ReadonlySet<RunState> = new Set<RunState>([
  'fetchingTicket',
  'branching',
  'understandingContext',
  'planning',
  'implementing',
  'evaluatingTests',
  'reviewingCode',
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
 * plumbing (locking, preparing, the `running` umbrella, unlocking) and
 * shouldn't surface in the UI timeline.
 *
 * GH-52: `running` is now hidden — it's the umbrella state the runner
 * enters before the skill emits its first phase marker, not a visible
 * step. The skill emits `implementing` to mark the actual feature-build
 * phase. `branching` is now visible too, because the skill creates the
 * branch as a meaningful user-facing step (was a runner-internal stub).
 */
const USER_VISIBLE_LABELS: Record<RunState, string | null> = {
  idle: null,
  locking: null,
  preparing: null,
  fetchingTicket: 'Fetching ticket',
  branching: 'Setting up branch',
  understandingContext: 'Understanding context',
  planning: 'Planning',
  running: null,
  awaitingApproval: 'Awaiting approval',
  implementing: 'Implementing feature',
  evaluatingTests: 'Evaluating tests',
  reviewingCode: 'Reviewing code',
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
   * Per-run git worktree manager (#GH-72). The runner asks for a fresh
   * worktree on `start` and removes it on terminal status, so each run
   * gets its own isolated checkout. PR A wires the existing single-run
   * path through worktrees; PR B drops the app-wide lock and lets
   * concurrent runs coexist (each with its own worktree).
   */
  worktreeManager: WorktreeManager;
  /**
   * Read-only adapter over the ticket poller's per-project cache. The runner
   * uses it ONLY to resolve a ticket's `summary` by `key` so branch + commit
   * derivation reads "feat/GH-31-show-app-version" instead of the previous
   * "feat/GH-31-gh-31" (#35). Optional — runner falls back to using the key
   * as the summary if the ticket isn't in the cache (e.g. a fresh process
   * before the first poll, or a ticket the poller never saw).
   */
  ticketPoller?: { list: (projectId: string) => Ticket[] };
  /**
   * Read-only adapter over the app-config store (#GH-86). When provided, the
   * runner asks for the current `defaultRunTimeoutMin` immediately before
   * spawning Claude and threads it into `ClaudeProcessManager.run` as
   * `timeoutMs`. The read happens per-run so a user can edit the default
   * mid-session and have the next run pick it up without a restart.
   *
   * Optional — when omitted (or when the read fails) the runner passes no
   * `timeoutMs`, letting `ClaudeProcessManager` apply its built-in default
   * (30 min). Tests can leave this out without changing the legacy timeout
   * behavior.
   */
  appConfig?: { get: () => Promise<{ ok: true; data: { defaultRunTimeoutMin: number } } | { ok: false; error: unknown }> };
  /** Test injection. Defaults to `Date.now()`. */
  clock?: { now: () => number };
  /**
   * Optional global config adapter (#GH-85). When provided, the runner
   * reads `claudeCliPath` from it on each Claude spawn and passes it as
   * the per-run `command` override — so a Settings → Claude CLI override
   * takes effect on the next run without app restart. Optional so test
   * setups that don't care about the override path stay terse.
   */
  appConfigAdapter?: {
    get: () => Promise<
      | { ok: true; data: { claudeCliPath: string | null } }
      | { ok: false; error: { code: string; message: string } }
    >;
  };
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

/**
 * Thrown by `runClaudeWithApprovals` when the Claude CLI exits cleanly while
 * a `dispatchApproval` coroutine is still awaiting user input (#GH-73).
 *
 * Background: skills run under `claude -p` (print / single-turn) which
 * exits after one turn — there is no inter-turn stdin read available, so
 * any skill that emits `<<<EF_APPROVAL_REQUEST>>>` and then "reads stdin"
 * per the SKILL.md contract is making a request the spawn-mode cannot
 * honour. Without this guard the pipeline would march to `done` with no
 * code changes (the skill never got past the approval gate) while the
 * dispatchApproval coroutine sat forever on an orphaned `await`.
 *
 * The proper fix is to re-architect the approval flow so it doesn't
 * depend on Claude reading stdin mid-turn — filed as a follow-up to
 * GH-73. This error makes the failure mode loud + correct in the
 * meantime: the run terminates `failed` with a clear message instead
 * of the silent `done` users were seeing.
 */
class ApprovalAbandonedError extends Error {
  constructor() {
    super(
      'Claude exited while still awaiting a response to an EF_APPROVAL_REQUEST. ' +
        "Skills cannot block on stdin under e-frank's print-mode (`claude -p`) spawn — " +
        'see GH-73 follow-up for the approval-flow re-architecture.',
    );
    this.name = 'ApprovalAbandonedError';
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
  /**
   * Active runs, keyed by runId (#GH-79 / #GH-72 PR B). Pre-PR-B this was a
   * single `ActiveRunCtx | null` slot; PR B replaces it with a map so the
   * runner supports multiple concurrent runs (each with its own worktree
   * from PR A). The app-wide `ALREADY_RUNNING` check is dropped — the
   * per-ticket cross-session lock from #GH-13 still prevents starting the
   * same ticket twice. Insertion order matters: `current()` returns the
   * FIRST inserted run for back-compat with legacy singular callers.
   */
  private readonly active = new Map<string, ActiveRunCtx>();

  constructor(options: WorkflowRunnerOptions) {
    super();
    this.options = options;
    this.clock = options.clock ?? { now: () => Date.now() };
  }

  // -- Public API ----------------------------------------------------------

  current(): Run | null {
    if (this.active.size === 0) return null;
    // Return the FIRST inserted run for back-compat with legacy singular
    // callers (which assumed there was ever only one). Plural callers
    // should use `listActive()` instead.
    const first = this.active.values().next().value;
    if (first === undefined) return null;
    return deepCloneRun(first.run);
  }

  /**
   * Returns every in-flight run as a Run[] (#GH-79). Plural counterpart
   * to `current()`. Used by the renderer's `useGlobalActiveRuns` /
   * `useActiveRuns(projectId)` hooks and the new `runs:list-active` IPC.
   */
  listActive(): Run[] {
    const out: Run[] = [];
    for (const ctx of this.active.values()) {
      out.push(deepCloneRun(ctx.run));
    }
    return out;
  }

  async start(req: StartRunRequest): Promise<RunnerResult<{ run: Run }>> {
    // #GH-79: app-wide ALREADY_RUNNING check is dropped — concurrent runs
    // are supported. The per-ticket cross-session lock below (GH-13)
    // still prevents the SAME ticket from being double-started.
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

    // In-memory per-ticket check (#GH-79). Pre-#GH-79 the app-wide
    // `this.active !== null` guard caught any duplicate start synchronously.
    // With concurrent runs allowed, the cross-session pre-check below isn't
    // sufficient on its own: `runHistory.markRunning` is async (queued
    // through enqueue), so a second start() for the same ticket can pass
    // the pre-check before the first start's lock has persisted. Walking
    // `this.active.values()` catches in-process duplicates synchronously.
    for (const ctx of this.active.values()) {
      if (ctx.run.projectId === req.projectId && ctx.run.ticketKey === req.ticketKey) {
        return {
          ok: false,
          error: {
            code: 'ALREADY_RUNNING',
            message: `a run is already active for ticket "${req.ticketKey}" (runId=${ctx.run.id})`,
          },
        };
      }
    }

    // Cross-session per-ticket lock (GH-13). Catches orphans from a previous
    // app session that crashed mid-run and left a lock behind.
    // `releaseStaleLocks(0)` at startup should clear these on boot; this
    // guard catches the rare race where a different in-flight runner
    // instance (or a bug elsewhere) left a lock behind anyway.
    const existingLocks = this.options.runHistory.getRunningWithMetadata(req.projectId);
    const orphaned = existingLocks.find((entry) => entry.key === req.ticketKey);
    if (orphaned !== undefined) {
      const lockedDesc =
        orphaned.lockedAt > 0
          ? `started ${new Date(orphaned.lockedAt).toISOString()}`
          : 'started before the last app restart';
      return {
        ok: false,
        error: {
          code: 'ALREADY_RUNNING',
          message:
            `ticket ${req.ticketKey} is already locked (${lockedDesc}); ` +
            'the previous run may have crashed and the lock was not auto-cleared on startup — ' +
            'check the app logs for stale-lock recovery warnings, or remove the entry from ' +
            'run-history.json in the app userData directory',
        },
      };
    }
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
      // Only persist when distinct from the key — a fallback summary equal
      // to the key just adds noise (the UI already renders "{key} — …" so
      // duplicating it would read as "ABC-123 — ABC-123").
      ...(ticketSummary !== req.ticketKey ? { ticketSummary } : {}),
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
    this.active.set(run.id, ctx);
    // #GH-79: emit a plural snapshot every time the active-set changes,
    // so renderer hooks subscribing to `runs-changed` see the fresh shape
    // without polling.
    this.emitRunsChanged();

    // Fire-and-forget: drive the pipeline asynchronously so `start()` returns
    // immediately with the initial Run snapshot. Consumers track progress
    // via state-changed / current-changed events.
    void this.runPipeline(ctx, project, ticketSummary).catch((err) => {

      console.error('[workflow-runner] pipeline crashed unexpectedly:', err);
    });

    return { ok: true, data: { run: deepCloneRun(run) } };
  }

  async cancel(runId: string): Promise<RunnerResult<{ runId: string }>> {
    const ctx = this.active.get(runId);
    if (ctx === undefined) {
      return {
        ok: false,
        error: {
          code: 'NOT_RUNNING',
          message: `no active run with runId="${runId}"`,
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
    const repoPath = project.repo.localPath;
    /**
     * #GH-72: each run gets its own isolated git worktree (a sibling
     * checkout under `worktreesRoot`) so it can't race with the user's
     * primary working tree or with other runs. The worktree is created
     * once at the start of the pipeline and torn down unconditionally
     * after the terminal state — the `finally`-equivalent cleanup below
     * handles failure / cancel paths the same as success.
     *
     * `worktreeCwd` is `null` until `addWorktree` succeeds; if creation
     * fails the pipeline routes to `failed` before claude is even spawned.
     */
    let worktreeCwd: string | null = null;
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
        // After lock acquisition, allocate the isolated worktree. Done
        // inside `locking` (rather than its own pipeline phase) because
        // it's an implementation detail of preparing the workspace —
        // the user-visible timeline shouldn't gain a "worktree-add" step.
        const wt = await this.options.worktreeManager.addWorktree({
          runId: ctx.run.id,
          baseBranch: project.repo.baseBranch,
          repoPath,
        });
        if (!wt.ok) {
          throw new Error(
            `worktree.add failed: ${wt.error.code} - ${wt.error.message}`,
          );
        }
        worktreeCwd = wt.data.cwd;
      });

      // -- running -- (Claude takes over: spawns the skill, drives git/
      //               PR/ticket via its own Bash tool, emits phase markers
      //               so the runner can keep `Run.state` honest, emits
      //               approval markers to pause for human review.)
      await this.runState(ctx, 'running', async () => {
        // worktreeCwd is non-null here: the `locking` block above either
        // assigned it or threw, in which case we wouldn't reach this state.
        // The runtime check appeases TS's `let | null` narrowing.
        if (worktreeCwd === null) {
          throw new Error('internal: worktreeCwd missing after locking phase');
        }
        await this.runClaudeWithApprovals(ctx, worktreeCwd);
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

    // -- worktree cleanup -- (#GH-72; runs on every terminal path).
    // Idempotent — `removeWorktree` no-ops if the directory is absent,
    // so an `addWorktree` failure earlier doesn't make this throw. We
    // log failures but never propagate them: a stuck worktree is a
    // disk-clutter problem, not a reason to surface the run as failed.
    if (worktreeCwd !== null) {
      const rm = await this.options.worktreeManager.removeWorktree({
        runId: ctx.run.id,
        repoPath,
      });
      if (!rm.ok) {
        console.warn(
          `[workflow-runner] worktree.remove failed for runId=${ctx.run.id}: ${rm.error.code} - ${rm.error.message}`,
        );
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

    // Emit current-changed with the final run snapshot first, then delete
    // this run from the active map.
    this.emit('current-changed', { run: deepCloneRun(ctx.run) });
    this.active.delete(ctx.run.id);
    // Detach any lingering claude listeners.
    if (ctx.detachOutputListener !== null) {
      ctx.detachOutputListener();
      ctx.detachOutputListener = null;
    }
    if (ctx.detachExitListener !== null) {
      ctx.detachExitListener();
      ctx.detachExitListener = null;
    }
    // #GH-79: only signal "no active runs" via the legacy current-changed
    // contract when the entire active map is empty. Siblings that are still
    // in flight keep the runner "active" from a legacy-subscriber POV.
    // Always fire runs-changed so plural subscribers see the new shape.
    if (this.active.size === 0) {
      this.emit('current-changed', { run: null });
    }
    this.emitRunsChanged();
  }

  /**
   * Emit the plural `runs-changed` event with the current set of in-flight
   * runs (#GH-79). Called on every active-map mutation: a new `start()`,
   * a run reaching terminal state. The runtime cost is one snapshot per
   * mutation, which is bounded by user-driven run starts/finishes — not
   * by per-state-transition churn.
   */
  private emitRunsChanged(): void {
    const runs: Run[] = [];
    for (const ctx of this.active.values()) {
      runs.push(deepCloneRun(ctx.run));
    }
    this.emit('runs-changed', { runs });
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
    // #GH-85: resolve the Claude CLI override from appConfig (if the
    // adapter is wired up — it is in main, tests can skip it). A `null`
    // or missing override falls back to the manager's default command.
    let commandOverride: string | undefined;
    if (this.options.appConfigAdapter !== undefined) {
      const cfg = await this.options.appConfigAdapter.get();
      if (cfg.ok) {
        if (cfg.data.claudeCliPath !== null && cfg.data.claudeCliPath.trim() !== '') {
          commandOverride = cfg.data.claudeCliPath;
        }
      } else {
        // Don't fail the run — log loud and fall back to PATH. A corrupt
        // config shouldn't stop work, but a silent fallback would make
        // "my Claude override isn't being used" impossible to debug.
        console.warn(
          `[workflow-runner] appConfigAdapter.get failed: ${cfg.error.code} - ${cfg.error.message}; ` +
            'falling back to default claude command',
        );
      }
    }

    // #GH-86: resolve the per-run timeout from app-config. Read fresh per
    // run so live edits to the default flow through without a restart.
    // Omit the field entirely when there's no adapter / the read fails,
    // letting ClaudeProcessManager fall back to its built-in default.
    let timeoutMs: number | undefined;
    if (this.options.appConfig !== undefined) {
      try {
        const res = await this.options.appConfig.get();
        if (res.ok) {
          timeoutMs = res.data.defaultRunTimeoutMin * 60 * 1000;
        }
      } catch {
        // Swallow — leave timeoutMs undefined so the manager applies its
        // built-in default. A bad config read shouldn't fail the run.
      }
    }

    const startRes = this.options.claudeManager.run({
      ticketKey: ctx.run.ticketKey,
      cwd,
      command: commandOverride,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
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
      // GH-95: a timeout that fires AFTER the PR has been created is treated
      // as completed-with-warning rather than failed. The user-visible work
      // (branch + commit + push + PR) shipped; only the tail (ticket update
      // / memory-bank refresh) was cut short. We stamp `terminalWarning` and
      // return so the pipeline continues down the success path. The
      // approval-deferred check below is intentionally skipped — by the time
      // `creatingPr` has stamped prUrl, the planning approval marker has
      // already been resolved (approval markers fire in Phase 3 of the
      // skill, well before Phase 7's PR creation).
      if (
        exitEvent.reason === 'timeout' &&
        ctx.run.prUrl !== undefined &&
        ctx.run.prUrl !== ''
      ) {
        ctx.run.terminalWarning =
          `claude exited with reason="timeout" after PR creation; ` +
          'tail work (ticket update / memory-bank refresh) may not have completed';
        return;
      }
      if (exitEvent.reason !== 'completed' || (exitEvent.exitCode !== null && exitEvent.exitCode !== 0)) {
        throw new Error(
          `claude exited with reason="${exitEvent.reason}" exitCode=${String(exitEvent.exitCode)}`,
        );
      }
      // GH-73: Claude exited cleanly but a dispatchApproval coroutine is still
      // awaiting user input. Under `-p` mode the CLI can't read stdin between
      // turns, so the skill's "wait for approve\n" never fires; without this
      // guard the run would march to `done` with no code changes while the
      // dispatchApproval coroutine sat on an orphaned await. Reject the
      // deferred so dispatchApproval's catch can clean up (idempotently), then
      // throw so the pipeline body catch routes the run to `failed`.
      if (ctx.approvalDeferred !== null) {
        const deferred = ctx.approvalDeferred;
        ctx.approvalDeferred = null;
        const err = new ApprovalAbandonedError();
        deferred.reject(err);
        throw err;
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
   *
   * GH-52 dedupe: if the incoming phase already matches the current state
   * AND the last step is still running, treat the marker as a re-announce
   * and drop it. The skill is supposed to emit each phase marker exactly
   * once per run; this guard makes the runner robust to a misbehaving
   * skill (e.g. one that re-emits `committing` on approval-resume) so the
   * timeline doesn't accumulate duplicate steps. It also lets the
   * approval-resume path push a fresh phase step without worrying that
   * the skill's next marker will spawn a second one.
   */
  private transitionToPhase(ctx: ActiveRunCtx, phase: RunState): void {
    const lastIdx = ctx.run.steps.length - 1;
    const lastStep = ctx.run.steps[lastIdx];
    if (
      ctx.run.state === phase &&
      lastStep !== undefined &&
      lastStep.state === phase &&
      lastStep.status === 'running'
    ) {
      return;
    }
    this.closeLastRunningStep(ctx);
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

  /**
   * Close the most recent step IF it's still `running`. Used by both
   * `transitionToPhase` (when the next phase marker arrives) and
   * `dispatchApproval` (when the runner enters `awaitingApproval`) so the
   * runner never has two simultaneously-running steps in its timeline.
   * No-op when there's no running tail step.
   */
  private closeLastRunningStep(ctx: ActiveRunCtx): void {
    const lastIdx = ctx.run.steps.length - 1;
    const lastStep = ctx.run.steps[lastIdx];
    if (lastStep !== undefined && lastStep.status === 'running') {
      lastStep.status = 'done';
      lastStep.finishedAt = this.clock.now();
    }
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

    // GH-52 #4: close the prior in-flight phase step BEFORE pushing
    // the awaitingApproval step. Without this, the timeline reads as
    // two simultaneously-running steps (e.g. `planning` (running) +
    // `awaitingApproval` (running)) and the user can't tell which
    // step the run is actually paused on. We close the prior step
    // here even though the body code in runState would eventually
    // close it — we need the state to be coherent the moment
    // `awaitingApproval` is observable to the renderer.
    this.closeLastRunningStep(ctx);

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
      // Two rejection paths land here:
      //   1. `cancel()` rejects the deferred while the run is paused on
      //      approval → state is still `awaitingApproval` → we clean up
      //      and re-throw so the running-state body sees the cancellation.
      //   2. GH-73: `runClaudeWithApprovals` rejects the deferred because
      //      Claude exited cleanly while we were still awaiting input. By
      //      the time this catch runs as a microtask, the pipeline catch
      //      has already moved the run to `failed`. Mutating state here
      //      would clobber that.
      //
      // Mitigation: only run the state cleanup if we're still in
      // `awaitingApproval`. If the pipeline already advanced, the catch
      // becomes a no-op — we just re-throw so the orphan path falls out.
      cancelledFromCallback = true;
      const lastIdx = ctx.run.steps.length - 1;
      const lastStep = ctx.run.steps[lastIdx];
      const stillAwaiting =
        ctx.run.state === 'awaitingApproval' &&
        lastStep !== undefined &&
        lastStep.state === 'awaitingApproval' &&
        lastStep.status === 'running';
      if (stillAwaiting) {
        lastStep.status = 'done';
        lastStep.finishedAt = this.clock.now();
        ctx.run.pendingApproval = null;
        // Restore the phase we were in before the pause; default to
        // 'running' for the legacy single-phase case.
        ctx.run.state = ctx.priorPhase ?? 'running';
        ctx.priorPhase = null;
        ctx.approvalDeferred = null;
        this.emitStateChanged(ctx);
        this.emit('current-changed', { run: deepCloneRun(ctx.run) });
        await this.persist(ctx);
      }
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
    const ctx = this.active.get(runId);
    if (ctx === undefined) {
      return {
        ok: false,
        error: {
          code: 'NOT_RUNNING',
          message: `no active run with runId="${runId}"`,
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
    // #GH-79: state transitions mutate the in-memory Run.state field. The
    // plural snapshot reflects that change too, so subscribers to
    // `runs-changed` see per-transition updates without having to also
    // subscribe to `state-changed`. Bounded cost: one Map.values() walk
    // per transition; current pipeline emits ~10 transitions per run.
    this.emitRunsChanged();
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
  override on(event: 'runs-changed', listener: (e: { runs: Run[] }) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override on(event: string | symbol, listener: (...args: any[]) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  override emit(event: 'state-changed', e: RunStateEvent): boolean;
  override emit(event: 'current-changed', e: { run: Run | null }): boolean;
  override emit(event: 'runs-changed', e: { runs: Run[] }): boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override emit(event: string | symbol, ...args: any[]): boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override emit(event: string | symbol, ...args: any[]): boolean {
    return super.emit(event, ...args);
  }
}
