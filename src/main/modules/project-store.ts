/**
 * ProjectStore — persists `ProjectInstance` records to a JSON file under
 * `app.getPath('userData')` with atomic writes and a write mutex.
 *
 * File envelope:
 *   { schemaVersion: 1, projects: ProjectInstance[] }
 *
 * As of #25 the store does NOT cascade-delete secrets — secrets belong to
 * Connections (issue #24), not projects. Validation runs through the
 * schema's hand-rolled validator; the store assigns id / createdAt /
 * updatedAt itself.
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  validateProjectInstance,
  validateProjectInstanceInput,
  type ProjectInstance,
  type ValidationError,
} from '../../shared/schema/project-instance.js';

// -- fs surface -------------------------------------------------------------

/**
 * Minimal fs surface used by the store — abstracted for testability.
 * `SecretsManager` reuses this same shape.
 */
export interface ProjectStoreFs {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  mkdir(path: string, opts: { recursive: true }): Promise<void>;
}

function defaultFs(): ProjectStoreFs {
  return {
    readFile: (path, encoding) => fs.readFile(path, encoding),
    writeFile: (path, data, encoding) => fs.writeFile(path, data, encoding),
    rename: (from, to) => fs.rename(from, to),
    unlink: (path) => fs.unlink(path),
    mkdir: (path, opts) => fs.mkdir(path, opts).then(() => undefined),
  };
}

// -- Public types -----------------------------------------------------------

export interface ProjectStoreOptions {
  /** Absolute path to projects.json. */
  filePath: string;
  /** Override fs for tests. Defaults to node:fs/promises. */
  fs?: ProjectStoreFs;
}

export type StoreErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'FILE_CORRUPT'
  | 'IO_FAILURE'
  | 'RECOVERED_INCOMPATIBLE';

export type StoreResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: { code: StoreErrorCode; message: string; details?: ValidationError[] };
    };

interface StoreEnvelope {
  schemaVersion: 1;
  projects: ProjectInstance[];
}

const SCHEMA_VERSION = 1;

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

function notInitialized<T>(): StoreResult<T> {
  return {
    ok: false,
    error: {
      code: 'IO_FAILURE',
      message: 'init() not called or init failed; refusing to mutate',
    },
  };
}

// -- Class ------------------------------------------------------------------

export class ProjectStore {
  private readonly filePath: string;
  private readonly fs: ProjectStoreFs;

  private envelope: StoreEnvelope = { schemaVersion: SCHEMA_VERSION, projects: [] };
  private initialized = false;

