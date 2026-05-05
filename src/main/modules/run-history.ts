/**
 * RunHistory — persists which Jira tickets are "running" or "processed" per
 * project, so the poller can filter them out of the eligible-tickets list.
 *
 * Mirrors `SecretsManager` / `ProjectStore`:
 *   - schema-versioned envelope (`{ schemaVersion: 1, runs: { [projectId]: { processed, running } } }`)
 *   - atomic writes (temp + rename)
 *   - single-Promise write mutex
 *   - mutators guard on `initialized` (refuse to clobber an unread file)
 *   - getters are sync and return `[]` on uninitialized state — the poller
 *     consults them on every tick and we don't want to await per-tick
 *
 * Plain JSON; no encryption (no secrets here, just ticket keys).
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProjectStoreFs } from './project-store.js';

export interface RunHistoryOptions {
  /** Absolute path to run-history.json. */
  filePath: string;
  fs?: ProjectStoreFs;
}

export type RunHistoryErrorCode =
  | 'IO_FAILURE'
  | 'CORRUPT'
  | 'UNSUPPORTED_SCHEMA_VERSION';

export type RunHistoryResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: RunHistoryErrorCode; message: string } };

interface ProjectRuns {
  processed: string[];
  running: string[];
}

interface RunHistoryEnvelope {
  schemaVersion: 1;
  runs: Record<string, ProjectRuns>;
}

const SCHEMA_VERSION = 1;

