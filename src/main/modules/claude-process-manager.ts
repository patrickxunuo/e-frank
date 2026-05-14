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
const DEFAULT_SKILL_NAME = 'ef-auto-feature';

/**
 * Drop a trailing `\r` produced by CRLF line endings on Windows. The line
 * splitter splits on `\n` only, so on Windows the `\r` would otherwise leak
 * into emitted `OutputEvent.line` strings and surface as garbage in the UI.
 */
function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * Parse one stream-json event line and project its human-readable text
 * into the consumer's emit callback. Each event may contribute zero,
 * one, or many text fragments.
 *
 * Non-JSON lines (defensive — Claude shouldn't emit them under
 * `--output-format=stream-json`, but `--verbose` warnings or unknown
 * noise might leak in) pass through as plain text.
 *
 * Events we extract text from:
 *   - `stream_event` → `event.type=content_block_delta` with
 *     `delta.type=text_delta` (assistant response chunks streaming).
 *   - `stream_event` → `event.type=content_block_start` with
 *     `content_block.type=text` (rare: full text block re-emitted).
 *   - `assistant` messages with `type=text` content blocks.
 *   - `user` messages with `type=tool_result` content (this is where
 *     `<<<EF_PHASE>>>` and `<<<EF_APPROVAL_REQUEST>>>` markers from
 *     the skill's `echo` calls show up).
 *   - `result` event's `result` field (the final answer at run wrap).
 *
 * Other event types (system init, rate_limit_event, signature_delta,
 * input_json_delta, message_start/stop, etc.) are dropped.
 */
function emitJsonEventLines(
  line: string,
  emit: (text: string) => void,
): void {
  const trimmed = line.trim();
  if (trimmed === '') return;

  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    // Not JSON — pass through verbatim (defensive against verbose logs
    // or unknown noise). This also makes the parser a no-op when
    // stream-json mode is disabled and Claude emits plain text.
    emit(line);
    return;
  }

  for (const text of extractTextsFromEvent(event)) {
    if (text !== '') emit(text);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function extractTextsFromEvent(event: unknown): string[] {
  if (!isPlainObject(event)) return [];
  const out: string[] = [];

  // `stream_event` wraps an Anthropic API stream event — the source of
  // real-time deltas. Text lives at `event.delta.text` for
  // `content_block_delta` with `type=text_delta`.
  if (event['type'] === 'stream_event' && isPlainObject(event['event'])) {
    const inner = event['event'];
    if (inner['type'] === 'content_block_delta' && isPlainObject(inner['delta'])) {
      const delta = inner['delta'];
      if (delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
        out.push(delta['text']);
      }
    }
    if (inner['type'] === 'content_block_start' && isPlainObject(inner['content_block'])) {
      const block = inner['content_block'];
      if (block['type'] === 'text' && typeof block['text'] === 'string') {
        out.push(block['text']);
      }
    }
  }

  // Whole `assistant` messages carry an array of content blocks. Some
  // are `type=text`, some are `tool_use` (which we skip).
  if (event['type'] === 'assistant' && isPlainObject(event['message'])) {
    const msg = event['message'];
    if (Array.isArray(msg['content'])) {
      for (const block of msg['content']) {
        if (isPlainObject(block) && block['type'] === 'text' && typeof block['text'] === 'string') {
          out.push(block['text']);
        }
      }
    }
  }

  // `user` messages with `tool_result` content — this is how Bash tool
  // output (including the skill's `echo "<<<EF_PHASE>>>..."` markers)
  // gets back to us. The marker scanner in workflow-runner relies on
  // this path firing before exit.
  if (event['type'] === 'user' && isPlainObject(event['message'])) {
    const msg = event['message'];
    if (Array.isArray(msg['content'])) {
      for (const block of msg['content']) {
        if (isPlainObject(block) && block['type'] === 'tool_result') {
          const c = block['content'];
          if (typeof c === 'string') {
            out.push(c);
          } else if (Array.isArray(c)) {
            for (const sub of c) {
              if (isPlainObject(sub) && sub['type'] === 'text' && typeof sub['text'] === 'string') {
                out.push(sub['text']);
              }
            }
          }
        }
      }
    }
  }

  // Final `result` event at end-of-run.
  if (event['type'] === 'result' && typeof event['result'] === 'string') {
    out.push(event['result']);
  }

  return out;
}

export interface ClaudeProcessManagerOptions {
  spawner: Spawner;
  /** ms before SIGTERM is sent automatically. Default 30 * 60 * 1000 (30 min). */
  timeoutMs?: number;
  /** ms between SIGTERM and SIGKILL escalation during cancel/timeout. Default 5000. */
  killGraceMs?: number;
  /** The command to spawn. Default 'claude'. Tests can override. */
  command?: string;
  /**
   * Name of the Claude skill to invoke. The spawn argv is built as
   * `--dangerously-skip-permissions /<skillName> <ticketKey>`. Default
   * 'ef-auto-feature' — e-frank's autonomous ticket-to-PR orchestrator
   * (companion to the human-paced `ef-feature` skill). Per-project /
   * per-run skill selection lands in a follow-up issue (#39).
   */
  skillName?: string;
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
  private readonly skillName: string;

  /**
   * Active runs, keyed by runId (#GH-79). Pre-PR-B this was a single
   * `ActiveRun | null` slot; PR B replaces it with a map so the runner
   * can spawn multiple Claude subprocesses for concurrent runs (each
   * spawn is independent — separate child process, separate stdio).
   * The app-wide ALREADY_RUNNING check at `run()` is dropped.
   */
  private readonly active = new Map<string, ActiveRun>();

  constructor(options: ClaudeProcessManagerOptions) {
    super();
    this.spawner = options.spawner;
    this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.command = options.command ?? DEFAULT_COMMAND;
    this.skillName = options.skillName ?? DEFAULT_SKILL_NAME;
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

    // #GH-79: app-wide ALREADY_RUNNING check is dropped — multiple
    // concurrent Claude subprocesses are supported, each independent
    // (separate child, separate stdio). Per-ticket protection still
    // lives at the WorkflowRunner layer via runHistory locks.

    const runId = randomUUID();
    const startedAt = Date.now();
    const timeoutMs = req.timeoutMs ?? this.defaultTimeoutMs;

    let child: SpawnedProcess;
    try {
      // `--dangerously-skip-permissions` skips Claude's per-tool confirmation
      // prompts. Necessary because e-frank doesn't have a stdin channel to
      // relay "yes" back to Claude — the ApprovalPanel's marker contract is
      // a higher-level plan review, not per-edit gating. Without this flag,
      // Claude prints "I need write permissions to proceed" and hangs. This
      // is a stop-gap; a future issue should add proper prompt templating
      // (system prompt + ticket title/body) and a real tool-allowlist
      // policy instead of a blanket skip.
      //
      // `-p` (`--print`) puts Claude in non-interactive single-prompt
      // mode. Required: stream-json mode only emits in -p mode.
      //
      // `--output-format=stream-json` + `--include-partial-messages` +
      // `--verbose` makes Claude emit one JSON event per line as the
      // run progresses. This is the only reliable way to get real-time
      // output from `claude` on Windows — plain text mode with piped
      // stdout block-buffers via MSVCRT (4-8 KB chunks dumping at
      // exit). stream-json events flush per-emit. Each event is
      // `{type, ...}` (assistant deltas, tool calls, tool results); we
      // parse them in `handleStreamChunk` and project the human-
      // readable text back to OutputEvent lines so the existing line-
      // based marker scanner in workflow-runner keeps working
      // unchanged.
      //
      // Prompt: `/<skillName> <ticketKey>` is one logical argv slot.
      // `NodeSpawner` runs with `shell: true` (Windows `.cmd` shim
      // resolution via PATHEXT) and quotes args containing spaces
      // internally so cmd.exe / POSIX sh don't re-tokenize the prompt.
      child = this.spawner.spawn({
        command: this.command,
        args: [
          '-p',
          '--output-format=stream-json',
          '--include-partial-messages',
          '--verbose',
          '--dangerously-skip-permissions',
          `/${this.skillName} ${req.ticketKey}`,
        ],
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
    this.active.set(runId, activeRun);

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
    const active = this.active.get(runId);
    if (active === undefined) {
      return {
        ok: false,
        error: {
          code: 'NOT_RUNNING',
          message: `no active run with runId="${runId}"`,
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
    const active = this.active.get(req.runId);
    if (active === undefined) {
      return {
        ok: false,
        error: {
          code: 'NOT_RUNNING',
          message: `no active run with runId="${req.runId}"`,
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

  /**
   * Returns the FIRST in-flight run snapshot for back-compat with legacy
   * callers (#GH-79). Pre-PR-B this returned the lone active run; now it
   * returns the first inserted run. Plural callers should iterate via
   * the runner's `listActive()`.
   */
  status(): { runId: string; pid: number | undefined; startedAt: number } | null {
    if (this.active.size === 0) return null;
    const first = this.active.values().next().value;
    if (first === undefined) return null;
    return {
      runId: first.runId,
      pid: first.pid,
      startedAt: first.startedAt,
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
      const stripped = stripCarriageReturn(line);
      if (stream === 'stdout') {
        // stdout under `--output-format=stream-json` is one JSON event
        // per line. Project each event's human-readable text back into
        // line-shaped OutputEvents — re-splitting on internal newlines
        // because a single event (e.g. a tool_result with multi-line
        // output) can carry a multi-line payload that the rest of the
        // pipeline (marker scanner, run-log UI) wants as separate
        // lines. Non-JSON falls through verbatim, so plain-text mode
        // and unknown noise still work.
        emitJsonEventLines(stripped, (extracted) => {
          for (const sub of extracted.split('\n')) {
            this.emitOutput(run, stream, stripCarriageReturn(sub));
          }
        });
      } else {
        // stderr stays raw — Claude's stderr is human-readable warnings
        // and errors, not stream-json.
        this.emitOutput(run, stream, stripped);
      }
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

    // Remove this run from the active map BEFORE emitting (#GH-79). The
    // pre-PR-B comment said this was to avoid blocking listeners that
    // call run() from the exit handler; with the lock dropped the order
    // is no longer load-bearing, but we keep it stable so the map
    // reflects "post-exit reality" by the time subscribers run.
    this.active.delete(run.runId);

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
    if (run.exited || this.active.get(run.runId) !== run) {
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
