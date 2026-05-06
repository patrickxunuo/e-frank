# Execution View — Acceptance Criteria

## Description (client-readable)
The full-screen route that shows the live AI Execution Log for a workflow run. Stepped timeline driven by #7's `state-changed` events; per-step terminal-style stdout/stderr from #2's claude `output` events. Header has progress counter + Auto-scroll toggle + Pause + Cancel. Bottom has a PromptInput → claude stdin (shared component for #9's Modify flow). Right pane is a placeholder labeled "Approval panel lands in #9" — replaced by the live approval panel in #9 without changes to this PR's layout.

## Adaptation Note
This is a **UI feature** with one new main-process module (RunLogStore for persistence). Tests live in jsdom + Testing Library; no Electron-driven Playwright. Real Electron-driven E2E for the entire workflow lives in a follow-up issue.

## Interface Contract

### Tech Stack (locked, inherited from #1-#7)
- React 18 + TypeScript strict
- CSS Modules + tokens from #5
- No new runtime deps

### File Structure (exact)
```
src/
├── main/
│   ├── index.ts                            # MODIFY — instantiate RunLogStore, wire claude.output → log, register runs:readLog handler
│   └── modules/
│       └── run-log-store.ts                # NEW — append-only NDJSON persistence + read-back
├── preload/
│   └── index.ts                            # MODIFY — extend window.api.runs.readLog
├── renderer/
│   ├── App.tsx                             # MODIFY — extend ViewState with `execution`, route to ExecutionView
│   ├── components/
│   │   ├── ExecutionLog.tsx                # NEW
│   │   ├── ExecutionLog.module.css
│   │   ├── PromptInput.tsx                 # NEW (shared with #9)
│   │   ├── PromptInput.module.css
│   │   └── ansi.ts                         # NEW — stripAnsi utility
│   ├── state/
│   │   └── run-log.ts                      # NEW — useRunLog(run) hook
│   └── views/
│       ├── ExecutionView.tsx               # NEW
│       ├── ExecutionView.module.css
│       └── ProjectDetail.tsx               # MODIFY — re-add Open Details button → routes to ExecutionView
└── shared/
    ├── ipc.ts                              # MODIFY — add RUNS_READ_LOG channel + types
    └── schema/
        └── run.ts                          # MODIFY — add RunLogEntry type

tests/unit/
├── run-log-store.test.ts                   # NEW
├── state-run-log.test.tsx                  # NEW
├── components-execution-log.test.tsx       # NEW
├── components-prompt-input.test.tsx        # NEW
├── views-execution-view.test.tsx           # NEW
├── views-project-detail.test.tsx           # MODIFY — Open Details button restored + tested
└── ipc-contract-runs.test.ts               # MODIFY — add IPC-RUNS-005 for readLog
```

### Schema additions (exact)

`src/shared/schema/run.ts` — add:
```ts
export interface RunLogEntry {
  runId: string;
  stream: 'stdout' | 'stderr';
  line: string;
  /** Epoch ms when the line was received in main. */
  timestamp: number;
  /** Workflow state at the time the line was received (best-effort tagging
   *  so the renderer can bucket lines without re-deriving from timestamps). */
  state: RunState;
}
```

### IPC contract extension

`src/shared/ipc.ts` — add:
```ts
RUNS_READ_LOG: 'runs:read-log',
```
With request/response types and IpcApi extension:
```ts
export interface RunsReadLogRequest { runId: string }
export interface RunsReadLogResponse { entries: RunLogEntry[] }
// IpcApi.runs:
readLog: (req: RunsReadLogRequest) => Promise<IpcResult<RunsReadLogResponse>>;
```

### RunLogStore (exact)

File: `src/main/modules/run-log-store.ts`

```ts
export interface RunLogStoreOptions {
  /** Absolute path to the directory holding per-run log files. */
  runsDir: string;
  fs?: RunLogStoreFs;
}

export interface RunLogStoreFs {
  appendFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  mkdir(path: string, opts: { recursive: true }): Promise<void>;
}

export type RunLogStoreErrorCode = 'IO_FAILURE' | 'NOT_FOUND' | 'CORRUPT';
export type RunLogStoreResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: RunLogStoreErrorCode; message: string } };

export class RunLogStore {
  constructor(options: RunLogStoreOptions);
  init(): Promise<RunLogStoreResult<void>>;
  /** Append a single entry as one NDJSON line. Atomic on POSIX, near-atomic on Windows for short writes. */
  appendLine(entry: RunLogEntry): Promise<RunLogStoreResult<void>>;
  /** Read all entries for a run. Returns [] if the file doesn't exist. Skips malformed lines (logged). */
  read(runId: string): Promise<RunLogStoreResult<RunLogEntry[]>>;
}
```

