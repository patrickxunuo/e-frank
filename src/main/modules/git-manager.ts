/**
 * GitManager — interface + Stub + real Node implementation.
 *
 * `StubGitManager` (resolves successfully without doing anything) was the #7
 * placeholder. `NodeGitManager` (issue #10) is the production implementation
 * that wraps the `git` CLI via the existing `Spawner` abstraction. Both are
 * exported; production wiring uses `NodeGitManager`, tests / debug builds may
 * still pick up the stub.
 *
 * The four `GitManager` operations (`prepareRepo`, `createBranch`, `commit`,
 * `push`) match the calls already issued by `WorkflowRunner`.
 */

import type { Spawner, SpawnedProcess } from './spawner.js';

export interface PrepareRepoRequest {
  projectId: string;
  cwd: string;
  baseBranch: string;
}

export interface CreateBranchRequest {
  cwd: string;
  branchName: string;
}

export interface CommitRequest {
  cwd: string;
  message: string;
}

export interface PushRequest {
  cwd: string;
  branchName: string;
}

export type GitErrorCode =
  | 'NOT_A_REPO'
  | 'DIRTY_TREE'
  | 'BRANCH_EXISTS'
  | 'CONFLICT'
  | 'NO_CHANGES'
  | 'AUTH_FAILED'
  | 'PULL_FAILED'
  | 'BRANCH_FAILED'
  | 'COMMIT_FAILED'
  | 'PUSH_FAILED'
  | 'TIMEOUT'
  | 'IO_FAILURE';

export interface GitErrorDetails {
  /** Files involved in the failure (for CONFLICT, DIRTY_TREE). Optional. */
  files?: string[];
  /** Raw stderr, capped at 4 KB. Useful for diagnostics; safe to surface. */
  stderr?: string;
  /** The git subcommand that failed (e.g. 'pull', 'commit'). */
  subcommand?: string;
}

export type GitResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: { code: GitErrorCode; message: string; details?: GitErrorDetails };
    };

export interface GitManager {
  prepareRepo(req: PrepareRepoRequest): Promise<GitResult<{ baseSha: string }>>;
  createBranch(req: CreateBranchRequest): Promise<GitResult<{ branchName: string }>>;
  commit(req: CommitRequest): Promise<GitResult<{ sha: string }>>;
  push(req: PushRequest): Promise<GitResult<{ remoteUrl?: string }>>;
}

/**
 * Stub implementation — resolves successfully without doing anything. Real
 * implementation is `NodeGitManager` below; the stub is kept for tests and
 * debug builds that don't want to spawn real `git`.
 */
export class StubGitManager implements GitManager {
  async prepareRepo(_req: PrepareRepoRequest): Promise<GitResult<{ baseSha: string }>> {
    return { ok: true, data: { baseSha: 'stub-base-sha' } };
  }

  async createBranch(req: CreateBranchRequest): Promise<GitResult<{ branchName: string }>> {
    return { ok: true, data: { branchName: req.branchName } };
  }

  async commit(_req: CommitRequest): Promise<GitResult<{ sha: string }>> {
    return { ok: true, data: { sha: 'stub-commit-sha' } };
  }

  async push(_req: PushRequest): Promise<GitResult<{ remoteUrl?: string }>> {
    return { ok: true, data: {} };
  }
}

// -- NodeGitManager ----------------------------------------------------------

const DEFAULT_LOCAL_TIMEOUT_MS = 10_000;
const DEFAULT_PULL_TIMEOUT_MS = 60_000;
const DEFAULT_PUSH_TIMEOUT_MS = 60_000;
const KILL_GRACE_MS = 500;

/** Cap raw stream capture at 16 KB to bound memory. */
const STREAM_CAP_BYTES = 16 * 1024;
/** Cap surfaced `details.stderr` at 4 KB. */
const STDERR_DETAIL_CAP_BYTES = 4 * 1024;

export interface NodeGitManagerOptions {
  spawner: Spawner;
  /** Defaults below: 10s for local ops, 60s for pull/push. */
  timeouts?: {
    localMs?: number;
    pullMs?: number;
    pushMs?: number;
  };
  /** PATH lookup name. Defaults to 'git'. Override for tests / portable installs. */
  gitBin?: string;
}

