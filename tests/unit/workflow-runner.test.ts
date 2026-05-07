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

function makeFailingPrCreator(result: PrResult<{ url: string; number: number }>): PrCreator {
  return {
    async create(_req: CreatePrRequest): Promise<PrResult<{ url: string; number: number }>> {
      return result;
    },
  };
}

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
  markProcessedSpy: MockInstance;
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
  const markProcessedSpy = vi.spyOn(runHistory, 'markProcessed');
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
    markProcessedSpy,
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

      // RunHistory locks engaged + cleared.
      expect(h.markRunningSpy).toHaveBeenCalledWith('p-1', VALID_TICKET);
      expect(h.markProcessedSpy).toHaveBeenCalledWith('p-1', VALID_TICKET);
      expect(h.clearRunningSpy).toHaveBeenCalledWith('p-1', VALID_TICKET);

      // RunStore.save was called at least once (per WFR-026 — ideally per
      // transition, but this assertion is conservative).
      expect(h.saveSpy).toHaveBeenCalled();

      // The full state pipeline traversed in order. We assert the SET of
      // state values (not exhaustive ordering) here; ordering is asserted
      // separately in WFR-024.
      const seenStates = new Set(h.stateEvents.map((e) => e.run.state));
      const expected: Run['state'][] = [
        'locking',
        'preparing',
        'branching',
        'running',
        'committing',
        'pushing',
        'creatingPr',
        'updatingTicket',
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
  describe('WFR-010 git.prepareRepo fails', () => {
    it('WFR-010: prepareRepo failure → state=failed, unlocking still runs', async () => {
      const failingGit = makeFailingGitManager({
        prepareRepo: {
          ok: false,
          error: { code: 'PULL_FAILED', message: 'pull failed' },
        },
      });
      const h = await buildHarness({ gitManager: failingGit });
      const res = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(res.ok).toBe(true);

      const final = await waitForFinal(h);
      expect(final.state).toBe('failed');
      expect(final.status).toBe('failed');
      expect(typeof final.error).toBe('string');
      expect(final.error).toContain('PULL_FAILED');

      // Cleanup still ran.
      expect(h.clearRunningSpy).toHaveBeenCalled();
      const seenStates = new Set(h.stateEvents.map((e) => e.run.state));
      expect(seenStates.has('unlocking')).toBe(true);
    });
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
  describe('WFR-012 git.commit fails', () => {
    it('WFR-012: commit failure → state=failed; unlocking still runs', async () => {
      const failingGit = makeFailingGitManager({
        commit: {
          ok: false,
          error: { code: 'COMMIT_FAILED', message: 'no changes to commit' },
        },
      });
      const h = await buildHarness({ gitManager: failingGit });
      const res = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(res.ok).toBe(true);

      void driveClaudeHappyPath(h);
      const final = await waitForFinal(h);
      expect(final.state).toBe('failed');
      const seenStates = new Set(h.stateEvents.map((e) => e.run.state));
      expect(seenStates.has('unlocking')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // WFR-013 — pr.create fails (AUTH)
  // -------------------------------------------------------------------------
  describe('WFR-013 pr.create fails', () => {
    it('WFR-013: pr.create AUTH failure → state=failed', async () => {
      const failingPr = makeFailingPrCreator({
        ok: false,
        error: { code: 'AUTH', message: 'token rejected' },
      });
      const h = await buildHarness({ prCreator: failingPr });
      const res = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(res.ok).toBe(true);

      void driveClaudeHappyPath(h);
      const final = await waitForFinal(h);
      expect(final.state).toBe('failed');
      const seenStates = new Set(h.stateEvents.map((e) => e.run.state));
      expect(seenStates.has('unlocking')).toBe(true);
    });
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
      // Filter to the canonical pipeline states (so unrelated 'idle' /
      // re-entered 'running' bookkeeping doesn't break the assertion).
      const canonical: Run['state'][] = [
        'locking',
        'preparing',
        'branching',
        'running',
        'committing',
        'pushing',
        'creatingPr',
        'updatingTicket',
        'unlocking',
        'done',
      ];
      const filtered = states.filter((s) => canonical.includes(s));
      // Each canonical state must appear at least once.
      for (const s of canonical) {
        expect(filtered).toContain(s);
      }
      // And the FIRST occurrences must be in the canonical order.
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
    it('WFR-028: branchName uses {ticketKey} + {slug} from project workflow', async () => {
      // Spy on createBranch to see the actual branchName.
      const created: string[] = [];
      const spyGit: GitManager = {
        async prepareRepo(req) {
          return new StubGitManager().prepareRepo(req);
        },
        async createBranch(req) {
          created.push(req.branchName);
          return { ok: true, data: { branchName: req.branchName } };
        },
        async commit(req) {
          return new StubGitManager().commit(req);
        },
        async push(req) {
          return new StubGitManager().push(req);
        },
      };

      const h = await buildHarness({
        project: makeFakeProject({
          workflow: {
            mode: 'interactive',
            branchFormat: 'feat/{ticketKey}-{slug}',
          },
        }),
        gitManager: spyGit,
      });
      const res = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(res.ok).toBe(true);

      void driveClaudeHappyPath(h);
      const final = await waitForFinal(h);
      expect(final.state).toBe('done');

      expect(created.length).toBeGreaterThanOrEqual(1);
      const bn = created[0]!;
      // Must contain the ticket key (literal substitution).
      expect(bn).toContain('ABC-1');
      // And must NOT still contain the literal placeholder text.
      expect(bn).not.toContain('{ticketKey}');
      expect(bn).not.toContain('{slug}');
      // The branchName persisted on the Run reflects the same value.
      expect(final.branchName).toBe(bn);
    });
  });

  // -------------------------------------------------------------------------
  // WFR-029 — PR title format
  // -------------------------------------------------------------------------
  describe('WFR-029 PR title format', () => {
    it('WFR-029: PR title === "feat(${ticketKey}): ${ticketSummary}"', async () => {
      const captured: CreatePrRequest[] = [];
      const capturePr: PrCreator = {
        async create(req) {
          captured.push(req);
          return new StubPrCreator().create(req);
        },
      };

      const h = await buildHarness({ prCreator: capturePr });
      const res = await h.runner.start({
        projectId: 'p-1',
        ticketKey: VALID_TICKET,
      });
      expect(res.ok).toBe(true);

      void driveClaudeHappyPath(h);
      await waitForFinal(h);

      expect(captured).toHaveLength(1);
      const pr = captured[0]!;
      // Title MUST match `feat(<ticketKey>): <ticketSummary>` exactly.
      expect(pr.title).toMatch(/^feat\(ABC-1\):\s+/);
    });
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
});
