import { describe, it, expect, vi, type MockInstance } from 'vitest';
import { EventEmitter } from 'node:events';
import { WorkflowRunner } from '../../src/main/modules/workflow-runner';
import { RunHistory } from '../../src/main/modules/run-history';
import { RunStore } from '../../src/main/modules/run-store';
import { StubGitManager } from '../../src/main/modules/git-manager';
import { StubPrCreator } from '../../src/main/modules/pr-creator';
import { StubJiraUpdater } from '../../src/main/modules/jira-updater';
import type {
  GitManager,
  GitResult,
  PrepareRepoRequest,
  CreateBranchRequest,
  CommitRequest,
  PushRequest,
} from '../../src/main/modules/git-manager';
import type {
  PrCreator,
  PrResult,
  CreatePrRequest,
} from '../../src/main/modules/pr-creator';
import type {
  JiraUpdater,
  JiraUpdateResult,
  UpdateTicketRequest,
} from '../../src/main/modules/jira-updater';
import type {
  ClaudeProcessManager,
  RunRequest as ClaudeRunRequest,
  RunResponse as ClaudeRunResponse,
  RunResult as ClaudeRunResult,
  OutputEvent,
  ExitEvent,
} from '../../src/main/modules/claude-process-manager';
import type { ProjectStoreFs } from '../../src/main/modules/project-store';
import type { Run, RunStateEvent } from '../../src/shared/schema/run';
import type { ProjectInstance } from '../../src/shared/schema/project-instance';

/**
 * WFR-001..030 — WorkflowRunner state machine.
 *
 * Strategy:
 *  - All "leaf" subsystems (project store, secrets, git, pr, jira-update,
 *    claude) are injected. The runner is exercised under these test doubles.
 *  - `FakeClaudeProcessManager` is an `EventEmitter` that mocks `run` /
 *    `cancel` / `write` and exposes `emitOutput()` / `emitExit()` so tests
 *    can drive state transitions deterministically.
 *  - For event sequencing tests (WFR-024 / WFR-025) we collect every
 *    `state-changed` and `current-changed` event in arrays and assert the
 *    full ordering at the end.
 *  - For "fails mid-pipeline" tests (WFR-010..014) we swap the relevant stub
 *    for a one-off failing impl and assert state==='failed' (or the
 *    specific spec policy for jira.update).
 *
 * Key spec rules baked into the harness:
 *  - Single active run; second start → ALREADY_RUNNING.
 *  - TicketKey regex /^[A-Z][A-Z0-9_]*-\d+$/.
 *  - On Claude approval marker (interactive): runner pauses → awaitingApproval.
 *  - On Claude approval marker (yolo): runner immediately writes "approve\n".
 *  - Failure / cancel always reaches `unlocking` for cleanup.
 *  - `current-changed` fires per transition AND once on completion (with null).
 *  - jira.update failure does NOT fail the run (per spec WFR-014).
 */

// ---------------------------------------------------------------------------
// In-memory ProjectStoreFs stub for RunHistory + RunStore.
// ---------------------------------------------------------------------------

