/**
 * ProjectStore — persists `ProjectInstance` records to a JSON file under
 * `app.getPath('userData')` with atomic writes and a write mutex.
 *
 * File envelope:
 *   { schemaVersion: 1, projects: ProjectInstance[] }
 *
 * The store cascades token-ref deletion to a `SecretsManager` on `delete()`
 * (business rule 9). Validation runs through the schema's hand-rolled
 * validator; the store assigns id / createdAt / updatedAt itself.
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
import type { SecretsManager } from './secrets-manager.js';

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
  /** Used to cascade-delete tokens when a project is removed. */
  secretsManager: Pick<SecretsManager, 'delete'>;
  /** Override fs for tests. Defaults to node:fs/promises. */
  fs?: ProjectStoreFs;
}

export type StoreErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'FILE_CORRUPT'
  | 'IO_FAILURE';

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
  private readonly secretsManager: Pick<SecretsManager, 'delete'>;
  private readonly fs: ProjectStoreFs;

  private envelope: StoreEnvelope = { schemaVersion: SCHEMA_VERSION, projects: [] };
  private initialized = false;

  /** Single-Promise mutex chain (mirrors SecretsManager). */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: ProjectStoreOptions) {
    this.filePath = options.filePath;
    this.secretsManager = options.secretsManager;
    this.fs = options.fs ?? defaultFs();
  }

  /**
   * Reads the file (or initializes empty if missing). MUST be called once
   * before any CRUD operation. Idempotent.
   */
  async init(): Promise<StoreResult<{ count: number }>> {
    return this.enqueue(async () => {
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

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'FILE_CORRUPT',
            message: `projects file is not valid JSON: ${errMessage(err)}`,
          },
        };
      }

      if (!isPlainObject(parsed)) {
        return {
          ok: false,
          error: { code: 'FILE_CORRUPT', message: 'projects file root must be an object' },
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
      const projectsRaw = parsed['projects'];
      if (!Array.isArray(projectsRaw)) {
        return {
          ok: false,
          error: { code: 'FILE_CORRUPT', message: 'projects must be an array' },
        };
      }

      const projects: ProjectInstance[] = [];
      for (let i = 0; i < projectsRaw.length; i++) {
        const res = validateProjectInstance(projectsRaw[i]);
        if (!res.ok) {
          return {
            ok: false,
            error: {
              code: 'FILE_CORRUPT',
              message: `projects[${i}] failed schema validation`,
              details: res.errors,
            },
          };
        }
        projects.push(res.value);
      }

      this.envelope = { schemaVersion: SCHEMA_VERSION, projects };
      this.initialized = true;
      return { ok: true, data: { count: projects.length } };
    });
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
   * Cascade-deletes any tokenRef on the project from the secrets manager
   * BEFORE removing the project. Failures in the cascade are logged but do
   * NOT block the project deletion (rule 9).
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
      const target = this.envelope.projects[idx]!;

      // Cascade — best-effort, never blocks the project deletion.
      // Dedup so we don't call secretsManager.delete twice when the project
      // points repo and tickets at the same tokenRef.
      const refsToDelete = new Set<string>();
      if (target.repo.tokenRef !== undefined && target.repo.tokenRef !== '') {
        refsToDelete.add(target.repo.tokenRef);
      }
      if (target.tickets.tokenRef !== undefined && target.tickets.tokenRef !== '') {
        refsToDelete.add(target.tickets.tokenRef);
      }
      for (const ref of refsToDelete) {
        try {
          await this.secretsManager.delete(ref);
        } catch (err) {
          // Log only — never block the user-facing delete.
           
          console.warn(
            `[project-store] cascade-delete of secret "${ref}" failed: ${errMessage(err)}`,
          );
        }
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