File path: `runsDir/{runId}.log` (POSIX-joined to match the existing RunStore pattern).

### Renderer hook — `useRunLog(run)`

File: `src/renderer/state/run-log.ts`

```ts
export interface ExecLogStep {
  state: RunState;
  /** User-visible label or `null` for non-user-visible internal states. */
  label: string | null;
  status: RunStatus;
  startedAt?: number;
  finishedAt?: number;
  lines: RunLogEntry[];
}

export interface UseRunLogResult {
  steps: ExecLogStep[];
  /** Total user-visible steps (used by the progress counter). */
  totalUserVisibleSteps: number;
  /** Index of the current step in `steps` (for "X of Y"). */
  currentUserVisibleIndex: number;
  paused: boolean;
  setPaused: (b: boolean) => void;
  /** Lines that arrived while paused, not yet flushed. Used by tests to verify pause behavior. */
  bufferedLineCount: number;
}

export function useRunLog(run: Run | null): UseRunLogResult;
```

Behavior:
- On mount with a run whose `status` is terminal (`done`/`failed`/`cancelled`) → call `window.api.runs.readLog({ runId })` to load persisted lines, distribute them across steps by their `state` field
- On mount with a live run → subscribe to `window.api.claude.onOutput` and `window.api.runs.onStateChanged`. Bucket each output line into the step matching the run's CURRENT state at the time the line arrives.
- `paused === true` → buffer incoming lines without updating `steps`. `paused === false` → flush buffer into the appropriate steps, then resume normal flow.
- On unmount → unsubscribe.
- Per-effect `cancelled` flag pattern (matches `useTickets` from #6).
- Handles `window.api === undefined` gracefully.

### Components

**`<ExecutionLog>`** — `src/renderer/components/ExecutionLog.tsx`
```ts
interface ExecutionLogProps {
  steps: ExecLogStep[];
  /** Auto-scroll behavior — controlled by parent. */
  autoScroll: boolean;
  /** Index of the user-visible step that should be expanded by default
   *  (typically the current one). Other completed steps start collapsed. */
  expandIndex: number;
  'data-testid'?: string;
}
```
- Each step row: status icon (`pending` / `running` / `done` / `failed` / `cancelled`), label, timestamp range
- Collapsible body with monospace lines (timestamp + stream tag + text). Strip ANSI via `stripAnsi`.
- When `autoScroll` is true and the user is at bottom, scroll-to-bottom on new content. When the user scrolls up, stop following until they scroll back to bottom.
- `data-testid="log-step-{index}"` on each row, `data-testid="log-step-{index}-toggle"` on the collapse button, `data-testid="log-step-{index}-body"` on the content.

**`<PromptInput>`** — `src/renderer/components/PromptInput.tsx`
```ts
interface PromptInputProps {
  initialValue?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Resolves true on success, false on cancel. */
  onSubmit: (text: string) => Promise<boolean> | boolean;
  'data-testid'?: string;
}
```
- Multi-line `<textarea>` with auto-resize (max ~6 rows)
- "Send to AI" button (disabled when text is empty or disabled)
- Cmd/Ctrl+Enter submits. Plain Enter inserts newline.
- After successful submit, clears the input.
- Exposes `data-testid="log-prompt-input"` (textarea) and `data-testid="log-send-button"`.

**`<AnsiText>` / `stripAnsi`** — `src/renderer/components/ansi.ts`
- `stripAnsi(s: string): string` — removes CSI escape sequences (`\x1b\[[0-9;]*m` etc.). MVP strips; full color rendering is a follow-up.

### View — `<ExecutionView>`

```ts
interface ExecutionViewProps {
  runId: string;
  projectId: string;
  onBack: () => void;
}
```

Behavior:
- Resolves the run snapshot:
  - First check the active run via `window.api.runs.current()`. If `result.data.run?.id === runId`, use that.
  - Otherwise call `window.api.runs.readLog({ runId })` (history view — completed run).
  - For #8: if neither is available, show a "Run not found" placeholder. (Full history navigation lands when the Runs tab is implemented in a future issue.)
- Header bar (sticky top):
  - Back button (`data-testid="execution-back"`) — calls `onBack`
  - Project name (looked up via `window.api.projects.get`) + ticket key + state badge (`data-testid="execution-status-badge"`)
  - Right side: progress counter `Step {currentUserVisibleIndex+1} of {totalUserVisibleSteps}` (`data-testid="execution-progress"`), Auto-scroll Toggle (`data-testid="log-autoscroll-toggle"`, default ON), Pause button (`data-testid="log-pause-button"`, toggles useRunLog's paused state), Cancel button (`data-testid="log-cancel-button"`, calls `runs.cancel`, hidden if status is terminal)
- Two-column body:
  - Left (~60% width): `<ExecutionLog>` rendering useRunLog steps
  - Right (~40% width): empty placeholder card, text "Approval panel lands in #9" + small subtitle. `data-testid="execution-approval-placeholder"`. (#9 will replace this with the live approval pane.)
- Bottom (sticky): `<PromptInput>` with onSubmit calling `window.api.claude.write({ runId: claudeRunId, text })`. `claudeRunId` is resolved via `window.api.claude.status()` on each submit. If no claude run is active (terminal run), input is disabled.

### App.tsx routing

Extend `ViewState`:
```ts
type ViewState =
  | { kind: 'list' }
  | { kind: 'detail'; projectId: string }
  | { kind: 'execution'; runId: string; projectId: string };
```
Routing:
- ProjectDetail's Active Execution panel "Open Details" button → `setView({ kind: 'execution', runId, projectId })`. Open Details was removed during #7 review; it's restored in this PR.
- ExecutionView `onBack` → `setView({ kind: 'detail', projectId })`.

### Main process wiring

`src/main/index.ts`:
- Instantiate `RunLogStore({ runsDir: join(userData, 'runs') })` after `runStore`.
- After `workflowRunner` is constructed, subscribe to `claudeManager.onOutput`. For each event: if `workflowRunner.current() !== null`, `runLogStore.appendLine({ runId: workflowRunner.current().id, stream, line, timestamp, state: workflowRunner.current().state })`.
- Register `runs:read-log` IPC handler that calls `runLogStore.read(runId)`.

## Business Rules
1. **Live runs use the streaming subscription**; completed/failed/cancelled runs use `runs.readLog` for the persisted history.
2. **Pause buffers** new lines locally in the renderer (`useRunLog` hook). Resume flushes the buffer into the appropriate steps. Pause does NOT pause Claude itself.
3. **Auto-scroll follows new content** when the user is at bottom. Scrolling up disables follow-mode until the user scrolls back to bottom OR toggles auto-scroll off-then-on.
4. **ANSI escape codes are stripped** in MVP (no color rendering).
5. **PromptInput is a shared component**; #9 will reuse it for the Modify flow. For #8 it submits free text to claude stdin via `claude.write`.
6. **Right pane is an explicit placeholder** in #8 ("Approval panel lands in #9"). #9 replaces it.
7. **Open Details navigation** restored on the Active Execution panel in ProjectDetail.
8. **All interactive elements have `data-testid`**.
9. **Persistence is append-only NDJSON** at `userData/runs/{runId}.log`. One JSON object per line. Skip malformed lines on read with a console.warn.
10. **Cancel button** is hidden when the run's status is terminal.

## API Acceptance Tests

### RunLogStore (RUNLOG-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| RUNLOG-001 | `init()` creates the runs directory if missing | mkdir called with `recursive: true` |
| RUNLOG-002 | `appendLine()` writes one NDJSON line per entry | fs.appendFile invoked with `${JSON.stringify(entry)}\n` |
| RUNLOG-003 | `read()` of a missing log returns ok with empty entries | true |
| RUNLOG-004 | `read()` of an existing log returns parsed entries | 3 entries → array of 3 RunLogEntry objects |
| RUNLOG-005 | `read()` skips malformed NDJSON lines (logged warn) | 2 valid + 1 malformed → 2 entries returned |
| RUNLOG-006 | `read()` with non-ENOENT fs error returns IO_FAILURE | true |

### Renderer hook — useRunLog (RUNLOG-HOOK-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| RUNLOG-HOOK-001 | Live run: subscribes to claude.onOutput; new lines arrive in current step | true |
| RUNLOG-HOOK-002 | Terminal run: loads from runs.readLog on mount; no claude subscription | true |
| RUNLOG-HOOK-003 | Pause halts new-line propagation; bufferedLineCount increments | true |
| RUNLOG-HOOK-004 | Resume flushes buffer; bufferedLineCount drops to 0 | true |
| RUNLOG-HOOK-005 | State-change events update step status (running → done) | true |
| RUNLOG-HOOK-006 | onUnmount unsubscribes | true |
| RUNLOG-HOOK-007 | Lines for non-current claude run are filtered out | true |
| RUNLOG-HOOK-008 | window.api === undefined → no crash, empty steps | true |

### Components (CMP-EXEC-LOG-XXX, CMP-PROMPT-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| CMP-EXEC-LOG-001 | Step row renders with status icon and label | true |
| CMP-EXEC-LOG-002 | Body collapsed by default for completed steps; expanded for current | true |
| CMP-EXEC-LOG-003 | Toggle button collapses/expands the body | true |
| CMP-EXEC-LOG-004 | Lines render with stream tag (stdout/stderr) | true |
| CMP-EXEC-LOG-005 | ANSI escapes stripped in rendered output | input has `\x1b[31m` → output has no escape |
| CMP-EXEC-LOG-006 | Auto-scroll: when at bottom and new content, scrollTop set to scrollHeight | true |
| CMP-PROMPT-001 | Submit on Send button click | onSubmit called with current text |
| CMP-PROMPT-002 | Cmd/Ctrl+Enter submits | true |
| CMP-PROMPT-003 | Plain Enter inserts newline (does NOT submit) | true |
| CMP-PROMPT-004 | Empty text → Send disabled; submit not called | true |
| CMP-PROMPT-005 | Disabled prop disables both textarea and button | true |
| CMP-PROMPT-006 | After successful submit, input is cleared | true |
| CMP-PROMPT-007 | initialValue populates the input on mount | true |

### View (EXEC-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| EXEC-001 | Header renders project name + ticket key + status badge | true |
| EXEC-002 | Progress counter renders `Step X of Y` | true |
| EXEC-003 | Auto-scroll toggle defaults ON | true |
| EXEC-004 | Pause button toggles useRunLog paused state; UI shows "Resume" when paused | true |
| EXEC-005 | Cancel button calls window.api.runs.cancel; hidden when status is terminal | true |
| EXEC-006 | Back button calls onBack | true |
| EXEC-007 | Right pane shows "Approval panel lands in #9" placeholder | true |
| EXEC-008 | PromptInput onSubmit calls claude.write with claudeRunId from claude.status() | true |
| EXEC-009 | Live run with state events updates the timeline | true |
| EXEC-010 | Terminal run with no active claude run: input disabled | true |

### App-level + ProjectDetail (NAV-XXX)

| ID | Scenario | Expected |
|----|----------|----------|
| NAV-001 | ProjectDetail's Active Execution panel shows Open Details button | true |
| NAV-002 | Click Open Details → App routes to execution view (`view.kind === 'execution'`) | true |
| NAV-003 | ExecutionView Back returns to ProjectDetail | true |

### IPC contract (IPC-RUNS-005)

| ID | Scenario | Expected |
|----|----------|----------|
| IPC-RUNS-005 | `RUNS_READ_LOG === 'runs:read-log'`; IpcApi.runs.readLog typed as `(req) => Promise<IpcResult<{ entries: RunLogEntry[] }>>` | true |

## Manual verification (after PR)
- [ ] `npm run dev` regression: ProjectList + ProjectDetail still work
- [ ] Click Run on a ticket → Active Execution panel appears with Open Details button
- [ ] Click Open Details → ExecutionView opens with the timeline
- [ ] Pause / Resume work
- [ ] Type in the bottom input and Send → text is delivered to claude (or graceful error if no active claude run)
- [ ] Cancel works (transitions run to cancelled, log shows the final state)
- [ ] Back button returns to ProjectDetail

## Test Status
- [x] RUNLOG-001..006: PASS (6 tests)
- [x] RUNLOG-HOOK-001..008: PASS (9 tests)
- [x] CMP-EXEC-LOG-001..006: PASS (6 tests)
- [x] CMP-PROMPT-001..007: PASS (9 tests)
- [x] EXEC-001..010: PASS (11 tests)
- [x] NAV-001..003: PASS (Open Details restored on ProjectDetail)
- [x] IPC-RUNS-005: PASS (3 sub-tests)
- [x] Total project: **486/489 unit tests pass + 3 skipped (superseded)** (was 439 after #7; +47 new)
- [x] `npm run lint`: 0 / 0
- [x] `npm run typecheck`: 0
- [x] `npm run build`: clean — renderer 356.53 kB JS / 56.73 kB CSS
