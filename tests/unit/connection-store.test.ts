import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ConnectionStore,
  type ConnectionStoreFs,
} from '../../src/main/modules/connection-store';
import type {
  Connection,
  ConnectionIdentity,
  ConnectionInput,
} from '../../src/shared/schema/connection';
import type { SecretsErrorCode } from '../../src/main/modules/secrets-manager';

/**
 * CONN-STORE-001..017 — ConnectionStore unit tests.
 *
 * Mirrors `tests/unit/project-store.test.ts`:
 *  - in-memory ProjectStoreFs-shaped fake
 *  - secrets manager stub recording set/delete calls (with optional rejects)
 *  - getReferencingProjectIds is a per-test injectable
 *
 * Note: the production module exports a `ConnectionStoreFs` type alias for
 * `ProjectStoreFs`. If Agent B doesn't add that, we fall back to importing
 * `ProjectStoreFs` from project-store directly — either name is fine, but
 * we use `ConnectionStoreFs` here to keep the signal-of-intent obvious.
 */

// ---------------------------------------------------------------------------
// In-memory fs stub (lifted from project-store.test.ts; minor edits)
// ---------------------------------------------------------------------------

type FsOp =
  | { kind: 'readFile'; path: string }
  | { kind: 'writeFile'; path: string; data: string }
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'unlink'; path: string }
  | { kind: 'mkdir'; path: string };

interface MemFs extends ConnectionStoreFs {
  files: Map<string, string>;
  ops: FsOp[];
  enoentForMissing: boolean;
}