  /** Single-Promise mutex chain (mirrors SecretsManager). */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: ProjectStoreOptions) {
    this.filePath = options.filePath;
    this.fs = options.fs ?? defaultFs();
  }

  /**
   * Reads the file (or initializes empty if missing). MUST be called once
   * before any CRUD operation. Idempotent.
   *
   * **Recovery from incompatible files (since #25 schema break):** when the
   * existing projects.json fails JSON parse, root-shape, schemaVersion, or
   * per-project validation, we DON'T fail closed. Instead the original
   * file is renamed to `projects.json.bak-{ts}` and the store starts with
   * an empty envelope. The result still resolves `ok: true` so the rest
   * of main process wiring doesn't bail, but `data.recoveredFrom` is set
   * so the renderer can surface a banner. Pre-MVP this is the safe call —
   * users are guaranteed to be able to keep using the app, the old data
   * is preserved on disk for inspection, and the schema break doesn't
   * brick the app.
   */
  async init(): Promise<StoreResult<{ count: number; recoveredFrom?: string }>> {
    return this.enqueue<{ count: number; recoveredFrom?: string }>(async () => {
      if (this.initialized) {
        return { ok: true, data: { count: this.envelope.projects.length } };
      }

      let raw: string;
      try {
        raw = await this.fs.readFile(this.filePath, 'utf8');
      } catch (err) {
        if (isENOENT(err)) {
          this.envelope = { schemaVersion: SCHEMA_VERSION, projects: [] };
          this.initialized = true;
          return { ok: true, data: { count: 0 } };
        }
        return { ok: false, error: { code: 'IO_FAILURE', message: errMessage(err) } };
      }

      // Inner parse: returns the parsed envelope or a typed reason.
      const parseResult = this.parseEnvelope(raw);
      if (parseResult.ok) {
        this.envelope = parseResult.envelope;
        this.initialized = true;
        return { ok: true, data: { count: parseResult.envelope.projects.length } };
      }

      // Recovery path: archive the incompatible file and start empty.
      const reason = parseResult.reason;
      try {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = `${this.filePath}.bak-${ts}`;
        await this.fs.rename(this.filePath, backupPath);
        console.warn(
          `[project-store] projects file at "${this.filePath}" is incompatible (${reason}); archived to "${backupPath}" and starting fresh`,
        );
        this.envelope = { schemaVersion: SCHEMA_VERSION, projects: [] };
        this.initialized = true;
        return {
          ok: true,
          data: { count: 0, recoveredFrom: backupPath },
        };
      } catch (renameErr) {
        // If we can't even rename, return a hard error so the user sees
        // it and can intervene manually.
        return {
          ok: false,
          error: {
            code: 'IO_FAILURE',
            message: `incompatible projects file (${reason}); failed to archive: ${errMessage(renameErr)}`,
          },
        };
      }
    });
  }

  /**
   * Parse + validate the envelope text. Returns `ok: true` with the
   * envelope on success, or `ok: false` with a short reason for the
   * recovery path.
   */
  private parseEnvelope(
    raw: string,
  ): { ok: true; envelope: StoreEnvelope } | { ok: false; reason: string } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { ok: false, reason: `not valid JSON: ${errMessage(err)}` };
    }
    if (!isPlainObject(parsed)) {
      return { ok: false, reason: 'root must be an object' };
    }
    if (parsed['schemaVersion'] !== SCHEMA_VERSION) {
      return {
        ok: false,
        reason: `unsupported schemaVersion: expected ${SCHEMA_VERSION}, got ${String(parsed['schemaVersion'])}`,
      };
    }
    const projectsRaw = parsed['projects'];
    if (!Array.isArray(projectsRaw)) {
      return { ok: false, reason: 'projects must be an array' };
    }
    const projects: ProjectInstance[] = [];
    for (let i = 0; i < projectsRaw.length; i++) {
      const res = validateProjectInstance(projectsRaw[i]);
      if (!res.ok) {
        return { ok: false, reason: `projects[${i}] failed schema validation` };
      }
      projects.push(res.value);
    }
    return { ok: true, envelope: { schemaVersion: SCHEMA_VERSION, projects } };
  }

  async list(): Promise<StoreResult<ProjectInstance[]>> {
    if (!this.initialized) return notInitialized();
    // Return a defensive copy so the caller can't mutate internal state.
    return { ok: true, data: this.envelope.projects.map((p) => ({ ...p })) };
  }

  async get(id: string): Promise<StoreResult<ProjectInstance>> {
    if (!this.initialized) return notInitialized();
    const found = this.envelope.projects.find((p) => p.id === id);
    if (found === undefined) {
      return {
        ok: false,
        error: { code: 'NOT_FOUND', message: `no project with id "${id}"` },
      };
    }
    return { ok: true, data: { ...found } };
  }

  async create(input: unknown): Promise<StoreResult<ProjectInstance>> {
    return this.enqueue(async () => {
      if (!this.initialized) return notInitialized();
      const validated = validateProjectInstanceInput(input);
      if (!validated.ok) {
        return {
          ok: false,
          error: {
            code: 'VALIDATION_FAILED',
            message: 'input failed schema validation',
            details: validated.errors,
          },
        };
      }
      const now = Date.now();
      const project: ProjectInstance = {
        id: randomUUID(),
        name: validated.value.name,
        repo: { ...validated.value.repo },
        tickets: { ...validated.value.tickets },
        workflow: { ...validated.value.workflow },
        createdAt: now,
        updatedAt: now,
      };
      const next: StoreEnvelope = {
        schemaVersion: SCHEMA_VERSION,
        projects: [...this.envelope.projects, project],
      };
      const writeRes = await this.atomicWrite(next);
      if (!writeRes.ok) {
        return writeRes;
      }
      this.envelope = next;
      return { ok: true, data: { ...project } };
    });
  }

  async update(id: string, input: unknown): Promise<StoreResult<ProjectInstance>> {
    return this.enqueue(async () => {
      if (!this.initialized) return notInitialized();
      const idx = this.envelope.projects.findIndex((p) => p.id === id);
      if (idx === -1) {
        return {
          ok: false,
          error: { code: 'NOT_FOUND', message: `no project with id "${id}"` },
        };
      }
      const validated = validateProjectInstanceInput(input);
      if (!validated.ok) {
        return {
          ok: false,
          error: {
            code: 'VALIDATION_FAILED',
            message: 'input failed schema validation',
            details: validated.errors,
          },
        };
      }
      const existing = this.envelope.projects[idx]!;
      const updated: ProjectInstance = {
        id: existing.id, // preserve
        name: validated.value.name,
        repo: { ...validated.value.repo },
        tickets: { ...validated.value.tickets },
        workflow: { ...validated.value.workflow },
        createdAt: existing.createdAt, // preserve
        updatedAt: Date.now(),
      };
      const projects = [...this.envelope.projects];
      projects[idx] = updated;
      const next: StoreEnvelope = { schemaVersion: SCHEMA_VERSION, projects };
      const writeRes = await this.atomicWrite(next);
      if (!writeRes.ok) {
        return writeRes;
      }
      this.envelope = next;
      return { ok: true, data: { ...updated } };
    });
  }

  /**
   * Removes the project record. As of #25, no cascade — secrets belong to
   * Connections (issue #24), and the connection cascade is gated by
   * `getReferencingProjectIds` over in `ConnectionStore.delete`.
   */
  async delete(id: string): Promise<StoreResult<{ id: string }>> {
    return this.enqueue(async () => {
      if (!this.initialized) return notInitialized();
      const idx = this.envelope.projects.findIndex((p) => p.id === id);
      if (idx === -1) {
        return {
          ok: false,
          error: { code: 'NOT_FOUND', message: `no project with id "${id}"` },
        };
      }

      const projects = this.envelope.projects.filter((p) => p.id !== id);
      const next: StoreEnvelope = { schemaVersion: SCHEMA_VERSION, projects };
      const writeRes = await this.atomicWrite(next);
      if (!writeRes.ok) {
        return writeRes;
      }
      this.envelope = next;
      return { ok: true, data: { id } };
    });
  }

  // -- Internals ----------------------------------------------------------

  private enqueue<T>(op: () => Promise<StoreResult<T>>): Promise<StoreResult<T>> {
    let resolveOuter!: (v: StoreResult<T>) => void;
    const outer = new Promise<StoreResult<T>>((r) => {
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

  private async atomicWrite(envelope: StoreEnvelope): Promise<StoreResult<void>> {
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
