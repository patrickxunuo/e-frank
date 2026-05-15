/**
 * Claude CLI probe (#GH-85 Settings → Claude CLI section).
 *
 * Three responsibilities:
 *   1. Discover the `claude` binary via the OS' "find program in PATH"
 *      command (`where` on Windows, `which` on POSIX). Returns the first
 *      path printed; `null` if not found.
 *   2. Run `<binary> --version` and capture stdout, so the Settings UI
 *      can show e.g. "1.0.96 (Claude Code)" next to the resolved path.
 *   3. Validate an override path before persisting it to `appConfig.
 *      claudeCliPath`. Distinguishes between `PATH_NOT_FOUND` (file
 *      missing on disk), `NOT_EXECUTABLE` (file exists but `--version`
 *      crashed / exited non-zero), and `NOT_CLAUDE` (`--version` printed
 *      something that doesn't look like Claude CLI). The Settings UI
 *      reads the code to show the right message instead of a generic
 *      "validation failed".
 *
 * Stream-based `Spawner` is the only spawning primitive in this app, so
 * this module includes a small `runOnce` helper that accumulates
 * stdout/stderr until exit and resolves to `{stdout, stderr, exitCode}`.
 * Kept inside this module because no other call site needs it yet —
 * promote to its own helper if a second consumer shows up.
 */

import { access } from 'node:fs/promises';
import type { Spawner } from './spawner.js';

/** One-shot spawn timeout. `--version` is fast; anything slower is broken. */
const PROBE_TIMEOUT_MS = 3000;

/** Output stream accumulator. ChildProcess streams emit Buffer | string chunks. */
function readStream(
  stream: NodeJS.ReadableStream | null,
): { read: () => string; subscribe: () => void } {
  let buf = '';
  return {
    read(): string {
      return buf;
    },
    subscribe(): void {
      if (stream === null) return;
      stream.on('data', (chunk: Buffer | string) => {
        buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      });
    },
  };
}

export interface RunOnceResult {
  stdout: string;
  stderr: string;
  /** `null` when the process was killed by our timeout. */
  exitCode: number | null;
  /** True when our timeout fired before exit (we sent SIGTERM). */
  timedOut: boolean;
  /** True when the spawner emitted an `'error'` event (e.g. ENOENT). */
  spawnError: Error | null;
}

/**
 * Run a short-lived command, accumulate stdout+stderr, resolve on exit.
 * Kills the child on timeout. Exported for tests.
 */
export function runOnce(
  spawner: Spawner,
  command: string,
  args: ReadonlyArray<string>,
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<RunOnceResult> {
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  return new Promise<RunOnceResult>((resolve) => {
    let child;
    try {
      child = spawner.spawn({
        command,
        args,
        // `process.cwd()` is fine for probes — we never write here. Caller
        // can override (e.g. tests pinning to a tmpdir).
        cwd: opts.cwd ?? process.cwd(),
      });
    } catch (err) {
      resolve({
        stdout: '',
        stderr: '',
        exitCode: null,
        timedOut: false,
        spawnError: err instanceof Error ? err : new Error(String(err)),
      });
      return;
    }

    const stdout = readStream(child.stdout);
    const stderr = readStream(child.stderr);
    stdout.subscribe();
    stderr.subscribe();

    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore — exit handler will still fire (or, if it doesn't, the
        // `settled` guard below means we'll never resolve, but the
        // promise consumer can race against its own timeout).
      }
    }, timeoutMs);

    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: stdout.read(),
        stderr: stderr.read(),
        exitCode: code,
        timedOut,
        spawnError: null,
      });
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: stdout.read(),
        stderr: stderr.read(),
        exitCode: null,
        timedOut: false,
        spawnError: err,
      });
    });
  });
}

/**
 * Run `where claude` (win32) / `which claude` (posix) and return the first
 * line of stdout. `null` if the lookup command exits non-zero (= not on PATH).
 */
export async function discoverBinary(
  spawner: Spawner,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const finder = platform === 'win32' ? 'where' : 'which';
  const result = await runOnce(spawner, finder, ['claude']);
  if (result.spawnError !== null) return null;
  if (result.exitCode !== 0) return null;
  // `where` on Windows prints one path per line (multiple if claude.cmd
  // AND claude.ps1 etc both exist on PATH). Take the first.
  const first = result.stdout.split(/\r?\n/).map((s) => s.trim()).find((s) => s !== '');
  return first ?? null;
}

export interface ProbeVersionResult {
  /** Trimmed version string from stdout, or `null` if probe failed. */
  version: string | null;
  /** Raw `--version` stdout (used by validateOverride to test the "is it Claude?" regex). */
  rawOutput: string;
  /** Error code when probe failed; `null` on success. */
  error: 'NOT_EXECUTABLE' | null;
  /** Human-readable error message; `null` on success. */
  errorMessage: string | null;
}

/**
 * Run `<binaryPath> --version` and return the captured stdout. A non-zero
 * exit, a spawn error, or a timeout all map to `NOT_EXECUTABLE`.
 */
