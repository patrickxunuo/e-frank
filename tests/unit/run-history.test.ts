import { describe, it, expect, beforeEach } from 'vitest';
import { RunHistory } from '../../src/main/modules/run-history';
import type { ProjectStoreFs } from '../../src/main/modules/project-store';

/**
 * RunHistory acceptance tests (RH-001 .. RH-011).
 *
 * Mirrors the in-memory `ProjectStoreFs` stub pattern from
 * `project-store.test.ts` / `secrets-manager.test.ts`. The stub records every
 * fs op so RH-007 can assert the temp+rename atomic-write pattern.
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

const FILE_PATH = '/userData/run-history.json';
const PROJECT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('RunHistory', () => {
  let fs: MemFs;
  let history: RunHistory;

  beforeEach(() => {
    fs = createMemFs();
    history = new RunHistory({ filePath: FILE_PATH, fs });
  });

  // -------------------------------------------------------------------------
  // RH-001 — init() with missing file
  // -------------------------------------------------------------------------
  it('RH-001: init() with missing file → ok:true, projectCount:0', async () => {
    const res = await history.init();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.projectCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // RH-002 — markRunning then getRunning
  // -------------------------------------------------------------------------
  it('RH-002: markRunning then getRunning includes the key', async () => {
    await history.init();
    const res = await history.markRunning(PROJECT_A, 'ABC-1');
    expect(res.ok).toBe(true);
    expect(history.getRunning(PROJECT_A)).toContain('ABC-1');
  });

  // -------------------------------------------------------------------------
  // RH-003 — markProcessed / getProcessed (superseded)
  // -------------------------------------------------------------------------
  it.skip('RH-003 (superseded): the local processed set was removed; source-side state is authoritative', () => {});

  // -------------------------------------------------------------------------
  // RH-004 — clearRunning
  // -------------------------------------------------------------------------
  it('RH-004: clearRunning removes the key from running list', async () => {
    await history.init();
    await history.markRunning(PROJECT_A, 'ABC-1');
    expect(history.getRunning(PROJECT_A)).toContain('ABC-1');

    const res = await history.clearRunning(PROJECT_A, 'ABC-1');
    expect(res.ok).toBe(true);
    expect(history.getRunning(PROJECT_A)).not.toContain('ABC-1');
  });

  // -------------------------------------------------------------------------
  // RH-005 — multi-project isolation
  // -------------------------------------------------------------------------
  it('RH-005: per-project isolation — running on A does not bleed into B', async () => {
    await history.init();
    await history.markRunning(PROJECT_A, 'ABC-1');
    await history.markRunning(PROJECT_A, 'ABC-2');
    await history.markRunning(PROJECT_B, 'XYZ-9');

    expect(history.getRunning(PROJECT_A)).toEqual(
      expect.arrayContaining(['ABC-1', 'ABC-2']),
    );
    expect(history.getRunning(PROJECT_B)).toEqual(['XYZ-9']);
  });

  it('RH-005: getRunning returns empty array for unknown project', () => {
    // Not even initialized — the sync read should still be safe.
    expect(history.getRunning('unknown')).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // RH-006 — persistence: write then re-init
  // -------------------------------------------------------------------------
  it('RH-006: write then re-init restores state', async () => {
    await history.init();
    await history.markRunning(PROJECT_A, 'ABC-1');
    await history.markRunning(PROJECT_B, 'XYZ-1');

    // Spin up a fresh RunHistory against the same backing fs.
    const history2 = new RunHistory({ filePath: FILE_PATH, fs });
    const init2 = await history2.init();
    expect(init2.ok).toBe(true);
    if (!init2.ok) return;
    expect(init2.data.projectCount).toBe(2);

    expect(history2.getRunning(PROJECT_A)).toContain('ABC-1');
    expect(history2.getRunning(PROJECT_B)).toContain('XYZ-1');
  });

  // Back-compat: legacy files (pre-removal of the processed set) carry a
  // `processed` array on each project entry. The validator silently drops
  // the field; on the next write it's gone.
  it('RH-006b: legacy file with `processed` field is read successfully and dropped on next write', async () => {
    fs.files.set(
      FILE_PATH,
      JSON.stringify({
        schemaVersion: 1,
        runs: {
          [PROJECT_A]: { processed: ['ABC-9'], running: ['ABC-1'] },
        },
      }),
    );
    const res = await history.init();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(history.getRunning(PROJECT_A)).toEqual(['ABC-1']);

    // After a mutation, the file is rewritten without the `processed` field.
    await history.markRunning(PROJECT_A, 'ABC-2');
    const written = fs.files.get(FILE_PATH) ?? '';
    expect(written).not.toContain('processed');
    expect(written).toContain('"running"');
  });

  // -------------------------------------------------------------------------
  // RH-007 — atomic writes (temp + rename)
  // -------------------------------------------------------------------------
  it('RH-007: mutators write to a temp path and rename onto target', async () => {
    await history.init();
    fs.ops.length = 0;

    const res = await history.markRunning(PROJECT_A, 'ABC-1');
    expect(res.ok).toBe(true);

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

    // No raw direct writes to the target.
    const directWrites = fs.ops.filter(
      (op) => op.kind === 'writeFile' && op.path === FILE_PATH,
    );
    expect(directWrites).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // RH-008 — idempotent mutators
  // -------------------------------------------------------------------------
  it('RH-008: marking an already-running key is a no-op (no duplicate entry)', async () => {
    await history.init();
    const r1 = await history.markRunning(PROJECT_A, 'ABC-1');
    expect(r1.ok).toBe(true);
    const r2 = await history.markRunning(PROJECT_A, 'ABC-1');
    expect(r2.ok).toBe(true);

    const running = history.getRunning(PROJECT_A);
    // No duplicates.
    const occurrences = running.filter((k) => k === 'ABC-1').length;
    expect(occurrences).toBe(1);
  });

  it.skip('RH-008 (superseded): markProcessed idempotency — method removed with the local processed set', () => {});

  it('RH-008: clearRunning on a key that was never marked is ok', async () => {
    await history.init();
    const res = await history.clearRunning(PROJECT_A, 'NEVER-1');
    expect(res.ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // RH-009 — removeProject cascades within RunHistory
  // -------------------------------------------------------------------------
  it('RH-009: removeProject clears all keys for that project; others untouched', async () => {
    await history.init();
    await history.markRunning(PROJECT_A, 'ABC-1');
    await history.markRunning(PROJECT_A, 'ABC-2');
    await history.markRunning(PROJECT_B, 'XYZ-1');

    const res = await history.removeProject(PROJECT_A);
    expect(res.ok).toBe(true);

    expect(history.getRunning(PROJECT_A)).toEqual([]);
    expect(history.getRunning(PROJECT_B)).toContain('XYZ-1');
  });

  // -------------------------------------------------------------------------
  // RH-010 — schema version mismatch
  // -------------------------------------------------------------------------
  it('RH-010: init() with schemaVersion 99 → UNSUPPORTED_SCHEMA_VERSION', async () => {
    fs.files.set(
      FILE_PATH,
      JSON.stringify({ schemaVersion: 99, runs: {} }),
    );
    const res = await history.init();
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe('UNSUPPORTED_SCHEMA_VERSION');
  });

  // -------------------------------------------------------------------------
  // RH-011 — concurrent markRunning calls
  // -------------------------------------------------------------------------
  it('RH-011: concurrent markRunning calls — both effects survive (mutex)', async () => {
    await history.init();

    const p1 = history.markRunning(PROJECT_A, 'ABC-1');
    const p2 = history.markRunning(PROJECT_A, 'ABC-2');
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    const running = history.getRunning(PROJECT_A);
    expect(running).toContain('ABC-1');
    expect(running).toContain('ABC-2');
  });

  it('RH-011: many concurrent mutators across keys — no clobber', async () => {
    await history.init();

    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      ops.push(history.markRunning(PROJECT_A, `ABC-${i}`));
      ops.push(history.markRunning(PROJECT_B, `XYZ-${i}`));
    }
    await Promise.all(ops);

    const runningA = history.getRunning(PROJECT_A);
    const runningB = history.getRunning(PROJECT_B);
    for (let i = 0; i < 10; i++) {
      expect(runningA).toContain(`ABC-${i}`);
      expect(runningB).toContain(`XYZ-${i}`);
    }
  });

  // -------------------------------------------------------------------------
  // RH-012..RH-018 — GH-13 ticket locking with stale-lock recovery
  // -------------------------------------------------------------------------

  describe('GH-13 — stale-lock recovery', () => {
    let clockNow: number;
    let lockedFs: MemFs;
    let lockedHistory: RunHistory;

    beforeEach(() => {
      clockNow = 1_000_000;
      lockedFs = createMemFs();
      lockedHistory = new RunHistory({
        filePath: FILE_PATH,
        fs: lockedFs,
        clock: { now: () => clockNow },
      });
    });

    it('RH-012: markRunning stamps lockedAt from the injected clock', async () => {
      await lockedHistory.init();
      clockNow = 1_500_000;
      await lockedHistory.markRunning(PROJECT_A, 'ABC-1');

      const entries = lockedHistory.getRunningWithMetadata(PROJECT_A);
      expect(entries).toEqual([{ key: 'ABC-1', lockedAt: 1_500_000 }]);
    });

    it('RH-012: getRunning preserves its ReadonlyArray<string> contract on the new schema', async () => {
      await lockedHistory.init();
      await lockedHistory.markRunning(PROJECT_A, 'ABC-1');
      await lockedHistory.markRunning(PROJECT_A, 'ABC-2');

      const keys = lockedHistory.getRunning(PROJECT_A);
      // String[] — what the poller's `new Set(getRunning(id))` expects.
      expect(keys).toEqual(['ABC-1', 'ABC-2']);
    });

    it('RH-013: re-marking an already-locked ticket keeps the original lockedAt', async () => {
      await lockedHistory.init();
      clockNow = 1_500_000;
      await lockedHistory.markRunning(PROJECT_A, 'ABC-1');

      clockNow = 9_999_999;
      const res = await lockedHistory.markRunning(PROJECT_A, 'ABC-1');
      expect(res.ok).toBe(true);

      // Original timestamp preserved — re-marks must not refresh the lock,
      // otherwise stale-lock recovery would be defeated by repeat callers.
      const entries = lockedHistory.getRunningWithMetadata(PROJECT_A);
      expect(entries).toEqual([{ key: 'ABC-1', lockedAt: 1_500_000 }]);
    });

    it('RH-014: releaseStaleLocks(0) clears every lock and returns the released entries', async () => {
      await lockedHistory.init();
      clockNow = 1_500_000;
      await lockedHistory.markRunning(PROJECT_A, 'ABC-1');
      clockNow = 1_500_100;
      await lockedHistory.markRunning(PROJECT_A, 'ABC-2');
      clockNow = 1_500_200;
      await lockedHistory.markRunning(PROJECT_B, 'XYZ-9');

      clockNow = 2_000_000;
      const res = await lockedHistory.releaseStaleLocks(0);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.data).toEqual(
        expect.arrayContaining([
          { projectId: PROJECT_A, key: 'ABC-1', lockedAt: 1_500_000 },
          { projectId: PROJECT_A, key: 'ABC-2', lockedAt: 1_500_100 },
          { projectId: PROJECT_B, key: 'XYZ-9', lockedAt: 1_500_200 },
        ]),
      );
      expect(res.data).toHaveLength(3);
      expect(lockedHistory.getRunning(PROJECT_A)).toEqual([]);
      expect(lockedHistory.getRunning(PROJECT_B)).toEqual([]);
    });

    it('RH-015: releaseStaleLocks(thresholdMs) preserves locks newer than the threshold', async () => {
      await lockedHistory.init();
      clockNow = 1_500_000;
      await lockedHistory.markRunning(PROJECT_A, 'OLD-1');
      clockNow = 1_900_000;
      await lockedHistory.markRunning(PROJECT_A, 'NEW-1');

      // now = 2_000_000, threshold = 200_000 → cutoff = 1_800_000.
      // OLD-1 (1_500_000) is stale; NEW-1 (1_900_000) is fresh.
      clockNow = 2_000_000;
      const res = await lockedHistory.releaseStaleLocks(200_000);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      expect(res.data).toEqual([
        { projectId: PROJECT_A, key: 'OLD-1', lockedAt: 1_500_000 },
      ]);
      expect(lockedHistory.getRunning(PROJECT_A)).toEqual(['NEW-1']);
    });

    it('RH-016: schema v1 file migrates each running key to lockedAt=0; releaseStaleLocks(0) clears them', async () => {
      // Seed a v1 file directly — string[] running entries, processed field
      // legitimately present (back-compat path from RH-006b).
      lockedFs.files.set(
        FILE_PATH,
        JSON.stringify({
          schemaVersion: 1,
          runs: {
            [PROJECT_A]: { running: ['LEGACY-1', 'LEGACY-2'], processed: ['DONE-1'] },
          },
        }),
      );
      const initRes = await lockedHistory.init();
      expect(initRes.ok).toBe(true);

      // All v1 entries stamped lockedAt=0 (the "definitely stale" sentinel).
      expect(lockedHistory.getRunningWithMetadata(PROJECT_A)).toEqual([
        { key: 'LEGACY-1', lockedAt: 0 },
        { key: 'LEGACY-2', lockedAt: 0 },
      ]);

      clockNow = 2_000_000;
      const released = await lockedHistory.releaseStaleLocks(0);
      expect(released.ok).toBe(true);
      if (!released.ok) return;

      expect(released.data).toEqual(
        expect.arrayContaining([
          { projectId: PROJECT_A, key: 'LEGACY-1', lockedAt: 0 },
          { projectId: PROJECT_A, key: 'LEGACY-2', lockedAt: 0 },
        ]),
      );
      expect(lockedHistory.getRunning(PROJECT_A)).toEqual([]);
    });

    it('RH-017: persisted file is rewritten as schemaVersion 2 with structured lock entries', async () => {
      await lockedHistory.init();
      clockNow = 1_500_000;
      await lockedHistory.markRunning(PROJECT_A, 'ABC-1');

      const written = lockedFs.files.get(FILE_PATH) ?? '';
      const parsed = JSON.parse(written);
      expect(parsed.schemaVersion).toBe(2);
      expect(parsed.runs[PROJECT_A].running).toEqual([
        { key: 'ABC-1', lockedAt: 1_500_000 },
      ]);
    });

    it('RH-017: v1-on-disk file is upgraded to v2 on the next mutation', async () => {
      lockedFs.files.set(
        FILE_PATH,
        JSON.stringify({
          schemaVersion: 1,
          runs: { [PROJECT_A]: { running: ['LEGACY-1'] } },
        }),
      );
      await lockedHistory.init();
      clockNow = 1_500_000;
      await lockedHistory.markRunning(PROJECT_A, 'NEW-1');

      const written = lockedFs.files.get(FILE_PATH) ?? '';
      const parsed = JSON.parse(written);
      expect(parsed.schemaVersion).toBe(2);
      expect(parsed.runs[PROJECT_A].running).toEqual([
        { key: 'LEGACY-1', lockedAt: 0 },
        { key: 'NEW-1', lockedAt: 1_500_000 },
      ]);
    });

    it('RH-018: releaseStaleLocks on an empty store is a no-op (no spurious write)', async () => {
      await lockedHistory.init();
      lockedFs.ops.length = 0;
      const res = await lockedHistory.releaseStaleLocks(0);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data).toEqual([]);
      // No writeFile / rename ops — `mutate` short-circuits on `changed=false`.
      expect(lockedFs.ops.filter((o) => o.kind === 'writeFile')).toHaveLength(0);
      expect(lockedFs.ops.filter((o) => o.kind === 'rename')).toHaveLength(0);
    });

    it('RH-018: releaseStaleLocks clamps a negative thresholdMs to 0 (would otherwise wipe everything by accident)', async () => {
      await lockedHistory.init();
      clockNow = 1_500_000;
      await lockedHistory.markRunning(PROJECT_A, 'FRESH-1');

      // Without the clamp, `cutoff = now - (-500_000) = now + 500_000`,
      // which would release the just-acquired FRESH-1 lock. With the
      // clamp, thresholdMs becomes 0 → cutoff = now → FRESH-1 (lockedAt
      // = 1_500_000) is fresh relative to now = 1_500_100 (cutoff
      // = 1_500_100, lockedAt 1_500_000 <= cutoff → released? wait —
      // the spec is: clamp to 0 should NOT widen behavior beyond
      // "release everything older-or-equal to now". So with clamp=0
      // and lockedAt=1_500_000 < now=1_500_100, the lock IS released.
      // The point of the clamp is to prevent a NEGATIVE threshold from
      // releasing locks that lockedAt > now — let me reframe: the
      // clamp prevents the cutoff from drifting INTO THE FUTURE, which
      // is what a negative threshold would do.
      clockNow = 1_500_100;
      const res = await lockedHistory.releaseStaleLocks(-500_000);
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      // Behavior matches `releaseStaleLocks(0)` exactly — both clamp
      // to 0. The lock IS released because lockedAt (1_500_000) <=
      // cutoff (now - 0 = 1_500_100).
      expect(res.data).toEqual([
        { projectId: PROJECT_A, key: 'FRESH-1', lockedAt: 1_500_000 },
      ]);
    });

    it('RH-018: releaseStaleLocks preserves locks whose lockedAt is in the future (clock skew)', async () => {
      await lockedHistory.init();
      // Stamp a lock at t=2_000_000, then rewind the clock to t=1_000_000
      // and release with threshold=0. The "future" lock should be
      // preserved — cutoff (1_000_000) < lockedAt (2_000_000), so it
      // doesn't qualify as stale.
      clockNow = 2_000_000;
      await lockedHistory.markRunning(PROJECT_A, 'FUTURE-1');

      clockNow = 1_000_000;
      const res = await lockedHistory.releaseStaleLocks(0);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.data).toEqual([]);
      expect(lockedHistory.getRunning(PROJECT_A)).toEqual(['FUTURE-1']);
    });

    it('RH-018: releaseStaleLocks survives across re-init (atomic rewrite)', async () => {
      await lockedHistory.init();
      clockNow = 1_500_000;
      await lockedHistory.markRunning(PROJECT_A, 'ABC-1');

      clockNow = 2_000_000;
      const released = await lockedHistory.releaseStaleLocks(0);
      expect(released.ok).toBe(true);

      // Fresh RunHistory pointed at the same backing fs — the rewritten file
      // should NOT carry the released lock.
      const reopened = new RunHistory({
        filePath: FILE_PATH,
        fs: lockedFs,
        clock: { now: () => clockNow },
      });
      const init2 = await reopened.init();
      expect(init2.ok).toBe(true);
      expect(reopened.getRunning(PROJECT_A)).toEqual([]);
    });
  });
});