function defaultFs(): ProjectStoreFs {
  return {
    readFile: (path, encoding) => fs.readFile(path, encoding),
    writeFile: (path, data, encoding) => fs.writeFile(path, data, encoding),
    rename: (from, to) => fs.rename(from, to),
    unlink: (path) => fs.unlink(path),
    mkdir: (path, opts) => fs.mkdir(path, opts).then(() => undefined),
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

function emptyProjectRuns(): ProjectRuns {
  return { processed: [], running: [] };
}

export class RunHistory {
  private readonly filePath: string;
  private readonly fs: ProjectStoreFs;

  private envelope: RunHistoryEnvelope = { schemaVersion: SCHEMA_VERSION, runs: {} };
  private initialized = false;

  /** Single-Promise write mutex. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: RunHistoryOptions) {
    this.filePath = options.filePath;
    this.fs = options.fs ?? defaultFs();
  }

  /**
   * Reads the file (or initializes empty if missing). Idempotent — calling
   * twice is a no-op after the first successful run. Routed through the
   * mutex so it can't race with an in-flight mutation.
   */
  async init(): Promise<RunHistoryResult<{ projectCount: number }>> {
    return this.enqueue(async () => {
      if (this.initialized) {
        return {
          ok: true,
          data: { projectCount: Object.keys(this.envelope.runs).length },
        };
      }

      let raw: string;
      try {
        raw = await this.fs.readFile(this.filePath, 'utf8');
      } catch (err) {
        if (isENOENT(err)) {
          this.envelope = { schemaVersion: SCHEMA_VERSION, runs: {} };
          this.initialized = true;
          return { ok: true, data: { projectCount: 0 } };
        }
        return { ok: false, error: { code: 'IO_FAILURE', message: errMessage(err) } };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'CORRUPT',
            message: `run-history file is not valid JSON: ${errMessage(err)}`,
          },
        };
      }

      if (!isPlainObject(parsed)) {
        return {
          ok: false,
          error: { code: 'CORRUPT', message: 'run-history file root must be an object' },
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
      const runsRaw = parsed['runs'];
      if (!isPlainObject(runsRaw)) {
        return {
          ok: false,
          error: { code: 'CORRUPT', message: 'runs must be an object' },
        };
      }

      const cleaned: Record<string, ProjectRuns> = {};
      for (const [projectId, value] of Object.entries(runsRaw)) {
        if (!isPlainObject(value)) {
          return {
            ok: false,
            error: { code: 'CORRUPT', message: `runs["${projectId}"] must be an object` },
          };
        }
        const processed = value['processed'];
        const running = value['running'];
        if (!Array.isArray(processed) || !processed.every((k) => typeof k === 'string')) {
          return {
            ok: false,
            error: {
              code: 'CORRUPT',
              message: `runs["${projectId}"].processed must be a string[]`,
            },
          };
        }
        if (!Array.isArray(running) || !running.every((k) => typeof k === 'string')) {
          return {
            ok: false,
            error: {
              code: 'CORRUPT',
              message: `runs["${projectId}"].running must be a string[]`,
            },
          };
        }
        cleaned[projectId] = {
          processed: [...processed],
          running: [...running],
        };
      }

      this.envelope = { schemaVersion: SCHEMA_VERSION, runs: cleaned };
      this.initialized = true;
      return { ok: true, data: { projectCount: Object.keys(cleaned).length } };
    });
  }

  // -- Sync getters --------------------------------------------------------
  //
  // These read the in-memory state and return `[]` if the project is unknown
  // (or if init() hasn't been called yet). The poller consults them on every
  // tick and we don't want to await per-tick — the price is that pre-init
  // reads see an empty store, which is a safe default.

  /** Returns processed keys for a project (empty array if none). */
  getProcessed(projectId: string): ReadonlyArray<string> {
    const runs = this.envelope.runs[projectId];
    if (runs === undefined) return [];
    return runs.processed;
  }

  /** Returns running keys for a project. */
  getRunning(projectId: string): ReadonlyArray<string> {
    const runs = this.envelope.runs[projectId];
    if (runs === undefined) return [];
    return runs.running;
  }

  // -- Mutators ------------------------------------------------------------

  async markRunning(projectId: string, key: string): Promise<RunHistoryResult<void>> {
    return this.mutate((next) => {
      const project = ensureProject(next, projectId);
      if (project.running.includes(key)) {
        // Idempotent — no spurious write.
        return false;
      }
      project.running = [...project.running, key];
      return true;
    });
  }

  async clearRunning(projectId: string, key: string): Promise<RunHistoryResult<void>> {
    return this.mutate((next) => {
      const project = next.runs[projectId];
      if (project === undefined || !project.running.includes(key)) {
        return false;
      }
      project.running = project.running.filter((k) => k !== key);
      return true;
    });
  }

  async markProcessed(projectId: string, key: string): Promise<RunHistoryResult<void>> {
    return this.mutate((next) => {
      const project = ensureProject(next, projectId);
      if (project.processed.includes(key)) {
        return false;
      }
      project.processed = [...project.processed, key];
      // Marking processed implicitly clears running for the same key — this
      // matches the workflow where a ticket finishes a Claude run and gets
      // archived. (Spec rule 1: a ticket should be eligible iff !processed
      // AND !running; once processed, running is irrelevant anyway.)
      if (project.running.includes(key)) {
        project.running = project.running.filter((k) => k !== key);
      }
      return true;
    });
  }

  /** Removes all history for a project (cascade from project deletion). */
  async removeProject(projectId: string): Promise<RunHistoryResult<void>> {
    return this.mutate((next) => {
      if (!(projectId in next.runs)) {
        return false;
      }
      // `next.runs` was deep-cloned by `mutate`, so it's safe to mutate here.
      delete next.runs[projectId];
      return true;
    });
  }

  // -- Internals -----------------------------------------------------------

  /**
   * Produce a working copy of the envelope, hand it to `apply`, and write it
   * out atomically iff `apply` returned `true` (meaning something changed).
   * No-op writes (idempotent calls) skip the disk hit entirely.
   */
  private mutate(
    apply: (next: RunHistoryEnvelope) => boolean,
  ): Promise<RunHistoryResult<void>> {
    return this.enqueue(async () => {
      if (!this.initialized) {
        return {
          ok: false,
          error: {
            code: 'IO_FAILURE',
            message: 'init() not called or init failed; refusing to mutate',
          },
        };
      }
      // Deep-clone the envelope so the apply callback can mutate freely.
      const next: RunHistoryEnvelope = {
        schemaVersion: SCHEMA_VERSION,
        runs: cloneRuns(this.envelope.runs),
      };
      const changed = apply(next);
      if (!changed) {
        // Idempotent — nothing to write.
        return { ok: true, data: undefined };
      }
      const writeRes = await this.atomicWrite(next);
      if (!writeRes.ok) {
        return writeRes;
      }
      this.envelope = next;
      return { ok: true, data: undefined };
    });
  }

  private enqueue<T>(op: () => Promise<RunHistoryResult<T>>): Promise<RunHistoryResult<T>> {
    let resolveOuter!: (v: RunHistoryResult<T>) => void;
    const outer = new Promise<RunHistoryResult<T>>((r) => {
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

  private async atomicWrite(envelope: RunHistoryEnvelope): Promise<RunHistoryResult<void>> {
    try {
      await this.fs.mkdir(dirname(this.filePath), { recursive: true });
    } catch (err) {
      return { ok: false, error: { code: 'IO_FAILURE', message: errMessage(err) } };
    }
    const tmp = `${this.filePath}.tmp-${randomUUID()}`;
    try {
      await this.fs.writeFile(tmp, JSON.stringify(envelope, null, 2), 'utf8');
    } catch (err) {
      return { ok: false, error: { code: 'IO_FAILURE', message: errMessage(err) } };
    }
    try {
      await this.fs.rename(tmp, this.filePath);
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

function ensureProject(env: RunHistoryEnvelope, projectId: string): ProjectRuns {
  let project = env.runs[projectId];
  if (project === undefined) {
    project = emptyProjectRuns();
    env.runs[projectId] = project;
  }
  return project;
}

function cloneRuns(runs: Record<string, ProjectRuns>): Record<string, ProjectRuns> {
  const out: Record<string, ProjectRuns> = {};
  for (const [k, v] of Object.entries(runs)) {
    out[k] = { processed: [...v.processed], running: [...v.running] };
  }
  return out;
}
