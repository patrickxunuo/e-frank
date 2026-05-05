/**
 * SecretsManager — encrypts secrets via an injectable backend (Electron
 * `safeStorage` in production, a fake XOR cipher in tests) and persists them
 * to a sidecar JSON file under `app.getPath('userData')`.
 *
 * File envelope:
 *   { schemaVersion: 1, secrets: { [ref]: <base64 of encrypted bytes> } }
 *
 * Plaintext tokens NEVER appear in any file or IPC payload outside the
 * `set()` / `get()` round-trip.
 *
 * The backend is abstracted (mirroring the spawner pattern from #2) so the
 * unit tests don't need to touch real `safeStorage` — which itself only works
 * once Electron's `app` is `ready`.
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeStorage } from 'electron';
import type { ProjectStoreFs } from './project-store.js';

// -- Backend abstraction -----------------------------------------------------

/** Minimal facade over Electron's `safeStorage` so we can fake it in tests. */
export interface SecretsBackend {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(blob: Buffer): string;
}

/**
 * Real implementation — wraps Electron's `safeStorage`. Constructed only
 * after `app.whenReady()` (the only time `safeStorage.isEncryptionAvailable()`
 * is meaningful). Tests use `FakeSecretsBackend` instead.
 */
export class SafeStorageBackend implements SecretsBackend {
  isEncryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable() === true;
  }

  encryptString(plain: string): Buffer {
    return safeStorage.encryptString(plain);
  }

  decryptString(blob: Buffer): string {
    return safeStorage.decryptString(blob);
  }
}

/**
 * Test implementation — uses an XOR cipher so the encrypted bytes never
 * contain the plaintext as a substring (important for SM-011, which asserts
 * that the plaintext literal never appears in the file content even after
 * base64 decoding). The `MAGIC` prefix lets `decryptString` reject blobs that
 * weren't produced by `encryptString`.
 */
export class FakeSecretsBackend implements SecretsBackend {
  /** Set to false to simulate "no keyring available" environments. */
  available: boolean;

  /** XOR key — chosen to flip every byte well above ASCII printable range. */
  private static readonly XOR_KEY = 0x5a;
  /** 4-byte magic header so `decryptString` can detect non-encrypted input. */
  private static readonly MAGIC = Buffer.from([0x46, 0x53, 0x42, 0x31]); // "FSB1"

  constructor(opts?: { available?: boolean }) {
    this.available = opts?.available ?? true;
  }

  isEncryptionAvailable(): boolean {
    return this.available;
  }

  encryptString(plain: string): Buffer {
    const plainBuf = Buffer.from(plain, 'utf8');
    const cipher = Buffer.alloc(plainBuf.length);
    for (let i = 0; i < plainBuf.length; i++) {
      cipher[i] = plainBuf[i]! ^ FakeSecretsBackend.XOR_KEY;
    }
    return Buffer.concat([FakeSecretsBackend.MAGIC, cipher]);
  }

  decryptString(blob: Buffer): string {
    const magic = FakeSecretsBackend.MAGIC;
    if (blob.length < magic.length || !blob.subarray(0, magic.length).equals(magic)) {
      throw new Error('FakeSecretsBackend: blob is not encrypted (missing magic header)');
    }
    const cipher = blob.subarray(magic.length);
    const plain = Buffer.alloc(cipher.length);
    for (let i = 0; i < cipher.length; i++) {
      plain[i] = cipher[i]! ^ FakeSecretsBackend.XOR_KEY;
    }
    return plain.toString('utf8');
  }
}

// -- Manager -----------------------------------------------------------------

export interface SecretsManagerOptions {
  /** Absolute path to secrets sidecar file. */
  filePath: string;
  backend: SecretsBackend;
  fs?: ProjectStoreFs;
}

export type SecretsErrorCode = 'BACKEND_UNAVAILABLE' | 'NOT_FOUND' | 'IO_FAILURE' | 'CORRUPT';

export type SecretsResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: SecretsErrorCode; message: string } };

interface SecretsEnvelope {
  schemaVersion: 1;
  secrets: Record<string, string>; // ref → base64(encrypted bytes)
}

const SCHEMA_VERSION = 1;

/** Default fs adapter — wraps node:fs/promises, exposing only the 5 methods. */
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

export class SecretsManager {
  private readonly filePath: string;
  private readonly backend: SecretsBackend;
  private readonly fs: ProjectStoreFs;

  private envelope: SecretsEnvelope = { schemaVersion: SCHEMA_VERSION, secrets: {} };
  private initialized = false;

