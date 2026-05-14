/**
 * WorktreeManager — per-run git worktree lifecycle (#GH-72).
 *
 * Background: the workflow runner historically ran every run in the project's
 * primary working tree. That made concurrent runs impossible (they'd race on
 * `git checkout` / commits) and meant the user couldn't keep editing their
 * own files on the primary checkout while a run was in flight. This module
 * gives each run its own sibling working tree via `git worktree add`,
 * isolating runs from the user's primary checkout and from each other.
 *
 * Concurrency note: this is PR A of #GH-72 — worktree infrastructure only,
 * still wired into the single-active-run path. The single-slot runner is
 * unchanged in this PR. PR B drops the app-wide lock and exposes the
 * concurrency to users. Filing this as infra-first keeps each PR reviewable.
 *
 * Path layout under `worktreesRoot`:
 *   <worktreesRoot>/<runId>/    — the working tree for run `<runId>`
 *
 * runIds are UUIDs so the basename collision-free across projects. The
 * source-repo's `.git/worktrees/<runId>/` admin folder mirrors the same
 * name. `pruneStaleWorktrees` is called from startup to nuke any
 * directories left behind by a crashed run.
 */

import * as path from 'node:path';
import type { Spawner } from './spawner.js';
import { runGit, type RunGitResult } from './git-manager.js';

export type WorktreeErrorCode =
  | 'GIT_NOT_FOUND'
  | 'ADD_FAILED'
  | 'REMOVE_FAILED'
  | 'PRUNE_FAILED'
  | 'IO_FAILURE'
  | 'TIMEOUT';

export interface WorktreeErrorDetails {
  /** The git subcommand that failed. */
  subcommand?: string;
  /** Raw stderr, capped to 4 KB upstream by `runGit`. */
  stderr?: string;
}

export type WorktreeResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: WorktreeErrorCode; message: string; details?: WorktreeErrorDetails } };

export interface AddWorktreeRequest {
  /** Unique identifier — becomes the worktree directory basename. */
  runId: string;
  /** Branch to check out in the new worktree. Created if it doesn't exist. */
  baseBranch: string;
  /** Filesystem path to the source repo (the primary working tree). */
  repoPath: string;
}

export interface AddWorktreeResponse {
  /** Absolute filesystem path of the new working tree. Use as `cwd` for the run's subprocesses. */
  cwd: string;
}

export interface RemoveWorktreeRequest {
  runId: string;
  /** Source-repo path that hosts the worktree's admin folder. */
  repoPath: string;
}

export interface PruneStaleWorktreesRequest {
  /** Source-repo path whose admin folder we sweep. */
  repoPath: string;
  /** runIds known to be in-flight. Anything under `worktreesRoot` not in this set is fair game. */
  activeRunIds: ReadonlySet<string>;
}

export interface PruneStaleWorktreesResponse {
  /** runIds whose stale worktrees were removed. */
  pruned: string[];
}

/**
 * Filesystem facade. Tests inject an in-memory implementation; production
 * passes a thin `node:fs/promises` wrapper. Kept narrow so test doubles
 * don't need to mock the whole module.
 */
export interface WorktreeFs {
  mkdir(path: string, opts: { recursive: boolean }): Promise<void>;
  /** List immediate children (file or dir basenames). Returns [] if path is absent. */
  readdir(path: string): Promise<string[]>;
  /** True iff the path exists. */
  exists(path: string): Promise<boolean>;
}

