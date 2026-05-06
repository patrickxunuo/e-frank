/**
 * ConnectionStore — persists `Connection` records to a JSON file under
 * `app.getPath('userData')` with atomic writes and a write mutex.
 *
 * File envelope:
 *   { schemaVersion: 1, connections: Connection[] }
 *
 * Mirrors `ProjectStore` exactly: same `enqueue<T>` mutex chain, same
 * `atomicWrite` (write to `.tmp-{uuid}` then rename), same `notInitialized()`
 * guard. Cascade-delete for the connection's secret ref is best-effort and
 * never blocks the user-facing delete.
 *
 * Plaintext NEVER leaves the create/update path — the secretRef is the only
 * field persisted on the Connection.
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  validateConnection,
  validateConnectionInput,
  validateConnectionUpdate,
  type Connection,
  type ConnectionIdentity,
  type ConnectionInput,
  type ValidationError,
} from '../../shared/schema/connection.js';
import type { SecretsManager } from './secrets-manager.js';
import type { ProjectStoreFs } from './project-store.js';

// -- fs surface -------------------------------------------------------------

/**
 * Re-exported alias for `ProjectStoreFs` so consumers (and tests) can import
 * `ConnectionStoreFs` from this module without reaching across to
 * `project-store.ts`. Same contract.
 */
export type ConnectionStoreFs = ProjectStoreFs;

function defaultFs(): ConnectionStoreFs {
  return {
    readFile: (path, encoding) => fs.readFile(path, encoding),
    writeFile: (path, data, encoding) => fs.writeFile(path, data, encoding),
    rename: (from, to) => fs.rename(from, to),
    unlink: (path) => fs.unlink(path),
    mkdir: (path, opts) => fs.mkdir(path, opts).then(() => undefined),
  };
}

// -- Public types -----------------------------------------------------------

export interface ConnectionStoreOptions {
  /** Absolute path to connections.json. */
  filePath: string;
  /** Used to read existing tokens (for Jira email-only updates), set new tokens, and cascade-delete on connection removal. */
  secretsManager: Pick<SecretsManager, 'set' | 'get' | 'delete'>;
  /**
   * Returns the project IDs currently referencing the connection. Cascade-delete
   * is gated when the array is non-empty. In #24, projects don't yet carry
   * connection refs — this returns [] always; #25 wires it up.
   */
  getReferencingProjectIds: (connectionId: string) => Promise<string[]>;
  /** Override fs for tests. Defaults to node:fs/promises. */
  fs?: ConnectionStoreFs;
}

export type ConnectionStoreErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION_FAILED'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'FILE_CORRUPT'
  | 'IO_FAILURE'
  | 'LABEL_NOT_UNIQUE'
  | 'IN_USE';

export type ConnectionStoreErrorDetails =
  | ValidationError[]
  | { referencedBy: string[] };

export type ConnectionStoreResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        code: ConnectionStoreErrorCode;
        message: string;
        details?: ConnectionStoreErrorDetails;
      };
    };

interface StoreEnvelope {
  schemaVersion: 1;
  connections: Connection[];
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

function notInitialized<T>(): ConnectionStoreResult<T> {
  return {
    ok: false,
    error: {
      code: 'IO_FAILURE',
      message: 'init() not called or init failed; refusing to mutate',
    },
  };
}

/**
 * For Jira `api-token` connections, the secret value joins email and token
 * with `\n` so a single secrets ref captures both halves of the Basic-auth
 * pair. The test handler splits on the first `\n`.
 */
function buildSecretValue(input: ConnectionInput): string {
  if (input.provider === 'jira' && input.authMethod === 'api-token') {
    return `${input.email ?? ''}\n${input.plaintextToken}`;
  }
  return input.plaintextToken;
}

// -- Class ------------------------------------------------------------------

export class ConnectionStore {
  private readonly filePath: string;
  private readonly secretsManager: Pick<SecretsManager, 'set' | 'get' | 'delete'>;
  private readonly getReferencingProjectIds: (id: string) => Promise<string[]>;
  private readonly fs: ConnectionStoreFs;

  private envelope: StoreEnvelope = {
    schemaVersion: SCHEMA_VERSION,
    connections: [],
  };
  private initialized = false;

  /** Single-Promise mutex chain (mirrors ProjectStore / SecretsManager). */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: ConnectionStoreOptions) {
    this.filePath = options.filePath;
    this.secretsManager = options.secretsManager;
    this.getReferencingProjectIds = options.getReferencingProjectIds;
    this.fs = options.fs ?? defaultFs();
  }