export async function probeVersion(
  spawner: Spawner,
  binaryPath: string,
): Promise<ProbeVersionResult> {
  const result = await runOnce(spawner, binaryPath, ['--version']);
  if (result.spawnError !== null) {
    return {
      version: null,
      rawOutput: '',
      error: 'NOT_EXECUTABLE',
      errorMessage: result.spawnError.message,
    };
  }
  if (result.timedOut) {
    return {
      version: null,
      rawOutput: result.stdout,
      error: 'NOT_EXECUTABLE',
      errorMessage: `--version timed out after ${PROBE_TIMEOUT_MS}ms`,
    };
  }
  if (result.exitCode !== 0) {
    return {
      version: null,
      rawOutput: result.stdout,
      error: 'NOT_EXECUTABLE',
      errorMessage: `--version exited with code ${result.exitCode}`,
    };
  }
  const trimmed = result.stdout.trim();
  return {
    version: trimmed === '' ? null : trimmed,
    rawOutput: trimmed,
    error: null,
    errorMessage: null,
  };
}

/** Looseness intentional — Anthropic may rephrase `--version` output across
 *  Claude Code releases. As long as the word "claude" appears anywhere in
 *  the output, we accept it. Tighter (e.g. `/^Claude Code/`) would break
 *  silently on future renames; looser (always-true) misses the "user pointed
 *  the runner at bash" case the validation gate exists to prevent. */
const LOOKS_LIKE_CLAUDE_REGEX = /claude/i;

/**
 * Defense-in-depth: reject shell metacharacters in the override path
 * before fs.access. The runner spawns with `shell: true`, so a path
 * like `claude & calc.exe` would chain. Mirrors the validator in
 * `src/shared/schema/app-config.ts`.
 */
// eslint-disable-next-line no-control-regex
const PATH_SHELL_UNSAFE_REGEX = /[;|&<>()$`*?~!"'%^\x00-\x1f]/;

export type OverrideErrorCode = 'PATH_NOT_FOUND' | 'NOT_EXECUTABLE' | 'NOT_CLAUDE';

export interface ValidateOverrideOk {
  ok: true;
  data: { resolvedPath: string; version: string };
}
export interface ValidateOverrideErr {
  ok: false;
  error: { code: OverrideErrorCode; message: string };
}
export type ValidateOverrideResult = ValidateOverrideOk | ValidateOverrideErr;

/**
 * Validation gate before persisting an override path. Three checks, in
 * order: file exists → executable + zero-exit `--version` → output
 * matches the loose "is it Claude" regex. Each failure maps to a distinct
 * code so the UI can show the right message.
 */
export async function validateOverride(
  spawner: Spawner,
  path: string,
): Promise<ValidateOverrideResult> {
  if (path.trim() === '') {
    return {
      ok: false,
      error: { code: 'PATH_NOT_FOUND', message: 'override path cannot be empty' },
    };
  }
  if (PATH_SHELL_UNSAFE_REGEX.test(path)) {
    return {
      ok: false,
      error: {
        code: 'PATH_NOT_FOUND',
        message: 'path contains characters that are unsafe to spawn',
      },
    };
  }
  try {
    await access(path);
  } catch {
    return {
      ok: false,
      error: { code: 'PATH_NOT_FOUND', message: `file does not exist: ${path}` },
    };
  }
  const probe = await probeVersion(spawner, path);
  if (probe.error === 'NOT_EXECUTABLE' || probe.version === null) {
    return {
      ok: false,
      error: {
        code: 'NOT_EXECUTABLE',
        message: probe.errorMessage ?? '--version did not return a version string',
      },
    };
  }
  if (!LOOKS_LIKE_CLAUDE_REGEX.test(probe.rawOutput)) {
    return {
      ok: false,
      error: {
        code: 'NOT_CLAUDE',
        message: `the binary's --version output does not look like Claude CLI: ${probe.rawOutput.slice(0, 120)}`,
      },
    };
  }
  return { ok: true, data: { resolvedPath: path, version: probe.version } };
}

export type ProbeSource = 'override' | 'path' | 'not-found';

export interface ProbeResult {
  resolvedPath: string | null;
  version: string | null;
  source: ProbeSource;
}

/**
 * The orchestrator the `claude-cli:probe` IPC handler calls. Reads the
 * configured override (if any), otherwise discovers via PATH, then runs
 * `--version`. Never throws — always returns a `ProbeResult`.
 */
export async function probe(
  spawner: Spawner,
  override: string | null,
): Promise<ProbeResult> {
  if (override !== null && override.trim() !== '') {
    // Override is present — try it, but don't fall back if it's broken;
    // that's the user's mistake and Settings UI surfaces it.
    try {
      await access(override);
    } catch {
      return { resolvedPath: override, version: null, source: 'override' };
    }
    const probed = await probeVersion(spawner, override);
    return {
      resolvedPath: override,
      version: probed.version,
      source: 'override',
    };
  }
  const found = await discoverBinary(spawner);
  if (found === null) {
    return { resolvedPath: null, version: null, source: 'not-found' };
  }
  const probed = await probeVersion(spawner, found);
  return {
    resolvedPath: found,
    version: probed.version,
    source: 'path',
  };
}
