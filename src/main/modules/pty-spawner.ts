/**
 * PtySpawner — `Spawner` implementation that runs the child inside a
 * pseudo-terminal via `node-pty`.
 *
 * Why a PTY instead of `child_process.spawn`:
 *   When Claude is spawned via plain `child_process.spawn`, its stdout
 *   is a pipe — `isatty(stdout)` returns `false` — and glibc/MSVCRT
 *   switch to *block* buffering (~4-8 KB). A long-running Claude
 *   session sits silent for minutes and then dumps everything at exit.
 *   Two real consequences:
 *     1. UX: e-frank's UI shows "no output yet" for the entire run.
 *     2. Correctness: the `<<<EF_APPROVAL_REQUEST>>>` marker is buffered
 *        too — the runner never sees it mid-run, the ApprovalPanel
 *        never appears, and interactive-mode plan review silently
 *        no-ops.
 *
 *   A PTY makes Claude's stdout look like a real terminal, so its C
 *   runtime stays *line*-buffered. Each line flushes immediately.
 *
 * Stream model:
 *   PTYs merge stdout and stderr into one stream (it's how a real
 *   terminal works). `PtySpawnedProcess` exposes everything on
 *   `stdout`; `stderr` is an empty `PassThrough` for interface
 *   compatibility (no consumer of the existing `Spawner` ever
 *   distinguishes the two for Claude — both feed the line-splitter
 *   in `ClaudeProcessManager`). The line-handler treats every line as
 *   `stream: 'stdout'`. We lose the stream distinction but keep all
 *   the lines, and Claude's stderr is never structurally interesting
 *   anyway (just the occasional warning).
 *
 * Cancel + kill semantics:
 *   `IPty.kill(signal?)` sends a signal on POSIX and a hard kill on
 *   Windows (no real signal concept). Mirrors what
 *   `ClaudeProcessManager` already expects from `child.kill()`.
 *
 * Fallback:
 *   `node-pty` is a native module — if its prebuilt binary isn't
 *   available for the host's Node ABI / Electron version, `import`
 *   throws. The factory `tryCreatePtySpawner()` lets the caller catch
 *   that and degrade gracefully back to `NodeSpawner` (slow output but
 *   still functional).
 */

import { PassThrough, Writable } from 'node:stream';
import type {
  Spawner,
  SpawnedProcess,
  SpawnOptions,
} from './spawner.js';

// node-pty's IPty interface (subset we use). Inlined to avoid coupling
// the type at module load time.
interface IPty {
  pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  kill(signal?: string): void;
  resize(cols: number, rows: number): void;
}

interface PtyModule {
  spawn(
    file: string,
    args: string[] | string,
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      useConpty?: boolean;
    },
  ): IPty;
}

type ExitListener = (
  code: number | null,
  signal: NodeJS.Signals | null,
) => void;
type ErrorListener = (err: Error) => void;

/**
 * Wraps an `IPty` in our `SpawnedProcess` shape so `ClaudeProcessManager`
 * doesn't need to know whether it's talking to a piped child or a PTY
 * child.
 */
class PtySpawnedProcess implements SpawnedProcess {
  readonly pid: number | undefined;
  readonly stdout: PassThrough;
  /** Empty PassThrough — PTYs merge stdout+stderr; we route everything to stdout. */
  readonly stderr: PassThrough;
  readonly stdin: Writable;
  exitCode: number | null = null;
  killed = false;

  private readonly pty: IPty;
  private readonly exitListeners: ExitListener[] = [];
  // `error` listeners exist for parity with ChildProcess. node-pty doesn't
  // surface a synchronous spawn-error event — failures during ipty.spawn
  // throw, caught by `PtySpawner.spawn` and converted to a thrown Error
  // (which `ClaudeProcessManager` already maps to SPAWN_FAILED). So this
  // array is unused in practice but kept so the interface stays
  // structurally compatible with `child_process.ChildProcess`.
  private readonly errorListeners: ErrorListener[] = [];

