import { describe, it, expect, beforeEach } from 'vitest';
import { RunStore } from '../../src/main/modules/run-store';
import type { ProjectStoreFs } from '../../src/main/modules/project-store';
import type { Run } from '../../src/shared/schema/run';

/**
 * RUNSTORE-001..010 — RunStore (per-run JSON sidecar persistence).
 *
 * Mirrors the in-memory `ProjectStoreFs` stub from `project-store.test.ts` /
 * `run-history.test.ts` so we can assert the temp+rename atomic-write pattern
 * (RUNSTORE-003) and concurrent-save mutex (RUNSTORE-010) without touching
 * disk.
 *
 * The `runsDir` is the directory holding `{runId}.json` sidecars. Each save
 * writes one file; list scans them all. The exact filename layout is up to
 * Agent B (the test asserts only that `save → get` round-trips and that
 * writes go through a temp+rename pattern under `runsDir`).
 */

// ---------------------------------------------------------------------------
// In-memory ProjectStoreFs stub — same shape as run-history.test.ts
// ---------------------------------------------------------------------------

type FsOp =
  | { kind: 'readFile'; path: string }
  | { kind: 'writeFile'; path: string; data: string }
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'unlink'; path: string }
  | { kind: 'mkdir'; path: string }
  | { kind: 'readdir'; path: string };

interface MemFs extends ProjectStoreFs {
  files: Map<string, string>;
  ops: FsOp[];
  /**
   * Optional `readdir` shim so RunStore can list run sidecars. Agent B may or
   * may not call this; if they don't, list() can still derive entries from
   * an in-memory index. The stub provides it on the off chance.
   */
  readdir?: (path: string) => Promise<string[]>;
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
    async readdir(path: string): Promise<string[]> {
      ops.push({ kind: 'readdir', path });
      // Return file names in `path/` (one level — RunStore stores one sidecar
      // per run as `{path}/{runId}.json`).
      const prefix = path.endsWith('/') ? path : `${path}/`;
      const out: string[] = [];
      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        // Skip nested paths and tmp files that haven't been renamed.
        if (rest.includes('/')) continue;
        out.push(rest);
      }
      return out;
    },
  };
  return fs;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RUNS_DIR = '/userData/runs';
