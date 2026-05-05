/**
 * RunStore — per-run JSON sidecar persistence.
 *
 * Mirrors `secrets-manager.ts` + `run-history.ts` patterns:
 *   - schema-versioned envelope `{ schemaVersion: 1, run: <Run> }` per file
 *   - one file per run: `runsDir/{runId}.json`
 *   - atomic writes (temp + rename) so a crash mid-write can't leave a
 *     half-written file at the canonical path
 *   - single-Promise write mutex serializes concurrent saves so they don't
 *     clobber each other (e.g. two state transitions back-to-back, or a
 *     state-changed save racing with a final-cleanup save)
 *
 * Stores Run snapshots (NOT logs). Streaming raw stdout/stderr to a per-run
 * `.log` file is documented in the spec but lives in #8 — RunStore tracks
 * the structured Run state machine only.
 */

import { promises as fs } from 'node:fs';
import { posix as posixPath } from 'node:path';
import { randomUUID } from 'node:crypto';

// Use POSIX joining (forward slashes) regardless of OS so the path
// concatenation matches what the test MemFs and the real fs both accept.
// Node fs handles forward slashes on Windows fine; using OS-native `\` here
// would split-key the in-memory path map in tests.
const { dirname, join } = posixPath;
import type { ProjectStoreFs } from './project-store.js';
import type { Run } from '../../shared/schema/run.js';

export interface RunStoreOptions {
  /** Absolute path to the directory holding run sidecars. */
  runsDir: string;
  fs?: ProjectStoreFs;
}

export type RunStoreErrorCode =
  | 'IO_FAILURE'
  | 'CORRUPT'
  | 'NOT_FOUND'
  | 'UNSUPPORTED_SCHEMA_VERSION';

export type RunStoreResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: RunStoreErrorCode; message: string } };

interface RunEnvelope {
  schemaVersion: 1;
  run: Run;
}

const SCHEMA_VERSION = 1;

/**
 * Extended fs surface — RunStore needs `readdir` to enumerate per-run files
 * (plain `ProjectStoreFs` doesn't include it). We don't widen the shared
 * interface because the other stores never list a directory.
 */
export interface RunStoreFs extends ProjectStoreFs {
  readdir(path: string): Promise<string[]>;
}