function createMemFs(initial: Record<string, string> = {}): MemFs {
  const files = new Map<string, string>(Object.entries(initial));
  const ops: FsOp[] = [];

  const fs: MemFs = {
    files,
    ops,
    enoentForMissing: true,

    async readFile(path: string, _enc: 'utf8'): Promise<string> {
      ops.push({ kind: 'readFile', path });
      const content = files.get(path);
      if (content === undefined) {
        if (fs.enoentForMissing) {
          const err = new Error(
            `ENOENT: no such file or directory, open '${path}'`,
          ) as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
        return '';
      }
      return content;
    },

    async writeFile(path: string, data: string, _enc: 'utf8'): Promise<void> {
      ops.push({ kind: 'writeFile', path, data });
      files.set(path, data);
    },

    async rename(from: string, to: string): Promise<void> {
      ops.push({ kind: 'rename', from, to });
      const data = files.get(from);
      if (data === undefined) {
        const err = new Error(
          `ENOENT: rename source missing '${from}'`,
        ) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      files.delete(from);
      files.set(to, data);
    },

    async unlink(path: string): Promise<void> {
      ops.push({ kind: 'unlink', path });
      files.delete(path);
    },

    async mkdir(path: string, _opts: { recursive: true }): Promise<void> {
      ops.push({ kind: 'mkdir', path });
    },
  };

  return fs;
}

// ---------------------------------------------------------------------------
// SecretsManager stub
// ---------------------------------------------------------------------------

interface SecretsCall {
  fn: 'set' | 'get' | 'delete';
  ref: string;
  plaintext?: string;
}

interface SecretsStub {
  set: (ref: string, plaintext: string) => Promise<{ ok: true; data: { ref: string } } | { ok: false; error: { code: SecretsErrorCode; message: string } }>;
  get: (ref: string) => Promise<{ ok: true; data: { plaintext: string } } | { ok: false; error: { code: SecretsErrorCode; message: string } }>;
  delete: (ref: string) => Promise<{ ok: true; data: { ref: string } } | { ok: false; error: { code: SecretsErrorCode; message: string } }>;
  calls: SecretsCall[];
  /** Backing store for set/get round-trip in tests that exercise email-only Jira updates. */
  store: Map<string, string>;
  /** When set, the next set() call rejects with this error. */
  rejectSetWith?: Error;
  /** When set, the next delete() call rejects with this error. */
  rejectDeleteWith?: Error;
  /** When set, the next set() call returns a typed error result. */
  setErrorResult?: { code: SecretsErrorCode; message: string };
}

function createSecretsStub(): SecretsStub {
  const stub: SecretsStub = {
    calls: [],
    store: new Map<string, string>(),
    set: async (ref, plaintext) => {
      stub.calls.push({ fn: 'set', ref, plaintext });
      if (stub.rejectSetWith) throw stub.rejectSetWith;
      if (stub.setErrorResult) return { ok: false, error: stub.setErrorResult };
      stub.store.set(ref, plaintext);
      return { ok: true, data: { ref } };
    },
    get: async (ref) => {
      stub.calls.push({ fn: 'get', ref });
      const v = stub.store.get(ref);
      if (v === undefined) {
        return { ok: false, error: { code: 'NOT_FOUND', message: `no secret for ref "${ref}"` } };
      }
      return { ok: true, data: { plaintext: v } };
    },
    delete: async (ref) => {
      stub.calls.push({ fn: 'delete', ref });
      if (stub.rejectDeleteWith) throw stub.rejectDeleteWith;
      stub.store.delete(ref);
      return { ok: true, data: { ref } };
    },
  };
  return stub;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FILE_PATH = '/userData/connections.json';

function ghInput(overrides: Partial<ConnectionInput> = {}): ConnectionInput {
  return {
    provider: 'github',
    label: 'Personal',
    host: 'https://api.github.com',
    authMethod: 'pat',
    plaintextToken: 'ghp_secrettoken',
    ...overrides,
  };
}

function jiraInput(overrides: Partial<ConnectionInput> = {}): ConnectionInput {
  return {
    provider: 'jira',
    label: 'emonster',
    host: 'https://emonster.atlassian.net',
    authMethod: 'api-token',
    plaintextToken: 'jira_secret_token',
    email: 'gazhang@emonster.tech',
    ...overrides,
  };
}

function envelope(connections: Connection[]): string {
  return JSON.stringify({ schemaVersion: 1, connections });
}

function makeStoredConnection(over: Partial<Connection> = {}): Connection {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    provider: 'github',
    label: 'Existing',
    host: 'https://api.github.com',
    authMethod: 'pat',
    secretRef: 'connection:11111111-2222-4333-8444-555555555555:token',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeStore(opts: {
  fs: MemFs;
  secrets: SecretsStub;
  getReferencingProjectIds?: (id: string) => Promise<string[]>;
}): ConnectionStore {
  return new ConnectionStore({
    filePath: FILE_PATH,
    secretsManager: {
      set: opts.secrets.set,
      get: opts.secrets.get,
      delete: opts.secrets.delete,
    },
    getReferencingProjectIds:
      opts.getReferencingProjectIds ?? (async () => []),
    fs: opts.fs,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConnectionStore', () => {
  let fs: MemFs;
  let secrets: SecretsStub;
  let store: ConnectionStore;

  beforeEach(() => {
    fs = createMemFs();
    secrets = createSecretsStub();
    store = makeStore({ fs, secrets });
  });

  // -------------------------------------------------------------------------
  // CONN-STORE-001..004 — init()
  // -------------------------------------------------------------------------
  describe('CONN-STORE-001..004 init()', () => {
    it('CONN-STORE-001: init() with missing file → ok:true count:0', async () => {
      const r = await store.init();
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data.count).toBe(0);
    });

    it('CONN-STORE-002: init() parses an existing valid envelope', async () => {
      const a = makeStoredConnection({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', label: 'A' });
      const b = makeStoredConnection({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', label: 'B' });
      fs.files.set(FILE_PATH, envelope([a, b]));

      const init = await store.init();
      expect(init.ok).toBe(true);
      if (!init.ok) return;
      expect(init.data.count).toBe(2);

      const list = await store.list();
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      const ids = list.data.map((c) => c.id);
      expect(ids).toContain(a.id);
      expect(ids).toContain(b.id);

      // Round-trip: every field preserved
      const aFound = list.data.find((c) => c.id === a.id);
      expect(aFound?.label).toBe('A');
      expect(aFound?.host).toBe(a.host);
      expect(aFound?.secretRef).toBe(a.secretRef);
    });

    it('CONN-STORE-003: init() rejects FILE_CORRUPT on malformed JSON', async () => {
      fs.files.set(FILE_PATH, '{ this is { not valid json');
      const r = await store.init();
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('FILE_CORRUPT');
    });

    it('CONN-STORE-004: init() rejects UNSUPPORTED_SCHEMA_VERSION on v0 envelope', async () => {
      fs.files.set(
        FILE_PATH,
        JSON.stringify({ schemaVersion: 0, connections: [] }),
      );
      const r = await store.init();
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('UNSUPPORTED_SCHEMA_VERSION');
    });
  });

  // -------------------------------------------------------------------------
  // CONN-STORE-005..009 — create()
  // -------------------------------------------------------------------------
  describe('CONN-STORE-005..009 create()', () => {
    it('CONN-STORE-005: create() assigns id, derives secretRef, calls secretsManager.set, persists', async () => {
      await store.init();
      const r = await store.create(ghInput());
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(typeof r.data.id).toBe('string');
      expect(r.data.id.length).toBeGreaterThan(0);
      expect(r.data.secretRef).toBe(`connection:${r.data.id}:token`);

      // secretsManager.set called exactly once with the right ref
      const setCalls = secrets.calls.filter((c) => c.fn === 'set');
      expect(setCalls).toHaveLength(1);
      expect(setCalls[0]?.ref).toBe(r.data.secretRef);

      // Persisted in list
      const list = await store.list();
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      expect(list.data.map((c) => c.id)).toContain(r.data.id);
    });

    it('CONN-STORE-006: create() rejects LABEL_NOT_UNIQUE for same-provider duplicate label', async () => {
      await store.init();
      const first = await store.create(ghInput({ label: 'Personal' }));
      expect(first.ok).toBe(true);

      const second = await store.create(ghInput({ label: 'Personal' }));
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.error.code).toBe('LABEL_NOT_UNIQUE');
    });

    it('CONN-STORE-007: create() allows same label across different providers', async () => {
      await store.init();
      const gh = await store.create(ghInput({ label: 'Shared' }));
      expect(gh.ok).toBe(true);
      const jira = await store.create(jiraInput({ label: 'Shared' }));
      expect(jira.ok).toBe(true);
    });

    it('CONN-STORE-008: create() for Jira stores `${email}\\n${token}` under secretRef', async () => {
      await store.init();
      const r = await store.create(jiraInput());
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      const setCalls = secrets.calls.filter((c) => c.fn === 'set');
      expect(setCalls).toHaveLength(1);
      const stored = setCalls[0]?.plaintext ?? '';
      expect(stored).toContain('\n');
      // First half: email; second half: token
      const [emailPart, tokenPart] = stored.split('\n');
      expect(emailPart).toBe('gazhang@emonster.tech');
      expect(tokenPart).toBe('jira_secret_token');
    });

    it('CONN-STORE-009: create() aborts when secretsManager.set rejects — envelope NOT mutated', async () => {
      await store.init();
      secrets.rejectSetWith = new Error('keyring offline');

      const r = await store.create(ghInput());
      expect(r.ok).toBe(false);

      const list = await store.list();
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      expect(list.data).toHaveLength(0);

      // No file write happened either
      const writes = fs.ops.filter((o) => o.kind === 'writeFile');
      expect(writes).toHaveLength(0);
    });

    it('CONN-STORE-009: create() aborts when secretsManager.set returns ok:false', async () => {
      await store.init();
      secrets.setErrorResult = { code: 'BACKEND_UNAVAILABLE', message: 'no keychain' };

      const r = await store.create(ghInput());
      expect(r.ok).toBe(false);

      const list = await store.list();
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      expect(list.data).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // CONN-STORE-010..011 — update()
  // -------------------------------------------------------------------------
  describe('CONN-STORE-010..011 update()', () => {
    it('CONN-STORE-010: update() rotates token only when plaintextToken provided', async () => {
      await store.init();
      const created = await store.create(ghInput());
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const setCallsBefore = secrets.calls.filter((c) => c.fn === 'set').length;

      // Update label only — no plaintextToken — should not call set
      const noTokenRotation = await store.update(created.data.id, { label: 'Renamed' });
      expect(noTokenRotation.ok).toBe(true);
      const setCallsAfterNoRotation = secrets.calls.filter((c) => c.fn === 'set').length;
      expect(setCallsAfterNoRotation).toBe(setCallsBefore);

      // Now update WITH a new plaintextToken — should call set exactly once more
      const tokenRotation = await store.update(created.data.id, {
        plaintextToken: 'ghp_newtoken',
      });
      expect(tokenRotation.ok).toBe(true);
      const setCallsAfterRotation = secrets.calls.filter((c) => c.fn === 'set').length;
      expect(setCallsAfterRotation).toBe(setCallsBefore + 1);
    });

    it('CONN-STORE-010b: Jira email-only update re-joins the existing token (no silent drop)', async () => {
      await store.init();
      const created = await store.create(jiraInput({ email: 'a@example.com', plaintextToken: 'jira-secret' }));
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      // Email-only update: NO plaintextToken in the input.
      const updated = await store.update(created.data.id, { email: 'b@example.com' });
      expect(updated.ok).toBe(true);

      // The new secret value should be `b@example.com\njira-secret` — the
      // existing token was preserved, the email was rotated.
      const stored = secrets.store.get(created.data.secretRef);
      expect(stored).toBe('b@example.com\njira-secret');
    });

    it('CONN-STORE-011: update() reports LABEL_NOT_UNIQUE on collision', async () => {
      await store.init();
      const a = await store.create(ghInput({ label: 'A' }));
      const b = await store.create(ghInput({ label: 'B' }));
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;

      // Try to rename B to A
      const collision = await store.update(b.data.id, { label: 'A' });
      expect(collision.ok).toBe(false);
      if (collision.ok) return;
      expect(collision.error.code).toBe('LABEL_NOT_UNIQUE');
    });
  });

  // -------------------------------------------------------------------------
  // CONN-STORE-012..013 — delete()
  // -------------------------------------------------------------------------
  describe('CONN-STORE-012..013 delete()', () => {
    it('CONN-STORE-012: delete() refuses with IN_USE if getReferencingProjectIds returns non-empty', async () => {
      const referencingFs = createMemFs();
      const referencingSecrets = createSecretsStub();
      const getReferencingProjectIds = vi
        .fn()
        .mockResolvedValue(['project-abc']);
      const refStore = makeStore({
        fs: referencingFs,
        secrets: referencingSecrets,
        getReferencingProjectIds,
      });
      await refStore.init();
      const created = await refStore.create(ghInput());
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const r = await refStore.delete(created.data.id);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('IN_USE');

      // details.referencedBy populated
      const details = r.error.details;
      expect(details).toBeDefined();
      // We cannot narrow without the discriminator, so assert structurally
      expect(typeof details === 'object' && details !== null).toBe(true);
      const referenced = (details as { referencedBy?: unknown })?.referencedBy;
      expect(Array.isArray(referenced)).toBe(true);
      expect(referenced).toEqual(['project-abc']);

      // Cascade delete NOT called
      const deleteCalls = referencingSecrets.calls.filter((c) => c.fn === 'delete');
      expect(deleteCalls).toHaveLength(0);

      // Connection still in list
      const list = await refStore.list();
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      expect(list.data.map((c) => c.id)).toContain(created.data.id);
    });

    it('CONN-STORE-013: delete() cascades secretsManager.delete; ignores cascade failure', async () => {
      await store.init();
      const created = await store.create(ghInput());
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      // Make the cascade reject — delete() should still succeed.
      secrets.rejectDeleteWith = new Error('keyring offline');

      const r = await store.delete(created.data.id);
      expect(r.ok).toBe(true);

      // Connection actually gone from envelope
      const list = await store.list();
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      expect(list.data.map((c) => c.id)).not.toContain(created.data.id);
    });

    it('CONN-STORE-013: delete() calls secretsManager.delete with the connection secretRef', async () => {
      await store.init();
      const created = await store.create(ghInput());
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const r = await store.delete(created.data.id);
      expect(r.ok).toBe(true);

      const deleteCalls = secrets.calls.filter((c) => c.fn === 'delete');
      expect(deleteCalls.map((c) => c.ref)).toContain(created.data.secretRef);
    });
  });

  // -------------------------------------------------------------------------
  // CONN-STORE-014 — recordVerification()
  // -------------------------------------------------------------------------
  describe('CONN-STORE-014 recordVerification()', () => {
    it('CONN-STORE-014: recordVerification() updates lastVerifiedAt + accountIdentity, bumps updatedAt', async () => {
      await store.init();
      const created = await store.create(ghInput());
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      // Yield so the wall clock can advance.
      await new Promise<void>((r) => setImmediate(r));

      const identity: ConnectionIdentity = {
        kind: 'github',
        login: 'gazhang',
        scopes: ['repo', 'read:user'],
      };
      const r = await store.recordVerification(created.data.id, identity);
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      expect(r.data.lastVerifiedAt).toBeGreaterThanOrEqual(created.data.createdAt);
      expect(r.data.accountIdentity).toEqual(identity);
      expect(r.data.verificationStatus).toBe('verified');
      expect(r.data.updatedAt).toBeGreaterThanOrEqual(created.data.updatedAt);
      expect(r.data.id).toBe(created.data.id);
      expect(r.data.createdAt).toBe(created.data.createdAt);
    });

    it('CONN-STORE-014b: markVerificationFailed() sets verificationStatus="auth-failed" and bumps updatedAt', async () => {
      await store.init();
      const created = await store.create(ghInput());
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      // First verify it, so we can confirm the field flips back.
      const identity: ConnectionIdentity = {
        kind: 'github',
        login: 'gazhang',
        scopes: ['repo'],
      };
      const verified = await store.recordVerification(created.data.id, identity);
      expect(verified.ok).toBe(true);
      if (!verified.ok) return;
      expect(verified.data.verificationStatus).toBe('verified');

      await new Promise<void>((r) => setImmediate(r));

      const failed = await store.markVerificationFailed(created.data.id);
      expect(failed.ok).toBe(true);
      if (!failed.ok) return;
      expect(failed.data.verificationStatus).toBe('auth-failed');
      // accountIdentity + lastVerifiedAt are preserved so the UI can show
      // "this WAS @gazhang, but the token is no longer valid".
      expect(failed.data.accountIdentity).toEqual(identity);
      expect(failed.data.lastVerifiedAt).toBe(verified.data.lastVerifiedAt);
      expect(failed.data.updatedAt).toBeGreaterThanOrEqual(verified.data.updatedAt);
    });

    it('CONN-STORE-014c: markVerificationFailed() returns NOT_FOUND for an unknown id', async () => {
      await store.init();
      const r = await store.markVerificationFailed('nope');
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.code).toBe('NOT_FOUND');
    });
  });

  // -------------------------------------------------------------------------
  // CONN-STORE-015 — atomic write
  // -------------------------------------------------------------------------
  describe('CONN-STORE-015 atomic write', () => {
    it('CONN-STORE-015: create() writes to a `.tmp-{uuid}` path then renames onto target', async () => {
      await store.init();
      // Reset op log so init's read isn't in our way.
      fs.ops.length = 0;

      const r = await store.create(ghInput());
      expect(r.ok).toBe(true);

      const writeIdx = fs.ops.findIndex(
        (op) =>
          op.kind === 'writeFile' &&
          op.path !== FILE_PATH &&
          op.path.startsWith(FILE_PATH),
      );
      const renameIdx = fs.ops.findIndex(
        (op) => op.kind === 'rename' && op.to === FILE_PATH,
      );
      expect(writeIdx).toBeGreaterThanOrEqual(0);
      expect(renameIdx).toBeGreaterThanOrEqual(0);
      expect(writeIdx).toBeLessThan(renameIdx);

      // Tmp path follows the `.tmp-{uuid}` pattern.
      const tmpWrite = fs.ops[writeIdx];
      if (tmpWrite?.kind === 'writeFile') {
        expect(tmpWrite.path).toMatch(/\.tmp-[0-9a-f-]+$/i);
      }

      // No raw write directly to target.
      const directWrites = fs.ops.filter(
        (op) => op.kind === 'writeFile' && op.path === FILE_PATH,
      );
      expect(directWrites).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // CONN-STORE-016 — concurrent create() (mutex)
  // -------------------------------------------------------------------------
  describe('CONN-STORE-016 concurrent create() (mutex)', () => {
    it('CONN-STORE-016: two concurrent create() calls both succeed; both appear in list; no clobber', async () => {
      await store.init();

      const p1 = store.create(ghInput({ label: 'A' }));
      const p2 = store.create(jiraInput({ label: 'B' }));
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.ok && r2.ok).toBe(true);
      if (!r1.ok || !r2.ok) return;
      expect(r1.data.id).not.toBe(r2.data.id);

      const list = await store.list();
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      expect(list.data).toHaveLength(2);
      const ids = list.data.map((c) => c.id);
      expect(ids).toContain(r1.data.id);
      expect(ids).toContain(r2.data.id);
    });
  });

  // -------------------------------------------------------------------------
  // CONN-STORE-017 — plaintext never appears on returned Connection
  // -------------------------------------------------------------------------
  describe('CONN-STORE-017 plaintext containment', () => {
    it('CONN-STORE-017: create() result does NOT carry plaintextToken or email-like fields beyond accountIdentity', async () => {
      await store.init();
      const r = await store.create(ghInput());
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      // Stringify and check the secret is nowhere in the returned object.
      const blob = JSON.stringify(r.data);
      expect(blob).not.toContain('ghp_secrettoken');
    });

    it('CONN-STORE-017: list() result for a Jira connection does NOT carry the joined plaintext', async () => {
      await store.init();
      const r = await store.create(jiraInput());
      expect(r.ok).toBe(true);

      const list = await store.list();
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      const blob = JSON.stringify(list.data);
      expect(blob).not.toContain('jira_secret_token');
      expect(blob).not.toContain('gazhang@emonster.tech\njira_secret_token');
    });

    it('CONN-STORE-017: get() result does NOT carry plaintextToken', async () => {
      await store.init();
      const created = await store.create(ghInput());
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const got = await store.get(created.data.id);
      expect(got.ok).toBe(true);
      if (!got.ok) return;
      const blob = JSON.stringify(got.data);
      expect(blob).not.toContain('ghp_secrettoken');
    });
  });
});
