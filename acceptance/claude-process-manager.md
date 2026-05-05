# Claude Process Manager — Acceptance Criteria

## Description (client-readable)
A main-process module that spawns the local `claude` CLI as a child process, streams its stdout/stderr to the renderer over typed IPC, and supports cancellation, configurable timeout, and stdin writes. This is the engine that future workflow features (#7, #8, #9) build on.

## Adaptation Note
This is a **backend-only** feature — no UI in this issue. The UI that consumes the streamed output is #8 (Stream Claude Output to Execution View). "Frontend tests" here are limited to type-level assertions that the renderer can call `window.api.claude.*` and subscribe to events with the correct shapes.

## Interface Contract

### Tech Stack (locked, inherited from #1)
- Node.js ≥ 20, Electron 31
- TypeScript strict mode
- Vitest 2 for unit tests (no real `claude` CLI invocation in tests)

### File Structure (exact)
```
src/
├── main/
│   ├── index.ts                          # extend with IPC handler registration
│   └── modules/
│       ├── spawner.ts                    # Spawner interface + NodeSpawner + FakeSpawner
│       └── claude-process-manager.ts     # ClaudeProcessManager class
├── preload/
│   └── index.ts                          # extend window.api
└── shared/
    └── ipc.ts                            # extend with new channels + types
tests/
└── unit/
    ├── spawner.test.ts                   # FakeSpawner behavior tests
    └── claude-process-manager.test.ts    # ClaudeProcessManager via FakeSpawner
```

### Spawner Interface (exact)

File: `src/main/modules/spawner.ts`

```ts
import type { ChildProcess } from 'node:child_process';

export interface SpawnOptions {
  command: string;
  args: ReadonlyArray<string>;
  cwd: string;
  env?: Readonly<Record<string, string>>;
  /** Whether to use a shell. Required on Windows for .cmd shims. */
  shell?: boolean;
}

/**
 * Minimal facade over child_process.spawn so ClaudeProcessManager can be
 * unit-tested without spawning real processes.
 */
export interface Spawner {
  spawn(options: SpawnOptions): SpawnedProcess;
}

/**
 * Subset of child_process.ChildProcess that we actually use. Lets the
 * FakeSpawner be a small, well-defined object instead of a full mock.
 */
export interface SpawnedProcess {
  readonly pid: number | undefined;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  readonly stdin: NodeJS.WritableStream | null;
  readonly exitCode: number | null;
  readonly killed: boolean;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit', cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

/** Real implementation — wraps child_process.spawn. */
export class NodeSpawner implements Spawner {
  spawn(options: SpawnOptions): SpawnedProcess { /* ... */ }
}

/** Test implementation — never spawns anything. Test code drives output via emit*() helpers. */
export class FakeSpawner implements Spawner {
  /** The most recent spawned fake. Tests use this to drive events. */
  readonly lastSpawned: FakeSpawnedProcess | null;
  spawn(options: SpawnOptions): FakeSpawnedProcess { /* ... */ }
}

export interface FakeSpawnedProcess extends SpawnedProcess {
  /** Test helper: emit a chunk on stdout. */
  emitStdout(chunk: string): void;
  /** Test helper: emit a chunk on stderr. */
  emitStderr(chunk: string): void;
  /** Test helper: simulate process exit. */
  emitExit(code: number | null, signal?: NodeJS.Signals | null): void;
  /** Test helper: simulate spawn error. */
  emitError(err: Error): void;
  /** Test helper: read what was written to stdin. */
  readonly stdinWrites: ReadonlyArray<string>;
}
```

### ClaudeProcessManager Class (exact public API)

File: `src/main/modules/claude-process-manager.ts`

```ts
import { EventEmitter } from 'node:events';
import type { Spawner } from './spawner';

export interface ClaudeProcessManagerOptions {
  spawner: Spawner;
  /** ms before SIGTERM is sent automatically. Default 30 * 60 * 1000 (30 min). */
  timeoutMs?: number;
  /** ms between SIGTERM and SIGKILL escalation during cancel/timeout. Default 5000. */
  killGraceMs?: number;
  /** The command to spawn. Default 'claude'. Tests can override. */
  command?: string;
}

export interface RunRequest {
  /** Ticket identifier. Validated against /^[A-Z][A-Z0-9_]*-\d+$/. */
  ticketKey: string;
  /** Working directory the claude process should run in (must be absolute). */
  cwd: string;
  /** Optional override of timeout in ms for this run. */
  timeoutMs?: number;
}

export interface RunResponse {
  runId: string;
  pid: number | undefined;
  startedAt: number;
}

export interface OutputEvent {
  runId: string;
  stream: 'stdout' | 'stderr';
  line: string;
  timestamp: number;
}

export interface ExitEvent {
  runId: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  reason: 'completed' | 'cancelled' | 'timeout' | 'error';
}

export type RunResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ManagerErrorCode; message: string } };

export type ManagerErrorCode =
  | 'INVALID_TICKET_KEY'
  | 'INVALID_CWD'
  | 'ALREADY_RUNNING'
  | 'NOT_RUNNING'
  | 'SPAWN_FAILED'
  | 'STDIN_CLOSED';

export class ClaudeProcessManager extends EventEmitter {
  constructor(options: ClaudeProcessManagerOptions);

  /**
   * Spawns a new claude run. Returns ALREADY_RUNNING if a run is in flight.
   * Emits 'output' events (OutputEvent) line by line on stdout/stderr.
   * Emits 'exit' event (ExitEvent) exactly once when the process exits.
   */
  run(req: RunRequest): RunResult<RunResponse>;

  /**
   * Sends SIGTERM to the active run, then SIGKILL after killGraceMs.
   * Returns NOT_RUNNING if no run is active.
   * The pending 'exit' event will fire with reason='cancelled'.
   */
  cancel(runId: string): RunResult<{ runId: string }>;

  /**
   * Writes text to the active run's stdin (no auto-newline — caller appends \n).
   * Returns NOT_RUNNING / STDIN_CLOSED on failure.
   */
  write(req: { runId: string; text: string }): RunResult<{ bytesWritten: number }>;

  /** Returns the active run snapshot, or null if idle. */
  status(): { runId: string; pid: number | undefined; startedAt: number } | null;

  /** Listener typing helpers — these are the only events emitted. */
  on(event: 'output', listener: (e: OutputEvent) => void): this;
  on(event: 'exit', listener: (e: ExitEvent) => void): this;
}
```

### IPC Contract Extension (exact)

File: `src/shared/ipc.ts` — extend with:

```ts
// Extend IPC_CHANNELS:
export const IPC_CHANNELS = {
  PING: 'app:ping',
  CLAUDE_RUN: 'claude:run',
  CLAUDE_CANCEL: 'claude:cancel',
  CLAUDE_WRITE: 'claude:write',
  CLAUDE_STATUS: 'claude:status',
  CLAUDE_OUTPUT: 'claude:output',     // event channel (main → renderer)
  CLAUDE_EXIT: 'claude:exit',         // event channel (main → renderer)
} as const;

// Re-export the manager's request/response/event types from shared/ipc.ts so
// renderer + main agree without a circular import. Keep types pure (no runtime
// imports from the main module).
export interface ClaudeRunRequest { ticketKey: string; cwd: string; timeoutMs?: number }
export interface ClaudeRunResponse { runId: string; pid: number | undefined; startedAt: number }
export interface ClaudeCancelRequest { runId: string }
export interface ClaudeWriteRequest { runId: string; text: string }
export interface ClaudeStatusResponse {
  active: { runId: string; pid: number | undefined; startedAt: number } | null;
}
export interface ClaudeOutputEvent {
  runId: string;
  stream: 'stdout' | 'stderr';
  line: string;
  timestamp: number;
}
export interface ClaudeExitEvent {
  runId: string;
  exitCode: number | null;
  signal: string | null;     // Signals serialized as string across IPC
  durationMs: number;
  reason: 'completed' | 'cancelled' | 'timeout' | 'error';
}

export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

// Extend IpcApi:
export interface IpcApi {
  ping: (req: PingRequest) => Promise<PingResponse>;
  claude: {
    run: (req: ClaudeRunRequest) => Promise<IpcResult<ClaudeRunResponse>>;
    cancel: (req: ClaudeCancelRequest) => Promise<IpcResult<{ runId: string }>>;
    write: (req: ClaudeWriteRequest) => Promise<IpcResult<{ bytesWritten: number }>>;
    status: () => Promise<IpcResult<ClaudeStatusResponse>>;
    /** Subscribe to streaming output events. Returns unsubscribe fn. */
    onOutput: (listener: (e: ClaudeOutputEvent) => void) => () => void;
    /** Subscribe to exit events. Returns unsubscribe fn. */
    onExit: (listener: (e: ClaudeExitEvent) => void) => () => void;
  };
}
```

### Preload bindings

File: `src/preload/index.ts` — extend the existing `api` object:
- `api.claude.run` → `ipcRenderer.invoke(CLAUDE_RUN, req)`
- `api.claude.cancel` → `ipcRenderer.invoke(CLAUDE_CANCEL, req)`
- `api.claude.write` → `ipcRenderer.invoke(CLAUDE_WRITE, req)`
- `api.claude.status` → `ipcRenderer.invoke(CLAUDE_STATUS)`
- `api.claude.onOutput(listener)` → `ipcRenderer.on(CLAUDE_OUTPUT, (_e, payload) => listener(payload))`; return an unsubscribe function that removes the listener
- `api.claude.onExit(listener)` → analogous to onOutput

The existing `api.ping` and `IPC_CHANNELS.PING` must keep working unchanged — no breaking changes to #1's contract.

### Main process wiring

File: `src/main/index.ts` — extend with:
- Construct a single `ClaudeProcessManager` instance at app startup
- Register IPC handlers for the 4 invoke channels (`claude:run/cancel/write/status`)
- Forward manager `'output'` and `'exit'` events to ALL renderer windows via `webContents.send(channel, payload)` (use `BrowserWindow.getAllWindows()` and check `!isDestroyed()`)

## Business Rules
1. **Single active run**: at most one `claude` child process at a time per MVP. A `run()` while active returns `ALREADY_RUNNING`. PRD §10 explicitly excludes multi-ticket concurrency.
2. **Line-buffered streaming**: stdout/stderr chunks may not align with line boundaries. The manager MUST buffer partial lines and emit ONE `output` event per complete line (terminated by `\n`). On process exit, any trailing non-terminated buffer is flushed as a final event.
3. **TicketKey validation**: must match `/^[A-Z][A-Z0-9_]*-\d+$/` (e.g. `ABC-123`, `INGEST-42`). Invalid keys return `INVALID_TICKET_KEY` BEFORE any spawn happens. This prevents command injection via the ticket key argument.
4. **CWD validation**: must be an absolute path. Existence check is the caller's responsibility (we don't `fs.statSync` to keep tests pure), but the manager MUST reject relative paths with `INVALID_CWD`.
5. **Cancel escalation**: SIGTERM is sent first; if the process hasn't exited within `killGraceMs` (default 5s), SIGKILL is sent. The `exit` event reflects which signal actually terminated the process.
6. **Timeout**: starts when `run()` is called. On timeout, manager calls cancel internally and the `exit` event fires with `reason: 'timeout'`. Default 30 minutes; per-run override allowed via `RunRequest.timeoutMs`.
7. **Stdin write**: writing to a closed stdin returns `STDIN_CLOSED`. The caller appends `\n` if needed (no implicit newline) — this lets the future Approval flow (#9) send multi-line responses or raw bytes.
8. **Spawn error handling**: if the child process emits `'error'` (e.g. ENOENT — `claude` not on PATH), the manager MUST emit an `exit` event with `reason: 'error'`, `exitCode: null`, and a `signal: null`, AND the original `run()` call must already have returned successfully (because `run()` is synchronous — the error arrives later asynchronously). The error message must surface in the OutputEvent stream as a stderr line so the UI sees it.
9. **No `runId` reuse**: each run gets a fresh runId (use `crypto.randomUUID()` or `Date.now()-counter`). Subscribers can filter events by runId if needed.
10. **Cross-platform spawn**:
    - Default `shell: true` so Windows `.cmd` shims resolve (the controlled args are safe — ticketKey is regex-validated, cwd is path-only).
    - On non-Windows, `shell: true` is also fine (POSIX shell, controlled args).
    - Tests override `command` to something inert if needed.

## API Acceptance Tests (IPC contract + module-level)

| ID | Scenario | Setup | Action | Expected |
|----|----------|-------|--------|----------|
| CPM-001 | Happy path: run → stream → exit | FakeSpawner + new manager | `run({ ticketKey: 'ABC-123', cwd: '/abs/path' })`; emit stdout `"hello\n"`; emit exit code 0 | `run()` returns `ok: true` with runId; `output` event fires with `{ runId, stream: 'stdout', line: 'hello' }`; `exit` event fires with `exitCode: 0, reason: 'completed'` |
| CPM-002 | Line buffering across chunks | FakeSpawner | emit `"foo\nb"`, then `"ar\n"` | TWO output events: `line: 'foo'` then `line: 'bar'` (NOT three, NOT one) |
| CPM-003 | Trailing partial line flushed on exit | FakeSpawner | emit `"final-line"` (no `\n`); emit exit code 0 | Output event fires with `line: 'final-line'` after exit |
| CPM-004 | Stderr is separately tagged | FakeSpawner | emit on stderr `"oops\n"`; emit exit | `output` event has `stream: 'stderr'`, `line: 'oops'` |
| CPM-005 | TicketKey validation rejects bad input | FakeSpawner | `run({ ticketKey: 'abc-123', cwd: '/a' })` | `ok: false`, `code: 'INVALID_TICKET_KEY'`. **No spawn happened** (FakeSpawner.lastSpawned stays at previous value) |
| CPM-006 | CWD validation rejects relative paths | FakeSpawner | `run({ ticketKey: 'A-1', cwd: 'relative/path' })` | `ok: false`, `code: 'INVALID_CWD'` |
| CPM-007 | Single active run | FakeSpawner | first `run()` succeeds; second `run()` while active | second returns `ok: false`, `code: 'ALREADY_RUNNING'` |
| CPM-008 | Run after previous exited is allowed | FakeSpawner | run, exit, run again | second `run()` returns `ok: true` |
| CPM-009 | Cancel sends SIGTERM | FakeSpawner | run; cancel(runId) | `kill('SIGTERM')` was called on the spawned process |
| CPM-010 | Cancel escalates to SIGKILL after grace | FakeSpawner with `killGraceMs: 50` + fake timers | run; cancel; advance 60ms without process exit | `kill('SIGKILL')` was called |
| CPM-011 | Cancel with no active run | FakeSpawner | `cancel('any-id')` | `ok: false`, `code: 'NOT_RUNNING'` |
| CPM-012 | Cancel with wrong runId | FakeSpawner | run; cancel('wrong-id') | `ok: false`, `code: 'NOT_RUNNING'` (runId mismatch) |
| CPM-013 | Cancel exit event has reason 'cancelled' | FakeSpawner | run; cancel; emit exit signal SIGTERM | exit event has `reason: 'cancelled'` |
| CPM-014 | Timeout fires automatically | FakeSpawner with `timeoutMs: 100` + fake timers | run; advance 150ms without exit | SIGTERM sent; eventual exit event has `reason: 'timeout'` |
| CPM-015 | Timeout per-run override | FakeSpawner with default `timeoutMs: 100000` + fake timers | `run({ ..., timeoutMs: 100 })`; advance 150ms | timeout fires (uses override, not default) |
| CPM-016 | Write to stdin succeeds | FakeSpawner | run; `write({ runId, text: 'yes\n' })` | `ok: true, data: { bytesWritten: 4 }`; FakeSpawner records 'yes\n' in stdinWrites |
| CPM-017 | Write before run | FakeSpawner | `write({ runId: 'x', text: 'hi' })` (no run active) | `ok: false`, `code: 'NOT_RUNNING'` |
| CPM-018 | Write after exit | FakeSpawner | run; emit exit; `write(...)` | `ok: false`, `code: 'NOT_RUNNING'` (run is no longer active after exit) |
| CPM-019 | Spawn error surfaces as exit + stderr line | FakeSpawner | run; emit error `Error('ENOENT')` | `output` event with `stream: 'stderr'`, line containing `'ENOENT'`; `exit` event with `reason: 'error'`, `exitCode: null` |
| CPM-020 | Status reports active run | FakeSpawner | run; call `status()` | returns `{ runId, pid, startedAt }`; matches the `RunResponse` |
| CPM-021 | Status returns null when idle | FakeSpawner | call `status()` (no run) | returns `null` |
| CPM-022 | RunIds are unique across runs | FakeSpawner | run; emit exit; run again | second runId !== first runId |

## Frontend / IPC Contract Tests (renderer-facing)

| ID | Scenario | Action | Expected |
|----|----------|--------|----------|
| IPC-CPM-001 | IPC channels exported | Import `IPC_CHANNELS` | `CLAUDE_RUN === 'claude:run'`, `CLAUDE_CANCEL === 'claude:cancel'`, `CLAUDE_WRITE === 'claude:write'`, `CLAUDE_STATUS === 'claude:status'`, `CLAUDE_OUTPUT === 'claude:output'`, `CLAUDE_EXIT === 'claude:exit'` |
| IPC-CPM-002 | IpcApi type extension | `expectTypeOf<IpcApi['claude']['run']>().toEqualTypeOf<...>()` etc. for each method | All 6 claude methods have correct typed signatures |
| IPC-CPM-003 | Existing PING contract still works | `expect(IPC_CHANNELS.PING).toBe('app:ping')`; type check `IpcApi['ping']` | No regression to #1's contract |

## E2E (Playwright) — Deferred
No new Playwright coverage in this issue. Real Electron-driven E2E for the Claude flow lands in #8 (Stream Claude Output to Execution View) when there's a UI to drive.

## Test Status
- [x] CPM-001 through CPM-022: PASS (24 tests in `tests/unit/claude-process-manager.test.ts`, includes 2 extra cases beyond the 22 spec IDs)
- [x] IPC-CPM-001 / 002 / 003: PASS (21 tests in `tests/unit/ipc-contract-claude.test.ts`)
- [x] FakeSpawner self-tests: PASS (18 tests in `tests/unit/spawner.test.ts`)
- [x] `npm run test`: 86/86 pass across 8 files (was 23/23 after #1)
- [x] `npm run lint`: 0 errors, 0 warnings
- [x] `npm run typecheck`: 0 errors
- [x] `npm run build`: clean — main 1.26 kB, preload 1.44 kB (now bundles the IPC-channels module), renderer 217.42 kB

## Manual verification (developer, after PR)
- [ ] `npm run dev` still works; `Ping` button still returns `pong: hello` (regression check on #1's IPC)
- [ ] (Optional, requires `claude` CLI on PATH) Wire a temporary debug button that calls `window.api.claude.run({ ticketKey: 'TEST-1', cwd: <abs path> })` and verify output streams in DevTools console
