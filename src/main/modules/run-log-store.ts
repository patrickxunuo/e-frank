/**
 * RunLogStore — append-only NDJSON persistence for streamed Claude output.
 *
 * One file per run: `runsDir/{runId}.log`. Each line is a JSON-serialized
 * `RunLogEntry`. Append-only — no rewrites, no atomic temp+rename. The
 * write surface is intentionally minimal (`appendFile` / `readFile` /
 * `mkdir`) so we can keep tests light and avoid the file-mutex machinery
 * RunStore needs for whole-file atomic writes.
 *
 * Reads parse line-by-line and SKIP malformed lines with a `console.warn`
 * (rule 9 in the spec): one bad write shouldn't poison the entire log.
 */

import { promises as fs } from 'node:fs';
import { posix as posixPath } from 'node:path';

// POSIX-joined paths to match RunStore's pattern. Node fs handles forward
// slashes on Windows fine; using OS-native `\` here would split-key the
// in-memory path map in tests.
const { join } = posixPath;

import type { RunLogEntry } from '../../shared/schema/run.js';

export interface RunLogStoreOptions {
  /** Absolute path to the directory holding per-run log files. */
  runsDir: string;
  fs?: RunLogStoreFs;
}

/**
 * Minimal fs surface for the log store. Append-only persistence doesn't
 * need rename / writeFile / readdir; `unlink` is needed for `delete()`,
 * which the run-delete IPC chains after dropping the JSON sidecar.
 */
export interface RunLogStoreFs {
  appendFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  mkdir(path: string, opts: { recursive: true }): Promise<void>;
  unlink(path: string): Promise<void>;
}

export type RunLogStoreErrorCode = 'IO_FAILURE' | 'NOT_FOUND' | 'CORRUPT';

export type RunLogStoreResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: RunLogStoreErrorCode; message: string } };

function defaultFs(): RunLogStoreFs {
  return {
    appendFile: (path, data, encoding) => fs.appendFile(path, data, encoding),
    readFile: (path, encoding) => fs.readFile(path, encoding),
    mkdir: (path, opts) => fs.mkdir(path, opts).then(() => undefined),
    unlink: (path) => fs.unlink(path),
  };
}

function isENOENT(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class RunLogStore {
  private readonly runsDir: string;
  private readonly fs: RunLogStoreFs;

  constructor(options: RunLogStoreOptions) {
    this.runsDir = options.runsDir;
    this.fs = options.fs ?? defaultFs();
  }

  /** Ensure `runsDir` exists (recursive mkdir). */
  async init(): Promise<RunLogStoreResult<void>> {
    try {
      await this.fs.mkdir(this.runsDir, { recursive: true });
      return { ok: true, data: undefined };
    } catch (err) {
      return { ok: false, error: { code: 'IO_FAILURE', message: errMessage(err) } };
    }
  }

  /**
   * Append a single entry as one NDJSON line. Atomic on POSIX for short
   * writes (kernel `O_APPEND` semantics); near-atomic on Windows (Win32's
   * append-mode write is also atomic for buffers smaller than the disk
   * cluster, which one log line is).
   */
  async appendLine(entry: RunLogEntry): Promise<RunLogStoreResult<void>> {
    const target = this.fileFor(entry.runId);
    const data = `${JSON.stringify(entry)}\n`;
    try {
      await this.fs.appendFile(target, data, 'utf8');
      return { ok: true, data: undefined };
    } catch (err) {
      return { ok: false, error: { code: 'IO_FAILURE', message: errMessage(err) } };
    }
  }

  /**
   * Drop the per-run log file. ENOENT is success (idempotent) — a run that
   * never produced output legitimately has no `.log` to remove. Any other
   * IO error surfaces, since the caller (run-delete IPC) wants to know if
   * a stray file was left behind.
   */
  async delete(runId: string): Promise<RunLogStoreResult<{ runId: string }>> {
    try {
      await this.fs.unlink(this.fileFor(runId));
      return { ok: true, data: { runId } };
    } catch (err) {
      if (isENOENT(err)) {
        return { ok: true, data: { runId } };
      }
      return { ok: false, error: { code: 'IO_FAILURE', message: errMessage(err) } };
    }
  }

  /**
   * Read every entry for a run. Missing log files resolve to an empty list
   * (a run that never produced output is a legitimate state). Malformed
   * NDJSON lines are skipped with a `console.warn` so a single bad write
   * doesn't poison the entire log.
   */
  async read(runId: string): Promise<RunLogStoreResult<RunLogEntry[]>> {
    let raw: string;
    try {
      raw = await this.fs.readFile(this.fileFor(runId), 'utf8');
    } catch (err) {
      if (isENOENT(err)) {
        return { ok: true, data: [] };
      }
      return { ok: false, error: { code: 'IO_FAILURE', message: errMessage(err) } };
    }

    const entries: RunLogEntry[] = [];
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined || line.length === 0) continue;
      try {
        const parsed = JSON.parse(line) as RunLogEntry;
        entries.push(parsed);
      } catch (err) {
        console.warn(
          `[run-log-store] skipping malformed line ${i} in "${runId}": ${errMessage(err)}`,
        );
      }
    }
    return { ok: true, data: entries };
  }

  // -- Internals ----------------------------------------------------------

  private fileFor(runId: string): string {
    return join(this.runsDir, `${runId}.log`);
  }
}