  constructor(pty: IPty) {
    this.pty = pty;
    this.pid = pty.pid;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = new Writable({
      write: (chunk, _enc, cb): void => {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        try {
          this.pty.write(text);
          cb();
        } catch (err) {
          cb(err instanceof Error ? err : new Error(String(err)));
        }
      },
    });

    pty.onData((data) => {
      this.stdout.write(data);
    });

    pty.onExit(({ exitCode, signal }) => {
      this.exitCode = exitCode;
      // node-pty reports `signal` as a numeric code on POSIX (or 0/undefined
      // on Windows). Convert to a `NodeJS.Signals` string when we can; pass
      // null otherwise. The line-handling code in ClaudeProcessManager
      // already treats `signal: null` as "exited normally."
      const sigStr = typeof signal === 'number' && signal !== 0
        ? signalNumberToName(signal)
        : null;
      // Mark killed if we got a signal — mirrors child_process semantics
      // (.killed flips true once the subprocess receives a kill signal).
      if (sigStr !== null) this.killed = true;
      // End the stream so any buffered listeners flush before the exit
      // event fires; matches child_process behavior.
      this.stdout.end();
      for (const l of this.exitListeners) {
        l(exitCode, sigStr);
      }
    });
  }

  kill(signal?: NodeJS.Signals): boolean {
    try {
      this.pty.kill(signal);
      this.killed = true;
      return true;
    } catch {
      return false;
    }
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
}

/**
 * Best-effort POSIX signal-number → name conversion. Covers the signals
 * the runner actually surfaces (TERM/KILL/INT/HUP). Anything else falls
 * through to null and the consumer treats the exit as "exited normally
 * with the reported code."
 */
function signalNumberToName(num: number): NodeJS.Signals | null {
  switch (num) {
    case 1:
      return 'SIGHUP';
    case 2:
      return 'SIGINT';
    case 9:
      return 'SIGKILL';
    case 15:
      return 'SIGTERM';
    default:
      return null;
  }
}

/**
 * Spawner that runs the child inside a PTY. Constructed via
 * `tryCreatePtySpawner()` so the native dep can fail to load gracefully.
 */
export class PtySpawner implements Spawner {
  private readonly pty: PtyModule;

  constructor(pty: PtyModule) {
    this.pty = pty;
  }

  spawn(options: SpawnOptions): SpawnedProcess {
    // PTY doesn't go through cmd.exe / sh — it spawns the binary
    // directly inside a pseudo-terminal. Each arg in `options.args` is
    // passed verbatim as one argv element, so no shell-quoting is
    // needed (and would actually be harmful — quotes would become
    // literal characters in the argv).
    //
    // node-pty's PATH lookup handles `.cmd` shims on Windows via ConPTY.
    const ipty = this.pty.spawn(options.command, [...options.args], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: options.cwd,
      env: (options.env as NodeJS.ProcessEnv | undefined) ?? process.env,
    });
    return new PtySpawnedProcess(ipty);
  }
}

/**
 * Try to load `node-pty` and construct a `PtySpawner`. Returns `null`
 * on failure — the caller (main/index.ts) falls back to `NodeSpawner`,
 * trading live-streaming output for "at least the runner doesn't
 * crash on a bad install."
 *
 * The dynamic require sidesteps two issues:
 *   - Vitest test runs that don't need PTY (FakeSpawner is the only
 *     spawner used in tests) shouldn't pay the native-load cost.
 *   - If `electron-rebuild` hasn't been run (or failed), the import
 *     throws — we want to log + fall back, not bring down the app.
 */
export async function tryCreatePtySpawner(): Promise<PtySpawner | null> {
  try {
    // Use `import()` so the bundler treats this as a runtime dep and
    // tests/dev modes that never call this function don't attempt to
    // load the native binding.
    const mod = (await import('node-pty')) as unknown as PtyModule | { default: PtyModule };
    const pty = 'default' in mod ? mod.default : mod;
    if (typeof pty.spawn !== 'function') {
      throw new Error('node-pty default export missing `spawn`');
    }
    return new PtySpawner(pty);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[pty-spawner] node-pty unavailable, falling back to piped spawn: ${message}. ` +
        `Live output streaming will be slow (Claude buffers stdout when not on a TTY).`,
    );
    return null;
  }
}
