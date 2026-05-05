/**
 * GitManager — interface + stub implementation for issue #7.
 *
 * The real implementation (issue #10) will shell out to `git` for clone,
 * pull, branch, commit, push. For #7 we ship the interface and a
 * `StubGitManager` that always succeeds, so the workflow runner state
 * machine can be wired up and tested end-to-end without spawning real
 * `git` processes.
 *
 * Mirrors the spawner / secrets-backend pattern: production swap is a
 * one-line constructor change in `src/main/index.ts` when #10 lands.
 */

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
  | 'PULL_FAILED'
  | 'BRANCH_FAILED'
  | 'COMMIT_FAILED'
  | 'PUSH_FAILED'
  | 'IO_FAILURE';

export type GitResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: GitErrorCode; message: string } };

export interface GitManager {
  prepareRepo(req: PrepareRepoRequest): Promise<GitResult<{ baseSha: string }>>;
  createBranch(req: CreateBranchRequest): Promise<GitResult<{ branchName: string }>>;
  commit(req: CommitRequest): Promise<GitResult<{ sha: string }>>;
  push(req: PushRequest): Promise<GitResult<{ remoteUrl?: string }>>;
}

/**
 * Stub implementation — resolves successfully without doing anything. Real
 * implementation lands in #10. The stub enables the workflow runner state
 * machine to be tested end-to-end without spawning real `git` commands.
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
