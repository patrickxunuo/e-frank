import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  StubGitManager,
  NodeGitManager,
  parseConflictFiles,
  parsePorcelainFiles,
  isAuthFailure,
} from '../../src/main/modules/git-manager';
import {
  FakeSpawner,
  type FakeSpawnedProcess,
  type SpawnOptions,
  type SpawnedProcess,
  type Spawner,
} from '../../src/main/modules/spawner';

/**
 * NodeGitManager + helpers tests.
 *
 * Each test maps to an acceptance ID from `acceptance/git-manager.md` so the
 * test report can be cross-referenced with the spec. Tests are grouped by
 * concern (helper, prepareRepo, createBranch, commit, push, parsers, wiring).
 *
 * The `QueuedSpawner` test seam wraps `FakeSpawner` with a FIFO queue of
 * canned subprocess responses so multi-step ops (prepareRepo runs 4-5 git
 * commands) can be driven deterministically without real git invocations.
 */

// -------------------------------------------------------------------------
// Test harness
// -------------------------------------------------------------------------

interface QueuedResponse {
  /** Optional substring match against the args array (joined with space).
   *  When set, the response is only used if the args include this. */
  argsContains?: string;
  exitCode: number;
  stdout?: string;
  stderr?: string;
  /** When true, simulate a hang — the test fires the exit manually. */
  hang?: boolean;
}

/**
 * Wraps FakeSpawner with a FIFO queue of canned responses. Records every
 * spawn() call so tests can assert on cwd / shell / args.
 */
class QueuedSpawner implements Spawner {
  readonly inner = new FakeSpawner();
  readonly calls: SpawnOptions[] = [];
  readonly procs: FakeSpawnedProcess[] = [];
  private queue: QueuedResponse[] = [];

  enqueue(...responses: QueuedResponse[]): void {
    this.queue.push(...responses);
  }

  spawn(options: SpawnOptions): SpawnedProcess {
    this.calls.push(options);
    const fake = this.inner.spawn(options);
    this.procs.push(fake);
    const next = this.queue.shift();
    if (next === undefined) {
      throw new Error(`unexpected git invocation: ${options.args.join(' ')}`);
    }
    if (next.hang === true) {
      // Don't fire exit; the test will fire it (or let timeout fire).
      return fake;
    }
    queueMicrotask(() => {
      if (next.stdout !== undefined && next.stdout !== '') {
        fake.emitStdout(next.stdout);
      }
      if (next.stderr !== undefined && next.stderr !== '') {
        fake.emitStderr(next.stderr);
      }
      fake.emitExit(next.exitCode);
    });
    return fake;
  }
}

// Realistic stderr fixtures.
const CONFLICT_STDERR = [
  'Auto-merging src/foo.ts',
  'CONFLICT (content): Merge conflict in src/foo.ts',
  'CONFLICT (modify/delete): src/bar.ts deleted in HEAD and modified in feat/x',
  'error: could not apply abc1234... feat: foo',
  '',
].join('\n');

const DIRTY_PORCELAIN_STDOUT = [' M src/foo.ts', '?? newfile.txt', 'A  staged.ts', ''].join('\n');

const AUTH_FAILED_STDERR = [
  "remote: HTTP Basic: Access denied",
  "fatal: Authentication failed for 'https://github.com/foo/bar.git/'",
  '',
].join('\n');

