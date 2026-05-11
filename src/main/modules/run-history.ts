/**
 * RunHistory — persists which tickets are currently running per project, so
 * the poller can filter them out of the eligible-tickets list while a
 * workflow is in flight (prevents two concurrent runs on the same ticket).
 *
 * The persisted JSON used to also track "processed" tickets — keys whose
 * runs had completed at least once. The poller would hide them, on the
 * theory that you wouldn't want to re-run on the same ticket. That was
 * leaky semantics — the source of truth for "this ticket is done" lives
 * in Jira / GitHub (closed status, in-review label, etc.). The local
 * processed set was removed; the source-side state is now authoritative.
 *
 * For back-compat the persisted JSON may still contain a `processed`
 * array on older files. The init validator silently drops it.
 *
 * GH-13 — schema v2: each running entry is now `{ key, lockedAt }` where
 * `lockedAt` is the epoch ms when `markRunning` was called. The timestamp
 * powers stale-lock recovery: a desktop app that crashes mid-run leaves
 * its lock on disk, and the next launch must auto-release it (no in-process
 * runner is alive to clear it). `releaseStaleLocks(thresholdMs)` does the
 * sweep. Back-compat: v1 files (`running: string[]`) are read; entries get
 * stamped `lockedAt: 0` (sentinel meaning "definitely stale") so the next
 * `releaseStaleLocks(0)` removes them. The on-disk envelope is rewritten
 * as v2 on the next mutation. `getRunning(projectId)` keeps its
 * `ReadonlyArray<string>` signature so the poller's filter is untouched.
 *
 * Mirrors `SecretsManager` / `ProjectStore`:
 *   - schema-versioned envelope (`{ schemaVersion: 2, runs: { [projectId]: { running } } }`)
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
  /** Test injection. Defaults to `Date.now()`. */
  clock?: { now: () => number };
}

export type RunHistoryErrorCode =
  | 'IO_FAILURE'
  | 'CORRUPT'
  | 'UNSUPPORTED_SCHEMA_VERSION';

export type RunHistoryResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: RunHistoryErrorCode; message: string } };

/**
 * One running ticket lock. `lockedAt` is the epoch ms `markRunning` stamped
 * when the lock was acquired. `0` is a sentinel value used when migrating
 * from schema v1, where the timestamp wasn't recorded — such entries are
 * treated as "definitely stale" by `releaseStaleLocks`.
 */
export interface RunningLock {
  key: string;
  lockedAt: number;
}

interface ProjectRuns {
  running: RunningLock[];
}

interface RunHistoryEnvelope {
  schemaVersion: 2;
  runs: Record<string, ProjectRuns>;
}

/** Released-lock record returned by `releaseStaleLocks`. */
export interface ReleasedLock {
  projectId: string;
  key: string;
  lockedAt: number;
}

const SCHEMA_VERSION = 2;
/** Highest schema version we read from disk (v1 reads succeed and migrate). */
const SUPPORTED_READ_VERSIONS: ReadonlySet<number> = new Set([1, 2]);

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
  return { running: [] };
}

export class RunHistory {
  private readonly filePath: string;
  private readonly fs: ProjectStoreFs;
  private readonly clock: { now: () => number };

  private envelope: RunHistoryEnvelope = { schemaVersion: SCHEMA_VERSION, runs: {} };
  private initialized = false;

  /** Single-Promise write mutex. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: RunHistoryOptions) {
    this.filePath = options.filePath;
    this.fs = options.fs ?? defaultFs();
    this.clock = options.clock ?? { now: () => Date.now() };
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
      const schemaVersionRaw = parsed['schemaVersion'];
      if (typeof schemaVersionRaw !== 'number' || !SUPPORTED_READ_VERSIONS.has(schemaVersionRaw)) {
        return {
          ok: false,
          error: {
            code: 'UNSUPPORTED_SCHEMA_VERSION',
            message: `unsupported schemaVersion: expected one of [${[...SUPPORTED_READ_VERSIONS].join(', ')}], got ${String(schemaVersionRaw)}`,
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
        const runningRaw = value['running'];
        if (!Array.isArray(runningRaw)) {
          return {
            ok: false,
            error: {
              code: 'CORRUPT',
              message: `runs["${projectId}"].running must be an array`,
            },
          };
        }
        // v1: running is string[]. Each entry migrates to lockedAt=0 so the
        // next releaseStaleLocks(0) sweep removes them — pre-v2 timestamps
        // are unknowable, and any lock surviving an app restart on the old
        // schema is by definition orphaned.
        // v2: running is RunningLock[]. Validate per-entry shape.
        const migrated: RunningLock[] = [];
        for (const entry of runningRaw) {
          if (schemaVersionRaw === 1) {
            if (typeof entry !== 'string') {
              return {
                ok: false,
                error: {
                  code: 'CORRUPT',
                  message: `runs["${projectId}"].running must be a string[] on schemaVersion 1`,
                },
              };
            }
            migrated.push({ key: entry, lockedAt: 0 });
          } else {
            if (!isPlainObject(entry)) {
              return {
                ok: false,
                error: {
                  code: 'CORRUPT',
                  message: `runs["${projectId}"].running entries must be objects on schemaVersion 2`,
                },
              };
            }
            const keyRaw = entry['key'];
            const lockedAtRaw = entry['lockedAt'];
            if (typeof keyRaw !== 'string' || typeof lockedAtRaw !== 'number') {
              return {
                ok: false,
                error: {
                  code: 'CORRUPT',
                  message: `runs["${projectId}"].running entries must have string key + number lockedAt`,
                },
              };
            }
            migrated.push({ key: keyRaw, lockedAt: lockedAtRaw });
          }
        }
        // `processed` is intentionally not read — older files (pre-removal
        // of the local processed filter) may still carry the field; we
        // accept the file but silently drop the field on the next write.
        cleaned[projectId] = {
          running: migrated,
        };
      }

      // Always store as the current schema version — v1 reads are migrated
      // in-memory and rewritten as v2 on the next mutation.
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

  /**
   * Returns running keys for a project. Signature is preserved as
   * `ReadonlyArray<string>` so the poller's eligibility filter
   * (`new Set(getRunning(id))`) stays unchanged across the v2 schema bump.
   * Use `getRunningWithMetadata` when timestamps are needed.
   */
  getRunning(projectId: string): ReadonlyArray<string> {
    const runs = this.envelope.runs[projectId];
    if (runs === undefined) return [];
    return runs.running.map((entry) => entry.key);
  }