export interface WorktreeManagerOptions {
  spawner: Spawner;
  fs: WorktreeFs;
  /** Base directory under which per-run worktree directories are created. */
  worktreesRoot: string;
  /** Git binary. Defaults to `git`. */
  gitBin?: string;
  /** Per-operation timeout in ms. Default 30s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_GIT_BIN = 'git';

export class WorktreeManager {
  private readonly spawner: Spawner;
  private readonly fs: WorktreeFs;
  private readonly worktreesRoot: string;
  private readonly gitBin: string;
  private readonly timeoutMs: number;

  constructor(options: WorktreeManagerOptions) {
    this.spawner = options.spawner;
    this.fs = options.fs;
    this.worktreesRoot = options.worktreesRoot;
    this.gitBin = options.gitBin ?? DEFAULT_GIT_BIN;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Create a fresh worktree for this run. Calls `git worktree add --detach`
   * first so we don't fight branch-checked-out-elsewhere conflicts — the
   * skill (which runs inside the worktree) is responsible for creating its
   * own branch off the requested base via `git checkout -b` once it gets
   * going. Detached HEAD is the cleanest way to spawn an isolated checkout
   * without claiming a branch name upfront.
   *
   * The `--detach` choice is deliberate over `git worktree add <path> <branch>`:
   * the latter refuses if `<branch>` is already checked out in any worktree
   * (including the primary), and the project's primary tree is almost
   * always on the base branch. Detached HEAD sidesteps that conflict.
   */
  async addWorktree(req: AddWorktreeRequest): Promise<WorktreeResult<AddWorktreeResponse>> {
    const cwd = this.pathFor(req.runId);

    try {
      await this.fs.mkdir(this.worktreesRoot, { recursive: true });
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'IO_FAILURE',
          message: `failed to create worktrees root: ${errMessage(err)}`,
        },
      };
    }

    const res = await runGit(
      this.spawner,
      this.gitBin,
      req.repoPath,
      ['worktree', 'add', '--detach', cwd, req.baseBranch],
      this.timeoutMs,
    );
    if (res.exitCode !== 0) {
      return this.failedGit('ADD_FAILED', 'worktree add', res);
    }
    return { ok: true, data: { cwd } };
  }

  /**
   * Remove a worktree. Uses `--force` because the run may have made local
   * changes (or be mid-commit-failure cleanup) — plain `git worktree remove`
   * refuses on dirty trees. The aggressive removal is acceptable because
   * the only thing in the worktree is the run's own work, and by the time
   * this is called the pipeline has decided the run is terminal.
   *
   * Non-existent worktrees return success — idempotent so the cleanup path
   * can run unconditionally without checking "did the run even create a
   * worktree?" guards.
   */
  async removeWorktree(req: RemoveWorktreeRequest): Promise<WorktreeResult<void>> {
    const cwd = this.pathFor(req.runId);

    if (!(await this.fs.exists(cwd))) {
      return { ok: true, data: undefined };
    }

    const res = await runGit(
      this.spawner,
      this.gitBin,
      req.repoPath,
      ['worktree', 'remove', '--force', cwd],
      this.timeoutMs,
    );
    if (res.exitCode !== 0) {
      return this.failedGit('REMOVE_FAILED', 'worktree remove', res);
    }
    return { ok: true, data: undefined };
  }

  /**
   * Sweep stale worktree directories left behind by crashed runs.
   *
   * Called from startup (`initStores`) for each project, with
   * `activeRunIds = new Set()` since the in-memory runner map is fresh.
   * Iterates `worktreesRoot`; for any directory whose basename isn't in
   * `activeRunIds`, removes it via `git worktree remove --force` and
   * follows with `git worktree prune` to clean up the source repo's
   * admin records.
   *
   * Errors on individual removals are logged via `details.stderr` but
   * do NOT abort the sweep — we want to clean up as many orphans as
   * possible, even if one is wedged.
   */
  async pruneStaleWorktrees(
    req: PruneStaleWorktreesRequest,
  ): Promise<WorktreeResult<PruneStaleWorktreesResponse>> {
    if (!(await this.fs.exists(this.worktreesRoot))) {
      return { ok: true, data: { pruned: [] } };
    }

    let basenames: string[];
    try {
      basenames = await this.fs.readdir(this.worktreesRoot);
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'IO_FAILURE',
          message: `failed to read worktrees root: ${errMessage(err)}`,
        },
      };
    }

    const pruned: string[] = [];
    for (const basename of basenames) {
      if (req.activeRunIds.has(basename)) continue;
      const cwd = this.pathFor(basename);
      const res = await runGit(
        this.spawner,
        this.gitBin,
        req.repoPath,
        ['worktree', 'remove', '--force', cwd],
        this.timeoutMs,
      );
      if (res.exitCode === 0) {
        pruned.push(basename);
      }
      // Non-zero exit is non-fatal — the directory may have already been
      // partially cleaned, or the worktree admin folder might be missing
      // from this particular repo (the worktree might belong to a sibling
      // project sharing the same worktreesRoot). The follow-up prune
      // below cleans whatever this repo's admin tracks.
    }

    // Sweep the source repo's admin records.
    const pruneRes = await runGit(
      this.spawner,
      this.gitBin,
      req.repoPath,
      ['worktree', 'prune'],
      this.timeoutMs,
    );
    if (pruneRes.exitCode !== 0) {
      return this.failedGit('PRUNE_FAILED', 'worktree prune', pruneRes);
    }

    return { ok: true, data: { pruned } };
  }

  /** Compute the absolute path for a given run's worktree. */
  pathFor(runId: string): string {
    return path.join(this.worktreesRoot, runId);
  }

  private failedGit<T>(
    code: WorktreeErrorCode,
    subcommand: string,
    res: RunGitResult,
  ): WorktreeResult<T> {
    if (res.timedOut) {
      return {
        ok: false,
        error: {
          code: 'TIMEOUT',
          message: `git ${subcommand} timed out after ${this.timeoutMs}ms`,
          details: { subcommand, stderr: res.stderr },
        },
      };
    }
    return {
      ok: false,
      error: {
        code,
        message: `git ${subcommand} exited ${res.exitCode}: ${truncate(res.stderr.trim(), 200)}`,
        details: { subcommand, stderr: res.stderr },
      },
    };
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
