/**
 * ClaudeProcessManager — the engine that spawns the local `claude` CLI as a
 * child process, line-buffers its stdout/stderr, supports cancellation,
 * configurable timeout, and stdin writes.
 *
 * Uses an injected `Spawner` so it can be unit-tested via `FakeSpawner`
 * without spawning real processes.
 *
 * See `acceptance/claude-process-manager.md` for the full behavioural spec.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { isAbsolute as pathIsAbsolute } from 'node:path';
import type { Spawner, SpawnedProcess } from './spawner.js';

const TICKET_KEY_REGEX = /^[A-Z][A-Z0-9_]*-\d+$/;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_KILL_GRACE_MS = 5000;
const DEFAULT_COMMAND = 'claude';

/**
 * Drop a trailing `\r` produced by CRLF line endings on Windows. The line
 * splitter splits on `\n` only, so on Windows the `\r` would otherwise leak
 * into emitted `OutputEvent.line` strings and surface as garbage in the UI.
 */
function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

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

export type ManagerErrorCode =
  | 'INVALID_TICKET_KEY'
  | 'INVALID_CWD'
  | 'ALREADY_RUNNING'
  | 'NOT_RUNNING'
  | 'SPAWN_FAILED'
  | 'STDIN_CLOSED';

export type RunResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ManagerErrorCode; message: string } };

/**
 * Internal record of the currently active run. There is at most one per
 * manager instance (business rule 1 — single active run).
 */
interface ActiveRun {
  runId: string;
  startedAt: number;
  pid: number | undefined;
  child: SpawnedProcess;
  stdoutBuf: string;
  stderrBuf: string;
  /** Set to a non-completed reason if cancel/timeout happens before exit. */
  pendingReason: ExitEvent['reason'] | null;
  timeoutTimer: ReturnType<typeof setTimeout> | null;
  killEscalationTimer: ReturnType<typeof setTimeout> | null;
  /** Guards against double-emitting the exit event. */
  exited: boolean;
}

export class ClaudeProcessManager extends EventEmitter {
  private readonly spawner: Spawner;
  private readonly defaultTimeoutMs: number;
  private readonly killGraceMs: number;
  private readonly command: string;

  private active: ActiveRun | null = null;

  constructor(options: ClaudeProcessManagerOptions) {
    super();
    this.spawner = options.spawner;
    this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.command = options.command ?? DEFAULT_COMMAND;
  }