const PROJECT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function makeRun(over: Partial<Run> = {}): Run {
  return {
    id: over.id ?? 'r-' + Math.random().toString(36).slice(2, 10),
    projectId: PROJECT_A,
    ticketKey: 'ABC-1',
    mode: 'interactive',
    branchName: 'feat/ABC-1',
    state: 'done',
    status: 'done',
    steps: [],
    pendingApproval: null,
    startedAt: 1_700_000_000_000,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RunStore', () => {
  let fs: MemFs;
  let store: RunStore;

  beforeEach(() => {
    fs = createMemFs();
    store = new RunStore({ runsDir: RUNS_DIR, fs });
  });

  // -------------------------------------------------------------------------
  // RUNSTORE-001 — init() with empty runsDir
  // -------------------------------------------------------------------------
  it('RUNSTORE-001: init() with empty runsDir → ok, count: 0', async () => {
    const res = await store.init();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.count).toBe(0);
  });

  // -------------------------------------------------------------------------
  // RUNSTORE-002 — save then get round-trip
  // -------------------------------------------------------------------------
  it('RUNSTORE-002: save() then get() round-trips data unchanged', async () => {
    await store.init();
    const run = makeRun({
      id: 'run-001',
      projectId: PROJECT_A,
      ticketKey: 'ABC-7',
      mode: 'yolo',
      branchName: 'feat/abc-7',
      state: 'done',
      status: 'done',
      steps: [
        {
          state: 'running',
          userVisibleLabel: 'Implementing feature',
          status: 'done',
          startedAt: 1,
          finishedAt: 2,
        },
      ],
      pendingApproval: null,
      startedAt: 1,
      finishedAt: 2,
      prUrl: 'https://example.test/pr/7',
    });
    const saveRes = await store.save(run);
    expect(saveRes.ok).toBe(true);
    if (!saveRes.ok) return;
    expect(saveRes.data.runId).toBe('run-001');

    const getRes = await store.get('run-001');
    expect(getRes.ok).toBe(true);
    if (!getRes.ok) return;
    // Deep-equal on the full Run shape.
    expect(getRes.data).toEqual(run);
  });

  // -------------------------------------------------------------------------
  // RUNSTORE-003 — atomic write pattern
  // -------------------------------------------------------------------------
  it('RUNSTORE-003: save() writes via temp + rename (no direct overwrite)', async () => {
    await store.init();
    fs.ops.length = 0;

    const run = makeRun({ id: 'atomic-1' });
    const res = await store.save(run);
    expect(res.ok).toBe(true);

    // Find a writeFile to a path under RUNS_DIR that is NOT the final filename
    // (i.e. a tmp path), and a rename that lands on a path under RUNS_DIR.
    const tmpWrite = fs.ops.find(
      (op): op is Extract<FsOp, { kind: 'writeFile' }> =>
        op.kind === 'writeFile' &&
        op.path.startsWith(RUNS_DIR) &&
        !op.path.endsWith('atomic-1.json'),
    );
    const finalRename = fs.ops.find(
      (op): op is Extract<FsOp, { kind: 'rename' }> =>
        op.kind === 'rename' &&
        op.to.startsWith(RUNS_DIR) &&
        op.to.endsWith('atomic-1.json'),
    );
    expect(tmpWrite).toBeDefined();
    expect(finalRename).toBeDefined();

    // No direct writeFile to the final sidecar.
    const directFinalWrite = fs.ops.find(
      (op) =>
        op.kind === 'writeFile' &&
        op.path.startsWith(RUNS_DIR) &&
        op.path.endsWith('atomic-1.json'),
    );
    expect(directFinalWrite).toBeUndefined();

    // tmp write must precede the rename.
    if (tmpWrite && finalRename) {
      const tmpIdx = fs.ops.indexOf(tmpWrite);
      const renameIdx = fs.ops.indexOf(finalRename);
      expect(tmpIdx).toBeLessThan(renameIdx);
    }
  });

  // -------------------------------------------------------------------------
  // RUNSTORE-004 — list newest-first
  // -------------------------------------------------------------------------
  it('RUNSTORE-004: list() returns runs sorted by startedAt desc', async () => {
    await store.init();
    const r1 = makeRun({ id: 'r-1', startedAt: 1_000 });
    const r2 = makeRun({ id: 'r-2', startedAt: 3_000 });
    const r3 = makeRun({ id: 'r-3', startedAt: 2_000 });
    await store.save(r1);
    await store.save(r2);
    await store.save(r3);

    const list = await store.list(PROJECT_A);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const startedAts = list.data.map((r) => r.startedAt);
    // Strictly non-increasing.
    for (let i = 1; i < startedAts.length; i++) {
      expect(startedAts[i - 1]!).toBeGreaterThanOrEqual(startedAts[i]!);
    }
    // The newest is r-2 (3_000).
    expect(list.data[0]?.id).toBe('r-2');
  });

  // -------------------------------------------------------------------------
  // RUNSTORE-005 — projectId filter
  // -------------------------------------------------------------------------
  it('RUNSTORE-005: list() filters by projectId', async () => {
    await store.init();
    await store.save(makeRun({ id: 'a-1', projectId: PROJECT_A, startedAt: 1 }));
    await store.save(makeRun({ id: 'a-2', projectId: PROJECT_A, startedAt: 2 }));
    await store.save(makeRun({ id: 'b-1', projectId: PROJECT_B, startedAt: 3 }));

    const aList = await store.list(PROJECT_A);
    expect(aList.ok).toBe(true);
    if (!aList.ok) return;
    expect(aList.data.map((r) => r.id).sort()).toEqual(['a-1', 'a-2']);

    const bList = await store.list(PROJECT_B);
    expect(bList.ok).toBe(true);
    if (!bList.ok) return;
    expect(bList.data.map((r) => r.id)).toEqual(['b-1']);
  });

  // -------------------------------------------------------------------------
  // RUNSTORE-006 — limit cap
  // -------------------------------------------------------------------------
  it('RUNSTORE-006: list() respects limit', async () => {
    await store.init();
    for (let i = 0; i < 7; i++) {
      await store.save(makeRun({ id: `r-${i}`, startedAt: i }));
    }
    const list = await store.list(PROJECT_A, 3);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.data.length).toBeLessThanOrEqual(3);
    // Newest 3 (startedAt 6, 5, 4) per RUNSTORE-004 ordering.
    expect(list.data.map((r) => r.id)).toEqual(['r-6', 'r-5', 'r-4']);
  });

  // -------------------------------------------------------------------------
  // RUNSTORE-007 — get() unknown id
  // -------------------------------------------------------------------------
  it('RUNSTORE-007: get() of an unknown runId → NOT_FOUND', async () => {
    await store.init();
    const res = await store.get('does-not-exist');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('NOT_FOUND');
  });

  // -------------------------------------------------------------------------
  // RUNSTORE-008 — get() on corrupt JSON
  // -------------------------------------------------------------------------
  it('RUNSTORE-008: get() of a corrupt sidecar → CORRUPT', async () => {
    await store.init();
    // Plant a malformed sidecar directly. The exact filename layout is up to
    // Agent B; we plant the most likely conventions (`{runId}.json` under
    // runsDir) and assert that loading by id flags it.
    fs.files.set(`${RUNS_DIR}/corrupt-1.json`, '{ this is not { valid json');

    const res = await store.get('corrupt-1');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('CORRUPT');
  });

  // -------------------------------------------------------------------------
  // RUNSTORE-009 — unsupported schemaVersion
  // -------------------------------------------------------------------------
  it('RUNSTORE-009: get() of a sidecar with schemaVersion != 1 → UNSUPPORTED_SCHEMA_VERSION', async () => {
    await store.init();
    fs.files.set(
      `${RUNS_DIR}/v99-1.json`,
      JSON.stringify({ schemaVersion: 99, run: makeRun({ id: 'v99-1' }) }),
    );

    const res = await store.get('v99-1');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('UNSUPPORTED_SCHEMA_VERSION');
  });

  // -------------------------------------------------------------------------
  // RUNSTORE-010 — concurrent saves (mutex)
  // -------------------------------------------------------------------------
  it('RUNSTORE-010: concurrent save() calls do not clobber each other', async () => {
    await store.init();

    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      ops.push(store.save(makeRun({ id: `concurrent-${i}`, startedAt: i })));
    }
    const results = await Promise.all(ops);
    for (const r of results) {
      expect((r as { ok: boolean }).ok).toBe(true);
    }

    const list = await store.list(PROJECT_A);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const ids = new Set(list.data.map((r) => r.id));
    for (let i = 0; i < 10; i++) {
      expect(ids.has(`concurrent-${i}`)).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // RUNSTORE-010 (extra) — repeated saves of the SAME run overwrite, not append
  // -------------------------------------------------------------------------
  it('RUNSTORE-010 (extra): repeated save() of the same runId overwrites in place', async () => {
    await store.init();
    const r1 = makeRun({ id: 'rolling-1', state: 'running', status: 'running' });
    await store.save(r1);

    const r2 = makeRun({ id: 'rolling-1', state: 'done', status: 'done' });
    await store.save(r2);

    const got = await store.get('rolling-1');
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.data.state).toBe('done');
    expect(got.data.status).toBe('done');

    // list() should report only ONE entry for this id.
    const list = await store.list(PROJECT_A);
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const occurrences = list.data.filter((r) => r.id === 'rolling-1').length;
    expect(occurrences).toBe(1);
  });
});
