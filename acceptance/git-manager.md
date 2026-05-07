# Git Manager — Acceptance Criteria

## Description (client-readable)
Replace `StubGitManager` with a real `NodeGitManager` that wraps the `git` CLI via the existing `Spawner` abstraction. Provides four operations the workflow runner already calls: `prepareRepo`, `createBranch`, `commit`, `push`. Detects conflicts, dirty trees, missing repos, auth failures, and "nothing to commit" — surfaces each as a typed error with an actionable message.

## Adaptation Note
Backend-only feature, no UI. Tests live in Vitest with the existing `FakeSpawner` from `src/main/modules/spawner.ts`. No Electron-driven Playwright.

## Interface Contract

### Tech Stack (locked)
- Node 22's `child_process.spawn` via `Spawner`
- No new runtime deps
- All `git` invocations use the array-form arg list (no shell concatenation), so command injection is impossible at the spawn layer

### File Structure (exact)

```
src/
├── main/
│   ├── index.ts                                # MODIFY — swap StubGitManager → NodeGitManager
│   └── modules/
│       └── git-manager.ts                      # MODIFY — add NodeGitManager class + new error codes; keep StubGitManager

tests/unit/
└── git-manager.test.ts                         # NEW
```

### Interface additions

`src/main/modules/git-manager.ts`:

```ts
export type GitErrorCode =
  | 'NOT_A_REPO'
  | 'DIRTY_TREE'         // NEW
  | 'BRANCH_EXISTS'      // NEW
  | 'CONFLICT'           // NEW
  | 'NO_CHANGES'         // NEW
  | 'AUTH_FAILED'        // NEW
  | 'PULL_FAILED'
  | 'BRANCH_FAILED'
  | 'COMMIT_FAILED'
  | 'PUSH_FAILED'
  | 'TIMEOUT'            // NEW
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
  | { ok: false; error: { code: GitErrorCode; message: string; details?: GitErrorDetails } };
```

The existing `prepareRepo` / `createBranch` / `commit` / `push` request types stay unchanged. Result types now carry the optional `details` payload.

### `NodeGitManager` class (exact)

```ts
export interface NodeGitManagerOptions {
  spawner: Spawner;
  /** Defaults below: 10s for local ops, 60s for pull/push. */
  timeouts?: {
    localMs?: number;     // status, rev-parse, checkout, branch, add, commit
    pullMs?: number;
    pushMs?: number;
  };
  /** PATH lookup name. Defaults to 'git'. Override for tests / portable installs. */
  gitBin?: string;
}

export class NodeGitManager implements GitManager {
  constructor(options: NodeGitManagerOptions);
  prepareRepo(req: PrepareRepoRequest): Promise<GitResult<{ baseSha: string }>>;
  createBranch(req: CreateBranchRequest): Promise<GitResult<{ branchName: string }>>;
  commit(req: CommitRequest): Promise<GitResult<{ sha: string }>>;
  push(req: PushRequest): Promise<GitResult<{ remoteUrl?: string }>>;
}
```

### Behavior — `prepareRepo({ projectId, cwd, baseBranch })`