  /**
   * Spawns a new claude run. Validation runs BEFORE any spawn so a bad
   * ticketKey or cwd never reaches the underlying spawner. Returns
   * `ALREADY_RUNNING` if a run is already in flight.
   */
  run(req: RunRequest): RunResult<RunResponse> {
    if (!TICKET_KEY_REGEX.test(req.ticketKey)) {
      return {
        ok: false,
        error: {
          code: 'INVALID_TICKET_KEY',
          message:
            'ticketKey must match /^[A-Z][A-Z0-9_]*-\\d+$/ (e.g. "ABC-123"); ' +
            `got "${req.ticketKey}"`,
        },
      };
    }

    if (!pathIsAbsolute(req.cwd)) {
      return {
        ok: false,
        error: {
          code: 'INVALID_CWD',
          message: `cwd must be an absolute path; got "${req.cwd}"`,
        },
      };
    }

    if (this.active !== null) {
      return {
        ok: false,
        error: {
          code: 'ALREADY_RUNNING',
          message: `a run is already active (runId=${this.active.runId})`,
        },
      };
    }

    const runId = randomUUID();
    const startedAt = Date.now();
    const timeoutMs = req.timeoutMs ?? this.defaultTimeoutMs;

    let child: SpawnedProcess;
    try {
      child = this.spawner.spawn({
        command: this.command,
        args: [req.ticketKey],
        cwd: req.cwd,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: { code: 'SPAWN_FAILED', message },
      };
    }

    const activeRun: ActiveRun = {
      runId,
      startedAt,
      pid: child.pid,
      child,
      stdoutBuf: '',
      stderrBuf: '',
      pendingReason: null,
      timeoutTimer: null,
      killEscalationTimer: null,
      exited: false,
    };
    this.active = activeRun;

    // Wire up streaming output. We listen for both Buffer and string chunks.
    if (child.stdout !== null) {
      child.stdout.on('data', (chunk: Buffer | string) => {
        this.handleStreamChunk(activeRun, 'stdout', chunk);
      });
    }
    if (child.stderr !== null) {
      child.stderr.on('data', (chunk: Buffer | string) => {
        this.handleStreamChunk(activeRun, 'stderr', chunk);
      });
    }

    child.on('exit', (code, signal) => {
      this.handleExit(activeRun, code, signal);
    });

    child.on('error', (err) => {
      this.handleSpawnError(activeRun, err);
    });

    // Per-run timeout.
    activeRun.timeoutTimer = setTimeout(() => {
      this.triggerTimeout(activeRun);
    }, timeoutMs);

    return {
      ok: true,
      data: { runId, pid: child.pid, startedAt },
    };
  }

  /**
   * Sends SIGTERM to the active run, then escalates to SIGKILL after
   * `killGraceMs`. The eventual `exit` event will fire with
   * `reason: 'cancelled'` (see business rule on reason precedence).
   */
  cancel(runId: string): RunResult<{ runId: string }> {
    const active = this.active;
    if (active === null || active.runId !== runId) {
      return {
        ok: false,
        error: {
          code: 'NOT_RUNNING',
          message:
            active === null
              ? 'no active run to cancel'
              : `runId mismatch: active runId is ${active.runId}, got ${runId}`,
        },
      };
    }

    // Mark intent first so reason precedence holds even if exit races us.
    if (active.pendingReason === null) {
      active.pendingReason = 'cancelled';
    }

    this.escalateKill(active);

    return { ok: true, data: { runId } };
  }

  /**
   * Writes text to the active run's stdin. No implicit newline — the caller
   * appends `\n` when they want one. This lets a future Approval flow send
   * multi-line responses or raw bytes.
   */
  write(req: { runId: string; text: string }): RunResult<{ bytesWritten: number }> {
    const active = this.active;
    if (active === null || active.runId !== req.runId) {
      return {
        ok: false,
        error: {
          code: 'NOT_RUNNING',
          message:
            active === null
              ? 'no active run to write to'
              : `runId mismatch: active runId is ${active.runId}, got ${req.runId}`,
        },
      };
    }

    const stdin = active.child.stdin;
    if (stdin === null || (stdin as { writable?: boolean }).writable === false) {
      return {
        ok: false,
        error: { code: 'STDIN_CLOSED', message: 'stdin is closed' },
      };
    }

    try {
      stdin.write(req.text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: { code: 'STDIN_CLOSED', message },
      };
    }

    return {
      ok: true,
      data: { bytesWritten: Buffer.byteLength(req.text, 'utf8') },
    };
  }

  /** Returns the active run snapshot, or null if idle. */
  status(): { runId: string; pid: number | undefined; startedAt: number } | null {
    if (this.active === null) {
      return null;
    }
    return {
      runId: this.active.runId,
      pid: this.active.pid,
      startedAt: this.active.startedAt,
    };
  }

  // -- Internal helpers -----------------------------------------------------

  /**
   * Append `chunk` to the per-stream buffer, slice off complete `\n`-terminated
   * lines, emit one `output` event per complete line, and keep the trailing
   * (possibly empty) partial line in the buffer. Trailing pieces are flushed
   * on exit by `handleExit`.
   */
  private handleStreamChunk(
    run: ActiveRun,
    stream: 'stdout' | 'stderr',
    chunk: Buffer | string,
  ): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const bufferKey = stream === 'stdout' ? 'stdoutBuf' : 'stderrBuf';
    const combined = run[bufferKey] + text;
    const parts = combined.split('\n');
    // The last element is everything after the final `\n` — keep it in the
    // buffer until either more data arrives or the process exits.
    const trailing = parts.pop() ?? '';
    run[bufferKey] = trailing;
    for (const line of parts) {
      this.emitOutput(run, stream, stripCarriageReturn(line));
    }
  }