export interface RunGitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * CONFLICT-line parser: returns the affected file paths.
 *
 * Matches lines like `CONFLICT (content): Merge conflict in src/foo.ts` and
 * extracts the trailing path. Deduplicates so multi-line repeats don't
 * inflate the surfaced list.
 */
export function parseConflictFiles(stderr: string): string[] {
  const out: string[] = [];
  const re = /^CONFLICT \([^)]+\): .+ in (.+)$/gm;
  for (const m of stderr.matchAll(re)) {
    if (m[1] !== undefined) out.push(m[1]);
  }
  return [...new Set(out)];
}

/**
 * Auth-failure detector. Matches the well-known patterns produced by both
 * HTTPS- and SSH-backed remotes, plus Git's own credential-prompt fallbacks
 * (which always fail in a non-TTY context like ours).
 */
export function isAuthFailure(stderr: string): boolean {
  return (
    /Authentication failed/i.test(stderr) ||
    /Permission denied \(publickey\)/i.test(stderr) ||
    /could not read Username/i.test(stderr) ||
    /HTTP Basic: Access denied/i.test(stderr) ||
    /fatal: could not read Password/i.test(stderr)
  );
}

/**
 * Dirty-tree porcelain parser: each line is `XY <path>` (two status chars +
 * space + path). We slice off the first three chars to recover the path.
 * Trailing whitespace is trimmed so trailing CRs (Windows) don't leak.
 */
export function parsePorcelainFiles(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue;
    // Use the original line (not trimmed) for slicing — porcelain's leading
    // 2 chars are the status, then a space, then the path. Trim only the
    // recovered path so trailing `\r` on Windows doesn't leak through.
    const path = line.slice(3).trim();
    if (path === '') continue;
    out.push(path);
  }
  return out;
}

/**
 * Spawn `git` with a controlled cwd, args, and timeout. Captures stdout +
 * stderr into capped strings, escalates SIGTERM → SIGKILL on timeout, and
 * resolves with `{ exitCode, stdout, stderr, timedOut }`.
 *
 * NEVER goes through a shell — `shell: false` is always set so the args are
 * delivered directly to the git binary, eliminating any chance of shell
 * interpolation. The `NodeSpawner` defaults to `shell: true` for `claude.cmd`
 * resolution, so this `false` is load-bearing.
 */