  /**
   * Reads the file (or initializes empty if missing). MUST be called once
   * before any CRUD operation. Idempotent.
   */
  async init(): Promise<ConnectionStoreResult<{ count: number }>> {
    return this.enqueue(async () => {
      if (this.initialized) {
        return { ok: true, data: { count: this.envelope.connections.length } };
      }

      let raw: string;
      try {
        raw = await this.fs.readFile(this.filePath, 'utf8');
      } catch (err) {
        if (isENOENT(err)) {
          this.envelope = { schemaVersion: SCHEMA_VERSION, connections: [] };
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
            message: `connections file is not valid JSON: ${errMessage(err)}`,
          },
        };
      }

      if (!isPlainObject(parsed)) {
        return {
          ok: false,
          error: { code: 'FILE_CORRUPT', message: 'connections file root must be an object' },
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
      const connectionsRaw = parsed['connections'];
      if (!Array.isArray(connectionsRaw)) {
        return {
          ok: false,
          error: { code: 'FILE_CORRUPT', message: 'connections must be an array' },
        };
      }

      const connections: Connection[] = [];
      for (let i = 0; i < connectionsRaw.length; i++) {
        const res = validateConnection(connectionsRaw[i]);
        if (!res.ok) {
          return {
            ok: false,
            error: {
              code: 'FILE_CORRUPT',
              message: `connections[${i}] failed schema validation`,
              details: res.errors,
            },
          };
        }
        connections.push(res.value);
      }

      this.envelope = { schemaVersion: SCHEMA_VERSION, connections };
      this.initialized = true;
      return { ok: true, data: { count: connections.length } };
    });
  }

  async list(): Promise<ConnectionStoreResult<Connection[]>> {
    if (!this.initialized) return notInitialized();
    return { ok: true, data: this.envelope.connections.map((c) => ({ ...c })) };
  }

  async get(id: string): Promise<ConnectionStoreResult<Connection>> {
    if (!this.initialized) return notInitialized();
    const found = this.envelope.connections.find((c) => c.id === id);
    if (found === undefined) {
      return {
        ok: false,
        error: { code: 'NOT_FOUND', message: `no connection with id "${id}"` },
      };
    }
    return { ok: true, data: { ...found } };
  }

  async create(input: unknown): Promise<ConnectionStoreResult<Connection>> {
    return this.enqueue(async () => {
      if (!this.initialized) return notInitialized();
      const validated = validateConnectionInput(input);
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
      const v = validated.value;

      // Label uniqueness within provider, case-sensitive.
      const collision = this.envelope.connections.find(
        (c) => c.provider === v.provider && c.label === v.label,
      );
      if (collision !== undefined) {
        return {
          ok: false,
          error: {
            code: 'LABEL_NOT_UNIQUE',
            message: `a ${v.provider} connection with label "${v.label}" already exists`,
          },
        };
      }

      const id = randomUUID();
      const secretRef = `connection:${id}:token`;

      // Persist the secret FIRST. If this fails, abort and do not persist
      // the Connection — the user shouldn't see a row pointing at a
      // non-existent secret.
      let setRes: Awaited<ReturnType<SecretsManager['set']>>;
      try {
        setRes = await this.secretsManager.set(secretRef, buildSecretValue(v));
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'IO_FAILURE',
            message: `secretsManager.set failed: ${errMessage(err)}`,
          },
        };
      }
      if (!setRes.ok) {
        return {
          ok: false,
          error: {
            code: 'IO_FAILURE',
            message: `secretsManager.set failed: ${setRes.error.code} - ${setRes.error.message}`,
          },
        };
      }

      const now = Date.now();
      const connection: Connection = {
        id,
        provider: v.provider,
        label: v.label,
        host: v.host,
        authMethod: v.authMethod,
        secretRef,
        createdAt: now,
        updatedAt: now,
      };
      const next: StoreEnvelope = {
        schemaVersion: SCHEMA_VERSION,
        connections: [...this.envelope.connections, connection],
      };
      const writeRes = await this.atomicWrite(next);
      if (!writeRes.ok) {
        return writeRes;
      }
      this.envelope = next;
      return { ok: true, data: { ...connection } };
    });
  }

  async update(
    id: string,
    input: unknown,
  ): Promise<ConnectionStoreResult<Connection>> {
    return this.enqueue(async () => {
      if (!this.initialized) return notInitialized();
      const idx = this.envelope.connections.findIndex((c) => c.id === id);
      if (idx === -1) {
        return {
          ok: false,
          error: { code: 'NOT_FOUND', message: `no connection with id "${id}"` },
        };
      }
      const validated = validateConnectionUpdate(input);
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
      const v = validated.value;
      const existing = this.envelope.connections[idx]!;

      // Label uniqueness check on collision with a different connection of
      // the same provider.
      if (v.label !== undefined && v.label !== existing.label) {
        const collision = this.envelope.connections.find(
          (c) =>
            c.id !== id &&
            c.provider === existing.provider &&
            c.label === v.label,
        );
        if (collision !== undefined) {
          return {
            ok: false,
            error: {
              code: 'LABEL_NOT_UNIQUE',
              message: `a ${existing.provider} connection with label "${v.label}" already exists`,
            },
          };
        }
      }

      // Token-side update rules:
      //  1. plaintextToken provided                     → write a fresh secret. For Jira, prepend the (possibly new) email.
      //  2. Jira: email changed but no token rotation   → re-read the existing secret, splice the new email in, write back. Otherwise an email-only edit silently drops.
      //  3. Otherwise                                   → don't touch the secret.
      const isJiraApi =
        existing.provider === 'jira' && existing.authMethod === 'api-token';
      const needsSecretWrite =
        v.plaintextToken !== undefined || (isJiraApi && v.email !== undefined);

      if (needsSecretWrite) {
        let secretValue: string;
        if (isJiraApi) {
          let token: string;
          if (v.plaintextToken !== undefined) {
            token = v.plaintextToken;
          } else {
            // Email-only edit on Jira: read the existing secret, keep the token half.
            const getRes = await this.secretsManager.get(existing.secretRef);
            if (!getRes.ok) {
              return {
                ok: false,
                error: {
                  code: 'IO_FAILURE',
                  message: `cannot rotate Jira email without an existing token: ${getRes.error.code}`,
                },
              };
            }
            const idx = getRes.data.plaintext.indexOf('\n');
            token = idx === -1 ? getRes.data.plaintext : getRes.data.plaintext.slice(idx + 1);
          }
          secretValue = `${v.email ?? ''}\n${token}`;
        } else {
          // Non-Jira: only here when v.plaintextToken !== undefined.
          secretValue = v.plaintextToken!;
        }
        let setRes: Awaited<ReturnType<SecretsManager['set']>>;
        try {
          setRes = await this.secretsManager.set(existing.secretRef, secretValue);
        } catch (err) {
          return {
            ok: false,
            error: {
              code: 'IO_FAILURE',
              message: `secretsManager.set failed: ${errMessage(err)}`,
            },
          };
        }
        if (!setRes.ok) {
          return {
            ok: false,
            error: {
              code: 'IO_FAILURE',
              message: `secretsManager.set failed: ${setRes.error.code} - ${setRes.error.message}`,
            },
          };
        }
      }

      const updated: Connection = {
        ...existing,
        ...(v.label !== undefined ? { label: v.label } : {}),
        ...(v.host !== undefined ? { host: v.host } : {}),
        updatedAt: Date.now(),
      };
      const connections = [...this.envelope.connections];
      connections[idx] = updated;
      const next: StoreEnvelope = { schemaVersion: SCHEMA_VERSION, connections };
      const writeRes = await this.atomicWrite(next);
      if (!writeRes.ok) {
        return writeRes;
      }
      this.envelope = next;
      return { ok: true, data: { ...updated } };
    });
  }

  /**
   * Refuses (`IN_USE`) if `getReferencingProjectIds(id)` returns a non-empty
   * array. Otherwise cascade-deletes the secret (best-effort; cascade
   * failure is logged but doesn't block the deletion) and removes the
   * connection from the envelope.
   */
  async delete(id: string): Promise<ConnectionStoreResult<{ id: string }>> {
    return this.enqueue(async () => {
      if (!this.initialized) return notInitialized();
      const idx = this.envelope.connections.findIndex((c) => c.id === id);
      if (idx === -1) {
        return {
          ok: false,
          error: { code: 'NOT_FOUND', message: `no connection with id "${id}"` },
        };
      }
      const target = this.envelope.connections[idx]!;

      let referencedBy: string[];
      try {
        referencedBy = await this.getReferencingProjectIds(id);
      } catch (err) {
        return {
          ok: false,
          error: {
            code: 'IO_FAILURE',
            message: `getReferencingProjectIds threw: ${errMessage(err)}`,
          },
        };
      }
      if (referencedBy.length > 0) {
        return {
          ok: false,
          error: {
            code: 'IN_USE',
            message: `connection is referenced by ${referencedBy.length} project(s)`,
            details: { referencedBy },
          },
        };
      }

      // Cascade — best-effort. A reject from the secrets manager is logged
      // but doesn't block the user-facing delete. Mirrors ProjectStore.
      try {
        const delRes = await this.secretsManager.delete(target.secretRef);
        if (!delRes.ok) {
          console.warn(
            `[connection-store] cascade-delete of secret "${target.secretRef}" returned error: ${delRes.error.code} - ${delRes.error.message}`,
          );
        }
      } catch (err) {
        console.warn(
          `[connection-store] cascade-delete of secret "${target.secretRef}" threw: ${errMessage(err)}`,
        );
      }

      const connections = this.envelope.connections.filter((c) => c.id !== id);
      const next: StoreEnvelope = { schemaVersion: SCHEMA_VERSION, connections };
      const writeRes = await this.atomicWrite(next);
      if (!writeRes.ok) {
        return writeRes;
      }
      this.envelope = next;
      return { ok: true, data: { id } };
    });
  }

  /**
   * Atomic update of `lastVerifiedAt + accountIdentity + updatedAt` after a
   * successful Test Connection. Returns the updated Connection.
   */
  async recordVerification(
    id: string,
    identity: ConnectionIdentity,
  ): Promise<ConnectionStoreResult<Connection>> {
    return this.enqueue(async () => {
      if (!this.initialized) return notInitialized();
      const idx = this.envelope.connections.findIndex((c) => c.id === id);
      if (idx === -1) {
        return {
          ok: false,
          error: { code: 'NOT_FOUND', message: `no connection with id "${id}"` },
        };
      }
      const existing = this.envelope.connections[idx]!;
      const now = Date.now();
      const updated: Connection = {
        ...existing,
        accountIdentity: identity,
        lastVerifiedAt: now,
        verificationStatus: 'verified',
        updatedAt: now,
      };
      const connections = [...this.envelope.connections];
      connections[idx] = updated;
      const next: StoreEnvelope = { schemaVersion: SCHEMA_VERSION, connections };
      const writeRes = await this.atomicWrite(next);
      if (!writeRes.ok) {
        return writeRes;
      }
      this.envelope = next;
      return { ok: true, data: { ...updated } };
    });
  }

  /**
   * Flip `verificationStatus` to `'auth-failed'` after a Test Connection
   * returned HTTP 401. Other failures (network, 5xx, 403, timeouts) MUST NOT
   * call this — only an explicit 401 invalidates the cached "this token
   * works" state.
   *
   * Preserves the existing `accountIdentity` + `lastVerifiedAt` so the UI
   * can still show "this WAS @gazhang, but the token is no longer valid".
   */
  async markVerificationFailed(
    id: string,
  ): Promise<ConnectionStoreResult<Connection>> {
    return this.enqueue(async () => {
      if (!this.initialized) return notInitialized();
      const idx = this.envelope.connections.findIndex((c) => c.id === id);
      if (idx === -1) {
        return {
          ok: false,
          error: { code: 'NOT_FOUND', message: `no connection with id "${id}"` },
        };
      }
      const existing = this.envelope.connections[idx]!;
      const updated: Connection = {
        ...existing,
        verificationStatus: 'auth-failed',
        updatedAt: Date.now(),
      };
      const connections = [...this.envelope.connections];
      connections[idx] = updated;
      const next: StoreEnvelope = { schemaVersion: SCHEMA_VERSION, connections };
      const writeRes = await this.atomicWrite(next);
      if (!writeRes.ok) {
        return writeRes;
      }
      this.envelope = next;
      return { ok: true, data: { ...updated } };
    });
  }

  // -- Internals ----------------------------------------------------------

  private enqueue<T>(
    op: () => Promise<ConnectionStoreResult<T>>,
  ): Promise<ConnectionStoreResult<T>> {
    let resolveOuter!: (v: ConnectionStoreResult<T>) => void;
    const outer = new Promise<ConnectionStoreResult<T>>((r) => {
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

  private async atomicWrite(
    envelope: StoreEnvelope,
  ): Promise<ConnectionStoreResult<void>> {
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
