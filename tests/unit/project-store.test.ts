import { describe, it, expect, beforeEach } from 'vitest';
import {
  ProjectStore,
  type ProjectStoreFs,
} from '../../src/main/modules/project-store';
import type { SecretsResult } from '../../src/main/modules/secrets-manager';
import type {
  ProjectInstance,
  ProjectInstanceInput,
} from '../../src/shared/schema/project-instance';

/**
 * ProjectStore acceptance tests (PS-001 .. PS-015).
 *
 * Uses an in-memory `ProjectStoreFs` stub that records every fs op into an
 * event log so PS-007 can assert the temp+rename pattern. A minimal
 * `secretsManagerStub` records `delete()` calls and (optionally) rejects
 * to simulate failures.
 */

// ---------------------------------------------------------------------------
// In-memory ProjectStoreFs stub
// ---------------------------------------------------------------------------

type FsOp =
  | { kind: 'readFile'; path: string }
  | { kind: 'writeFile'; path: string; data: string }
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'unlink'; path: string }
  | { kind: 'mkdir'; path: string };

interface MemFs extends ProjectStoreFs {
  files: Map<string, string>;
  ops: FsOp[];
  /** Assign to throw a custom error from `readFile` (e.g. ENOENT). */
  readFileError?: NodeJS.ErrnoException;
  /** Override the ENOENT thrown when reading a missing file. */
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
      if (fs.readFileError) throw fs.readFileError;
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

interface SecretsManagerStub {
  delete: (ref: string) => Promise<SecretsResult<{ ref: string }>>;
  /** Refs that `delete()` was invoked with, in order. */
  deletedRefs: string[];
  /** When set to true, the next `delete()` call rejects with this error. */
  rejectWith?: Error;
}

function createSecretsStub(): SecretsManagerStub {
  const stub: SecretsManagerStub = {
    deletedRefs: [],
    delete: async (ref: string) => {
      stub.deletedRefs.push(ref);
      if (stub.rejectWith) {
        throw stub.rejectWith;
      }
      return { ok: true, data: { ref } };
    },
  };
  return stub;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FILE_PATH = '/userData/projects.json';

function validInput(overrides?: Partial<ProjectInstanceInput>): ProjectInstanceInput {
  return {
    name: 'My Project',
    repo: {
      type: 'github',
      localPath: '/abs/repo',
      baseBranch: 'main',
    },
    tickets: {
      source: 'jira',
      query: 'project = ABC',
    },
    workflow: {
      mode: 'interactive',
      branchFormat: 'feat/{ticketKey}',
    },
    ...overrides,
  };
}

function envelope(projects: ProjectInstance[]): string {
  return JSON.stringify({ schemaVersion: 1, projects });
}

function makeProject(over: Partial<ProjectInstance>): ProjectInstance {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    name: 'Existing',
    repo: { type: 'github', localPath: '/abs/repo', baseBranch: 'main' },
    tickets: { source: 'jira', query: 'project = ABC' },
    workflow: { mode: 'interactive', branchFormat: 'feat/{ticketKey}' },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProjectStore', () => {
  let fs: MemFs;
  let secrets: SecretsManagerStub;
  let store: ProjectStore;

  beforeEach(() => {
    fs = createMemFs();
    secrets = createSecretsStub();
    store = new ProjectStore({
      filePath: FILE_PATH,
      secretsManager: secrets,
      fs,
    });
  });

  // -------------------------------------------------------------------------
  // PS-001..004 — init()
  // -------------------------------------------------------------------------
  describe('PS-001..004 init()', () => {
    it('PS-001: init() with missing file → ok:true, count:0', async () => {
      const result = await store.init();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.count).toBe(0);

      const list = await store.list();
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      expect(list.data).toEqual([]);
    });

    it('PS-002: init() with valid file containing 2 projects → count:2 and list returns them', async () => {
      const a = makeProject({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'A' });
      const b = makeProject({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'B' });
      fs.files.set(FILE_PATH, envelope([a, b]));

      const init = await store.init();
      expect(init.ok).toBe(true);
      if (!init.ok) return;
      expect(init.data.count).toBe(2);

      const list = await store.list();
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      expect(list.data).toHaveLength(2);
      const ids = list.data.map((p) => p.id);
      expect(ids).toContain(a.id);
      expect(ids).toContain(b.id);
    });

    it('PS-003: init() with invalid JSON → FILE_CORRUPT', async () => {
      fs.files.set(FILE_PATH, '{ this is { not valid json');
      const result = await store.init();
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('FILE_CORRUPT');
    });

    it('PS-004: init() with schemaVersion 99 → UNSUPPORTED_SCHEMA_VERSION', async () => {
      fs.files.set(
        FILE_PATH,
        JSON.stringify({ schemaVersion: 99, projects: [] }),
      );
      const result = await store.init();
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('UNSUPPORTED_SCHEMA_VERSION');
    });
  });

  // -------------------------------------------------------------------------
  // PS-005..006 — create()
  // -------------------------------------------------------------------------
  describe('PS-005..006 create()', () => {
    it('PS-005: create() valid input → assigns id, createdAt, updatedAt; list reflects new project', async () => {
      await store.init();
      const before = Date.now();
      const result = await store.create(validInput({ name: 'Created' }));
      const after = Date.now();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(typeof result.data.id).toBe('string');
      expect(result.data.id.length).toBeGreaterThan(0);
      expect(result.data.name).toBe('Created');
      expect(result.data.createdAt).toBeGreaterThanOrEqual(before);
      expect(result.data.createdAt).toBeLessThanOrEqual(after);
      expect(result.data.updatedAt).toBe(result.data.createdAt);

      const list = await store.list();
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      expect(list.data.map((p) => p.id)).toContain(result.data.id);
    });

    it('PS-006: create() invalid input → VALIDATION_FAILED with details', async () => {
      await store.init();
      const result = await store.create({
        name: '',
        repo: { type: 'gitlab', localPath: './rel', baseBranch: '' },
        tickets: { source: 'foo', query: '' },
        workflow: { mode: 'turbo', branchFormat: 'no-placeholder' },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('VALIDATION_FAILED');
      expect(Array.isArray(result.error.details)).toBe(true);
      expect((result.error.details ?? []).length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // PS-007 — atomic write
  // -------------------------------------------------------------------------
  describe('PS-007 atomic write', () => {
    it('PS-007: create() writes to a temp path, then rename onto target', async () => {
      await store.init();
      // Drop any read ops from init() so we look only at write+rename ordering.
      fs.ops.length = 0;

      const result = await store.create(validInput());
      expect(result.ok).toBe(true);

      // Find the writeFile to a tmp path and the rename onto the target.
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
      // writeFile(temp) MUST happen before rename(temp -> target).
      expect(writeIdx).toBeLessThan(renameIdx);

      // No raw writeFile straight to the target — every mutation goes via temp.
      const directWrites = fs.ops.filter(
        (op) => op.kind === 'writeFile' && op.path === FILE_PATH,
      );
      expect(directWrites).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // PS-008 — get() unknown id
  // -------------------------------------------------------------------------
  describe('PS-008 get()', () => {
    it('PS-008: get() unknown id → NOT_FOUND', async () => {
      await store.init();
      const result = await store.get('00000000-0000-4000-8000-000000000000');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('NOT_FOUND');
    });
  });

  // -------------------------------------------------------------------------
  // PS-009..010 — update()
  // -------------------------------------------------------------------------
  describe('PS-009..010 update()', () => {
    it('PS-009: update() bumps updatedAt, preserves createdAt and id', async () => {
      await store.init();
      const created = await store.create(validInput({ name: 'V1' }));
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const original = created.data;

      // Wait a tick so updatedAt can plausibly differ. Using a tiny busy-wait
      // would be fragile; instead, just yield a microtask and assert >=.
      await new Promise<void>((r) => setImmediate(r));

      const updated = await store.update(
        original.id,
        validInput({ name: 'V2' }),
      );
      expect(updated.ok).toBe(true);
      if (!updated.ok) return;

      expect(updated.data.id).toBe(original.id);
      expect(updated.data.createdAt).toBe(original.createdAt);
      expect(updated.data.updatedAt).toBeGreaterThanOrEqual(original.updatedAt);
      expect(updated.data.name).toBe('V2');
    });

    it('PS-010: update() unknown id → NOT_FOUND', async () => {
      await store.init();
      const result = await store.update(
        '00000000-0000-4000-8000-000000000000',
        validInput(),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('NOT_FOUND');
    });
  });

  // -------------------------------------------------------------------------
  // PS-011..012 — delete() + cascade
  // -------------------------------------------------------------------------
  describe('PS-011..012 delete() cascade', () => {
    it('PS-011: delete() cascades to secrets for non-empty tokenRefs', async () => {
      await store.init();
      const created = await store.create(
        validInput({
          repo: {
            type: 'github',
            localPath: '/abs/repo',
            baseBranch: 'main',
            tokenRef: 'github-default',
          },
          tickets: {
            source: 'jira',
            query: 'project = ABC',
            tokenRef: 'jira-default',
          },
        }),
      );
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const result = await store.delete(created.data.id);
      expect(result.ok).toBe(true);

      expect(secrets.deletedRefs).toContain('github-default');
      expect(secrets.deletedRefs).toContain('jira-default');
    });

    it('PS-011: delete() does NOT call secrets.delete for missing/undefined tokenRefs', async () => {
      await store.init();
      const created = await store.create(validInput()); // no tokenRefs at all
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const result = await store.delete(created.data.id);
      expect(result.ok).toBe(true);
      expect(secrets.deletedRefs).toHaveLength(0);
    });

    it('PS-012: delete() proceeds even when secrets.delete rejects', async () => {
      await store.init();
      const created = await store.create(
        validInput({
          repo: {
            type: 'github',
            localPath: '/abs/repo',
            baseBranch: 'main',
            tokenRef: 'will-fail',
          },
        }),
      );
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      secrets.rejectWith = new Error('keychain offline');
      const result = await store.delete(created.data.id);
      expect(result.ok).toBe(true);

      // Project really gone.
      const after = await store.get(created.data.id);
      expect(after.ok).toBe(false);
      if (after.ok) return;
      expect(after.error.code).toBe('NOT_FOUND');
    });
  });

  // -------------------------------------------------------------------------
  // PS-013 — concurrent create() (mutex)
  // -------------------------------------------------------------------------
  describe('PS-013 concurrent create() (mutex)', () => {
    it('PS-013: two concurrent create() calls both succeed and both appear in list', async () => {
      await store.init();

      const p1 = store.create(validInput({ name: 'Concurrent A' }));
      const p2 = store.create(validInput({ name: 'Concurrent B' }));
      const [r1, r2] = await Promise.all([p1, p2]);

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      if (!r1.ok || !r2.ok) return;
      expect(r1.data.id).not.toBe(r2.data.id);

      const list = await store.list();
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      const names = list.data.map((p) => p.name);
      expect(names).toContain('Concurrent A');
      expect(names).toContain('Concurrent B');
      expect(list.data).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // PS-014 — round-trip after restart
  // -------------------------------------------------------------------------
  describe('PS-014 round-trip after restart', () => {
    it('PS-014: list/get round-trip after restart preserves all fields', async () => {
      await store.init();
      const a = await store.create(validInput({ name: 'Persistent A' }));
      const b = await store.create(validInput({ name: 'Persistent B' }));
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      if (!a.ok || !b.ok) return;

      // The fs stub now has the latest envelope at FILE_PATH. Spin up a new
      // ProjectStore against the SAME backing fs and re-init. (We deliberately
      // do not share `secrets` either — the new store has fresh stubs.)
      const fs2 = fs;
      const secrets2 = createSecretsStub();
      const store2 = new ProjectStore({
        filePath: FILE_PATH,
        secretsManager: secrets2,
        fs: fs2,
      });
      const init2 = await store2.init();
      expect(init2.ok).toBe(true);
      if (!init2.ok) return;
      expect(init2.data.count).toBe(2);

      const list = await store2.list();
      expect(list.ok).toBe(true);
      if (!list.ok) return;

      // Find each by id and assert exact equality on the persisted fields.
      for (const persisted of [a.data, b.data]) {
        const found = list.data.find((p) => p.id === persisted.id);
        expect(found).toBeDefined();
        if (!found) continue;
        expect(found.id).toBe(persisted.id);
        expect(found.name).toBe(persisted.name);
        expect(found.createdAt).toBe(persisted.createdAt);
        expect(found.updatedAt).toBe(persisted.updatedAt);
        expect(found.repo).toEqual(persisted.repo);
        expect(found.tickets).toEqual(persisted.tickets);
        expect(found.workflow).toEqual(persisted.workflow);
      }
    });
  });

  // -------------------------------------------------------------------------
  // PS-015 — delete() removes only the targeted project
  // -------------------------------------------------------------------------
  describe('PS-015 delete() targeting', () => {
    it('PS-015: delete() removes only the targeted project; others unchanged', async () => {
      await store.init();
      const a = await store.create(validInput({ name: 'A' }));
      const b = await store.create(validInput({ name: 'B' }));
      const c = await store.create(validInput({ name: 'C' }));
      expect(a.ok && b.ok && c.ok).toBe(true);
      if (!a.ok || !b.ok || !c.ok) return;

      const del = await store.delete(b.data.id);
      expect(del.ok).toBe(true);

      const list = await store.list();
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      const ids = list.data.map((p) => p.id);
      expect(ids).toContain(a.data.id);
      expect(ids).not.toContain(b.data.id);
      expect(ids).toContain(c.data.id);
      expect(list.data).toHaveLength(2);
    });
  });
});