  private flushTrailingBuffers(run: ActiveRun): void {
    if (run.stdoutBuf.length > 0) {
      const line = run.stdoutBuf;
      run.stdoutBuf = '';
      this.emitOutput(run, 'stdout', stripCarriageReturn(line));
    }
    if (run.stderrBuf.length > 0) {
      const line = run.stderrBuf;
      run.stderrBuf = '';
      this.emitOutput(run, 'stderr', stripCarriageReturn(line));
    }
  }

  private emitOutput(
    run: ActiveRun,
    stream: 'stdout' | 'stderr',
    line: string,
  ): void {
    const event: OutputEvent = {
      runId: run.runId,
      stream,
      line,
      timestamp: Date.now(),
    };
    this.emit('output', event);
  }

  private handleExit(
    run: ActiveRun,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (run.exited) {
      return;
    }
    run.exited = true;

    // Clear any outstanding timers.
    if (run.timeoutTimer !== null) {
      clearTimeout(run.timeoutTimer);
      run.timeoutTimer = null;
    }
    if (run.killEscalationTimer !== null) {
      clearTimeout(run.killEscalationTimer);
      run.killEscalationTimer = null;
    }

    // Flush any partial lines accumulated before exit (rule 2 — trailing
    // non-terminated buffer is flushed as a final event).
    this.flushTrailingBuffers(run);

    const reason: ExitEvent['reason'] = run.pendingReason ?? 'completed';

    const exitEvent: ExitEvent = {
      runId: run.runId,
      exitCode: code,
      signal,
      durationMs: Date.now() - run.startedAt,
      reason,
    };

    // Clear active state BEFORE emitting so a listener that calls run() in
    // response to exit isn't blocked by ALREADY_RUNNING.
    if (this.active === run) {
      this.active = null;
    }

    this.emit('exit', exitEvent);
  }

  /**
   * Spawn-error path (rule 8): emit the error message as a synthesized
   * stderr `output` event so the UI sees it, then emit `exit` with
   * `reason: 'error'`, `exitCode: null`, `signal: null`.
   */
  private handleSpawnError(run: ActiveRun, err: Error): void {
    if (run.exited) {
      return;
    }
    this.emitOutput(run, 'stderr', err.message);
    // Mark the reason BEFORE handleExit so the precedence path picks it up.
    if (run.pendingReason === null) {
      run.pendingReason = 'error';
    }
    this.handleExit(run, null, null);
  }

  private triggerTimeout(run: ActiveRun): void {
    if (run.exited || this.active !== run) {
      return;
    }
    if (run.pendingReason === null) {
      run.pendingReason = 'timeout';
    }
    this.escalateKill(run);
  }

  /**
   * Send SIGTERM now and schedule SIGKILL after `killGraceMs`. Idempotent:
   * if a kill escalation timer is already armed, leave it alone.
   */
  private escalateKill(run: ActiveRun): void {
    try {
      run.child.kill('SIGTERM');
    } catch {
      // Best-effort: if the process is already gone, the eventual exit
      // listener will still fire (or already has).
    }

    if (run.killEscalationTimer !== null) {
      return;
    }
    run.killEscalationTimer = setTimeout(() => {
      run.killEscalationTimer = null;
      if (run.exited) {
        return;
      }
      try {
        run.child.kill('SIGKILL');
      } catch {
        // Ignore — handleExit will still fire when the process actually exits.
      }
    }, this.killGraceMs);
  }

  // -- Typed event listener overloads --------------------------------------
  //
  // We override `on` and `emit` only to add typed overloads for the manager's
  // domain events. The implementation signatures keep `any[]` so they remain
  // assignment-compatible with the base `EventEmitter` signatures under
  // `noImplicitAny` / `strict`.

  override on(event: 'output', listener: (e: OutputEvent) => void): this;
  override on(event: 'exit', listener: (e: ExitEvent) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override on(event: string | symbol, listener: (...args: any[]) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  override emit(event: 'output', e: OutputEvent): boolean;
  override emit(event: 'exit', e: ExitEvent): boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override emit(event: string | symbol, ...args: any[]): boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override emit(event: string | symbol, ...args: any[]): boolean {
    return super.emit(event, ...args);
  }
}