export async function runGit(
  spawner: Spawner,
  gitBin: string,
  cwd: string,
  args: ReadonlyArray<string>,
  timeoutMs: number,
): Promise<RunGitResult> {
  return new Promise<RunGitResult>((resolve) => {
    let child: SpawnedProcess;
    try {
      child = spawner.spawn({
        command: gitBin,
        args,
        cwd,
        shell: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      resolve({ exitCode: -1, stdout: '', stderr: message, timedOut: false });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdoutBytesRef = { v: 0 };
    const stdoutTruncRef = { v: false };
    const stderrBytesRef = { v: 0 };
    const stderrTruncRef = { v: false };

    const collect = (
      chunks: Buffer[],
      bytesRef: { v: number },
      truncatedRef: { v: boolean },
      chunk: Buffer | string,
    ): void => {
      if (truncatedRef.v) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      const remaining = STREAM_CAP_BYTES - bytesRef.v;
      if (remaining <= 0) {
        truncatedRef.v = true;
        return;
      }
      if (buf.length <= remaining) {
        chunks.push(buf);
        bytesRef.v += buf.length;
      } else {
        chunks.push(buf.subarray(0, remaining));
        bytesRef.v += remaining;
        truncatedRef.v = true;
      }
    };

    if (child.stdout !== null) {
      child.stdout.on('data', (chunk: Buffer | string) => {
        collect(stdoutChunks, stdoutBytesRef, stdoutTruncRef, chunk);
      });
    }
    if (child.stderr !== null) {
      child.stderr.on('data', (chunk: Buffer | string) => {
        collect(stderrChunks, stderrBytesRef, stderrTruncRef, chunk);
      });
    }

    let timedOut = false;
    let exited = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let killEscalationTimer: ReturnType<typeof setTimeout> | null = null;

    const finalize = (exitCode: number): void => {
      if (exited) return;
      exited = true;
      if (timeoutTimer !== null) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (killEscalationTimer !== null) {
        clearTimeout(killEscalationTimer);
        killEscalationTimer = null;
      }
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      resolve({ exitCode, stdout, stderr, timedOut });
    };

    child.on('exit', (code, _signal) => {
      // If the child was SIGKILL'd after timeout, exit code may be null.
      finalize(code ?? -1);
    });

    child.on('error', (err) => {
      // ENOENT / spawn errors. Treat as exit -1 with the error message in
      // stderr so callers can still reason about the failure.
      if (exited) return;
      const buf = Buffer.from(err.message, 'utf8');
      collect(stderrChunks, stderrBytesRef, stderrTruncRef, buf);
      finalize(-1);
    });

    // Timeout dance: SIGTERM, then SIGKILL after KILL_GRACE_MS more.
    timeoutTimer = setTimeout(() => {
      if (exited) return;
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // best-effort
      }
      killEscalationTimer = setTimeout(() => {
        killEscalationTimer = null;
        if (exited) return;
        try {
          child.kill('SIGKILL');
        } catch {
          // best-effort — exit listener still wins eventually.
        }
      }, KILL_GRACE_MS);
    }, timeoutMs);
  });
}

/**
 * Scrub inline credentials embedded in remote URLs that git happily echoes
 * to stderr. When a push fails, git prints the remote URL verbatim, and on
 * HTTPS-with-token setups that URL carries the credential in the userinfo
 * portion (everything before the `@`). This regex replaces that whole
 * portion with `***` so callers (and surfaced error messages, and any
 * downstream logs) never see the secret.
 *
 * Runs before byte-cap so we can't accidentally surface a trailing partial
 * token if the substitution falls within the truncation boundary.
 */
function scrubStderr(s: string): string {
  return s.replace(/(https?:\/\/)[^@\s/]+@/g, '$1***@');
}

/** Cap a string at 4 KB for surfacing in `details.stderr`. */
function cap4k(s: string): string {
  const scrubbed = scrubStderr(s);
  if (Buffer.byteLength(scrubbed, 'utf8') <= STDERR_DETAIL_CAP_BYTES) return scrubbed;
  // Slice by bytes so we don't truncate mid-codepoint catastrophically.
  const buf = Buffer.from(scrubbed, 'utf8');
  return buf.subarray(0, STDERR_DETAIL_CAP_BYTES).toString('utf8');
}

/**
 * Production GitManager — wraps the `git` CLI through the injected Spawner.
 *
 * Every operation runs in the project's `cwd` (passed through verbatim).
 * Args are hardcoded array literals — no string concatenation, no shell —
 * so command injection is impossible at this layer.
 */
export class NodeGitManager implements GitManager {
  private readonly spawner: Spawner;
  private readonly gitBin: string;
  private readonly localMs: number;
  private readonly pullMs: number;
  private readonly pushMs: number;

  constructor(options: NodeGitManagerOptions) {
    this.spawner = options.spawner;
    this.gitBin = options.gitBin ?? 'git';
    this.localMs = options.timeouts?.localMs ?? DEFAULT_LOCAL_TIMEOUT_MS;
    this.pullMs = options.timeouts?.pullMs ?? DEFAULT_PULL_TIMEOUT_MS;
    this.pushMs = options.timeouts?.pushMs ?? DEFAULT_PUSH_TIMEOUT_MS;
  }

  async prepareRepo(
    req: PrepareRepoRequest,
  ): Promise<GitResult<{ baseSha: string }>> {
    // 1. Verify repo.
    const insideRes = await runGit(
      this.spawner,
      this.gitBin,
      req.cwd,
      ['rev-parse', '--is-inside-work-tree'],
      this.localMs,
    );
    if (insideRes.timedOut) {
      return this.gitErr('TIMEOUT', `git rev-parse timed out in ${req.cwd}`, 'rev-parse', insideRes.stderr);
    }
    if (insideRes.exitCode !== 0) {
      return this.gitErr(
        'NOT_A_REPO',
        `not a git repository: ${req.cwd}`,
        'rev-parse',
        insideRes.stderr,
      );
    }

    // 2. Check clean tree.
    const statusRes = await runGit(
      this.spawner,
      this.gitBin,
      req.cwd,
      ['status', '--porcelain'],
      this.localMs,
    );
    if (statusRes.timedOut) {
      return this.gitErr('TIMEOUT', `git status timed out in ${req.cwd}`, 'status', statusRes.stderr);
    }
    if (statusRes.exitCode !== 0) {
      return this.gitErr('IO_FAILURE', 'git status failed', 'status', statusRes.stderr);
    }
    const dirtyFiles = parsePorcelainFiles(statusRes.stdout);
    if (dirtyFiles.length > 0) {
      return this.gitErr(
        'DIRTY_TREE',
        `working tree has uncommitted changes (${dirtyFiles.length} file${dirtyFiles.length === 1 ? '' : 's'})`,
        'status',
        statusRes.stderr,
        dirtyFiles,
      );
    }

    // 3. Checkout base.
    const checkoutRes = await runGit(
      this.spawner,
      this.gitBin,
      req.cwd,
      ['checkout', req.baseBranch],
      this.localMs,
    );
    if (checkoutRes.timedOut) {
      return this.gitErr(
        'TIMEOUT',
        `git checkout ${req.baseBranch} timed out`,
        'checkout',
        checkoutRes.stderr,
      );
    }
    if (checkoutRes.exitCode !== 0) {
      return this.gitErr(
        'PULL_FAILED',
        `git checkout ${req.baseBranch} failed`,
        'checkout',
        checkoutRes.stderr,
      );
    }

    // 4. Pull --rebase.
    const pullRes = await runGit(
      this.spawner,
      this.gitBin,
      req.cwd,
      ['pull', '--rebase'],
      this.pullMs,
    );
    if (pullRes.timedOut) {
      return this.gitErr('TIMEOUT', 'git pull --rebase timed out', 'pull', pullRes.stderr);
    }
    if (pullRes.exitCode !== 0) {
      const conflictFiles = parseConflictFiles(pullRes.stderr);
      if (conflictFiles.length > 0) {
        return this.gitErr(
          'CONFLICT',
          `git pull --rebase produced conflicts in ${conflictFiles.length} file${conflictFiles.length === 1 ? '' : 's'}`,
          'pull',
          pullRes.stderr,
          conflictFiles,
        );
      }
      if (isAuthFailure(pullRes.stderr)) {
        return this.gitErr(
          'AUTH_FAILED',
          'git authentication failed during pull',
          'pull',
          pullRes.stderr,
        );
      }
      return this.gitErr('PULL_FAILED', 'git pull --rebase failed', 'pull', pullRes.stderr);
    }

    // 5. Capture base sha.
    const shaRes = await runGit(
      this.spawner,
      this.gitBin,
      req.cwd,
      ['rev-parse', 'HEAD'],
      this.localMs,
    );
    if (shaRes.timedOut) {
      return this.gitErr('TIMEOUT', 'git rev-parse HEAD timed out', 'rev-parse', shaRes.stderr);
    }
    if (shaRes.exitCode !== 0) {
      return this.gitErr(
        'IO_FAILURE',
        'git rev-parse HEAD failed',
        'rev-parse',
        shaRes.stderr,
      );
    }
    return { ok: true, data: { baseSha: shaRes.stdout.trim() } };
  }

  async createBranch(
    req: CreateBranchRequest,
  ): Promise<GitResult<{ branchName: string }>> {
    // 1. Check branch doesn't exist locally.
    const refRes = await runGit(
      this.spawner,
      this.gitBin,
      req.cwd,
      ['show-ref', '--verify', '--quiet', `refs/heads/${req.branchName}`],
      this.localMs,
    );
    if (refRes.timedOut) {
      return this.gitErr(
        'TIMEOUT',
        `git show-ref timed out for branch "${req.branchName}"`,
        'show-ref',
        refRes.stderr,
      );
    }
    if (refRes.exitCode === 0) {
      return this.gitErr(
        'BRANCH_EXISTS',
        `a branch named '${req.branchName}' already exists; rename or delete it`,
        'show-ref',
      );
    }

    // 2. Create + check out.
    const checkoutRes = await runGit(
      this.spawner,
      this.gitBin,
      req.cwd,
      ['checkout', '-b', req.branchName],
      this.localMs,
    );
    if (checkoutRes.timedOut) {
      return this.gitErr(
        'TIMEOUT',
        `git checkout -b ${req.branchName} timed out`,
        'checkout',
        checkoutRes.stderr,
      );
    }
    if (checkoutRes.exitCode !== 0) {
      return this.gitErr(
        'BRANCH_FAILED',
        `git checkout -b ${req.branchName} failed`,
        'checkout',
        checkoutRes.stderr,
      );
    }
    return { ok: true, data: { branchName: req.branchName } };
  }

  async commit(req: CommitRequest): Promise<GitResult<{ sha: string }>> {
    // 1. Stage everything.
    const addRes = await runGit(
      this.spawner,
      this.gitBin,
      req.cwd,
      ['add', '-A'],
      this.localMs,
    );
    if (addRes.timedOut) {
      return this.gitErr('TIMEOUT', 'git add -A timed out', 'add', addRes.stderr);
    }
    if (addRes.exitCode !== 0) {
      return this.gitErr('COMMIT_FAILED', 'git add -A failed', 'add', addRes.stderr);
    }

    // 2. Commit. Args explicitly DO NOT include --no-verify or --no-gpg-sign:
    //    hooks run, signing config respected.
    const commitRes = await runGit(
      this.spawner,
      this.gitBin,
      req.cwd,
      ['commit', '-m', req.message],
      this.localMs,
    );
    if (commitRes.timedOut) {
      return this.gitErr('TIMEOUT', 'git commit timed out', 'commit', commitRes.stderr);
    }
    if (commitRes.exitCode !== 0) {
      const combined = `${commitRes.stdout}\n${commitRes.stderr}`;
      if (
        /nothing to commit/i.test(combined) ||
        /no changes added to commit/i.test(combined)
      ) {
        return this.gitErr(
          'NO_CHANGES',
          'nothing to commit (working tree clean)',
          'commit',
          commitRes.stderr,
        );
      }
      return this.gitErr('COMMIT_FAILED', 'git commit failed', 'commit', commitRes.stderr);
    }

    // 3. Capture commit sha.
    const shaRes = await runGit(
      this.spawner,
      this.gitBin,
      req.cwd,
      ['rev-parse', 'HEAD'],
      this.localMs,
    );
    if (shaRes.timedOut) {
      return this.gitErr('TIMEOUT', 'git rev-parse HEAD timed out', 'rev-parse', shaRes.stderr);
    }
    if (shaRes.exitCode !== 0) {
      return this.gitErr(
        'IO_FAILURE',
        'git rev-parse HEAD failed',
        'rev-parse',
        shaRes.stderr,
      );
    }
    return { ok: true, data: { sha: shaRes.stdout.trim() } };
  }

  async push(req: PushRequest): Promise<GitResult<{ remoteUrl?: string }>> {
    // Push. Args DO NOT include --force, --force-with-lease, or any flag
    // that overrides safe-push behaviour.
    const pushRes = await runGit(
      this.spawner,
      this.gitBin,
      req.cwd,
      ['push', '-u', 'origin', req.branchName],
      this.pushMs,
    );
    if (pushRes.timedOut) {
      return this.gitErr('TIMEOUT', 'git push timed out', 'push', pushRes.stderr);
    }
    if (pushRes.exitCode !== 0) {
      if (isAuthFailure(pushRes.stderr)) {
        return this.gitErr(
          'AUTH_FAILED',
          'git authentication failed during push',
          'push',
          pushRes.stderr,
        );
      }
      return this.gitErr('PUSH_FAILED', 'git push failed', 'push', pushRes.stderr);
    }

    // Capture remote URL — best-effort, failure is non-fatal.
    const remoteRes = await runGit(
      this.spawner,
      this.gitBin,
      req.cwd,
      ['remote', 'get-url', 'origin'],
      this.localMs,
    );
    if (
      !remoteRes.timedOut &&
      remoteRes.exitCode === 0 &&
      remoteRes.stdout.trim() !== ''
    ) {
      return { ok: true, data: { remoteUrl: remoteRes.stdout.trim() } };
    }
    return { ok: true, data: {} };
  }

  /**
   * Build a typed error result, capping `details.stderr` at 4 KB so the
   * surfaced payload stays bounded. Empty / undefined parts of `details` are
   * omitted so the payload is minimal.
   */
  private gitErr<T>(
    code: GitErrorCode,
    message: string,
    subcommand?: string,
    stderr?: string,
    files?: string[],
  ): GitResult<T> {
    const details: GitErrorDetails = {};
    if (subcommand !== undefined) details.subcommand = subcommand;
    if (stderr !== undefined && stderr !== '') details.stderr = cap4k(stderr);
    if (files !== undefined && files.length > 0) details.files = files;
    const error: { code: GitErrorCode; message: string; details?: GitErrorDetails } = {
      code,
      message,
    };
    if (Object.keys(details).length > 0) {
      error.details = details;
    }
    return { ok: false, error };
  }
}
