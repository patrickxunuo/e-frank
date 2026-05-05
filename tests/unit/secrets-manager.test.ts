import { describe, it, expect, beforeEach } from 'vitest';
import {
  SecretsManager,
  FakeSecretsBackend,
} from '../../src/main/modules/secrets-manager';
import type { ProjectStoreFs } from '../../src/main/modules/project-store';

/**
 * SecretsManager acceptance tests (SM-001 .. SM-012).
 *
 * Uses Agent B's `FakeSecretsBackend` (a real exported module, not test-only)
 * to avoid invoking Electron `safeStorage`. An in-memory `ProjectStoreFs`
 * stub records every fs op so SM-008 / SM-011 can inspect what landed on disk.
 */

// ---------------------------------------------------------------------------
// In-memory ProjectStoreFs stub (mirrors the one in project-store.test.ts;
// kept local so each test file is self-contained).
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
}

function createMemFs(initial: Record<string, string> = {}): MemFs {
  const files = new Map<string, string>(Object.entries(initial));
  const ops: FsOp[] = [];

  const fs: MemFs = {
    files,
    ops,

    async readFile(path: string, _enc: 'utf8'): Promise<string> {
      ops.push({ kind: 'readFile', path });
      const content = files.get(path);
      if (content === undefined) {
        const err = new Error(
          `ENOENT: no such file or directory, open '${path}'`,
        ) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
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

const FILE_PATH = '/userData/secrets.json';
const PLAINTEXT_TOKEN = 'super-secret-token-123';

describe('SecretsManager', () => {
  let fs: MemFs;
  let backend: FakeSecretsBackend;
  let mgr: SecretsManager;

  beforeEach(async () => {
    fs = createMemFs();
    backend = new FakeSecretsBackend({ available: true });
    mgr = new SecretsManager({ filePath: FILE_PATH, backend, fs });
    await mgr.init();
  });

  // -------------------------------------------------------------------------
  // SM-001..006 — round-trip basics
  // -------------------------------------------------------------------------
  describe('SM-001..006 round-trip basics', () => {
    it('SM-001: set() then get() round-trip returns the same plaintext', async () => {
      const setRes = await mgr.set('jira-default', PLAINTEXT_TOKEN);
      expect(setRes.ok).toBe(true);

      const getRes = await mgr.get('jira-default');
      expect(getRes.ok).toBe(true);
      if (!getRes.ok) return;
      expect(getRes.data.plaintext).toBe(PLAINTEXT_TOKEN);
    });

    it('SM-002: set() overwrites existing ref — second set wins', async () => {
      await mgr.set('jira-default', 'first-value');
      await mgr.set('jira-default', 'second-value');

      const getRes = await mgr.get('jira-default');
      expect(getRes.ok).toBe(true);
      if (!getRes.ok) return;
      expect(getRes.data.plaintext).toBe('second-value');
    });

    it('SM-003: get() missing ref → NOT_FOUND', async () => {
      const result = await mgr.get('nope');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('NOT_FOUND');
    });

    it('SM-004: delete() existing ref then get → NOT_FOUND', async () => {
      await mgr.set('jira-default', PLAINTEXT_TOKEN);

      const del = await mgr.delete('jira-default');
      expect(del.ok).toBe(true);

      const get = await mgr.get('jira-default');
      expect(get.ok).toBe(false);
      if (get.ok) return;
      expect(get.error.code).toBe('NOT_FOUND');
    });

    it('SM-005: delete() missing ref is idempotent — ok:true', async () => {
      const result = await mgr.delete('never-existed');
      expect(result.ok).toBe(true);
    });

    it('SM-006: list() returns ref names only — array of strings, no plaintext', async () => {
      await mgr.set('a', 'plain-A');
      await mgr.set('b', 'plain-B');

      const result = await mgr.list();
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(Array.isArray(result.data.refs)).toBe(true);
      for (const ref of result.data.refs) {
        expect(typeof ref).toBe('string');
      }
      expect(result.data.refs).toContain('a');
      expect(result.data.refs).toContain('b');

      // Defense: nothing in the list payload should look like a plaintext value.
      const serialized = JSON.stringify(result.data);
      expect(serialized).not.toContain('plain-A');
      expect(serialized).not.toContain('plain-B');
    });
  });

  // -------------------------------------------------------------------------
  // SM-007 — backend unavailable
  // -------------------------------------------------------------------------
  describe('SM-007 backend unavailable', () => {
    it('SM-007: set() with unavailable backend → BACKEND_UNAVAILABLE; nothing persisted', async () => {
      const offlineFs = createMemFs();
      const offlineBackend = new FakeSecretsBackend({ available: false });
      const offlineMgr = new SecretsManager({
        filePath: FILE_PATH,
        backend: offlineBackend,
        fs: offlineFs,
      });
      await offlineMgr.init();

      // Track writes that happened during init() (if any) so we only inspect
      // writes caused by the failed set().
      const writesBefore = offlineFs.ops.filter((op) => op.kind === 'writeFile').length;

      const result = await offlineMgr.set('any', PLAINTEXT_TOKEN);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('BACKEND_UNAVAILABLE');

      const writesAfter = offlineFs.ops.filter((op) => op.kind === 'writeFile').length;
      expect(writesAfter).toBe(writesBefore); // no new writes
    });

    it('SM-007: isAvailable() reflects backend availability', async () => {
      expect(mgr.isAvailable()).toBe(true);

      const offlineMgr = new SecretsManager({
        filePath: FILE_PATH,
        backend: new FakeSecretsBackend({ available: false }),
        fs: createMemFs(),
      });
      expect(offlineMgr.isAvailable()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // SM-008 — atomic write
  // -------------------------------------------------------------------------
  describe('SM-008 atomic write', () => {
    it('SM-008: set() writes to a temp path then renames onto target', async () => {
      // Drop any ops from init() so we look only at the write+rename ordering.
      fs.ops.length = 0;

      const result = await mgr.set('jira-default', PLAINTEXT_TOKEN);
      expect(result.ok).toBe(true);

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

      const directWrites = fs.ops.filter(
        (op) => op.kind === 'writeFile' && op.path === FILE_PATH,
      );
      expect(directWrites).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // SM-009..010 — init()
  // -------------------------------------------------------------------------
  describe('SM-009..010 init()', () => {
    it('SM-009: init() on missing file → ok:true, count:0', async () => {
      const freshFs = createMemFs();
      const freshMgr = new SecretsManager({
        filePath: FILE_PATH,
        backend: new FakeSecretsBackend({ available: true }),
        fs: freshFs,
      });
      const result = await freshMgr.init();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.count).toBe(0);
    });

    it('SM-010: init() with schemaVersion !== 1 → CORRUPT', async () => {
      const corruptFs = createMemFs({
        [FILE_PATH]: JSON.stringify({ schemaVersion: 99, secrets: {} }),
      });
      const corruptMgr = new SecretsManager({
        filePath: FILE_PATH,
        backend: new FakeSecretsBackend({ available: true }),
        fs: corruptFs,
      });
      const result = await corruptMgr.init();
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('CORRUPT');
    });
  });

  // -------------------------------------------------------------------------
  // SM-011 — plaintext NEVER appears in the file content
  // -------------------------------------------------------------------------
  describe('SM-011 plaintext never on disk', () => {
    it('SM-011: after multiple set() calls, no writeFile payload contains the plaintext', async () => {
      await mgr.set('a', PLAINTEXT_TOKEN);
      await mgr.set('b', PLAINTEXT_TOKEN + '-B');
      await mgr.set('c', 'yet-another-plaintext-value');

      const writes = fs.ops.filter(
        (op): op is Extract<FsOp, { kind: 'writeFile' }> => op.kind === 'writeFile',
      );
      expect(writes.length).toBeGreaterThan(0);

      for (const op of writes) {
        expect(op.data).not.toContain(PLAINTEXT_TOKEN);
        expect(op.data).not.toContain(PLAINTEXT_TOKEN + '-B');
        expect(op.data).not.toContain('yet-another-plaintext-value');
      }

      // Defense: also check the final on-disk content.
      const finalContent = fs.files.get(FILE_PATH);
      expect(finalContent).toBeDefined();
      if (!finalContent) return;
      expect(finalContent).not.toContain(PLAINTEXT_TOKEN);
      expect(finalContent).not.toContain('yet-another-plaintext-value');
    });
  });

  // -------------------------------------------------------------------------
  // SM-012 — corrupt blob on get()
  // -------------------------------------------------------------------------
  describe('SM-012 corrupt blob', () => {
    it('SM-012: get() on a corrupt-encrypted entry → CORRUPT', async () => {
      // Write a sidecar file directly with a non-base64-flipped (i.e. invalid)
      // blob for the ref. The FakeSecretsBackend.decryptString throws on
      // non-flipped input, which the manager should map to CORRUPT.
      const corruptFs = createMemFs({
        [FILE_PATH]: JSON.stringify({
          schemaVersion: 1,
          secrets: { 'broken-ref': '!!!not-valid-base64!!!' },
        }),
      });
      const corruptMgr = new SecretsManager({
        filePath: FILE_PATH,
        backend: new FakeSecretsBackend({ available: true }),
        fs: corruptFs,
      });
      const init = await corruptMgr.init();
      expect(init.ok).toBe(true);

      const result = await corruptMgr.get('broken-ref');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('CORRUPT');
    });
  });
});