  /** Returns running lock entries with their lockedAt timestamps. */
  getRunningWithMetadata(projectId: string): ReadonlyArray<RunningLock> {
    const runs = this.envelope.runs[projectId];
    if (runs === undefined) return [];
    return runs.running.map((entry) => ({ ...entry }));
  }

  // -- Mutators ------------------------------------------------------------

  async markRunning(projectId: string, key: string): Promise<RunHistoryResult<void>> {
    const lockedAt = this.clock.now();
    return this.mutate((next) => {
      const project = ensureProject(next, projectId);
      if (project.running.some((entry) => entry.key === key)) {
        // Idempotent — no spurious write. We do NOT update the timestamp on
        // a re-mark, because the original `lockedAt` is the meaningful one
        // (the wall-clock moment when this lock was first acquired). If the
        // lock survived a crash, releaseStaleLocks owns deciding it's stale.
        return false;
      }
      project.running = [...project.running, { key, lockedAt }];
      return true;
    });
  }

  async clearRunning(projectId: string, key: string): Promise<RunHistoryResult<void>> {
    return this.mutate((next) => {
      const project = next.runs[projectId];
      if (project === undefined || !project.running.some((entry) => entry.key === key)) {
        return false;
      }
      project.running = project.running.filter((entry) => entry.key !== key);
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

  /**
   * Release every lock whose `lockedAt` is older than `now - thresholdMs`,
   * across all projects. Returns the released entries so callers can log /
   * surface them. Designed for app-startup recovery: at fresh process start,
   * no run can be in flight (single-process desktop app), so every persisted
   * lock is by definition orphaned and should be cleared. Call this AFTER
   * `init()`.
   *
   * `thresholdMs: 0` (the default) means "release everything", which is what
   * `initStores()` uses on boot. A non-zero threshold is reserved for future
   * use cases (e.g. a periodic janitor that prunes truly old locks while
   * leaving recent ones to a separate recovery path).
   *
   * `lockedAt: 0` entries (migrated from schema v1) are always released —
   * their original timestamp is unknowable, so they're definitively stale.
   */
  async releaseStaleLocks(
    thresholdMs: number = 0,
  ): Promise<RunHistoryResult<ReleasedLock[]>> {
    // A negative thresholdMs would push the cutoff into the future
    // (`cutoff = now - (-x) = now + x`) and release every lock, including
    // legitimately fresh ones. Clamp at 0 so the public API can't be
    // misused (e.g. a buggy computed threshold). The boot path passes 0,
    // which is documented to release everything.
    const safeThreshold = Math.max(0, thresholdMs);
    const now = this.clock.now();
    const cutoff = now - safeThreshold;
    const released: ReleasedLock[] = [];
    const writeRes = await this.mutate((next) => {
      let changed = false;
      for (const [projectId, project] of Object.entries(next.runs)) {
        const keep: RunningLock[] = [];
        for (const entry of project.running) {
          // `lockedAt <= cutoff` releases entries older than the threshold.
          // The v1-migrated `lockedAt: 0` sentinel always falls past any
          // realistic cutoff (cutoff is `now - thresholdMs`, so cutoff > 0
          // whenever now > thresholdMs, which is always true at runtime).
          if (entry.lockedAt <= cutoff) {
            released.push({ projectId, key: entry.key, lockedAt: entry.lockedAt });
          } else {
            keep.push(entry);
          }
        }
        if (keep.length !== project.running.length) {
          project.running = keep;
          changed = true;
        }
      }
      return changed;
    });
    if (!writeRes.ok) {
      return writeRes;
    }
    return { ok: true, data: released };
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
    out[k] = { running: v.running.map((entry) => ({ ...entry })) };
  }
  return out;
}
