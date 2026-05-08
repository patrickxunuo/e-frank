/**
 * Minimal facade over `child_process.spawn` so that the Claude process manager
 * can be unit-tested without spawning real processes.
 *
 * `NodeSpawner` is the production implementation that wraps `child_process.spawn`.
 * `FakeSpawner` is a test double that never spawns anything; tests drive its
 * `FakeSpawnedProcess` instances via `emitStdout`/`emitStderr`/`emitExit`/`emitError`.
 *
 * This file deliberately avoids any Electron imports — it is pure Node + tests.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';

export interface SpawnOptions {
  command: string;
  args: ReadonlyArray<string>;
  cwd: string;
  env?: Readonly<Record<string, string>>;
  /** Whether to use a shell. Required on Windows for .cmd shims. */
  shell?: boolean;
}

/**
 * Subset of `child_process.ChildProcess` that the manager actually uses.
 *
 * Keeping this narrow lets `FakeSpawner` be a small, well-defined object
 * instead of a full mock of Node's ChildProcess.
 */
export interface SpawnedProcess {
  // Optional (not `number | undefined` required) so this is structurally
  // assignable from `child_process.ChildProcess`, which declares `pid?: number`.
  readonly pid?: number;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  readonly stdin: NodeJS.WritableStream | null;
  readonly exitCode: number | null;
  readonly killed: boolean;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit', cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

/**
 * Abstraction over `child_process.spawn` so the manager is testable.
 */
export interface Spawner {
  spawn(options: SpawnOptions): SpawnedProcess;
}

/**
 * Real implementation — wraps `child_process.spawn`.
 *
 * `shell` defaults to `true` (per business rule 10 in the acceptance spec) so
 * Windows `.cmd` shims (like `claude.cmd`) resolve correctly. The arguments
 * we pass are controlled (ticketKey is regex-validated, cwd is path-only),
 * so command injection is not a concern at this layer.
 */
export class NodeSpawner implements Spawner {
  spawn(options: SpawnOptions): SpawnedProcess {
    const useShell = options.shell ?? true;
    const child = nodeSpawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv | undefined,
      shell: useShell,
      windowsHide: true,
    });
    return child;
  }
}

/**
 * Test-driven version of `SpawnedProcess`. Adds emit helpers so tests can
 * synthesize stdout/stderr chunks, exits, and spawn errors.
 */
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
  /** Test helper: the most recent signal passed to kill(). */
  readonly lastSignal: NodeJS.Signals | undefined;
}

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type ErrorListener = (err: Error) => void;

/**
 * Concrete fake. PassThrough streams are used for stdout/stderr so that
 * consumers can register `.on('data', ...)` exactly like a real ChildProcess.
 *
 * stdin captures every chunk written to it into the public `stdinWrites`
 * array, mirroring how tests inspect what the manager sent.
 */
class FakeSpawnedProcessImpl implements FakeSpawnedProcess {
  readonly pid: number | undefined;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly stdin: Writable;
  exitCode: number | null = null;
  killed = false;
  lastSignal: NodeJS.Signals | undefined = undefined;

  private readonly _stdinWrites: string[] = [];
  private readonly exitListeners: ExitListener[] = [];
  private readonly errorListeners: ErrorListener[] = [];

  constructor(pid: number) {
    this.pid = pid;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    const writes = this._stdinWrites;
    this.stdin = new Writable({
      write(chunk, _enc, cb): void {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        writes.push(text);
        cb();
      },
    });
  }

  get stdinWrites(): ReadonlyArray<string> {
    return this._stdinWrites;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.lastSignal = signal ?? 'SIGTERM';
    // Match Node's `ChildProcess.killed` semantics: the flag is set as soon as
    // a signal has been delivered, not when the process actually terminates.
    this.killed = true;
    return true;
  }

  on(event: 'exit', cb: ExitListener): void;
  on(event: 'error', cb: ErrorListener): void;
  on(event: 'exit' | 'error', cb: ExitListener | ErrorListener): void {
    if (event === 'exit') {
      this.exitListeners.push(cb as ExitListener);
    } else {
      this.errorListeners.push(cb as ErrorListener);
    }
  }

  emitStdout(chunk: string): void {
    this.stdout.write(chunk);
  }

  emitStderr(chunk: string): void {
    this.stderr.write(chunk);
  }

  emitExit(code: number | null, signal?: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.killed = true;
    const sig = signal ?? null;
    for (const listener of this.exitListeners) {
      listener(code, sig);
    }
  }

  emitError(err: Error): void {
    for (const listener of this.errorListeners) {
      listener(err);
    }
  }
}

/**
 * Test implementation — never spawns anything. Each call to `spawn()` creates
 * a fresh `FakeSpawnedProcess`, stores it in `lastSpawned`, and returns it.
 */
export class FakeSpawner implements Spawner {
  private _lastSpawned: FakeSpawnedProcessImpl | null = null;
  private _lastOptions: SpawnOptions | null = null;
  private nextPid = 10000;

  /** The most recent spawned fake. Tests use this to drive events. */
  get lastSpawned(): FakeSpawnedProcess | null {
    return this._lastSpawned;
  }

  /**
   * The options passed to the most recent `spawn()` call. Tests assert
   * against this when they need to verify the command + argv (e.g. that
   * the manager built a `/<skillName> <ticketKey>` prompt correctly).
   */
  get lastOptions(): SpawnOptions | null {
    return this._lastOptions;
  }

  spawn(options: SpawnOptions): FakeSpawnedProcess {
    this._lastOptions = options;
    const fake = new FakeSpawnedProcessImpl(this.nextPid++);
    this._lastSpawned = fake;
    return fake;
  }
}
