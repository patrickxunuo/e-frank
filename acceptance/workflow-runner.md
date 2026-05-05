# Workflow Runner State Machine — Acceptance Criteria

## Description (client-readable)
The orchestrator that drives the ticket → PR pipeline. Spawns Claude via #2's `ClaudeProcessManager`, locks tickets via #4's `RunHistory`, and emits structured events for every state transition. UI consumers (#6 Active Execution panel, #8 streaming logs, #9 approvals) subscribe via IPC. Subsystems for Git ops / PR creation / Jira update are injected as interfaces with **stub implementations** in this PR — real implementations land in #10/#11/#13. The Active Execution panel from #6 comes alive in this PR.

## Adaptation Note
This is a **backend-heavy** feature with two small renderer-side wirings (replace `useActiveRun` stub; replace ProjectDetail's no-op Run handlers). No new UI primitives or screens. UI for streaming logs (#8) and approvals (#9) lands separately.

## Interface Contract

### Tech Stack (locked, inherited from #1-#6)
- TypeScript strict
- Vitest 2 unit tests, no real Claude / git / Jira / PRs in tests
- No new runtime deps

### File Structure (exact)
```
src/
├── main/
│   ├── index.ts                              # MODIFY — instantiate runner, wire handlers
│   └── modules/
│       ├── workflow-runner.ts                # NEW — state machine
│       ├── run-store.ts                      # NEW — per-run JSON sidecar persistence
│       ├── git-manager.ts                    # NEW — interface + StubGitManager
│       ├── pr-creator.ts                     # NEW — interface + StubPrCreator
│       └── jira-updater.ts                   # NEW — interface + StubJiraUpdater
├── preload/
│   └── index.ts                              # MODIFY — extend window.api.runs.*
├── renderer/
│   ├── state/
│   │   └── active-run.ts                     # MODIFY — replace null stub with real subscription
│   ├── views/
│   │   ├── ProjectDetail.tsx                 # MODIFY — wire Run/RunSelected to runs.start
│   │   └── ProjectDetail.module.css          # MODIFY (if needed, minor)
│   └── App.tsx                               # MODIFY — trim no-op banner handlers
└── shared/
    ├── ipc.ts                                # MODIFY — runs:* channels + types
    └── schema/
        └── run.ts                            # NEW

tests/unit/
├── run-schema.test.ts                        # NEW
├── git-manager.test.ts                       # NEW
├── pr-creator.test.ts                        # NEW
├── jira-updater.test.ts                      # NEW
├── run-store.test.ts                         # NEW
├── workflow-runner.test.ts                   # NEW (the big one)
├── ipc-contract-runs.test.ts                 # NEW
├── state-active-run.test.tsx                 # NEW (replaces inline coverage in #6)
└── views-project-detail.test.tsx             # MODIFY — Run handlers now hit IPC
```

### Run Schema (exact)

File: `src/shared/schema/run.ts`

```ts
export type RunMode = 'interactive' | 'yolo';

export type RunState =
  | 'idle'
  | 'locking'
  | 'preparing'         // git pull base
  | 'branching'         // checkout new branch
  | 'running'           // Claude executing
  | 'awaitingApproval'  // interactive only — paused on checkpoint marker
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
  /** User-visible step name (matches design vocabulary), or null for non-user-visible states. */
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
  /** 'approve': continue with original; 'reject': fail the run; 'modify': continue with edited plan text. */
  decision: 'approve' | 'reject' | 'modify';
  /** Required when decision === 'modify'; ignored otherwise. */
  text?: string;
}
```

### Subsystem Interfaces (exact)

**`GitManager`** (file: `src/main/modules/git-manager.ts`)
```ts
export interface PrepareRepoRequest { projectId: string; cwd: string; baseBranch: string }
export interface CreateBranchRequest { cwd: string; branchName: string }
export interface CommitRequest { cwd: string; message: string }
export interface PushRequest { cwd: string; branchName: string }

export type GitErrorCode = 'NOT_A_REPO' | 'PULL_FAILED' | 'BRANCH_FAILED' | 'COMMIT_FAILED' | 'PUSH_FAILED' | 'IO_FAILURE';
export type GitResult<T> = { ok: true; data: T } | { ok: false; error: { code: GitErrorCode; message: string } };

export interface GitManager {
  prepareRepo(req: PrepareRepoRequest): Promise<GitResult<{ baseSha: string }>>;
  createBranch(req: CreateBranchRequest): Promise<GitResult<{ branchName: string }>>;
  commit(req: CommitRequest): Promise<GitResult<{ sha: string }>>;
  push(req: PushRequest): Promise<GitResult<{ remoteUrl?: string }>>;
}

/**
 * Stub for #7 — resolves successfully without doing anything. Real impl
 * lands in #10. The stub enables the workflow runner state machine to be
 * tested end-to-end without spawning real `git` commands.
 */
export class StubGitManager implements GitManager { /* always returns ok */ }
```

**`PrCreator`** (file: `src/main/modules/pr-creator.ts`)
```ts
export interface CreatePrRequest {
  cwd: string;
  branchName: string;
  baseBranch: string;
  title: string;
  body: string;
}

export type PrErrorCode = 'AUTH' | 'NETWORK' | 'INVALID_REQUEST' | 'IO_FAILURE';
export type PrResult<T> = { ok: true; data: T } | { ok: false; error: { code: PrErrorCode; message: string } };

export interface PrCreator {
  create(req: CreatePrRequest): Promise<PrResult<{ url: string; number: number }>>;
}

/** Stub — returns a deterministic fake URL for #7 tests. Real impl in #11. */
export class StubPrCreator implements PrCreator { /* always returns ok */ }
```

**`JiraUpdater`** (file: `src/main/modules/jira-updater.ts`)
```ts
export interface UpdateTicketRequest {
  ticketKey: string;
  prUrl: string;
  /** Optional Jira transition (e.g. "In Review"). Stub ignores. */
  transitionTo?: string;
}

export type JiraUpdateErrorCode = 'AUTH' | 'NETWORK' | 'NOT_FOUND' | 'IO_FAILURE';
export type JiraUpdateResult<T> = { ok: true; data: T } | { ok: false; error: { code: JiraUpdateErrorCode; message: string } };

export interface JiraUpdater {
  update(req: UpdateTicketRequest): Promise<JiraUpdateResult<{ ticketKey: string }>>;
}

export class StubJiraUpdater implements JiraUpdater { /* always returns ok */ }
```

### RunStore (exact)

File: `src/main/modules/run-store.ts`

```ts
export interface RunStoreOptions {
  /** Absolute path to the directory holding run sidecars. */
  runsDir: string;
  fs?: ProjectStoreFs;
}

export type RunStoreErrorCode = 'IO_FAILURE' | 'CORRUPT' | 'NOT_FOUND' | 'UNSUPPORTED_SCHEMA_VERSION';
export type RunStoreResult<T> = { ok: true; data: T } | { ok: false; error: { code: RunStoreErrorCode; message: string } };

export class RunStore {
  constructor(options: RunStoreOptions);
  init(): Promise<RunStoreResult<{ count: number }>>;
  /** Persist a run snapshot atomically. */
  save(run: Run): Promise<RunStoreResult<{ runId: string }>>;
  /** Read a run by id. */
  get(runId: string): Promise<RunStoreResult<Run>>;
  /** List runs for a project, newest-first, capped at `limit`. */
  list(projectId: string, limit?: number): Promise<RunStoreResult<Run[]>>;
}
```

File envelope (per-run JSON):
```json
{ "schemaVersion": 1, "run": <Run> }
```

### WorkflowRunner (exact)

File: `src/main/modules/workflow-runner.ts`

```ts
export interface WorkflowRunnerOptions {
  projectStore: { get: (req: { id: string }) => Promise<...> };
  secretsManager: { get: (ref: string) => Promise<...> };
  runHistory: RunHistory;
  runStore: RunStore;
  claudeManager: ClaudeProcessManager;
  gitManager: GitManager;
  prCreator: PrCreator;
  jiraUpdater: JiraUpdater;
  /** Test injection. Default uses Date.now() / globalThis.setTimeout. */
  clock?: { now: () => number };
}

export interface StartRunRequest {
  projectId: string;
  ticketKey: string;
  /** Optional override; defaults to project's workflow.mode. */
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

export type RunnerResult<T> = { ok: true; data: T } | { ok: false; error: { code: RunnerErrorCode; message: string } };

export class WorkflowRunner extends EventEmitter {
  constructor(options: WorkflowRunnerOptions);

  start(req: StartRunRequest): Promise<RunnerResult<{ run: Run }>>;
  cancel(runId: string): Promise<RunnerResult<{ runId: string }>>;
  approve(req: { runId: string }): Promise<RunnerResult<{ runId: string }>>;
  reject(req: { runId: string }): Promise<RunnerResult<{ runId: string }>>;
  modify(req: { runId: string; text: string }): Promise<RunnerResult<{ runId: string }>>;
  /** Returns the live active run snapshot, or null. */
  current(): Run | null;

  on(event: 'state-changed', listener: (e: RunStateEvent) => void): this;
  on(event: 'current-changed', listener: (e: { run: Run | null }) => void): this;
}
```

### State Pipeline (exact)

```
start()
  → locking          (RunHistory.markRunning)
  → preparing        (gitManager.prepareRepo)
  → branching        (gitManager.createBranch — branchName from project.workflow.branchFormat with {ticketKey} + {slug})
  → running          (claudeManager.run — listens for output and approval markers)
      ⤺ awaitingApproval  (interactive only — pauses until approve/reject/modify)
  → committing       (gitManager.commit — message format: 'feat(${ticketKey}): ${ticketSummary}')
  → pushing          (gitManager.push)
  → creatingPr       (prCreator.create — title = same as commit, body = run summary)
  → updatingTicket   (jiraUpdater.update — adds 'PR created: <url>' comment, transitions to 'In Review')
  → unlocking        (RunHistory.markProcessed + clearRunning)
  → done
```

Failure / cancel paths:
- Any state failing transitions to `failed` with `error` set; `unlocking` runs as cleanup; final state `failed`
- Cancel sets `pendingReason='cancelled'` synchronously; current state's awaitable is cancelled (Claude killed if mid-run); cleanup goes through `unlocking` and ends in `cancelled`

Mode handling:
- `interactive`: on Claude marker → state becomes `awaitingApproval`; pendingApproval is populated; runner waits for `approve/reject/modify`
- `yolo`: on Claude marker → runner immediately writes "approve\n" to Claude stdin; no UI prompt

User-visible step labels (mapped from internal states):
- `running`: "Implementing feature" (initial), then dynamic based on Claude markers (e.g. Claude can declare current step in stdout)
- `committing`: "Committing changes"
- `pushing`: "Pushing branch"
- `creatingPr`: "Creating pull request"
- `updatingTicket`: "Updating ticket"
- non-user-visible (locking, preparing, branching, unlocking): `userVisibleLabel: null`

### Approval Marker Format (locked)

When a Claude Code skill needs approval, it emits a single line:
```
<<<EF_APPROVAL_REQUEST>>>{"plan":"...","filesToModify":[...],"diff":"...","options":["approve","reject"]}<<<END_EF_APPROVAL_REQUEST>>>
```

The runner parses the JSON between the markers and populates `pendingApproval`. On `approve` decision, runner writes `approve\n` to Claude stdin. On `modify` with text, runner writes `${text}\n`. On `reject`, runner cancels the run.

This convention is documented in `memory-bank/systemPatterns.md` so #9 (UI) and Claude skill authors agree on the format.

### IPC Contract Extension (exact)

File: `src/shared/ipc.ts` — extend `IPC_CHANNELS`:
```ts
RUNS_START: 'runs:start',
RUNS_CANCEL: 'runs:cancel',
RUNS_APPROVE: 'runs:approve',
RUNS_REJECT: 'runs:reject',
RUNS_MODIFY: 'runs:modify',
RUNS_CURRENT: 'runs:current',
RUNS_LIST_HISTORY: 'runs:list-history',
RUNS_CURRENT_CHANGED: 'runs:current-changed',  // event
RUNS_STATE_CHANGED: 'runs:state-changed',      // event
```

Add types and extend `IpcApi.runs` with the corresponding methods. Mirror #4's drift-guard pattern (re-export `Run` / `RunStateEvent` from shared).

### Renderer wiring

**`src/renderer/state/active-run.ts`** — replace the always-null stub:
```ts
function useActiveRun(projectId: string): Run | null {
  const [run, setRun] = useState<Run | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!window.api) return undefined;
    void (async () => {
      const result = await window.api.runs.current();
      if (cancelled) return;
      if (result.ok && result.data && result.data.projectId === projectId) {
        setRun(result.data);
      } else {
        setRun(null);
      }
    })();
    const off = window.api.runs.onCurrentChanged(({ run: nextRun }) => {
      if (cancelled) return;
      if (nextRun && nextRun.projectId === projectId) {
        setRun(nextRun);
      } else {
        setRun(null);
      }
    });
    return () => { cancelled = true; off?.(); };
  }, [projectId]);
  return run;
}
```

**`src/renderer/views/ProjectDetail.tsx`** — Run / Run Selected handlers:
```ts
const handleRun = (key: string) => window.api?.runs.start({ projectId, ticketKey: key });
// Run Selected: sequential — wait for current to finish before starting next.
// MVP: start the first; UI shows the active run; user clicks Run on the next when current finishes.
// (Sequential queue can be its own enhancement — for #7, multi-select Run starts one ticket and reports the rest as "queued" in a banner.)
```

**`src/renderer/App.tsx`** — remove the placeholder banner for `onRun/onRunSelected/onOpenExecution` (those are now real), but keep banner infra for genuine errors.

The Active Execution panel from #6 now appears whenever a run is active.

## Business Rules
1. **Single active run** — second `start()` returns `ALREADY_RUNNING`.
2. **TicketKey validated** — same regex as #2 (`/^[A-Z][A-Z0-9_]*-\d+$/`).
3. **Cancel always reaches `unlocking`** — releases ticket lock + clears active state.
4. **Failure cleanup** — `unlocking` runs even after failure; final state is `failed`.
5. **Approval markers in interactive mode** — runner pauses and emits `awaitingApproval`.
6. **YOLO auto-approves** every checkpoint immediately.
7. **Per-run logs persisted** — JSON snapshot at `userData/runs/{runId}.json` after each state transition (atomic). Streaming raw stdout/stderr at `userData/runs/{runId}.log` (append-only).
8. **Stub subsystems success path** — git/PR/Jira-update all return ok in this PR. Tests pin the contract; #10/#11/#13 swap real impls.
9. **`current-changed` event emitted on every state transition AND on completion** — UI tracks the live run.
10. **`state-changed` event** — finer-grained: emitted for each individual state entry/exit. UI may use this for the timeline; for #7 we just emit it to verify ordering in tests.
11. **Branch naming** — derived from project's `workflow.branchFormat`, replacing `{ticketKey}` and `{slug}` (slug = lowercased ticket summary first ~6 words, kebab-cased).
12. **PR title** — `feat(${ticketKey}): ${ticketSummary}` per PRD §6.6.

## API Acceptance Tests (test IDs)

### Schema (RUN-SCHEMA-XXX)
| ID | Scenario | Expected |
|----|----------|----------|
| RUN-SCHEMA-001 | All RunState values exported | union covers 14 states |
| RUN-SCHEMA-002 | RunStep / Run / RunStateEvent / ApprovalRequest / ApprovalResponse types compile | renderer-safe (no Node imports) |

### Subsystem stubs (GIT-XXX / PR-XXX / JIRA-UPD-XXX)
| ID | Scenario | Expected |
|----|----------|----------|
| GIT-STUB-001 | StubGitManager.prepareRepo returns ok | { ok: true, data: { baseSha: '<stub>' } } |
| GIT-STUB-002 | StubGitManager.createBranch returns ok with given branchName | true |
| GIT-STUB-003 | StubGitManager.commit returns ok with stub sha | true |
| GIT-STUB-004 | StubGitManager.push returns ok | true |
| PR-STUB-001 | StubPrCreator.create returns ok with deterministic url | url contains branchName |
| JIRA-UPD-STUB-001 | StubJiraUpdater.update returns ok | true |

### RunStore (RUNSTORE-XXX)
| ID | Scenario | Expected |
|----|----------|----------|
| RUNSTORE-001 | init() with empty runsDir | ok, count: 0 |
| RUNSTORE-002 | save() then get() round-trip | data matches |
| RUNSTORE-003 | save() atomically (temp + rename) | fs sees the pattern |
| RUNSTORE-004 | list() returns newest-first | sorted by startedAt desc |
| RUNSTORE-005 | list() respects projectId filter | only matching project's runs |
| RUNSTORE-006 | list() respects limit | <= limit |
| RUNSTORE-007 | get() unknown id | NOT_FOUND |
| RUNSTORE-008 | get() corrupt JSON | CORRUPT |
| RUNSTORE-009 | get() unknown schemaVersion | UNSUPPORTED_SCHEMA_VERSION |
| RUNSTORE-010 | Concurrent saves (mutex) | both persist; no clobber |

### WorkflowRunner (WFR-XXX)
| ID | Scenario | Expected |
|----|----------|----------|
| WFR-001 | start() happy path interactive (no checkpoints) end-to-end | states traverse: locking → preparing → branching → running → committing → pushing → creatingPr → updatingTicket → unlocking → done. RunHistory.markRunning + markProcessed + clearRunning called. RunStore.save called. final state='done', status='done'. |
| WFR-002 | start() happy path yolo | same as WFR-001 with mode='yolo' |
| WFR-003 | start() while another run active | second returns ALREADY_RUNNING |
| WFR-004 | start() unknown projectId | PROJECT_NOT_FOUND |
| WFR-005 | start() invalid ticketKey ('abc-1') | INVALID_TICKET_KEY |
| WFR-006 | Cancel during locking | run ends in 'cancelled', RunHistory.clearRunning called |
| WFR-007 | Cancel during preparing | git.prepareRepo aborted (or completes; run ends 'cancelled') — verifies cleanup runs |
| WFR-008 | Cancel during running | claudeManager.cancel called; run ends 'cancelled' |
| WFR-009 | Cancel during awaitingApproval | claude killed; run ends 'cancelled' |
| WFR-010 | git.prepareRepo fails (PULL_FAILED) | run state='failed', error contains code; unlocking still runs |
| WFR-011 | claude.run fails | run state='failed' |
| WFR-012 | git.commit fails | run state='failed'; unlocking runs |
| WFR-013 | pr.create fails (AUTH) | run state='failed'; unlocking runs |
| WFR-014 | jira.update fails | run state='done' (don't fail the run for ticket-update issues — log + continue) OR state='failed' depending on policy. **Spec choice: don't fail the run** — log + emit error event but continue to unlocking with status='done'. |
| WFR-015 | Approval marker in interactive mode → awaitingApproval | pendingApproval populated; state=awaitingApproval; current() reflects |
| WFR-016 | approve() resolves awaiting state → continues to committing | claude stdin received 'approve\n'; state advances |
| WFR-017 | reject() resolves awaiting state → run ends 'cancelled' | true |
| WFR-018 | modify(text) resolves awaiting state → claude stdin received text + '\n'; state advances | true |
| WFR-019 | YOLO + approval marker → auto-approve immediately | claude stdin received 'approve\n'; no awaitingApproval state ever entered |
| WFR-020 | Multiple approval markers in one run | each handled correctly |
| WFR-021 | Malformed approval marker (bad JSON) | runner does NOT pause; logs warning; treats as regular output |
| WFR-022 | current() during run | returns the active Run |
| WFR-023 | current() when idle | returns null |
| WFR-024 | state-changed events emitted in correct order | every transition fires exactly once |
| WFR-025 | current-changed event fires on every transition + once on completion (with null OR final run? choose: null on completion) | UI subscribers see live updates |
| WFR-026 | RunStore.save called per state transition | persistence is incremental (every transition writes the run JSON) |
| WFR-027 | After done/failed/cancelled, current() returns null | runner is idle; new start() succeeds |
| WFR-028 | branchName uses {ticketKey} + {slug} from project config | observed in createBranch call |
| WFR-029 | PR title = `feat(${ticketKey}): ${ticketSummary}` | observed in pr.create call |
| WFR-030 | approve() when not awaiting | NOT_AWAITING_APPROVAL |

### IPC Contract (IPC-RUNS-XXX)
| ID | Scenario | Expected |
|----|----------|----------|
| IPC-RUNS-001 | All 9 channels exported with correct strings | true |
| IPC-RUNS-002 | IpcApi.runs methods typed correctly | expectTypeOf for all 9 |
| IPC-RUNS-003 | Regression: PING / claude / projects / secrets / jira channels still present | drift guard |
| IPC-RUNS-004 | Run / RunStateEvent re-exported from ipc.ts match schema | drift guard |

### Renderer hook (ACTIVE-RUN-XXX)
| ID | Scenario | Expected |
|----|----------|----------|
| ACTIVE-RUN-001 | useActiveRun on mount calls runs.current; returns the run if matches projectId | true |
| ACTIVE-RUN-002 | useActiveRun returns null if active run is for different projectId | true |
| ACTIVE-RUN-003 | useActiveRun updates on onCurrentChanged events for matching projectId | true |
| ACTIVE-RUN-004 | useActiveRun ignores onCurrentChanged for non-matching projectId | true |
| ACTIVE-RUN-005 | useActiveRun unsubscribes on unmount | true |
| ACTIVE-RUN-006 | useActiveRun handles window.api === undefined | returns null without throwing |

### ProjectDetail wiring (DET-RUN-XXX)
| ID | Scenario | Expected |
|----|----------|----------|
| DET-RUN-001 | Click Run on a row → window.api.runs.start called with projectId + ticketKey | true |
| DET-RUN-002 | runs.start error → inline error banner shown | true |
| DET-RUN-003 | Run Selected starts the FIRST checked ticket; remaining keys mentioned in a banner ("4 more queued — start them after this run completes") | true |

### Test Status
- [x] RUN-SCHEMA-001..002: PASS (11 tests)
- [x] GIT-STUB-001..004 / PR-STUB-001 / JIRA-UPD-STUB-001: PASS
- [x] RUNSTORE-001..010: PASS (11 tests)
- [x] WFR-001..030: PASS (33 tests)
- [x] IPC-RUNS-001..004: PASS (33 tests)
- [x] ACTIVE-RUN-001..006: PASS (7 tests)
- [x] DET-RUN-001..003: PASS (3 tests)
- [x] Total project: **439/439 unit tests pass** (was 335/335 after #6; +104 new + 3 superseded skipped)
- [x] `npm run lint`: 0 / 0
- [x] `npm run typecheck`: 0
- [x] `npm run build`: clean — preload 5.58 kB; renderer 323.48 kB JS / 43.17 kB CSS

## Manual verification (after PR)
- [ ] `npm run dev` regression: project detail loads
- [ ] Click Run on a ticket → Active Execution panel appears with the live run progressing through steps via stub git/PR/Jira ops; finishes after a few seconds
- [ ] Click Cancel mid-run → panel transitions to "Cancelled"
- [ ] Refreshing the app while a run is in progress: panel disappears (run state isn't restored yet — that's a future enhancement)