function defaultFs(): RunStoreFs {
  return {
    readFile: (path, encoding) => fs.readFile(path, encoding),
    writeFile: (path, data, encoding) => fs.writeFile(path, data, encoding),
    rename: (from, to) => fs.rename(from, to),
    unlink: (path) => fs.unlink(path),
    mkdir: (path, opts) => fs.mkdir(path, opts).then(() => undefined),
    readdir: (path) => fs.readdir(path),
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
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

const DEFAULT_LIST_LIMIT = 50;

/**
 * RunStore — per-run JSON sidecar persistence with atomic writes + write
 * mutex. See module docstring for design rationale.
 */
export class RunStore {
  private readonly runsDir: string;
  private readonly fs: RunStoreFs;

  /** Single-Promise write mutex (mirrors SecretsManager / RunHistory). */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: RunStoreOptions) {
    this.runsDir = options.runsDir;
    // Widen if a `ProjectStoreFs` was passed without `readdir` — the default
    // shape does include it.
    const fsArg = options.fs as RunStoreFs | undefined;
    this.fs = fsArg ?? defaultFs();
  }

  /**
   * Ensures `runsDir` exists and returns the count of existing run files
   * (`*.json`, excluding `.tmp-*` partials).
   */
  async init(): Promise<RunStoreResult<{ count: number }>> {
    return this.enqueue(async () => {
      try {
        await this.fs.mkdir(this.runsDir, { recursive: true });
      } catch (err) {
        return { ok: false, error: { code: 'IO_FAILURE', message: errMessage(err) } };
      }
      let entries: string[];
      try {
        entries = await this.fs.readdir(this.runsDir);
      } catch (err) {
        if (isENOENT(err)) {
          return { ok: true, data: { count: 0 } };
        }
        return { ok: false, error: { code: 'IO_FAILURE', message: errMessage(err) } };
      }
      const count = entries.filter(
        (name) => name.endsWith('.json') && !name.includes('.tmp-'),
      ).length;
      return { ok: true, data: { count } };
    });
  }

  /**
   * Persist a run snapshot atomically (temp + rename). Routed through the
   * write mutex so concurrent saves serialize.
   */
  async save(run: Run): Promise<RunStoreResult<{ runId: string }>> {
    return this.enqueue(async () => {
      const envelope: RunEnvelope = { schemaVersion: SCHEMA_VERSION, run };
      const target = this.fileFor(run.id);
      const writeRes = await this.atomicWrite(target, envelope);
      if (!writeRes.ok) {
        return writeRes;
      }
      return { ok: true, data: { runId: run.id } };
    });
  }

  /**
   * Read a single run by id. Reads bypass the mutex — they don't write any
   * shared state and an in-flight save will land atomically via rename so
   * the read either sees the old or new file, never a half-written one.
   */
  async get(runId: string): Promise<RunStoreResult<Run>> {
    let raw: string;
    try {
      raw = await this.fs.readFile(this.fileFor(runId), 'utf8');
    } catch (err) {
      if (isENOENT(err)) {
        return {
          ok: false,
          error: { code: 'NOT_FOUND', message: `no run with id "${runId}"` },
        };
      }
      return { ok: false, error: { code: 'IO_FAILURE', message: errMessage(err) } };
    }

    return this.parseEnvelope(raw, runId);
  }

  /**
   * List runs for a project, newest-first, capped at `limit` (default 50).
   * Per-file errors are skipped (logged) so one corrupt sidecar doesn't
   * crash the whole list; the runner-history equivalent for the user is
   * an incomplete history rather than no history at all.
   */
  async list(projectId: string, limit?: number): Promise<RunStoreResult<Run[]>> {
    let entries: string[];
    try {
      entries = await this.fs.readdir(this.runsDir);
    } catch (err) {
      if (isENOENT(err)) {
        // Directory hasn't been initialized — treat as empty.
        return { ok: true, data: [] };
      }
      return { ok: false, error: { code: 'IO_FAILURE', message: errMessage(err) } };
    }

    const runs: Run[] = [];
    for (const name of entries) {
      if (!name.endsWith('.json') || name.includes('.tmp-')) continue;
      const runId = name.slice(0, -'.json'.length);
      const res = await this.get(runId);
      if (!res.ok) {
        // Per-file read errors are best-effort — skip and continue. A
        // CORRUPT or UNSUPPORTED_SCHEMA_VERSION shouldn't poison the list.

        console.warn(
          `[run-store] skipping "${name}" during list: ${res.error.code} - ${res.error.message}`,
        );
        continue;
      }
      if (res.data.projectId === projectId) {
        runs.push(res.data);
      }
    }

    runs.sort((a, b) => b.startedAt - a.startedAt);
    const cap = limit ?? DEFAULT_LIST_LIMIT;
    return { ok: true, data: runs.slice(0, cap) };
  }

  // -- Internals -----------------------------------------------------------

  private fileFor(runId: string): string {
    return join(this.runsDir, `${runId}.json`);
  }

  private parseEnvelope(raw: string, runId: string): RunStoreResult<Run> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return {
        ok: false,
        error: { code: 'CORRUPT', message: `run "${runId}" is not valid JSON: ${errMessage(err)}` },
      };
    }
    if (!isPlainObject(parsed)) {
      return {
        ok: false,
        error: { code: 'CORRUPT', message: `run "${runId}" envelope must be an object` },
      };
    }
    if (parsed['schemaVersion'] !== SCHEMA_VERSION) {
      return {
        ok: false,
        error: {
          code: 'UNSUPPORTED_SCHEMA_VERSION',
          message: `unsupported schemaVersion: expected ${SCHEMA_VERSION}, got ${String(parsed['schemaVersion'])}`,
        },
      };
    }
    const run = parsed['run'];
    if (!isPlainObject(run)) {
      return {
        ok: false,
        error: { code: 'CORRUPT', message: `run "${runId}" envelope.run must be an object` },
      };
    }
    // Light shape check — full domain validation is over-engineered for a
    // sidecar produced by our own writer. We trust the envelope.
    if (typeof run['id'] !== 'string' || typeof run['projectId'] !== 'string') {
      return {
        ok: false,
        error: { code: 'CORRUPT', message: `run "${runId}" missing id / projectId` },
      };
    }
    return { ok: true, data: run as unknown as Run };
  }

  private enqueue<T>(op: () => Promise<RunStoreResult<T>>): Promise<RunStoreResult<T>> {
    let resolveOuter!: (v: RunStoreResult<T>) => void;
    const outer = new Promise<RunStoreResult<T>>((r) => {
      resolveOuter = r;
    });
    this.writeChain = this.writeChain.then(async () => {
      try {
        const res = await op();
        resolveOuter(res);
      } catch (err) {
        resolveOuter({
          ok: false,
          error: { code: 'IO_FAILURE', message: errMessage(err) },
        });
      }
    });
    return outer;
  }

  private async atomicWrite(target: string, envelope: RunEnvelope): Promise<RunStoreResult<void>> {
    try {
      await this.fs.mkdir(dirname(target), { recursive: true });
    } catch (err) {
      return { ok: false, error: { code: 'IO_FAILURE', message: errMessage(err) } };
    }
    const tmp = `${target}.tmp-${randomUUID()}`;
    try {
      await this.fs.writeFile(tmp, JSON.stringify(envelope, null, 2), 'utf8');
    } catch (err) {
      return { ok: false, error: { code: 'IO_FAILURE', message: errMessage(err) } };
    }
    try {
      await this.fs.rename(tmp, target);
    } catch (err) {
      try {
        await this.fs.unlink(tmp);
      } catch {
        // ignore
      }
      return { ok: false, error: { code: 'IO_FAILURE', message: errMessage(err) } };
    }
    return { ok: true, data: undefined };
  }
}