function createMemFs(): ProjectStoreFs & { files: Map<string, string> } {
  const files = new Map<string, string>();

  return {
    files,
    async readFile(path: string, _enc: 'utf8'): Promise<string> {
      const content = files.get(path);
      if (content === undefined) {
        const err = new Error(
          `ENOENT: no such file or directory, open '${path}'`,
        ) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return content;
    },
    async writeFile(path: string, data: string, _enc: 'utf8'): Promise<void> {
      files.set(path, data);
    },
    async rename(from: string, to: string): Promise<void> {
      const data = files.get(from);
      if (data === undefined) {
        const err = new Error(
          `ENOENT: rename source missing '${from}'`,
        ) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      files.delete(from);
      files.set(to, data);
    },
    async unlink(path: string): Promise<void> {
      files.delete(path);
    },
    async mkdir(_path: string, _opts: { recursive: true }): Promise<void> {
      // no-op
    },
  };
}

// ---------------------------------------------------------------------------
// FakeClaudeProcessManager — drives `output` / `exit` events when tests call
// `emitOutput` / `emitExit`.
// ---------------------------------------------------------------------------

class FakeClaudeProcessManager extends EventEmitter {
  /** Most recent runId returned from `run`. */
  lastRunId: string | null = null;
  /** All run() requests received, in order. */
  readonly runRequests: ClaudeRunRequest[] = [];
  /** All cancel() calls received, in order. */
  readonly cancelCalls: string[] = [];
  /** Every text written via `write()`, in order. */
  readonly stdinWrites: string[] = [];
  /** When set, the next `run()` call fails with this error code+message. */
  nextRunFails:
    | { code: 'INVALID_TICKET_KEY' | 'INVALID_CWD' | 'ALREADY_RUNNING' | 'SPAWN_FAILED'; message: string }
    | null = null;
  /** Internal monotonic counter so each run gets a unique id. */
  private idCounter = 0;
  /** True if a run is currently active (between run() and emitExit()). */
  private active: boolean = false;

  run(req: ClaudeRunRequest): ClaudeRunResult<ClaudeRunResponse> {
    this.runRequests.push(req);
    if (this.nextRunFails) {
      const err = this.nextRunFails;
      this.nextRunFails = null;
      return { ok: false, error: { code: err.code, message: err.message } };
    }
    if (this.active) {
      return {
        ok: false,
        error: { code: 'ALREADY_RUNNING', message: 'a run is already active' },
      };
    }
    this.idCounter += 1;
    const runId = `claude-run-${this.idCounter}`;
    this.lastRunId = runId;
    this.active = true;
    return {
      ok: true,
      data: { runId, pid: 1000 + this.idCounter, startedAt: Date.now() },
    };
  }

  cancel(runId: string): ClaudeRunResult<{ runId: string }> {
    this.cancelCalls.push(runId);
    if (!this.active) {
      return {
        ok: false,
        error: { code: 'NOT_RUNNING', message: 'no active run to cancel' },
      };
    }
    return { ok: true, data: { runId } };
  }

  write(req: { runId: string; text: string }): ClaudeRunResult<{ bytesWritten: number }> {
    this.stdinWrites.push(req.text);
    if (!this.active) {
      return {
        ok: false,
        error: { code: 'NOT_RUNNING', message: 'no active run to write to' },
      };
    }
    return {
      ok: true,
      data: { bytesWritten: Buffer.byteLength(req.text, 'utf8') },
    };
  }

  status(): { runId: string; pid: number | undefined; startedAt: number } | null {
    if (!this.active || this.lastRunId === null) return null;
    return { runId: this.lastRunId, pid: undefined, startedAt: 0 };
  }

  // ---- Test-only helpers ----------------------------------------------

  emitOutput(line: string, stream: 'stdout' | 'stderr' = 'stdout'): void {
    if (this.lastRunId === null) {
      throw new Error('emitOutput called before run()');
    }
    const event: OutputEvent = {
      runId: this.lastRunId,
      stream,
      line,
      timestamp: Date.now(),
    };
    this.emit('output', event);
  }

  emitExit(
    code: number | null,
    reason: ExitEvent['reason'] = 'completed',
    signal: NodeJS.Signals | null = null,
  ): void {
    if (this.lastRunId === null) {
      throw new Error('emitExit called before run()');
    }
    const event: ExitEvent = {
      runId: this.lastRunId,
      exitCode: code,
      signal,
      durationMs: 0,
      reason,
    };
    this.active = false;
    this.emit('exit', event);
  }
}

// ---------------------------------------------------------------------------
// Project store + secrets manager stubs (the runner needs `get` from each).
// ---------------------------------------------------------------------------

interface FakeProjectStore {
  get: (id: string) => Promise<
    | { ok: true; data: ProjectInstance }
    | { ok: false; error: { code: string; message: string } }
  >;
}

interface FakeSecretsManager {
  get: (
    ref: string,
  ) => Promise<
    | { ok: true; data: { plaintext: string } }
    | { ok: false; error: { code: string; message: string } }
  >;
}

function makeFakeProject(over: Partial<ProjectInstance> = {}): ProjectInstance {
  return {
    id: 'p-1',
    name: 'My Project',
    repo: {
      type: 'github',
      localPath: '/abs/repo',
      baseBranch: 'main',
      connectionId: 'conn-gh-1',
      slug: 'gazhang/repo',
    },
    tickets: {
      source: 'jira',
      connectionId: 'conn-jr-1',
      projectKey: 'ABC',
      query: 'project = ABC',
    },
    workflow: { mode: 'interactive', branchFormat: 'feature/{ticketKey}-{slug}' },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function makeFakeProjectStore(project: ProjectInstance | null): FakeProjectStore {
  return {
    async get(id) {
      if (project === null || project.id !== id) {
        return { ok: false, error: { code: 'NOT_FOUND', message: 'no project' } };
      }
      return { ok: true, data: project };
    },
  };
}

function makeFakeSecretsManager(): FakeSecretsManager {
  return {
    async get(_ref) {
      return { ok: true, data: { plaintext: 'fake-token' } };
    },
  };
}

// ---------------------------------------------------------------------------
// Failing one-off subsystem stubs.
// ---------------------------------------------------------------------------

function makeFailingGitManager(over: {
  prepareRepo?: GitResult<{ baseSha: string }>;
  createBranch?: GitResult<{ branchName: string }>;
  commit?: GitResult<{ sha: string }>;
  push?: GitResult<{ remoteUrl?: string }>;
}): GitManager {
  const fallback = new StubGitManager();
  return {
    async prepareRepo(req: PrepareRepoRequest): Promise<GitResult<{ baseSha: string }>> {
      if (over.prepareRepo) return over.prepareRepo;
      return fallback.prepareRepo(req);
    },
    async createBranch(req: CreateBranchRequest): Promise<GitResult<{ branchName: string }>> {
      if (over.createBranch) return over.createBranch;
      return fallback.createBranch(req);
    },
    async commit(req: CommitRequest): Promise<GitResult<{ sha: string }>> {
      if (over.commit) return over.commit;
      return fallback.commit(req);
    },
    async push(req: PushRequest): Promise<GitResult<{ remoteUrl?: string }>> {
      if (over.push) return over.push;
      return fallback.push(req);
    },
  };
}

// `makeFailingPrCreator` was removed — its only consumer was WFR-013, which
// is now skipped (the runner no longer calls prCreator after #37). The
// helper would be dead code; the type imports it referenced are still used
// by the spy harness in WFR-035 (no-git/PR/Jira invariant test).

function makeFailingJiraUpdater(
  result: JiraUpdateResult<{ ticketKey: string }>,
): JiraUpdater {
  return {
    async update(_req: UpdateTicketRequest): Promise<JiraUpdateResult<{ ticketKey: string }>> {
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Harness — wires up a fresh runner with controllable subsystems.
// ---------------------------------------------------------------------------

interface HarnessOptions {
  project?: ProjectInstance | null;
  gitManager?: GitManager;
  prCreator?: PrCreator;
  jiraUpdater?: JiraUpdater;
}

interface Harness {
  runner: WorkflowRunner;
  fakeClaude: FakeClaudeProcessManager;
  runHistory: RunHistory;
  runStore: RunStore;
  projectStore: FakeProjectStore;
  secretsManager: FakeSecretsManager;
  gitManager: GitManager;
  prCreator: PrCreator;
  jiraUpdater: JiraUpdater;
  /** Captured `state-changed` events, in firing order. */
  stateEvents: RunStateEvent[];
  /** Captured `current-changed` events, in firing order. */
  currentEvents: { run: Run | null }[];
  /** Spies for verifying RunHistory calls. Typed loosely because Vitest's
   * spy type is strict-per-method and the harness shares one Harness shape. */
  markRunningSpy: MockInstance;
  clearRunningSpy: MockInstance;
  /** Spy for verifying RunStore.save was called. */
  saveSpy: MockInstance;
}

async function buildHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const project = opts.project === undefined ? makeFakeProject() : opts.project;
  const projectStore = makeFakeProjectStore(project);
  const secretsManager = makeFakeSecretsManager();

  const fs = createMemFs();
  const runHistory = new RunHistory({
    filePath: '/userData/run-history.json',
    fs,
  });
  await runHistory.init();
  const runStore = new RunStore({ runsDir: '/userData/runs', fs });
  await runStore.init();

  const gitManager = opts.gitManager ?? new StubGitManager();
  const prCreator = opts.prCreator ?? new StubPrCreator();
  const jiraUpdater = opts.jiraUpdater ?? new StubJiraUpdater();

  const fakeClaude = new FakeClaudeProcessManager();
  const claudeManager = fakeClaude as unknown as ClaudeProcessManager;

  const markRunningSpy = vi.spyOn(runHistory, 'markRunning');
  const clearRunningSpy = vi.spyOn(runHistory, 'clearRunning');
  const saveSpy = vi.spyOn(runStore, 'save');

  const runner = new WorkflowRunner({
    projectStore,
    secretsManager,
    runHistory,
    runStore,
    claudeManager,
    gitManager,
    prCreator,
    jiraUpdater,
  });

  const stateEvents: RunStateEvent[] = [];
  const currentEvents: { run: Run | null }[] = [];
  runner.on('state-changed', (e) => {
    stateEvents.push(e);
  });
  runner.on('current-changed', (e) => {
    currentEvents.push(e);
  });

  return {
    runner,
    fakeClaude,
    runHistory,
    runStore,
    projectStore,
    secretsManager,
    gitManager,
    prCreator,
    jiraUpdater,
    stateEvents,
    currentEvents,
    markRunningSpy,
    clearRunningSpy,
    saveSpy,
  };
}

// ---------------------------------------------------------------------------
// Helpers — wait for state / final outcome / etc.
// ---------------------------------------------------------------------------

async function waitForState(
  harness: Harness,
  state: Run['state'],
  timeoutMs = 2_000,
): Promise<Run> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const cur = harness.runner.current();
    if (cur && cur.state === state) return cur;
    // Also check fired events — some states are entered + exited in the same
    // microtask, so `current()` may already have moved on.
    for (const ev of harness.stateEvents) {
      if (ev.run.state === state) return ev.run;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(
    `waitForState(${state}) timed out. last state=${harness.runner.current()?.state ?? 'null'}`,
  );
}

async function waitForFinal(harness: Harness, timeoutMs = 5_000): Promise<Run> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (harness.runner.current() === null && harness.stateEvents.length > 0) {
      // The last state event is the final one (current() has been cleared).
      const last = harness.stateEvents[harness.stateEvents.length - 1];
      if (last && (last.run.state === 'done' || last.run.state === 'failed' || last.run.state === 'cancelled')) {
        return last.run;
      }
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(
    `waitForFinal timed out. eventCount=${harness.stateEvents.length} ` +
      `last state=${harness.stateEvents[harness.stateEvents.length - 1]?.run.state ?? 'none'}`,
  );
}

/**
 * Drive the Claude phase of a happy-path run: wait for `running`, emit a
 * single output line, then emit a clean exit (code 0, reason 'completed').
 */
async function driveClaudeHappyPath(harness: Harness): Promise<void> {
  await waitForState(harness, 'running');
  harness.fakeClaude.emitOutput('working...\n');
  // Brief tick so the runner sees the output before exit.
  await new Promise((r) => setTimeout(r, 0));
  harness.fakeClaude.emitExit(0, 'completed');
}

const VALID_TICKET = 'ABC-1';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowRunner', () => {
  // -------------------------------------------------------------------------
  // WFR-001 — happy path interactive (no checkpoint markers)
  // -------------------------------------------------------------------------
  describe('WFR-001 happy path interactive (no checkpoints)', () => {
    it('WFR-001: traverses all states and ends in done', async () => {
      const h = await buildHarness();
      const start = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(start.ok).toBe(true);

      // Drive Claude past the "running" state to completion.
      void driveClaudeHappyPath(h);

      const final = await waitForFinal(h);
      expect(final.state).toBe('done');
      expect(final.status).toBe('done');

      // RunHistory: lock engaged + released. The processed-set machinery
      // was removed; source-side state (issue closed) is now authoritative
      // for "this ticket is done."
      expect(h.markRunningSpy).toHaveBeenCalledWith('p-1', VALID_TICKET);
      expect(h.clearRunningSpy).toHaveBeenCalledWith('p-1', VALID_TICKET);

      // RunStore.save was called at least once (per WFR-026 — ideally per
      // transition, but this assertion is conservative).
      expect(h.saveSpy).toHaveBeenCalled();

      // The full state pipeline traversed in order. After #37 the runner
      // is a thin host: only `locking`, `running`, `unlocking`, and the
      // terminal `done` are entered by the runner itself. The legacy
      // `preparing | branching | committing | pushing | creatingPr |
      // updatingTicket` are now driven by phase markers from Claude;
      // none of those are emitted by `driveClaudeHappyPath` (which just
      // simulates a clean Claude exit), so they don't appear here.
      const seenStates = new Set(h.stateEvents.map((e) => e.run.state));
      const expected: Run['state'][] = [
        'locking',
        'running',
        'unlocking',
        'done',
      ];
      for (const s of expected) {
        expect(seenStates.has(s)).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // WFR-002 — happy path yolo
  // -------------------------------------------------------------------------
  describe('WFR-002 happy path yolo', () => {
    it('WFR-002: same pipeline succeeds in yolo mode', async () => {
      const h = await buildHarness({
        project: makeFakeProject({
          workflow: {
            mode: 'yolo',
            branchFormat: 'feature/{ticketKey}-{slug}',
          },
        }),
      });
      const start = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(start.ok).toBe(true);

      void driveClaudeHappyPath(h);

      const final = await waitForFinal(h);
      expect(final.state).toBe('done');
      expect(final.mode).toBe('yolo');
    });
  });

  // -------------------------------------------------------------------------
  // WFR-003 — second start while another active
  // -------------------------------------------------------------------------
  describe('WFR-003 single active run', () => {
    it('WFR-003: second start() while another is active → ALREADY_RUNNING', async () => {
      const h = await buildHarness();
      const first = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(first.ok).toBe(true);

      const second = await h.runner.start({
        projectId: 'p-1',
        ticketKey: 'ABC-2',
      });
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.error.code).toBe('ALREADY_RUNNING');

      // Drive the first to completion to clean up.
      void driveClaudeHappyPath(h);
      await waitForFinal(h);
    });
  });

  // -------------------------------------------------------------------------
  // WFR-CROSS-SESSION-LOCK — GH-13 cross-session orphaned-lock rejection
  // -------------------------------------------------------------------------
  describe('WFR-CROSS-SESSION-LOCK (GH-13)', () => {
    it('rejects start() when a leftover RunHistory lock exists for the ticket', async () => {
      const h = await buildHarness();
      // Simulate a crashed previous session: a lock survived in RunHistory
      // but no in-process run is active (h.runner.active === null because
      // we haven't called start() yet). markRunning is invoked directly so
      // the runner's start() path encounters the lock the way it would on
      // a real fresh-launch where releaseStaleLocks somehow missed it (or
      // before that hook ran).
      const mark = await h.runHistory.markRunning('p-1', VALID_TICKET);
      expect(mark.ok).toBe(true);

      const res = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('ALREADY_RUNNING');
      // The message must distinguish the cross-session case from the
      // in-process duplicate (which says "a run is already active") so
      // the renderer banner gives the user actionable context.
      expect(res.error.message).toContain('already locked');
      // Wording specifically tells the user the lock was NOT auto-cleared
      // on startup (i.e. restarting the app won't fix this — startup
      // already tried). Pointing at run-history.json gives an escape hatch.
      expect(res.error.message).toContain('run-history.json');
      expect(res.error.message).not.toContain('restart the app to clear');
    });

    it('uses the "before the last app restart" wording for v1-migrated locks (lockedAt=0 sentinel)', async () => {
      const h = await buildHarness();
      // Directly mutate the runHistory envelope to inject a lockedAt=0
      // entry, simulating a v1-migrated lock that survived startup
      // releaseStaleLocks (e.g. the release failed and only warned).
      // Use a private cast — this is the only test path that needs to
      // observe the sentinel branch of the message.
      const internal = h.runHistory as unknown as {
        envelope: { runs: Record<string, { running: { key: string; lockedAt: number }[] }> };
      };
      internal.envelope.runs['p-1'] = { running: [{ key: VALID_TICKET, lockedAt: 0 }] };

      const res = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('ALREADY_RUNNING');
      expect(res.error.message).toContain('before the last app restart');
    });

    it('cross-session check does not fire when the lock is for a different ticket', async () => {
      const h = await buildHarness();
      await h.runHistory.markRunning('p-1', 'OTHER-99');

      const res = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(res.ok).toBe(true);

      // Drive Claude to completion so the harness cleans up.
      void driveClaudeHappyPath(h);
      await waitForFinal(h);
    });

    it('cross-session check does not fire when the lock is for a different project', async () => {
      const h = await buildHarness();
      await h.runHistory.markRunning('p-other', VALID_TICKET);

      const res = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(res.ok).toBe(true);

      void driveClaudeHappyPath(h);
      await waitForFinal(h);
    });
  });

  // -------------------------------------------------------------------------
  // WFR-004 — unknown projectId
  // -------------------------------------------------------------------------
  describe('WFR-004 PROJECT_NOT_FOUND', () => {
    it('WFR-004: start() with unknown projectId → PROJECT_NOT_FOUND', async () => {
      const h = await buildHarness();
      const res = await h.runner.start({
        projectId: 'does-not-exist',
        ticketKey: VALID_TICKET,
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('PROJECT_NOT_FOUND');
    });
  });

  // -------------------------------------------------------------------------
  // WFR-005 — invalid ticketKey
  // -------------------------------------------------------------------------
  describe('WFR-005 INVALID_TICKET_KEY', () => {
    it('WFR-005: start() with lowercase ticketKey → INVALID_TICKET_KEY', async () => {
      const h = await buildHarness();
      const res = await h.runner.start({
        projectId: 'p-1',
        ticketKey: 'abc-1',
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('INVALID_TICKET_KEY');
    });

    it('WFR-005: rejects assorted bad ticketKey forms', async () => {
      const h = await buildHarness();
      const bad = ['', 'abc', 'ABC', 'ABC-', '-1', '1ABC-1'];
      for (const k of bad) {
        const res = await h.runner.start({ projectId: 'p-1', ticketKey: k });
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe('INVALID_TICKET_KEY');
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // WFR-006 — cancel during locking
  // -------------------------------------------------------------------------
  describe('WFR-006 cancel during locking', () => {
    it('WFR-006: cancel during locking ends in cancelled with clearRunning called', async () => {
      const h = await buildHarness();
      const start = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(start.ok).toBe(true);
      if (!start.ok) return;

      // Cancel as soon as we possibly can — might race past locking but the
      // spec promises cleanup runs through `unlocking` regardless.
      await h.runner.cancel(start.data.run.id);

      // If still in running state (rare), we still need to drive Claude to
      // exit so the runner can wind down. emitExit is safe even if cancel
      // already killed the active flag.
      try {
        h.fakeClaude.emitExit(null, 'cancelled');
      } catch {
        // emitExit throws if no claude run was ever started — that's fine.
      }

      const final = await waitForFinal(h);
      expect(final.state).toBe('cancelled');
      expect(h.clearRunningSpy).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // WFR-007 — cancel during preparing
  // -------------------------------------------------------------------------
  describe('WFR-007 cancel during preparing', () => {
    it('WFR-007: cancel after entering preparing still ends in cancelled with cleanup', async () => {
      // Slow down git.prepareRepo so there's a window to cancel.
      let resolvePrepare: (() => void) | null = null;
      const slowGit = makeFailingGitManager({});
      const origPrepare = slowGit.prepareRepo.bind(slowGit);
      slowGit.prepareRepo = async (req): Promise<GitResult<{ baseSha: string }>> => {
        await new Promise<void>((res) => {
          resolvePrepare = res;
        });
        return origPrepare(req);
      };

      const h = await buildHarness({ gitManager: slowGit });
      const start = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(start.ok).toBe(true);
      if (!start.ok) return;

      // Wait briefly so the runner enters `preparing`, then cancel.
      await new Promise((r) => setTimeout(r, 20));
      await h.runner.cancel(start.data.run.id);

      // Allow the slow prepare to resolve (so the runner's awaitable can
      // settle into the cancellation path). Cast — TS narrows the let to
      // `null` since the assignment happens inside the Promise executor.
      (resolvePrepare as (() => void) | null)?.();

      // Drain claude in case the runner advanced past prepare before cancel.
      try {
        h.fakeClaude.emitExit(null, 'cancelled');
      } catch {
        // ignore
      }

      const final = await waitForFinal(h);
      expect(final.state).toBe('cancelled');
      expect(h.clearRunningSpy).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // WFR-008 — cancel during running
  // -------------------------------------------------------------------------
  describe('WFR-008 cancel during running', () => {
    it('WFR-008: cancel during running calls claudeManager.cancel + ends cancelled', async () => {
      const h = await buildHarness();
      const start = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(start.ok).toBe(true);
      if (!start.ok) return;

      // Wait for `running` state.
      await waitForState(h, 'running');
      await h.runner.cancel(start.data.run.id);

      expect(h.fakeClaude.cancelCalls.length).toBeGreaterThanOrEqual(1);

      // Simulate the OS confirming the kill.
      h.fakeClaude.emitExit(null, 'cancelled', 'SIGTERM');

      const final = await waitForFinal(h);
      expect(final.state).toBe('cancelled');
    });
  });

  // -------------------------------------------------------------------------
  // WFR-009 — cancel during awaitingApproval
  // -------------------------------------------------------------------------
  describe('WFR-009 cancel during awaitingApproval', () => {
    it('WFR-009: cancel during awaitingApproval kills claude + ends cancelled', async () => {
      const h = await buildHarness();
      const start = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(start.ok).toBe(true);
      if (!start.ok) return;

      await waitForState(h, 'running');
      h.fakeClaude.emitOutput(
        '<<<EF_APPROVAL_REQUEST>>>{"plan":"do thing","options":["approve","reject"]}<<<END_EF_APPROVAL_REQUEST>>>\n',
      );
      await waitForState(h, 'awaitingApproval');

      await h.runner.cancel(start.data.run.id);
      expect(h.fakeClaude.cancelCalls.length).toBeGreaterThanOrEqual(1);

      h.fakeClaude.emitExit(null, 'cancelled', 'SIGTERM');

      const final = await waitForFinal(h);
      expect(final.state).toBe('cancelled');
    });
  });

  // -------------------------------------------------------------------------
  // WFR-010 — git.prepareRepo fails (PULL_FAILED)
  // -------------------------------------------------------------------------
  describe('WFR-010 git.prepareRepo fails (superseded by #37)', () => {
    // Superseded — after the architectural pivot the runner no longer calls
    // `gitManager.prepareRepo`. Repo preparation (pull, etc.) happens inside
    // Claude's skill via its own Bash tool. There's no failure path for the
    // runner to surface here. Kept skipped (rather than deleted) so the WFR
    // numbering stays stable.
    it.skip('WFR-010 (superseded): runner no longer calls prepareRepo', () => {});
  });

  // -------------------------------------------------------------------------
  // WFR-011 — claude.run fails
  // -------------------------------------------------------------------------
  describe('WFR-011 claude.run fails', () => {
    it('WFR-011: claude run failure → state=failed', async () => {
      const h = await buildHarness();
      // Make the next `run()` fail.
      h.fakeClaude.nextRunFails = {
        code: 'SPAWN_FAILED',
        message: 'claude not found',
      };

      const res = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(res.ok).toBe(true);

      const final = await waitForFinal(h);
      expect(final.state).toBe('failed');
      expect(h.clearRunningSpy).toHaveBeenCalled();
    });

    it('WFR-011: claude exit with non-completed reason → state=failed', async () => {
      const h = await buildHarness();
      const res = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(res.ok).toBe(true);

      await waitForState(h, 'running');
      // Simulate a spawn-error exit (non-zero, reason !== 'completed').
      h.fakeClaude.emitExit(1, 'error');

      const final = await waitForFinal(h);
      expect(final.state).toBe('failed');
    });
  });

  // -------------------------------------------------------------------------
  // WFR-012 — git.commit fails
  // -------------------------------------------------------------------------
  describe('WFR-012 git.commit fails (superseded by #37)', () => {
    // Superseded — runner no longer commits. Claude's skill runs the commit
    // via its own Bash tool; commit failure is observable via Claude's exit
    // code (covered by WFR-011's "non-completed reason" path).
    it.skip('WFR-012 (superseded): runner no longer calls commit', () => {});
  });

  // -------------------------------------------------------------------------
  // WFR-013 — pr.create fails (AUTH)
  // -------------------------------------------------------------------------
  describe('WFR-013 pr.create fails (superseded by #37)', () => {
    // Superseded — runner no longer opens PRs. Claude's skill calls
    // `gh pr create` from its Bash tool; PR-creation failure is observable
    // via Claude's non-zero exit (covered by WFR-011).
    it.skip('WFR-013 (superseded): runner no longer calls prCreator', () => {});
  });

  // -------------------------------------------------------------------------
  // WFR-014 — jira.update fails (spec choice: don't fail the run)
  // -------------------------------------------------------------------------
  describe('WFR-014 jira.update fails (don\'t fail the run)', () => {
    it('WFR-014: jira.update failure → run still ends in done', async () => {
      const failingJira = makeFailingJiraUpdater({
        ok: false,
        error: { code: 'NETWORK', message: 'jira down' },
      });
      const h = await buildHarness({ jiraUpdater: failingJira });
      const res = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(res.ok).toBe(true);

      void driveClaudeHappyPath(h);
      const final = await waitForFinal(h);
      // Spec choice: jira.update failure does NOT fail the run.
      expect(final.state).toBe('done');
      expect(final.status).toBe('done');
    });
  });

  // -------------------------------------------------------------------------
  // WFR-015 — approval marker → awaitingApproval
  // -------------------------------------------------------------------------
  describe('WFR-015 approval marker (interactive)', () => {
    it('WFR-015: approval marker populates pendingApproval and pauses in awaitingApproval', async () => {
      const h = await buildHarness();
      const res = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(res.ok).toBe(true);

      await waitForState(h, 'running');
      h.fakeClaude.emitOutput(
        '<<<EF_APPROVAL_REQUEST>>>{"plan":"refactor X","filesToModify":["a.ts"],"diff":"+ foo","options":["approve","reject"]}<<<END_EF_APPROVAL_REQUEST>>>\n',
      );

      const awaiting = await waitForState(h, 'awaitingApproval');
      expect(awaiting.pendingApproval).not.toBeNull();
      expect(awaiting.pendingApproval?.plan).toBe('refactor X');
      expect(awaiting.pendingApproval?.filesToModify).toEqual(['a.ts']);
      expect(awaiting.pendingApproval?.diff).toBe('+ foo');
      expect(awaiting.pendingApproval?.options).toEqual(['approve', 'reject']);

      // current() reflects the awaiting state.
      const cur = h.runner.current();
      expect(cur).not.toBeNull();
      expect(cur?.state).toBe('awaitingApproval');

      // Cleanup: cancel the run so we don't leave it dangling.
      if (res.ok) await h.runner.cancel(res.data.run.id);
      try {
        h.fakeClaude.emitExit(null, 'cancelled');
      } catch {
        // already exited
      }
      await waitForFinal(h);
    });
  });

  // -------------------------------------------------------------------------
  // WFR-016 — approve() advances state
  // -------------------------------------------------------------------------
  describe('WFR-016 approve() advances state', () => {
    it('WFR-016: approve writes "approve\\n" to claude stdin and unblocks the run', async () => {
      const h = await buildHarness();
      const res = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      await waitForState(h, 'running');
      h.fakeClaude.emitOutput(
        '<<<EF_APPROVAL_REQUEST>>>{"plan":"x","options":["approve","reject"]}<<<END_EF_APPROVAL_REQUEST>>>\n',
      );
      await waitForState(h, 'awaitingApproval');

      const approveRes = await h.runner.approve({ runId: res.data.run.id });
      expect(approveRes.ok).toBe(true);
      expect(h.fakeClaude.stdinWrites).toContain('approve\n');

      // Drive Claude to completion to advance to committing.
      h.fakeClaude.emitExit(0, 'completed');
      const final = await waitForFinal(h);
      expect(final.state).toBe('done');
    });
  });

  // -------------------------------------------------------------------------
  // WFR-017 — reject() ends in cancelled
  // -------------------------------------------------------------------------
  describe('WFR-017 reject() ends in cancelled', () => {
    it('WFR-017: reject during awaitingApproval → run ends cancelled', async () => {
      const h = await buildHarness();
      const res = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      await waitForState(h, 'running');
      h.fakeClaude.emitOutput(
        '<<<EF_APPROVAL_REQUEST>>>{"plan":"x","options":["approve","reject"]}<<<END_EF_APPROVAL_REQUEST>>>\n',
      );
      await waitForState(h, 'awaitingApproval');

      const rejRes = await h.runner.reject({ runId: res.data.run.id });
      expect(rejRes.ok).toBe(true);

      try {
        h.fakeClaude.emitExit(null, 'cancelled');
      } catch {
        // ignore — already exited
      }

      const final = await waitForFinal(h);
      expect(final.state).toBe('cancelled');
    });
  });

  // -------------------------------------------------------------------------
  // WFR-018 — modify() writes text + advances
  // -------------------------------------------------------------------------
  describe('WFR-018 modify() writes text + advances', () => {
    it('WFR-018: modify writes ${text}\\n to stdin and run continues', async () => {
      const h = await buildHarness();
      const res = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      await waitForState(h, 'running');
      h.fakeClaude.emitOutput(
        '<<<EF_APPROVAL_REQUEST>>>{"plan":"x","options":["approve","modify"]}<<<END_EF_APPROVAL_REQUEST>>>\n',
      );
      await waitForState(h, 'awaitingApproval');

      const modRes = await h.runner.modify({
        runId: res.data.run.id,
        text: 'use the other approach',
      });
      expect(modRes.ok).toBe(true);
      // The exact write should be the text + '\n'.
      expect(h.fakeClaude.stdinWrites).toContain('use the other approach\n');

      h.fakeClaude.emitExit(0, 'completed');
      const final = await waitForFinal(h);
      expect(final.state).toBe('done');
    });
  });

  // -------------------------------------------------------------------------
  // WFR-019 — yolo auto-approves; never enters awaitingApproval
  // -------------------------------------------------------------------------
  describe('WFR-019 yolo auto-approves', () => {
    it('WFR-019: yolo + marker → approve\\n written; never enters awaitingApproval', async () => {
      const h = await buildHarness({
        project: makeFakeProject({
          workflow: {
            mode: 'yolo',
            branchFormat: 'feature/{ticketKey}-{slug}',
          },
        }),
      });
      const res = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(res.ok).toBe(true);

      await waitForState(h, 'running');
      h.fakeClaude.emitOutput(
        '<<<EF_APPROVAL_REQUEST>>>{"plan":"x","options":["approve","reject"]}<<<END_EF_APPROVAL_REQUEST>>>\n',
      );

      // Wait briefly so the runner can react. Then assert no awaitingApproval
      // event was ever emitted.
      await new Promise((r) => setTimeout(r, 50));
      const sawAwaiting = h.stateEvents.some(
        (e) => e.run.state === 'awaitingApproval',
      );
      expect(sawAwaiting).toBe(false);
      expect(h.fakeClaude.stdinWrites).toContain('approve\n');

      h.fakeClaude.emitExit(0, 'completed');
      const final = await waitForFinal(h);
      expect(final.state).toBe('done');
    });
  });

  // -------------------------------------------------------------------------
  // WFR-020 — multiple markers in one run
  // -------------------------------------------------------------------------
  describe('WFR-020 multiple approval markers', () => {
    it('WFR-020: each marker handled (interactive — pause then approve, twice)', async () => {
      const h = await buildHarness();
      const res = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      await waitForState(h, 'running');

      h.fakeClaude.emitOutput(
        '<<<EF_APPROVAL_REQUEST>>>{"plan":"step 1"}<<<END_EF_APPROVAL_REQUEST>>>\n',
      );
      await waitForState(h, 'awaitingApproval');
      const a1 = await h.runner.approve({ runId: res.data.run.id });
      expect(a1.ok).toBe(true);

      // Wait for runner to write back to stdin and (typically) re-enter
      // running. We don't assert the state shape here — just that the second
      // marker is also handled.
      await new Promise((r) => setTimeout(r, 20));

      h.fakeClaude.emitOutput(
        '<<<EF_APPROVAL_REQUEST>>>{"plan":"step 2"}<<<END_EF_APPROVAL_REQUEST>>>\n',
      );
      await waitForState(h, 'awaitingApproval');
      const a2 = await h.runner.approve({ runId: res.data.run.id });
      expect(a2.ok).toBe(true);

      // 'approve\n' written exactly twice.
      const approveCount = h.fakeClaude.stdinWrites.filter(
        (s) => s === 'approve\n',
      ).length;
      expect(approveCount).toBeGreaterThanOrEqual(2);

      h.fakeClaude.emitExit(0, 'completed');
      const final = await waitForFinal(h);
      expect(final.state).toBe('done');
    });
  });

  // -------------------------------------------------------------------------
  // WFR-021 — malformed marker is ignored
  // -------------------------------------------------------------------------
  describe('WFR-021 malformed marker', () => {
    it('WFR-021: malformed JSON marker → runner does NOT pause', async () => {
      const h = await buildHarness();
      const res = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(res.ok).toBe(true);

      await waitForState(h, 'running');
      h.fakeClaude.emitOutput(
        '<<<EF_APPROVAL_REQUEST>>>{not valid json{{<<<END_EF_APPROVAL_REQUEST>>>\n',
      );

      // Give the runner a moment — should NOT transition to awaitingApproval.
      await new Promise((r) => setTimeout(r, 30));
      const sawAwaiting = h.stateEvents.some(
        (e) => e.run.state === 'awaitingApproval',
      );
      expect(sawAwaiting).toBe(false);

      h.fakeClaude.emitExit(0, 'completed');
      const final = await waitForFinal(h);
      expect(final.state).toBe('done');
    });
  });

  // -------------------------------------------------------------------------
  // WFR-031..035 — phase markers (#37)
  // -------------------------------------------------------------------------
  describe('WFR-031 phase marker → state transition', () => {
    it('WFR-031: a valid phase marker transitions Run.state and pushes a step', async () => {
      const h = await buildHarness();
      const res = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(res.ok).toBe(true);

      await waitForState(h, 'running');
      h.fakeClaude.emitOutput(
        '<<<EF_PHASE>>>{"phase":"committing"}<<<END_EF_PHASE>>>\n',
      );
      await waitForState(h, 'committing');

      // A second marker advances state again and closes the prior step.
      h.fakeClaude.emitOutput(
        '<<<EF_PHASE>>>{"phase":"pushing"}<<<END_EF_PHASE>>>\n',
      );
      await waitForState(h, 'pushing');

      h.fakeClaude.emitExit(0, 'completed');
      const final = await waitForFinal(h);
      expect(final.state).toBe('done');

      // Both phase states appear in the steps timeline.
      const phaseStates = final.steps.map((s) => s.state);
      expect(phaseStates).toContain('committing');
      expect(phaseStates).toContain('pushing');
    });

    it('WFR-031b: every step is `done` (or terminal) at finish — no straggler stays `running`', async () => {
      // Regression: phase steps inserted by transitionToPhase have only
      // their PREVIOUS sibling closed by the next transition. The LAST
      // phase step (no successor) used to be left in `running` forever
      // — surfacing as a perpetual "still working" heartbeat in the UI
      // after the run finished.
      const h = await buildHarness();
      const res = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(res.ok).toBe(true);

      await waitForState(h, 'running');
      h.fakeClaude.emitOutput(
        '<<<EF_PHASE>>>{"phase":"committing"}<<<END_EF_PHASE>>>\n',
      );
      await waitForState(h, 'committing');
      // `pushing` is the final phase the skill emits before exit — the
      // one most likely to be left dangling.
      h.fakeClaude.emitOutput(
        '<<<EF_PHASE>>>{"phase":"pushing"}<<<END_EF_PHASE>>>\n',
      );
      await waitForState(h, 'pushing');

      h.fakeClaude.emitExit(0, 'completed');
      const final = await waitForFinal(h);

      // No step in the timeline is left `running` once the run has
      // landed in a terminal state. (`unlocking` / `done` get their own
      // entries with their own statuses; what we care about is that no
      // earlier phase straggles.)
      const stragglers = final.steps.filter((s) => s.status === 'running');
      expect(stragglers).toEqual([]);
    });
  });

  describe('WFR-032 phase marker (unknown phase) ignored', () => {
    it('WFR-032: unknown phase value is logged + ignored; state does not change', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const h = await buildHarness();
      const res = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(res.ok).toBe(true);

      await waitForState(h, 'running');
      const beforeStep = h.runner.current()?.steps.length ?? 0;
      h.fakeClaude.emitOutput(
        '<<<EF_PHASE>>>{"phase":"frobnicating"}<<<END_EF_PHASE>>>\n',
      );
      // Give the parser a tick to dispatch.
      await new Promise((r) => setTimeout(r, 10));

      const cur = h.runner.current();
      expect(cur?.state).toBe('running');
      // No new step was pushed.
      expect(cur?.steps.length).toBe(beforeStep);
      // We logged a warn about the unknown phase.
      expect(warnSpy).toHaveBeenCalled();

      h.fakeClaude.emitExit(0, 'completed');
      await waitForFinal(h);
      warnSpy.mockRestore();
    });
  });

  describe('WFR-033 phase marker (malformed JSON) ignored', () => {
    it('WFR-033: malformed JSON is logged + ignored; subsequent valid markers still parse', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const h = await buildHarness();
      const res = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(res.ok).toBe(true);

      await waitForState(h, 'running');
      h.fakeClaude.emitOutput(
        '<<<EF_PHASE>>>{not valid json}}<<<END_EF_PHASE>>>\n',
      );
      await new Promise((r) => setTimeout(r, 10));
      expect(h.runner.current()?.state).toBe('running');

      // A subsequent VALID marker must still be parsed.
      h.fakeClaude.emitOutput(
        '<<<EF_PHASE>>>{"phase":"committing"}<<<END_EF_PHASE>>>\n',
      );
      await waitForState(h, 'committing');

      h.fakeClaude.emitExit(0, 'completed');
      await waitForFinal(h);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('WFR-034 approval mid-phase restores phase', () => {
    it('WFR-034: approval marker during `committing` resumes to `committing`, not `running`', async () => {
      const h = await buildHarness();
      const res = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      await waitForState(h, 'running');
      // Advance to committing via phase marker.
      h.fakeClaude.emitOutput(
        '<<<EF_PHASE>>>{"phase":"committing"}<<<END_EF_PHASE>>>\n',
      );
      await waitForState(h, 'committing');

      // Mid-phase, an approval marker arrives → state pauses at
      // awaitingApproval, then resumes to the prior phase (committing),
      // NOT to running.
      h.fakeClaude.emitOutput(
        '<<<EF_APPROVAL_REQUEST>>>{"plan":"check"}<<<END_EF_APPROVAL_REQUEST>>>\n',
      );
      await waitForState(h, 'awaitingApproval');
      const approveRes = await h.runner.approve({ runId: res.data.run.id });
      expect(approveRes.ok).toBe(true);

      // After resume, state must return to committing.
      await new Promise((r) => setTimeout(r, 20));
      expect(h.runner.current()?.state).toBe('committing');

      h.fakeClaude.emitExit(0, 'completed');
      await waitForFinal(h);
    });
  });

  describe('WFR-034b branching marker carries branchName; creatingPr carries prUrl', () => {
    it('WFR-034b: payload fields update Run.branchName and Run.prUrl atomically with the state transition', async () => {
      const h = await buildHarness();
      const res = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(res.ok).toBe(true);

      await waitForState(h, 'running');
      const initialBranch = h.runner.current()?.branchName;
      // The runner's pre-Claude derivation is non-empty.
      expect(typeof initialBranch).toBe('string');

      // Branching marker carries the actual branch name. Runner adopts it.
      h.fakeClaude.emitOutput(
        '<<<EF_PHASE>>>{"phase":"branching","branchName":"feat/from-claude"}<<<END_EF_PHASE>>>\n',
      );
      await waitForState(h, 'branching');
      expect(h.runner.current()?.branchName).toBe('feat/from-claude');

      // creatingPr marker carries the PR URL.
      h.fakeClaude.emitOutput(
        '<<<EF_PHASE>>>{"phase":"creatingPr","prUrl":"https://github.com/o/r/pull/42"}<<<END_EF_PHASE>>>\n',
      );
      await waitForState(h, 'creatingPr');
      expect(h.runner.current()?.prUrl).toBe('https://github.com/o/r/pull/42');

      h.fakeClaude.emitExit(0, 'completed');
      const final = await waitForFinal(h);
      expect(final.branchName).toBe('feat/from-claude');
      expect(final.prUrl).toBe('https://github.com/o/r/pull/42');
    });
  });

  describe('WFR-035 no git/PR/Jira calls', () => {
    it('WFR-035: happy path makes ZERO calls to gitManager / prCreator / jiraUpdater', async () => {
      // Spy on every method that the runner used to call directly.
      const prepareSpy = vi.fn();
      const branchSpy = vi.fn();
      const commitSpy = vi.fn();
      const pushSpy = vi.fn();
      const prSpy = vi.fn();
      const jiraSpy = vi.fn();

      const trackingGit: GitManager = {
        async prepareRepo(req: PrepareRepoRequest): Promise<GitResult<{ baseSha: string }>> {
          prepareSpy(req);
          return { ok: true, data: { baseSha: 'deadbeef' } };
        },
        async createBranch(req: CreateBranchRequest): Promise<GitResult<{ branchName: string }>> {
          branchSpy(req);
          return { ok: true, data: { branchName: req.branchName } };
        },
        async commit(req: CommitRequest): Promise<GitResult<{ sha: string }>> {
          commitSpy(req);
          return { ok: true, data: { sha: 'cafebabe' } };
        },
        async push(req: PushRequest): Promise<GitResult<{ remoteUrl?: string }>> {
          pushSpy(req);
          return { ok: true, data: {} };
        },
      };
      const trackingPr: PrCreator = {
        async create(
          req: CreatePrRequest,
        ): Promise<PrResult<{ url: string; number: number }>> {
          prSpy(req);
          return { ok: true, data: { url: 'https://example.com/pr/1', number: 1 } };
        },
      };
      const trackingJira: JiraUpdater = {
        async update(req: UpdateTicketRequest): Promise<JiraUpdateResult<{ ticketKey: string }>> {
          jiraSpy(req);
          return { ok: true, data: { ticketKey: req.ticketKey } };
        },
      };

      const h = await buildHarness({
        gitManager: trackingGit,
        prCreator: trackingPr,
        jiraUpdater: trackingJira,
      });
      const res = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(res.ok).toBe(true);
      void driveClaudeHappyPath(h);
      const final = await waitForFinal(h);
      expect(final.state).toBe('done');

      // Crucial #37 invariant: the runner MUST NOT call any of these.
      expect(prepareSpy).not.toHaveBeenCalled();
      expect(branchSpy).not.toHaveBeenCalled();
      expect(commitSpy).not.toHaveBeenCalled();
      expect(pushSpy).not.toHaveBeenCalled();
      expect(prSpy).not.toHaveBeenCalled();
      expect(jiraSpy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // WFR-022 — current() during run
  // -------------------------------------------------------------------------
  describe('WFR-022 current() during run', () => {
    it('WFR-022: current() returns active run snapshot', async () => {
      const h = await buildHarness();
      const res = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(res.ok).toBe(true);

      await waitForState(h, 'running');
      const cur = h.runner.current();
      expect(cur).not.toBeNull();
      expect(cur?.projectId).toBe('p-1');
      expect(cur?.ticketKey).toBe(VALID_TICKET);

      h.fakeClaude.emitExit(0, 'completed');
      await waitForFinal(h);
    });
  });

  // -------------------------------------------------------------------------
  // WFR-023 — current() when idle
  // -------------------------------------------------------------------------
  describe('WFR-023 current() when idle', () => {
    it('WFR-023: current() returns null before any run', async () => {
      const h = await buildHarness();
      expect(h.runner.current()).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // WFR-024 — state-changed events emitted in the right order
  // -------------------------------------------------------------------------
  describe('WFR-024 state-changed event ordering', () => {
    it('WFR-024: state events fire in pipeline order, each at most once on the happy path', async () => {
      const h = await buildHarness();
      const res = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(res.ok).toBe(true);

      void driveClaudeHappyPath(h);
      await waitForFinal(h);

      const states = h.stateEvents.map((e) => e.run.state);
      // After #37 the runner-driven pipeline is just `locking → running →
      // unlocking → done`. Phase markers (committing / pushing / creatingPr /
      // updatingTicket) are tested separately by WFR-032; this test asserts
      // that the *runner-driven* baseline still goes in order.
      const canonical: Run['state'][] = [
        'locking',
        'running',
        'unlocking',
        'done',
      ];
      const filtered = states.filter((s) => canonical.includes(s));
      for (const s of canonical) {
        expect(filtered).toContain(s);
      }
      const firstIndices = canonical.map((s) => filtered.indexOf(s));
      for (let i = 1; i < firstIndices.length; i++) {
        expect(firstIndices[i]!).toBeGreaterThan(firstIndices[i - 1]!);
      }
    });
  });

  // -------------------------------------------------------------------------
  // WFR-025 — current-changed events fire on each transition + final null
  // -------------------------------------------------------------------------
  describe('WFR-025 current-changed events', () => {
    it('WFR-025: current-changed fires on transitions AND once on completion (final null)', async () => {
      const h = await buildHarness();
      const res = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(res.ok).toBe(true);

      void driveClaudeHappyPath(h);
      await waitForFinal(h);

      // At least one event must be `{ run: null }` — the spec choice in
      // acceptance for WFR-025 is "null on completion".
      const sawNull = h.currentEvents.some((e) => e.run === null);
      expect(sawNull).toBe(true);

      // The very last event should be the null one (completion).
      const last = h.currentEvents[h.currentEvents.length - 1];
      expect(last?.run).toBeNull();

      // We saw multiple non-null events too (one per transition).
      const nonNullCount = h.currentEvents.filter((e) => e.run !== null).length;
      expect(nonNullCount).toBeGreaterThan(1);
    });
  });

  // -------------------------------------------------------------------------
  // WFR-026 — RunStore.save called per state transition
  // -------------------------------------------------------------------------
  describe('WFR-026 RunStore.save per transition', () => {
    it('WFR-026: save called multiple times across the pipeline (incremental persistence)', async () => {
      const h = await buildHarness();
      const res = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(res.ok).toBe(true);

      void driveClaudeHappyPath(h);
      await waitForFinal(h);

      // Strict per-transition save would mean ~10+ calls (one per state).
      // We assert at least 5 to allow for batched saves, but ensure it's
      // genuinely incremental (not just one final blob).
      expect(h.saveSpy.mock.calls.length).toBeGreaterThanOrEqual(5);
    });
  });

  // -------------------------------------------------------------------------
  // WFR-027 — current() null after completion; new start works
  // -------------------------------------------------------------------------
  describe('WFR-027 idle after completion', () => {
    it('WFR-027: after done, current()===null and a new start() succeeds', async () => {
      const h = await buildHarness();
      const r1 = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(r1.ok).toBe(true);

      void driveClaudeHappyPath(h);
      await waitForFinal(h);

      expect(h.runner.current()).toBeNull();

      const r2 = await h.runner.start({
        projectId: 'p-1',
        ticketKey: 'ABC-2',
      });
      expect(r2.ok).toBe(true);

      // Cleanup the second run.
      void driveClaudeHappyPath(h);
      await waitForFinal(h);
    });
  });

  // -------------------------------------------------------------------------
  // WFR-028 — branchName uses {ticketKey} and {slug}
  // -------------------------------------------------------------------------
  describe('WFR-028 branchName interpolation', () => {
    it('WFR-028: branchName interpolates {ticketKey} + {slug} on the Run snapshot', async () => {
      // After #37 the runner doesn't call createBranch — Claude does. We
      // assert the derivation by reading `Run.branchName` on the active
      // run; the same value is what Claude's skill receives via the
      // initial `start()` snapshot and uses for `git checkout -b`.
      const h = await buildHarness({
        project: makeFakeProject({
          workflow: {
            mode: 'interactive',
            branchFormat: 'feat/{ticketKey}-{slug}',
          },
        }),
      });
      const res = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const bn = res.data.run.branchName;
      // Must contain the ticket key (literal substitution).
      expect(bn).toContain('ABC-1');
      // And must NOT still contain the literal placeholder text.
      expect(bn).not.toContain('{ticketKey}');
      expect(bn).not.toContain('{slug}');

      // Same value persists on the final Run snapshot.
      void driveClaudeHappyPath(h);
      const final = await waitForFinal(h);
      expect(final.state).toBe('done');
      expect(final.branchName).toBe(bn);
    });
  });

  // -------------------------------------------------------------------------
  // WFR-029 — PR title format
  // -------------------------------------------------------------------------
  describe('WFR-029 PR title format (superseded by #37)', () => {
    // Superseded — runner no longer constructs PR titles. Claude's skill
    // composes the title from the Conventional-Commits format documented
    // in `.claude/skills/ef-feature/SKILL.md` (Phase 7.3) and runs
    // `gh pr create` itself.
    it.skip('WFR-029 (superseded): runner no longer calls prCreator', () => {});
  });

  // -------------------------------------------------------------------------
  // WFR-030 — approve() outside awaitingApproval
  // -------------------------------------------------------------------------
  describe('WFR-030 approve() not awaiting → NOT_AWAITING_APPROVAL', () => {
    it('WFR-030: approve() while in `running` → NOT_AWAITING_APPROVAL', async () => {
      const h = await buildHarness();
      const res = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      await waitForState(h, 'running');
      const approveRes = await h.runner.approve({ runId: res.data.run.id });
      expect(approveRes.ok).toBe(false);
      if (approveRes.ok) return;
      expect(approveRes.error.code).toBe('NOT_AWAITING_APPROVAL');

      // Cleanup.
      h.fakeClaude.emitExit(0, 'completed');
      await waitForFinal(h);
    });

    it('WFR-030: approve() with no active run → NOT_RUNNING', async () => {
      const h = await buildHarness();
      const approveRes = await h.runner.approve({ runId: 'nope' });
      expect(approveRes.ok).toBe(false);
      if (approveRes.ok) return;
      // Spec lists both NOT_RUNNING and NOT_AWAITING_APPROVAL — either is
      // acceptable here (no active run).
      expect(['NOT_RUNNING', 'NOT_AWAITING_APPROVAL']).toContain(
        approveRes.error.code,
      );
    });
  });

  // -------------------------------------------------------------------------
  // GH-52 #4 — awaitingApproval entry must close the prior in-flight step
  // -------------------------------------------------------------------------
  describe('WFR-040 awaitingApproval entry closes prior phase step', () => {
    it('WFR-040: while paused there is exactly ONE step in `running` status (the awaiting one)', async () => {
      const h = await buildHarness();
      const res = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      await waitForState(h, 'running');
      // Open a phase via marker so there's a definite in-flight step
      // BEFORE the approval marker fires.
      h.fakeClaude.emitOutput(
        '<<<EF_PHASE>>>{"phase":"committing"}<<<END_EF_PHASE>>>\n',
      );
      await waitForState(h, 'committing');

      // Approval marker arrives mid-`committing`.
      h.fakeClaude.emitOutput(
        '<<<EF_APPROVAL_REQUEST>>>{"plan":"check"}<<<END_EF_APPROVAL_REQUEST>>>\n',
      );
      await waitForState(h, 'awaitingApproval');

      // Snapshot the steps array while the run is paused. There must be
      // exactly ONE step in `running` status — the awaitingApproval one.
      // The prior `committing` step must already be closed (`done`).
      const paused = h.runner.current();
      expect(paused).not.toBeNull();
      if (!paused) return;
      const runningStepsWhilePaused = paused.steps.filter(
        (s) => s.status === 'running',
      );
      expect(runningStepsWhilePaused).toHaveLength(1);
      expect(runningStepsWhilePaused[0]?.state).toBe('awaitingApproval');
      const committingStep = paused.steps.find(
        (s) => s.state === 'committing',
      );
      expect(committingStep?.status).toBe('done');
      expect(committingStep?.finishedAt).toBeTypeOf('number');

      // After resume, exactly ONE awaitingApproval step (closed `done`)
      // and ONE running `committing` step in the timeline tail.
      const approveRes = await h.runner.approve({ runId: res.data.run.id });
      expect(approveRes.ok).toBe(true);
      await new Promise((r) => setTimeout(r, 30));
      const resumed = h.runner.current();
      expect(resumed?.state).toBe('committing');
      const tail = resumed?.steps.slice(-3) ?? [];
      // Tail order: committing(done) → awaitingApproval(done) → committing(running)
      expect(tail[0]?.state).toBe('committing');
      expect(tail[0]?.status).toBe('done');
      expect(tail[1]?.state).toBe('awaitingApproval');
      expect(tail[1]?.status).toBe('done');
      expect(tail[2]?.state).toBe('committing');
      expect(tail[2]?.status).toBe('running');

      h.fakeClaude.emitExit(0, 'completed');
      await waitForFinal(h);
    });
  });

  // -------------------------------------------------------------------------
  // GH-52 #5 — runner-side dedupe of consecutive same-phase markers
  // -------------------------------------------------------------------------
  describe('WFR-041 transitionToPhase dedupes consecutive same-phase markers', () => {
    it('WFR-041: emitting `committing` twice in a row produces a single step', async () => {
      const h = await buildHarness();
      const res = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(res.ok).toBe(true);

      await waitForState(h, 'running');
      h.fakeClaude.emitOutput(
        '<<<EF_PHASE>>>{"phase":"committing"}<<<END_EF_PHASE>>>\n',
      );
      await waitForState(h, 'committing');
      const beforeCount = h.runner
        .current()
        ?.steps.filter((s) => s.state === 'committing').length;
      expect(beforeCount).toBe(1);

      // Re-announce — runner should drop this on the floor.
      h.fakeClaude.emitOutput(
        '<<<EF_PHASE>>>{"phase":"committing"}<<<END_EF_PHASE>>>\n',
      );
      await new Promise((r) => setTimeout(r, 20));
      const afterCount = h.runner
        .current()
        ?.steps.filter((s) => s.state === 'committing').length;
      expect(afterCount).toBe(1);

      h.fakeClaude.emitExit(0, 'completed');
      await waitForFinal(h);
    });
  });

  // -------------------------------------------------------------------------
  // GH-52 #6 — new phase markers (fetchingTicket, understandingContext, etc.)
  // -------------------------------------------------------------------------
  describe('WFR-042 new phase markers transition + push steps', () => {
    it('WFR-042: each new phase marker advances state and creates a labelled step', async () => {
      const h = await buildHarness();
      const res = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(res.ok).toBe(true);

      await waitForState(h, 'running');

      const newPhases: Array<{
        marker: string;
        state: Run['state'];
        label: string;
      }> = [
        {
          marker: 'fetchingTicket',
          state: 'fetchingTicket',
          label: 'Fetching ticket',
        },
        {
          marker: 'understandingContext',
          state: 'understandingContext',
          label: 'Understanding context',
        },
        { marker: 'planning', state: 'planning', label: 'Planning' },
        {
          marker: 'implementing',
          state: 'implementing',
          label: 'Implementing feature',
        },
        {
          marker: 'evaluatingTests',
          state: 'evaluatingTests',
          label: 'Evaluating tests',
        },
        {
          marker: 'reviewingCode',
          state: 'reviewingCode',
          label: 'Reviewing code',
        },
      ];

      for (const phase of newPhases) {
        h.fakeClaude.emitOutput(
          `<<<EF_PHASE>>>{"phase":"${phase.marker}"}<<<END_EF_PHASE>>>\n`,
        );
        await waitForState(h, phase.state);
        const cur = h.runner.current();
        expect(cur?.state).toBe(phase.state);
        const matching = cur?.steps.find((s) => s.state === phase.state);
        expect(matching?.userVisibleLabel).toBe(phase.label);
      }

      h.fakeClaude.emitExit(0, 'completed');
      const final = await waitForFinal(h);
      // Every phase appears exactly once and is closed at finish.
      for (const phase of newPhases) {
        const matches = final.steps.filter((s) => s.state === phase.state);
        expect(matches).toHaveLength(1);
        expect(matches[0]?.status).toBe('done');
      }
    });
  });
});