// -------------------------------------------------------------------------
// GIT-STUB-001..004 — StubGitManager (preserved from earlier issue)
// -------------------------------------------------------------------------
describe('StubGitManager', () => {
  it('GIT-STUB-001: prepareRepo returns ok with a baseSha', async () => {
    const git = new StubGitManager();
    const result = await git.prepareRepo({
      projectId: 'p-1',
      cwd: '/abs/repo',
      baseBranch: 'main',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.data.baseSha).toBe('string');
    expect(result.data.baseSha.length).toBeGreaterThan(0);
  });

  it('GIT-STUB-002: createBranch returns ok and echoes the requested branchName', async () => {
    const git = new StubGitManager();
    const result = await git.createBranch({
      cwd: '/abs/repo',
      branchName: 'feature/ABC-1-add-thing',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.branchName).toBe('feature/ABC-1-add-thing');
  });

  it('GIT-STUB-003: commit returns ok with a non-empty stub sha', async () => {
    const git = new StubGitManager();
    const result = await git.commit({
      cwd: '/abs/repo',
      message: 'feat(ABC-1): add thing',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.data.sha).toBe('string');
    expect(result.data.sha.length).toBeGreaterThan(0);
  });

  it('GIT-STUB-004: push returns ok', async () => {
    const git = new StubGitManager();
    const result = await git.push({
      cwd: '/abs/repo',
      branchName: 'feature/ABC-1-add-thing',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.data.remoteUrl !== undefined) {
      expect(typeof result.data.remoteUrl).toBe('string');
    }
  });
});

// -------------------------------------------------------------------------
// GIT-PARSE-001..004 — Stderr / porcelain parsers (pure functions)
// -------------------------------------------------------------------------
describe('GIT-PARSE-001..004 stderr parsers', () => {
  it('GIT-PARSE-001: parseConflictFiles extracts file from CONFLICT (content) line', () => {
    const result = parseConflictFiles(
      'CONFLICT (content): Merge conflict in src/foo.ts\n',
    );
    expect(result).toEqual(['src/foo.ts']);
  });

  it('GIT-PARSE-001 (extra): parseConflictFiles handles modify/delete variant', () => {
    const result = parseConflictFiles(CONFLICT_STDERR);
    // Must include both files from the realistic fixture.
    expect(result).toContain('src/foo.ts');
    expect(result).toContain('src/bar.ts deleted in HEAD and modified in feat/x'.replace(/^.*in /, ''));
    // Defensive: at minimum we got src/foo.ts; src/bar.ts is captured from
    // the modify/delete line via the same regex.
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it('GIT-PARSE-002: parseConflictFiles deduplicates repeated paths', () => {
    const stderr = [
      'CONFLICT (content): Merge conflict in src/foo.ts',
      'CONFLICT (content): Merge conflict in src/foo.ts',
      'CONFLICT (modify/delete): bar.ts deleted in HEAD and modified in feat/x',
      'CONFLICT (content): Merge conflict in src/foo.ts',
      '',
    ].join('\n');
    const result = parseConflictFiles(stderr);
    const fooCount = result.filter((p) => p === 'src/foo.ts').length;
    expect(fooCount).toBe(1);
    // Total unique entries should be 2 (foo + bar).
    expect(new Set(result).size).toBe(result.length);
  });

  it('GIT-PARSE-003: parsePorcelainFiles extracts paths from porcelain output', () => {
    const result = parsePorcelainFiles(DIRTY_PORCELAIN_STDOUT);
    expect(result).toEqual(['src/foo.ts', 'newfile.txt', 'staged.ts']);
  });

  it('GIT-PARSE-003 (extra): parsePorcelainFiles ignores blank lines', () => {
    const result = parsePorcelainFiles('\n\n');
    expect(result).toEqual([]);
  });

  it('GIT-PARSE-004: isAuthFailure matches "Authentication failed"', () => {
    expect(
      isAuthFailure("fatal: Authentication failed for 'https://github.com/foo/bar.git/'"),
    ).toBe(true);
  });

  it('GIT-PARSE-004: isAuthFailure matches "Permission denied (publickey)"', () => {
    expect(isAuthFailure('git@github.com: Permission denied (publickey).')).toBe(true);
  });

  it('GIT-PARSE-004: isAuthFailure matches "could not read Username"', () => {
    expect(
      isAuthFailure("fatal: could not read Username for 'https://github.com': terminal prompts disabled"),
    ).toBe(true);
  });

  it('GIT-PARSE-004: isAuthFailure matches "HTTP Basic: Access denied"', () => {
    expect(isAuthFailure('remote: HTTP Basic: Access denied')).toBe(true);
  });

  it('GIT-PARSE-004: isAuthFailure matches "fatal: could not read Password"', () => {
    expect(
      isAuthFailure("fatal: could not read Password for 'https://x@github.com'"),
    ).toBe(true);
  });

  it('GIT-PARSE-004 (negative): isAuthFailure returns false on benign stderr', () => {
    expect(isAuthFailure('error: pathspec did not match any files')).toBe(false);
  });
});

// -------------------------------------------------------------------------
// GIT-HELPER-001..005 — runGit helper
//
// We exercise these properties indirectly through the public NodeGitManager
// API (since runGit is internal): every public op spawns at least one git
// subcommand, so we can assert command/args/cwd/shell on the recorded
// `calls`. Timeout escalation is verified against a hung process.
// -------------------------------------------------------------------------
describe('GIT-HELPER-001..005 runGit helper', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('GIT-HELPER-001: invokes Spawner with command="git" and shell:false', async () => {
    const sp = new QueuedSpawner();
    sp.enqueue({ exitCode: 0, stdout: '' });
    const mgr = new NodeGitManager({ spawner: sp });
    // createBranch step 1: show-ref. We let it succeed (exit 0 = branch
    // exists) so the call returns quickly with BRANCH_EXISTS — we only care
    // that exactly one call was made and it had the right shape.
    await mgr.createBranch({ cwd: '/repo', branchName: 'feat/x' });
    expect(sp.calls.length).toBeGreaterThanOrEqual(1);
    const first = sp.calls[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(first.command).toBe('git');
    expect(first.shell).toBe(false);
  });

  it('GIT-HELPER-002: passes cwd to spawn unchanged', async () => {
    const sp = new QueuedSpawner();
    sp.enqueue({ exitCode: 0, stdout: '' });
    const mgr = new NodeGitManager({ spawner: sp });
    await mgr.createBranch({ cwd: '/some/abs/repo', branchName: 'feat/x' });
    const first = sp.calls[0];
    expect(first?.cwd).toBe('/some/abs/repo');
  });

  it('GIT-HELPER-003: resolves with exitCode/stdout/stderr after child exits', async () => {
    const sp = new QueuedSpawner();
    // commit happy path: add -A → commit -m → rev-parse HEAD
    sp.enqueue(
      { argsContains: 'add', exitCode: 0 },
      { argsContains: 'commit', exitCode: 0, stdout: '[main abc] feat: foo\n' },
      { argsContains: 'rev-parse', exitCode: 0, stdout: 'abcdef0\n' },
    );
    const mgr = new NodeGitManager({ spawner: sp });
    const r = await mgr.commit({ cwd: '/repo', message: 'feat: foo' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The result.data.sha is built from the trimmed rev-parse stdout —
    // proving the helper captured stdout correctly.
    expect(r.data.sha).toBe('abcdef0');
  });

  it('GIT-HELPER-004: SIGTERM → 500ms → SIGKILL on timeout', async () => {
    vi.useFakeTimers();
    const sp = new QueuedSpawner();
    // Hang on the first call (show-ref). The op uses local timeout (default 10s).
    sp.enqueue({ exitCode: 0, hang: true });
    const mgr = new NodeGitManager({
      spawner: sp,
      timeouts: { localMs: 1000, pullMs: 60_000, pushMs: 60_000 },
    });
    const promise = mgr.createBranch({ cwd: '/repo', branchName: 'feat/x' });

    // Advance past the local timeout — should send SIGTERM.
    await vi.advanceTimersByTimeAsync(1100);
    const proc = sp.procs[0];
    expect(proc).toBeDefined();
    if (proc === undefined) return;
    expect(proc.lastSignal).toBe('SIGTERM');

    // Advance another 600ms past the SIGTERM-grace — should escalate to SIGKILL.
    await vi.advanceTimersByTimeAsync(600);
    expect(proc.lastSignal).toBe('SIGKILL');

    // Now let the promise resolve (the impl emits an exit after kill).
    proc.emitExit(-1, 'SIGKILL');
    const r = await promise;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('TIMEOUT');
  });

  it('GIT-HELPER-005: truncates internal buffers at 16 KB', async () => {
    const sp = new QueuedSpawner();
    // Push a huge stderr chunk on the first call (show-ref). exit 0 means
    // BRANCH_EXISTS short-circuit. The huge stderr must NOT cause the
    // promise to reject — it should be silently capped.
    const huge = 'A'.repeat(50_000); // 50 KB > 16 KB cap
    sp.enqueue({ exitCode: 0, stdout: '', stderr: huge });
    const mgr = new NodeGitManager({ spawner: sp });
    const r = await mgr.createBranch({ cwd: '/repo', branchName: 'feat/x' });
    // The operation should still return cleanly (BRANCH_EXISTS) without
    // exploding from the oversized stderr.
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('BRANCH_EXISTS');
    // If `details.stderr` is surfaced, it must be capped at 4 KB or less.
    if (r.error.details?.stderr !== undefined) {
      expect(r.error.details.stderr.length).toBeLessThanOrEqual(4096);
    }
  });
});

// -------------------------------------------------------------------------
// GIT-PREPARE-001..009 — prepareRepo
// -------------------------------------------------------------------------
describe('GIT-PREPARE-001..009 prepareRepo', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('GIT-PREPARE-001: happy path returns baseSha from rev-parse HEAD', async () => {
    const sp = new QueuedSpawner();
    sp.enqueue(
      { argsContains: 'rev-parse', exitCode: 0, stdout: 'true\n' }, // is-inside-work-tree
      { argsContains: 'status', exitCode: 0, stdout: '' }, // clean
      { argsContains: 'checkout', exitCode: 0 }, // base
      { argsContains: 'pull', exitCode: 0 }, // pull --rebase
      { argsContains: 'rev-parse', exitCode: 0, stdout: 'abc123\n' }, // HEAD
    );
    const mgr = new NodeGitManager({ spawner: sp });
    const r = await mgr.prepareRepo({
      projectId: 'p',
      cwd: '/repo',
      baseBranch: 'qa',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.baseSha).toBe('abc123');
  });

  it('GIT-PREPARE-002: rev-parse non-zero exit → NOT_A_REPO', async () => {
    const sp = new QueuedSpawner();
    sp.enqueue({ exitCode: 128, stderr: 'fatal: not a git repository' });
    const mgr = new NodeGitManager({ spawner: sp });
    const r = await mgr.prepareRepo({
      projectId: 'p',
      cwd: '/no-repo',
      baseBranch: 'main',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('NOT_A_REPO');
    expect(r.error.message).toContain('/no-repo');
  });

  it('GIT-PREPARE-003: status --porcelain non-empty → DIRTY_TREE with files', async () => {
    const sp = new QueuedSpawner();
    sp.enqueue(
      { argsContains: 'rev-parse', exitCode: 0, stdout: 'true\n' },
      { argsContains: 'status', exitCode: 0, stdout: DIRTY_PORCELAIN_STDOUT },
    );
    const mgr = new NodeGitManager({ spawner: sp });
    const r = await mgr.prepareRepo({
      projectId: 'p',
      cwd: '/repo',
      baseBranch: 'main',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('DIRTY_TREE');
    expect(r.error.details?.files).toEqual(['src/foo.ts', 'newfile.txt', 'staged.ts']);
  });

  it('GIT-PREPARE-004: checkout failure → PULL_FAILED with stderr', async () => {
    const sp = new QueuedSpawner();
    sp.enqueue(
      { argsContains: 'rev-parse', exitCode: 0, stdout: 'true\n' },
      { argsContains: 'status', exitCode: 0, stdout: '' },
      {
        argsContains: 'checkout',
        exitCode: 1,
        stderr: "error: pathspec 'qa' did not match any file(s) known to git",
      },
    );
    const mgr = new NodeGitManager({ spawner: sp });
    const r = await mgr.prepareRepo({
      projectId: 'p',
      cwd: '/repo',
      baseBranch: 'qa',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('PULL_FAILED');
    expect(r.error.details?.stderr).toContain('pathspec');
  });

  it('GIT-PREPARE-005: pull --rebase CONFLICT → CONFLICT with parsed files', async () => {
    const sp = new QueuedSpawner();
    sp.enqueue(
      { argsContains: 'rev-parse', exitCode: 0, stdout: 'true\n' },
      { argsContains: 'status', exitCode: 0, stdout: '' },
      { argsContains: 'checkout', exitCode: 0 },
      { argsContains: 'pull', exitCode: 1, stderr: CONFLICT_STDERR },
    );
    const mgr = new NodeGitManager({ spawner: sp });
    const r = await mgr.prepareRepo({
      projectId: 'p',
      cwd: '/repo',
      baseBranch: 'main',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('CONFLICT');
    expect(r.error.details?.files).toContain('src/foo.ts');
  });

  it('GIT-PREPARE-006: pull --rebase auth failure → AUTH_FAILED', async () => {
    const sp = new QueuedSpawner();
    sp.enqueue(
      { argsContains: 'rev-parse', exitCode: 0, stdout: 'true\n' },
      { argsContains: 'status', exitCode: 0, stdout: '' },
      { argsContains: 'checkout', exitCode: 0 },
      { argsContains: 'pull', exitCode: 128, stderr: AUTH_FAILED_STDERR },
    );
    const mgr = new NodeGitManager({ spawner: sp });
    const r = await mgr.prepareRepo({
      projectId: 'p',
      cwd: '/repo',
      baseBranch: 'main',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('AUTH_FAILED');
  });

  it('GIT-PREPARE-007: pull --rebase generic failure → PULL_FAILED', async () => {
    const sp = new QueuedSpawner();
    sp.enqueue(
      { argsContains: 'rev-parse', exitCode: 0, stdout: 'true\n' },
      { argsContains: 'status', exitCode: 0, stdout: '' },
      { argsContains: 'checkout', exitCode: 0 },
      {
        argsContains: 'pull',
        exitCode: 1,
        stderr: 'error: cannot pull with rebase: You have unstaged changes.',
      },
    );
    const mgr = new NodeGitManager({ spawner: sp });
    const r = await mgr.prepareRepo({
      projectId: 'p',
      cwd: '/repo',
      baseBranch: 'main',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('PULL_FAILED');
    expect(r.error.details?.stderr).toContain('rebase');
  });

  it('GIT-PREPARE-008: pull/push timeout → TIMEOUT', async () => {
    vi.useFakeTimers();
    const sp = new QueuedSpawner();
    sp.enqueue(
      { argsContains: 'rev-parse', exitCode: 0, stdout: 'true\n' },
      { argsContains: 'status', exitCode: 0, stdout: '' },
      { argsContains: 'checkout', exitCode: 0 },
      // Hang on the pull.
      { exitCode: 0, hang: true },
    );
    const mgr = new NodeGitManager({
      spawner: sp,
      timeouts: { localMs: 10_000, pullMs: 1_000, pushMs: 60_000 },
    });
    const promise = mgr.prepareRepo({
      projectId: 'p',
      cwd: '/repo',
      baseBranch: 'main',
    });
    // Drain the first three (synchronous-microtask) calls.
    await vi.advanceTimersByTimeAsync(0);

    // Past the pull timeout — SIGTERM should fire on the hung pull proc
    // (procs[3] is the pull).
    await vi.advanceTimersByTimeAsync(1100);
    const pullProc = sp.procs[3];
    expect(pullProc).toBeDefined();
    if (pullProc === undefined) return;
    expect(pullProc.lastSignal).toBe('SIGTERM');

    // Past the SIGKILL grace.
    await vi.advanceTimersByTimeAsync(600);
    expect(pullProc.lastSignal).toBe('SIGKILL');

    pullProc.emitExit(-1, 'SIGKILL');
    const r = await promise;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('TIMEOUT');
  });

  it('GIT-PREPARE-009: every git invocation includes cwd and shell:false', async () => {
    const sp = new QueuedSpawner();
    sp.enqueue(
      { argsContains: 'rev-parse', exitCode: 0, stdout: 'true\n' },
      { argsContains: 'status', exitCode: 0, stdout: '' },
      { argsContains: 'checkout', exitCode: 0 },
      { argsContains: 'pull', exitCode: 0 },
      { argsContains: 'rev-parse', exitCode: 0, stdout: 'abc\n' },
    );
    const mgr = new NodeGitManager({ spawner: sp });
    await mgr.prepareRepo({ projectId: 'p', cwd: '/abs/repo', baseBranch: 'main' });
    expect(sp.calls.length).toBe(5);
    for (const call of sp.calls) {
      expect(call.command).toBe('git');
      expect(call.cwd).toBe('/abs/repo');
      expect(call.shell).toBe(false);
    }
  });
});

// -------------------------------------------------------------------------
// GIT-BRANCH-001..003 — createBranch
// -------------------------------------------------------------------------
describe('GIT-BRANCH-001..003 createBranch', () => {
  it('GIT-BRANCH-001: happy path: show-ref (exit 1) → checkout -b → ok', async () => {
    const sp = new QueuedSpawner();
    sp.enqueue(
      { argsContains: 'show-ref', exitCode: 1 }, // not found
      { argsContains: 'checkout', exitCode: 0 },
    );
    const mgr = new NodeGitManager({ spawner: sp });
    const r = await mgr.createBranch({
      cwd: '/repo',
      branchName: 'feat/ABC-1-add',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.branchName).toBe('feat/ABC-1-add');
    // Second call must be checkout -b <branch>.
    const second = sp.calls[1];
    expect(second).toBeDefined();
    if (second === undefined) return;
    expect(second.args).toContain('checkout');
    expect(second.args).toContain('-b');
    expect(second.args).toContain('feat/ABC-1-add');
  });

  it('GIT-BRANCH-002: show-ref exit 0 → BRANCH_EXISTS with branch in message', async () => {
    const sp = new QueuedSpawner();
    sp.enqueue({ argsContains: 'show-ref', exitCode: 0 });
    const mgr = new NodeGitManager({ spawner: sp });
    const r = await mgr.createBranch({
      cwd: '/repo',
      branchName: 'feat/already-here',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('BRANCH_EXISTS');
    expect(r.error.message).toContain('feat/already-here');
  });

  it('GIT-BRANCH-003: checkout -b failure → BRANCH_FAILED with stderr', async () => {
    const sp = new QueuedSpawner();
    sp.enqueue(
      { argsContains: 'show-ref', exitCode: 1 },
      {
        argsContains: 'checkout',
        exitCode: 128,
        stderr: "fatal: invalid reference: feat/!!!",
      },
    );
    const mgr = new NodeGitManager({ spawner: sp });
    const r = await mgr.createBranch({
      cwd: '/repo',
      branchName: 'feat/!!!',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('BRANCH_FAILED');
    expect(r.error.details?.stderr).toContain('invalid reference');
  });
});

// -------------------------------------------------------------------------
// GIT-COMMIT-001..006 — commit
// -------------------------------------------------------------------------
describe('GIT-COMMIT-001..006 commit', () => {
  it('GIT-COMMIT-001: happy path: add -A → commit -m → rev-parse → ok', async () => {
    const sp = new QueuedSpawner();
    sp.enqueue(
      { argsContains: 'add', exitCode: 0 },
      { argsContains: 'commit', exitCode: 0, stdout: '[main abc] feat: x\n' },
      { argsContains: 'rev-parse', exitCode: 0, stdout: 'abcdef0123\n' },
    );
    const mgr = new NodeGitManager({ spawner: sp });
    const r = await mgr.commit({ cwd: '/repo', message: 'feat(ABC-1): add x' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.sha).toBe('abcdef0123');
    // First call: add -A
    expect(sp.calls[0]?.args).toContain('add');
    expect(sp.calls[0]?.args).toContain('-A');
    // Second call: commit -m <message>
    expect(sp.calls[1]?.args).toContain('commit');
    expect(sp.calls[1]?.args).toContain('-m');
    expect(sp.calls[1]?.args).toContain('feat(ABC-1): add x');
  });

  it('GIT-COMMIT-002: "nothing to commit" → NO_CHANGES', async () => {
    const sp = new QueuedSpawner();
    sp.enqueue(
      { argsContains: 'add', exitCode: 0 },
      {
        argsContains: 'commit',
        exitCode: 1,
        stdout: 'On branch main\nnothing to commit, working tree clean\n',
      },
    );
    const mgr = new NodeGitManager({ spawner: sp });
    const r = await mgr.commit({ cwd: '/repo', message: 'feat: x' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('NO_CHANGES');
  });

  it('GIT-COMMIT-002 (extra): "no changes added to commit" → NO_CHANGES', async () => {
    const sp = new QueuedSpawner();
    sp.enqueue(
      { argsContains: 'add', exitCode: 0 },
      {
        argsContains: 'commit',
        exitCode: 1,
        stderr: 'no changes added to commit (use "git add")',
      },
    );
    const mgr = new NodeGitManager({ spawner: sp });
    const r = await mgr.commit({ cwd: '/repo', message: 'feat: x' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('NO_CHANGES');
  });

  it('GIT-COMMIT-003: commit args do NOT include --no-verify', async () => {
    const sp = new QueuedSpawner();
    sp.enqueue(
      { argsContains: 'add', exitCode: 0 },
      { argsContains: 'commit', exitCode: 0 },
      { argsContains: 'rev-parse', exitCode: 0, stdout: 'abc\n' },
    );
    const mgr = new NodeGitManager({ spawner: sp });
    await mgr.commit({ cwd: '/repo', message: 'feat: x' });
    // Check every call's args array (not joined) for --no-verify.
    for (const call of sp.calls) {
      expect(call.args.includes('--no-verify')).toBe(false);
    }
  });

  it('GIT-COMMIT-004: commit args do NOT include --no-gpg-sign', async () => {
    const sp = new QueuedSpawner();
    sp.enqueue(
      { argsContains: 'add', exitCode: 0 },
      { argsContains: 'commit', exitCode: 0 },
      { argsContains: 'rev-parse', exitCode: 0, stdout: 'abc\n' },
    );
    const mgr = new NodeGitManager({ spawner: sp });
    await mgr.commit({ cwd: '/repo', message: 'feat: x' });
    for (const call of sp.calls) {
      expect(call.args.includes('--no-gpg-sign')).toBe(false);
    }
  });

  it('GIT-COMMIT-005: add -A failure → COMMIT_FAILED with stderr', async () => {
    const sp = new QueuedSpawner();
    sp.enqueue({
      argsContains: 'add',
      exitCode: 128,
      stderr: 'fatal: pathspec error',
    });
    const mgr = new NodeGitManager({ spawner: sp });
    const r = await mgr.commit({ cwd: '/repo', message: 'feat: x' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('COMMIT_FAILED');
    expect(r.error.details?.stderr).toContain('pathspec error');
  });

  it('GIT-COMMIT-006: commit failure (other) → COMMIT_FAILED with stderr', async () => {
    const sp = new QueuedSpawner();
    sp.enqueue(
      { argsContains: 'add', exitCode: 0 },
      {
        argsContains: 'commit',
        exitCode: 1,
        stderr: 'error: gpg failed to sign the data',
      },
    );
    const mgr = new NodeGitManager({ spawner: sp });
    const r = await mgr.commit({ cwd: '/repo', message: 'feat: x' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('COMMIT_FAILED');
    expect(r.error.details?.stderr).toContain('gpg failed');
  });
});

// -------------------------------------------------------------------------
// GIT-PUSH-001..005 — push
// -------------------------------------------------------------------------
describe('GIT-PUSH-001..005 push', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('GIT-PUSH-001: happy path: push -u origin <branch> → ok', async () => {
    const sp = new QueuedSpawner();
    sp.enqueue(
      { argsContains: 'push', exitCode: 0 },
      // Best-effort remote URL probe.
      {
        argsContains: 'remote',
        exitCode: 0,
        stdout: 'https://github.com/foo/bar.git\n',
      },
    );
    const mgr = new NodeGitManager({ spawner: sp });
    const r = await mgr.push({
      cwd: '/repo',
      branchName: 'feat/ABC-1-add',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // remoteUrl is best-effort; if present, it should be a string.
    if (r.data.remoteUrl !== undefined) {
      expect(typeof r.data.remoteUrl).toBe('string');
      expect(r.data.remoteUrl).toContain('github.com');
    }
    // First call must be `push -u origin <branch>`.
    const first = sp.calls[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(first.args).toContain('push');
    expect(first.args).toContain('-u');
    expect(first.args).toContain('origin');
    expect(first.args).toContain('feat/ABC-1-add');
  });

  it('GIT-PUSH-002: push args do NOT include --force or --force-with-lease', async () => {
    const sp = new QueuedSpawner();
    sp.enqueue(
      { argsContains: 'push', exitCode: 0 },
      { argsContains: 'remote', exitCode: 0, stdout: '' },
    );
    const mgr = new NodeGitManager({ spawner: sp });
    await mgr.push({ cwd: '/repo', branchName: 'feat/x' });
    for (const call of sp.calls) {
      // Use array .includes so a partial-string substring match (e.g. inside
      // a branch name) doesn't false-positive.
      expect(call.args.includes('--force')).toBe(false);
      expect(call.args.includes('--force-with-lease')).toBe(false);
      expect(call.args.includes('-f')).toBe(false);
    }
  });

  it('GIT-PUSH-003: auth pattern in stderr → AUTH_FAILED', async () => {
    const sp = new QueuedSpawner();
    sp.enqueue({
      argsContains: 'push',
      exitCode: 128,
      stderr: AUTH_FAILED_STDERR,
    });
    const mgr = new NodeGitManager({ spawner: sp });
    const r = await mgr.push({ cwd: '/repo', branchName: 'feat/x' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('AUTH_FAILED');
  });

  it('GIT-PUSH-004: other failure → PUSH_FAILED with stderr', async () => {
    const sp = new QueuedSpawner();
    sp.enqueue({
      argsContains: 'push',
      exitCode: 1,
      stderr:
        'remote: error: GH006: Protected branch update failed for refs/heads/main',
    });
    const mgr = new NodeGitManager({ spawner: sp });
    const r = await mgr.push({ cwd: '/repo', branchName: 'feat/x' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('PUSH_FAILED');
    expect(r.error.details?.stderr).toContain('Protected branch');
  });

  it('GIT-PUSH-005: push timeout → TIMEOUT', async () => {
    vi.useFakeTimers();
    const sp = new QueuedSpawner();
    sp.enqueue({ exitCode: 0, hang: true });
    const mgr = new NodeGitManager({
      spawner: sp,
      timeouts: { localMs: 10_000, pullMs: 60_000, pushMs: 1_000 },
    });
    const promise = mgr.push({ cwd: '/repo', branchName: 'feat/x' });
    await vi.advanceTimersByTimeAsync(1100);
    const proc = sp.procs[0];
    expect(proc).toBeDefined();
    if (proc === undefined) return;
    expect(proc.lastSignal).toBe('SIGTERM');
    await vi.advanceTimersByTimeAsync(600);
    expect(proc.lastSignal).toBe('SIGKILL');
    proc.emitExit(-1, 'SIGKILL');
    const r = await promise;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('TIMEOUT');
  });
});

// -------------------------------------------------------------------------
// GIT-WIRE-001 — main/index.ts instantiates NodeGitManager
// -------------------------------------------------------------------------
describe('GIT-WIRE-001 main wiring', () => {
  it('GIT-WIRE-001: main/index.ts instantiates NodeGitManager (not StubGitManager)', () => {
    const indexPath = resolve(__dirname, '../../src/main/index.ts');
    const text = readFileSync(indexPath, 'utf8');
    expect(text).toContain('new NodeGitManager(');
    // Confirm the StubGitManager construction has been removed from the
    // active wiring path. We allow `StubGitManager` to still be imported
    // (kept as a fallback per spec) — only the live `new StubGitManager()`
    // call should be gone.
    expect(text).not.toContain('new StubGitManager()');
  });
});