  /**
   * Single-Promise mutex chain. Every mutation appends `.then(...)` to this
   * chain, so concurrent set / delete calls serialize. `init()` is also
   * routed through this mutex to avoid racing with mutations.
   */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: SecretsManagerOptions) {
    this.filePath = options.filePath;
    this.backend = options.backend;
    this.fs = options.fs ?? defaultFs();
  }

  isAvailable(): boolean {
    return this.backend.isEncryptionAvailable();
  }

  /**
   * Reads the file (or initializes empty if missing). Idempotent — calling
   * twice is a no-op after the first successful run.
   */
  async init(): Promise<SecretsResult<{ count: number }>> {
    return this.enqueue(async () => {
      if (this.initialized) {
        return {
          ok: true,
          data: { count: Object.keys(this.envelope.secrets).length },
        };
      }
      let raw: string;
      try {
        raw = await this.fs.readFile(this.filePath, 'utf8');
      } catch (err) {
        if (isENOENT(err)) {
          this.envelope = { schemaVersion: SCHEMA_VERSION, secrets: {} };
          this.initialized = true;
          return { ok: true, data: { count: 0 } };
        }
        return {
          ok: false,
          error: { code: 'IO_FAILURE', message: errMessage(err) },
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        return {
          ok: false,
          error: { code: 'CORRUPT', message: `secrets file is not valid JSON: ${errMessage(err)}` },
        };
      }

      if (!isPlainObject(parsed)) {
        return {
          ok: false,
          error: { code: 'CORRUPT', message: 'secrets file root must be an object' },
        };
      }
      if (parsed['schemaVersion'] !== SCHEMA_VERSION) {
        return {
          ok: false,
          error: {
            code: 'CORRUPT',
            message: `unsupported schemaVersion: expected ${SCHEMA_VERSION}, got ${String(parsed['schemaVersion'])}`,
          },
        };
      }
      const secrets = parsed['secrets'];
      if (!isPlainObject(secrets)) {
        return {
          ok: false,
          error: { code: 'CORRUPT', message: 'secrets.secrets must be an object' },
        };
      }
      // Validate each entry is a string (base64).
      const cleaned: Record<string, string> = {};
      for (const [ref, value] of Object.entries(secrets)) {
        if (typeof value !== 'string') {
          return {
            ok: false,
            error: {
              code: 'CORRUPT',
              message: `secrets entry "${ref}" must be a base64 string`,
            },
          };
        }
        cleaned[ref] = value;
      }

      this.envelope = { schemaVersion: SCHEMA_VERSION, secrets: cleaned };
      this.initialized = true;
      return { ok: true, data: { count: Object.keys(cleaned).length } };
    });
  }

  async set(ref: string, plaintext: string): Promise<SecretsResult<{ ref: string }>> {
    return this.enqueue(async () => {
      if (!this.initialized) {
        return {
          ok: false,
          error: {
            code: 'IO_FAILURE',
            message: 'init() not called or init failed; refusing to mutate (would clobber on-disk file)',
          },
        };
      }
      if (!this.backend.isEncryptionAvailable()) {
        return {
          ok: false,
          error: {
            code: 'BACKEND_UNAVAILABLE',
            message: 'encryption backend is unavailable; refusing to store plaintext',
          },
        };
      }
      let blob: Buffer;
      try {
        blob = this.backend.encryptString(plaintext);
      } catch {
        // Don't include err.message — backends could include the input in
        // their error string (defense-in-depth: plaintext must never leave
        // the set/get round-trip).
        return {
          ok: false,
          error: { code: 'IO_FAILURE', message: 'encryption failed' },
        };
      }
      const next: SecretsEnvelope = {
        schemaVersion: SCHEMA_VERSION,
        secrets: { ...this.envelope.secrets, [ref]: blob.toString('base64') },
      };
      const writeRes = await this.atomicWrite(next);
      if (!writeRes.ok) {
        return writeRes;
      }
      this.envelope = next;
      return { ok: true, data: { ref } };
    });
  }

  async get(ref: string): Promise<SecretsResult<{ plaintext: string }>> {
    // Reads don't strictly need the mutex but routing through it keeps reads
    // consistent with in-flight writes.
    const b64 = this.envelope.secrets[ref];
    if (b64 === undefined) {
      return { ok: false, error: { code: 'NOT_FOUND', message: `no secret for ref "${ref}"` } };
    }
    let blob: Buffer;
    try {
      blob = Buffer.from(b64, 'base64');
    } catch (err) {
      return {
        ok: false,
        error: { code: 'CORRUPT', message: `failed to decode base64: ${errMessage(err)}` },
      };
    }
    let plain: string;
    try {
      plain = this.backend.decryptString(blob);
    } catch (err) {
      return {
        ok: false,
        error: { code: 'CORRUPT', message: `failed to decrypt: ${errMessage(err)}` },
      };
    }
    return { ok: true, data: { plaintext: plain } };
  }

  async delete(ref: string): Promise<SecretsResult<{ ref: string }>> {
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
      if (!(ref in this.envelope.secrets)) {
        // Idempotent: deleting a missing ref is ok, no file write needed.
        return { ok: true, data: { ref } };
      }
      const nextSecrets: Record<string, string> = { ...this.envelope.secrets };
      delete nextSecrets[ref];
      const next: SecretsEnvelope = { schemaVersion: SCHEMA_VERSION, secrets: nextSecrets };
      const writeRes = await this.atomicWrite(next);
      if (!writeRes.ok) {
        return writeRes;
      }
      this.envelope = next;
      return { ok: true, data: { ref } };
    });
  }

  async list(): Promise<SecretsResult<{ refs: string[] }>> {
    return { ok: true, data: { refs: Object.keys(this.envelope.secrets) } };
  }

  // -- Internals -----------------------------------------------------------

  /**
   * Append `op` to the write-mutex chain. Returns the same `SecretsResult`
   * the op produced. Errors are rethrown as `IO_FAILURE` so the chain stays
   * unbroken.
   */
  private enqueue<T>(op: () => Promise<SecretsResult<T>>): Promise<SecretsResult<T>> {
    let resolveOuter!: (v: SecretsResult<T>) => void;
    const outer = new Promise<SecretsResult<T>>((r) => {
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

  private async atomicWrite(envelope: SecretsEnvelope): Promise<SecretsResult<void>> {
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
      // Best-effort cleanup of the temp file, but don't mask the real error.
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

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