1. **Verify repo:** `git -C cwd rev-parse --is-inside-work-tree`. Non-zero exit → `NOT_A_REPO` with `cwd` in the message.
2. **Check clean tree:** `git -C cwd status --porcelain`. Non-empty stdout → `DIRTY_TREE` with `details.files = [<paths>]` (parsed from porcelain output).
3. **Checkout base:** `git -C cwd checkout <baseBranch>`. Non-zero → `PULL_FAILED` with stderr in details (the only "checkout failed" path here is "branch doesn't exist locally"; the workflow runner is responsible for choosing a real base branch — wrong base is the user's misconfig).
4. **Pull --rebase:** `git -C cwd pull --rebase`. On non-zero exit:
   - stderr contains `CONFLICT (content)` or `CONFLICT (modify/delete)` → `CONFLICT` with `details.files` parsed from the conflict lines.
   - stderr contains `Authentication failed` / `Permission denied (publickey)` / `could not read Username` → `AUTH_FAILED`.
   - Otherwise → `PULL_FAILED` with stderr in details.
5. **Capture base sha:** `git -C cwd rev-parse HEAD`. Return `{ baseSha: <stdout trimmed> }`.

### Behavior — `createBranch({ cwd, branchName })`

1. **Check branch doesn't exist locally:** `git -C cwd show-ref --verify --quiet refs/heads/<branchName>`. Exit 0 means it exists → `BRANCH_EXISTS` with the branch name in the message ("a branch named '<x>' already exists; rename or delete it").
2. **Create + check out:** `git -C cwd checkout -b <branchName>`. Non-zero → `BRANCH_FAILED` with stderr.

### Behavior — `commit({ cwd, message })`

1. **Stage:** `git -C cwd add -A`. Non-zero → `COMMIT_FAILED` with stderr.
2. **Commit:** `git -C cwd commit -m <message>`. Args MUST NOT include `--no-verify` (hooks run) or `--no-gpg-sign` (signing config respected — if user has `commit.gpgsign=true` it stays signed).
3. **Detect "nothing to commit":** if exit is non-zero AND stdout/stderr contains "nothing to commit" or "no changes added to commit" → `NO_CHANGES`.
4. **Other non-zero** → `COMMIT_FAILED` with stderr in details.
5. **Capture commit sha:** `git -C cwd rev-parse HEAD`. Return `{ sha: <trimmed> }`.

### Behavior — `push({ cwd, branchName })`

1. **Push:** `git -C cwd push -u origin <branchName>`. Args MUST NOT include `--force`, `--force-with-lease`, or any flag that overrides safe-push behaviour.
2. **Detect auth:** stderr indicators (same patterns as pull) → `AUTH_FAILED`.
3. **Other non-zero** → `PUSH_FAILED` with stderr.
4. **Capture remote URL (best-effort):** `git -C cwd remote get-url origin` (or parse stderr's "Branch 'X' set up to track 'Y'."). Optional; if it fails return `{}` (not an error).

### Helper — `runGit(cwd, args, opts) → Promise<{ exitCode, stdout, stderr }>`

- Spawns `git` with the args array (NEVER through a shell — use `shell: false` on the Spawner to neutralize injection). The current `NodeSpawner` defaults to `shell: true` for `claude.cmd` resolution; `runGit` MUST pass `shell: false` explicitly.
- Sets `cwd` on the spawn.
- Adds `timeoutMs` (default 10s; pull/push override to 60s). On timeout, sends SIGTERM, waits 500 ms, then SIGKILL; returns `{ exitCode: -1, stdout, stderr, timedOut: true }`.
- Captures stdout/stderr into strings (truncate at 16 KB to bound memory; the `details.stderr` surfaced to callers is capped further at 4 KB).
- Returns `{ exitCode, stdout, stderr, timedOut }`.

### Stderr parsers (exact)

```ts
// CONFLICT-line parser: returns the affected file paths.
function parseConflictFiles(stderr: string): string[] {
  const out: string[] = [];
  const re = /^CONFLICT \([^)]+\): .+ in (.+)$/gm;
  for (const m of stderr.matchAll(re)) {
    if (m[1]) out.push(m[1]);
  }
  return [...new Set(out)];
}

// Auth-failure detector.
function isAuthFailure(stderr: string): boolean {
  return (
    /Authentication failed/i.test(stderr) ||
    /Permission denied \(publickey\)/i.test(stderr) ||
    /could not read Username/i.test(stderr) ||
    /HTTP Basic: Access denied/i.test(stderr) ||
    /fatal: could not read Password/i.test(stderr)
  );
}

// Dirty-tree porcelain parser: each line is `XY <path>`.
function parsePorcelainFiles(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    // Drop the 2-char status, keep the rest.
    out.push(trimmed.slice(3).trim());
  }
  return out;
}
```

### Main wiring

`src/main/index.ts`:
- Import `NodeGitManager` from `./modules/git-manager.js` (alongside `StubGitManager`).
- Replace `new StubGitManager()` with `new NodeGitManager({ spawner: new NodeSpawner() })` in the WorkflowRunner construction. One-line change.
- The fallback to `StubGitManager` remains available if tests / debug builds need it.

## Business Rules

1. **All git ops run in the configured `localPath`** — every `runGit` call passes `cwd` explicitly.
2. **No `--no-verify`** anywhere in the args (hooks run).
3. **No `--no-gpg-sign`** anywhere in the args (signing config respected).
4. **No `--force` / `--force-with-lease`** on push.
5. **Spawn with `shell: false`** — args go directly to `git`; no shell interpolation.
6. **Per-op timeouts**: 10s for local ops, 60s for pull/push. On timeout: SIGTERM → 500 ms → SIGKILL.
7. **Stderr is captured and capped** at 4 KB in the surfaced `details.stderr`.
8. **Conflict files** for CONFLICT errors come from parsing `CONFLICT (...) ... in <file>` lines.
9. **Dirty tree files** for DIRTY_TREE errors come from parsing `git status --porcelain` output.
10. **No interactive prompts** — git is always spawned in a non-TTY context, so credential prompts fail fast (and we surface them as `AUTH_FAILED`).

## API Acceptance Tests

### `runGit` helper (GIT-HELPER-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| GIT-HELPER-001 | `runGit` invokes Spawner with `command='git'` and the supplied args, never through a shell | `shell: false` always |
| GIT-HELPER-002 | `runGit` passes the supplied `cwd` to spawn | true |
| GIT-HELPER-003 | `runGit` resolves with `{ exitCode, stdout, stderr }` after the child exits | true |
| GIT-HELPER-004 | `runGit` SIGTERMs then SIGKILLs after timeout | `lastSignal` records both in order |
| GIT-HELPER-005 | `runGit` truncates internal stdout/stderr buffers at 16 KB | true |

### `prepareRepo` (GIT-PREPARE-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| GIT-PREPARE-001 | Happy path: rev-parse → status (clean) → checkout → pull --rebase → rev-parse HEAD | `ok: true, data: { baseSha }` |
| GIT-PREPARE-002 | rev-parse exit 128 → `NOT_A_REPO` | true |
| GIT-PREPARE-003 | status --porcelain returns non-empty → `DIRTY_TREE` with `details.files` | true |
| GIT-PREPARE-004 | checkout fails → `PULL_FAILED` with stderr in details | true |
| GIT-PREPARE-005 | pull --rebase fails with CONFLICT in stderr → `CONFLICT` with parsed files | true |
| GIT-PREPARE-006 | pull --rebase fails with auth pattern → `AUTH_FAILED` | true |
| GIT-PREPARE-007 | pull --rebase fails with other reason → `PULL_FAILED` | true |
| GIT-PREPARE-008 | Pull/push timeout → `TIMEOUT` | true |
| GIT-PREPARE-009 | All `git` invocations include `cwd` and use `shell: false` | true |

### `createBranch` (GIT-BRANCH-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| GIT-BRANCH-001 | Happy path: show-ref (exit 1) → checkout -b → ok | true |
| GIT-BRANCH-002 | show-ref exit 0 → `BRANCH_EXISTS` with the branch name | true |
| GIT-BRANCH-003 | checkout -b fails → `BRANCH_FAILED` with stderr | true |

### `commit` (GIT-COMMIT-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| GIT-COMMIT-001 | Happy path: add -A → commit -m → rev-parse → ok | true |
| GIT-COMMIT-002 | "nothing to commit" → `NO_CHANGES` | true |
| GIT-COMMIT-003 | Commit args do NOT include `--no-verify` | true |
| GIT-COMMIT-004 | Commit args do NOT include `--no-gpg-sign` | true |
| GIT-COMMIT-005 | add -A failure → `COMMIT_FAILED` with stderr | true |
| GIT-COMMIT-006 | commit failure (other) → `COMMIT_FAILED` | true |

### `push` (GIT-PUSH-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| GIT-PUSH-001 | Happy path: push -u origin <branch> → ok with optional remoteUrl | true |
| GIT-PUSH-002 | Push args do NOT include `--force` / `--force-with-lease` | true |
| GIT-PUSH-003 | Auth pattern in stderr → `AUTH_FAILED` | true |
| GIT-PUSH-004 | Other failure → `PUSH_FAILED` with stderr | true |
| GIT-PUSH-005 | Push timeout → `TIMEOUT` | true |

### Stderr parsers (GIT-PARSE-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| GIT-PARSE-001 | `parseConflictFiles` extracts file from `CONFLICT (content): Merge conflict in src/foo.ts` | `['src/foo.ts']` |
| GIT-PARSE-002 | `parseConflictFiles` deduplicates repeated paths | unique list |
| GIT-PARSE-003 | `parsePorcelainFiles` extracts paths from ` M file.ts`, `?? new.ts`, `A  added.ts` | `['file.ts', 'new.ts', 'added.ts']` |
| GIT-PARSE-004 | `isAuthFailure` matches each known pattern | true |

### Main wiring (GIT-WIRE-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| GIT-WIRE-001 | `main/index.ts` instantiates `NodeGitManager`, not `StubGitManager` | true (regression) |

## Manual verification (after PR)
- [ ] Configure a real GitHub project with valid `repo.localPath`
- [ ] Trigger a workflow run
- [ ] Observe: branch `feat/<TICKET>-<slug>` created, commit message `feat(<TICKET>): <summary>`, push succeeds
- [ ] Try with a dirty working tree → workflow fails fast with DIRTY_TREE; tree is untouched
- [ ] Force a conflict on the base branch → CONFLICT error surfaces with the file list
- [ ] Try a project pointing at a non-git directory → NOT_A_REPO

## Test Status
- [ ] GIT-HELPER-001..005
- [ ] GIT-PREPARE-001..009
- [ ] GIT-BRANCH-001..003
- [ ] GIT-COMMIT-001..006
- [ ] GIT-PUSH-001..005
- [ ] GIT-PARSE-001..004
- [ ] GIT-WIRE-001
- [ ] All prior tests still pass
- [ ] `npm run lint`: 0
- [ ] `npm run typecheck`: 0
- [ ] `npm run build`: clean
