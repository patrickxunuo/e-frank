/**
 * AppConfigStore — persists the single `AppConfig` object to
 * `<userData>/app-config.json` (#GH-69 Foundation).
 *
 * Single-object analogue of `ConnectionStore`. Same patterns:
 *   - schema-versioned JSON envelope (`{ schemaVersion: 1, config: AppConfig }`)
 *   - atomic write via `.tmp-{uuid}` + rename
 *   - single-Promise mutex chain (`enqueue<T>`) so concurrent set() calls
 *     serialize cleanly
 *   - hand-rolled validator from `shared/schema/app-config.ts`
 *
 * Forward-compat: missing fields are filled from `DEFAULT_APP_CONFIG` on
 * `get()`, so old config files keep working when a future PR adds a new
 * field. Updating defaults is a non-breaking change.
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  validateAppConfig,
  DEFAULT_APP_CONFIG,
  type AppConfig,
  type AppConfigValidationError,
} from '../../shared/schema/app-config.js';
import type { ProjectStoreFs } from './project-store.js';

// -- fs surface -------------------------------------------------------------

/** Re-exported alias matching the ConnectionStore / ProjectStore convention. */
export type AppConfigStoreFs = ProjectStoreFs;

function defaultFs(): AppConfigStoreFs {
  return {
    readFile: (path, encoding) => fs.readFile(path, encoding),
    writeFile: (path, data, encoding) => fs.writeFile(path, data, encoding),
    rename: (from, to) => fs.rename(from, to),
    unlink: (path) => fs.unlink(path),
    mkdir: (path, opts) => fs.mkdir(path, opts).then(() => undefined),
  };
}

// -- Public types -----------------------------------------------------------

export interface AppConfigStoreOptions {
  /** Absolute path to app-config.json. */
  filePath: string;
  /** Override fs for tests. Defaults to node:fs/promises. */
  fs?: AppConfigStoreFs;
}

export type AppConfigStoreErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'FILE_CORRUPT'
  | 'IO_FAILURE';

export type AppConfigStoreErrorDetails = AppConfigValidationError[];

export type AppConfigStoreResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        code: AppConfigStoreErrorCode;
        message: string;
        details?: AppConfigStoreErrorDetails;
      };
    };

// -- Internal ---------------------------------------------------------------

interface StoreEnvelope {
  schemaVersion: 1;
  config: AppConfig;
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

function notInitialized<T>(): AppConfigStoreResult<T> {
  return {
    ok: false,
    error: {
      code: 'IO_FAILURE',
      message: 'init() not called or init failed; refusing to read/mutate',
    },
  };
}

// -- Class ------------------------------------------------------------------

export class AppConfigStore {
  private readonly filePath: string;
  private readonly fs: AppConfigStoreFs;

  private envelope: StoreEnvelope = {
    schemaVersion: SCHEMA_VERSION,
    config: { ...DEFAULT_APP_CONFIG },
  };
  private initialized = false;

  /** Single-Promise mutex chain (mirrors ConnectionStore / ProjectStore). */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: AppConfigStoreOptions) {
    this.filePath = options.filePath;
    this.fs = options.fs ?? defaultFs();
  }

  /**
   * Reads the file (or initializes with defaults if missing). MUST be
   * called once before `get()` or `set()`. Idempotent.
   *
   * File missing → seed with `DEFAULT_APP_CONFIG`, mark initialized. The
   * file is NOT created on disk until the first `set()` call — this
   * mirrors ConnectionStore's behavior and keeps a clean install from
   * accumulating empty sidecar files until needed.
   */
  async init(): Promise<AppConfigStoreResult<void>> {
    return this.enqueue(async () => {
      if (this.initialized) {
        return { ok: true, data: undefined };
      }

      let raw: string;
      try {
        raw = await this.fs.readFile(this.filePath, 'utf8');
      } catch (err) {
        if (isENOENT(err)) {
          this.envelope = { schemaVersion: SCHEMA_VERSION, config: { ...DEFAULT_APP_CONFIG } };
          this.initialized = true;
          return { ok: true, data: undefined };
        }
        return { ok: false, error: { code: 'IO_FAILURE', message: errMessage(err) } };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        return {
          ok: false,
          error: { code: 'FILE_CORRUPT', message: `JSON parse failed: ${errMessage(err)}` },
        };
      }

      if (!isPlainObject(parsed)) {
        return {
          ok: false,
          error: { code: 'FILE_CORRUPT', message: 'expected a JSON object at top level' },
        };
      }

      const version = parsed['schemaVersion'];
      if (version !== SCHEMA_VERSION) {
        return {
          ok: false,
          error: {
            code: 'UNSUPPORTED_SCHEMA_VERSION',
            message: `expected schemaVersion=${SCHEMA_VERSION}, got ${String(version)}`,
          },
        };
      }

      const cfg = parsed['config'];
      const validated = validateAppConfig(cfg, { strict: true });
      if (!validated.ok) {
        return {
          ok: false,
          error: {
            code: 'VALIDATION_FAILED',
            message: 'persisted config is invalid',
            details: validated.errors,
          },
        };
      }

      this.envelope = { schemaVersion: SCHEMA_VERSION, config: validated.data as AppConfig };
      this.initialized = true;
      return { ok: true, data: undefined };
    });
  }

  /**
   * Returns a defensive copy of the current config. Always includes every
   * field — missing entries from the persisted file are filled with
   * `DEFAULT_APP_CONFIG` values during `init()`.
   */
  async get(): Promise<AppConfigStoreResult<AppConfig>> {
    return this.enqueue(async () => {
      if (!this.initialized) return notInitialized();
      return { ok: true, data: { ...this.envelope.config } };
    });
  }

  /**
   * Shallow-merges `partial` into the existing config and persists. Returns
   * the post-merge full config. Validation runs in non-strict mode so the
   * caller can update one field without re-supplying the others.
   *
   * Empty partial (`{}`) is a valid no-op — useful for forcing a touch on
   * the file (e.g. to confirm write permissions).
   */
  async set(partial: Partial<AppConfig>): Promise<AppConfigStoreResult<AppConfig>> {
    return this.enqueue(async () => {
      if (!this.initialized) return notInitialized();

      const validated = validateAppConfig(partial, { strict: false });
      if (!validated.ok) {
        return {
          ok: false,
          error: {
            code: 'VALIDATION_FAILED',
            message: 'config update failed validation',
            details: validated.errors,
          },
        };
      }

      const merged: AppConfig = { ...this.envelope.config, ...validated.data };
      const next: StoreEnvelope = { schemaVersion: SCHEMA_VERSION, config: merged };
      const writeRes = await this.atomicWrite(next);
      if (!writeRes.ok) {
        return writeRes;
      }
      this.envelope = next;
      return { ok: true, data: { ...merged } };
    });
  }

  // -- Internal ------------------------------------------------------------

  private enqueue<T>(op: () => Promise<AppConfigStoreResult<T>>): Promise<AppConfigStoreResult<T>> {
    let resolveOuter!: (v: AppConfigStoreResult<T>) => void;
    const outer = new Promise<AppConfigStoreResult<T>>((r) => {
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

  private async atomicWrite(envelope: StoreEnvelope): Promise<AppConfigStoreResult<void>> {
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
        // ignore — best-effort cleanup
      }
      return { ok: false, error: { code: 'IO_FAILURE', message: errMessage(err) } };
    }
    return { ok: true, data: undefined };
  }
}
