import { describe, it, expect, vi } from 'vitest';
import * as path from 'node:path';
import { WorktreeManager, type WorktreeFs } from '../../src/main/modules/worktree-manager';
import { FakeSpawner, type FakeSpawnedProcess } from '../../src/main/modules/spawner';

/**
 * Cross-platform worktree path. The manager uses `path.join` internally,
 * which produces `\` on Windows and `/` on POSIX. Tests must agree.
 */
function wtPath(root: string, runId: string): string {
  return path.join(root, runId);
}

/** Poll until the spawner has captured a fresh spawn. The manager's
 *  addWorktree chains `await fs.mkdir(...)` before spawning, so the
 *  spawn doesn't happen on the same microtask as the call — multiple
 *  ticks may be needed. */
async function waitForSpawn(spawner: FakeSpawner, prevSpawned: FakeSpawnedProcess | null): Promise<FakeSpawnedProcess> {
  for (let i = 0; i < 100; i++) {
    if (spawner.lastSpawned !== null && spawner.lastSpawned !== prevSpawned) {
      return spawner.lastSpawned;
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error('spawner.lastSpawned never advanced');
}

/**
 * WT-001..010 — WorktreeManager (#GH-72 PR A).
 *
 * The manager wraps `git worktree add/remove/prune` via the existing
 * Spawner abstraction (same pattern used by claude-process-manager and
 * git-manager). Tests use `FakeSpawner` to capture argv + drive exit
 * codes deterministically. The fs facade is a minimal in-memory double
 * — only the four methods the manager uses (mkdir, readdir, exists,
 * and an internal stat-like check via readdir).
 *
 * Each `runGit` call from the manager produces ONE spawn; tests serially
 * drive each via `emitExit` so we can interleave argv assertions with
 * exit-code injection.
 */

function makeFs(): WorktreeFs & {
  mkdirCalls: string[];
  existing: Set<string>;
  dirContents: Map<string, string[]>;
} {
  const mkdirCalls: string[] = [];
  const existing = new Set<string>();
  const dirContents = new Map<string, string[]>();
  return {
    mkdirCalls,
    existing,
    dirContents,
    async mkdir(path, _opts): Promise<void> {
      mkdirCalls.push(path);
      existing.add(path);
    },
    async readdir(path): Promise<string[]> {
      if (!existing.has(path)) return [];
      return dirContents.get(path) ?? [];
    },
    async exists(path): Promise<boolean> {
      return existing.has(path);
    },
  };
}

/**
 * Drive a sequence of spawned processes to clean exit. Polls between
 * steps so async chains (mkdir → spawn, spawn-1 → exit → runGit resolve →
 * spawn-2) all advance.
 */
async function exitSequence(
  spawner: FakeSpawner,
  steps: Array<{ code: number; stderr?: string }>,
): Promise<void> {
  let prev: FakeSpawnedProcess | null = null;
  for (const step of steps) {
    const proc = await waitForSpawn(spawner, prev);
    if (step.stderr !== undefined) proc.emitStderr(step.stderr);
    proc.emitExit(step.code);
    prev = proc;
    // Yield so runGit resolves and the manager kicks off the next spawn.
    await new Promise((r) => setTimeout(r, 0));
  }
}

function makeManager(opts?: { worktreesRoot?: string; fs?: ReturnType<typeof makeFs> }) {
  const spawner = new FakeSpawner();
  const fs = opts?.fs ?? makeFs();
  const manager = new WorktreeManager({
    spawner,
    fs,
    worktreesRoot: opts?.worktreesRoot ?? '/userData/worktrees',
    timeoutMs: 1_000,
  });
  return { manager, spawner, fs };
}

describe('WorktreeManager — #GH-72 PR A', () => {
  describe('WT-001 addWorktree happy path', () => {
    it('WT-001: spawns `git worktree add --detach <cwd> <baseBranch>` in repoPath', async () => {
      const { manager, spawner, fs } = makeManager();
      const expectedCwd = wtPath('/userData/worktrees', 'r-abc');
      const promise = manager.addWorktree({
        runId: 'r-abc',
        baseBranch: 'main',
        repoPath: '/abs/repo',
      });
      const proc = await waitForSpawn(spawner, null);
      expect(fs.mkdirCalls).toContain('/userData/worktrees');
      const opts = spawner.lastOptions;
      expect(opts?.command).toBe('git');
      expect(opts?.args).toEqual([
        'worktree',
        'add',
        '--detach',
        expectedCwd,
        'main',
      ]);
      expect(opts?.cwd).toBe('/abs/repo');
      proc.emitExit(0);
      const res = await promise;
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data.cwd).toBe(expectedCwd);
      }
    });
  });

  describe('WT-002 addWorktree non-zero exit → ADD_FAILED', () => {
    it('WT-002: maps git failure to ADD_FAILED with stderr in details', async () => {
      const { manager, spawner } = makeManager();
      const promise = manager.addWorktree({
        runId: 'r-x',
        baseBranch: 'main',
        repoPath: '/abs/repo',
      });
      const proc = await waitForSpawn(spawner, null);
      proc.emitStderr("fatal: '/abs/repo' is not a git repository");
      proc.emitExit(128);
      const res = await promise;
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('ADD_FAILED');
        expect(res.error.details?.stderr).toContain('not a git repository');
      }
    });
  });

  describe('WT-003 removeWorktree happy path', () => {
    it('WT-003: spawns `git worktree remove --force <cwd>` in repoPath', async () => {
      const expectedCwd = wtPath('/userData/worktrees', 'r-abc');
      const fs = makeFs();
      fs.existing.add(expectedCwd);
      const { manager, spawner } = makeManager({ fs });
      const promise = manager.removeWorktree({
        runId: 'r-abc',
        repoPath: '/abs/repo',
      });
      const proc = await waitForSpawn(spawner, null);
      const opts = spawner.lastOptions;
      expect(opts?.args).toEqual([
        'worktree',
        'remove',
        '--force',
        expectedCwd,
      ]);
      expect(opts?.cwd).toBe('/abs/repo');
      proc.emitExit(0);
      const res = await promise;
      expect(res.ok).toBe(true);
    });
  });

  describe('WT-004 removeWorktree idempotent on missing dir', () => {
    it('WT-004: returns ok without spawning git when the worktree dir is absent', async () => {
      const { manager, spawner } = makeManager(); // fs.existing is empty
      const res = await manager.removeWorktree({
        runId: 'r-gone',
        repoPath: '/abs/repo',
      });
      expect(res.ok).toBe(true);
      // No spawn occurred — the manager short-circuited on the exists() check.
      expect(spawner.lastSpawned).toBeNull();
    });
  });

  describe('WT-005 removeWorktree non-zero exit → REMOVE_FAILED', () => {
    it('WT-005: maps git failure to REMOVE_FAILED with stderr in details', async () => {
      const fs = makeFs();
      fs.existing.add(wtPath('/userData/worktrees', 'r-x'));
      const { manager, spawner } = makeManager({ fs });
      const promise = manager.removeWorktree({
        runId: 'r-x',
        repoPath: '/abs/repo',
      });
      const proc = await waitForSpawn(spawner, null);
      proc.emitStderr('fatal: worktree is locked');
      proc.emitExit(128);
      const res = await promise;
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('REMOVE_FAILED');
      }
    });
  });

  describe('WT-006 pruneStaleWorktrees skips active runIds', () => {
    it('WT-006: removes only basenames not in activeRunIds, then runs `git worktree prune`', async () => {
      const fs = makeFs();
      fs.existing.add('/userData/worktrees');
      fs.dirContents.set('/userData/worktrees', ['r-alive', 'r-stale-1', 'r-stale-2']);
      const { manager, spawner } = makeManager({ fs });
      const promise = manager.pruneStaleWorktrees({
        repoPath: '/abs/repo',
        activeRunIds: new Set(['r-alive']),
      });
      // Three spawns expected: remove r-stale-1, remove r-stale-2, prune.
      await exitSequence(spawner, [{ code: 0 }, { code: 0 }, { code: 0 }]);
      const res = await promise;
      expect(res.ok).toBe(true);
      if (res.ok) {
        // r-alive is excluded; both stale runs are pruned.
        expect(res.data.pruned.sort()).toEqual(['r-stale-1', 'r-stale-2']);
      }
    });
  });

  describe('WT-007 pruneStaleWorktrees absent root returns empty', () => {
    it('WT-007: empty worktrees root → no spawns, pruned=[]', async () => {
      const { manager, spawner } = makeManager(); // fs.existing empty
      const res = await manager.pruneStaleWorktrees({
        repoPath: '/abs/repo',
        activeRunIds: new Set(),
      });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.data.pruned).toEqual([]);
      expect(spawner.lastSpawned).toBeNull();
    });
  });

  describe('WT-008 pruneStaleWorktrees individual-failure is non-fatal', () => {
    it('WT-008: one stale removal failing does NOT abort the rest of the sweep', async () => {
      const fs = makeFs();
      fs.existing.add('/userData/worktrees');
      fs.dirContents.set('/userData/worktrees', ['r-a', 'r-b']);
      const { manager, spawner } = makeManager({ fs });
      const promise = manager.pruneStaleWorktrees({
        repoPath: '/abs/repo',
        activeRunIds: new Set(),
      });
      // First removal fails; second succeeds; final prune succeeds.
      await exitSequence(spawner, [
        { code: 128, stderr: 'fatal: not a working tree' },
        { code: 0 },
        { code: 0 },
      ]);
      const res = await promise;
      expect(res.ok).toBe(true);
      if (res.ok) {
        // Only r-b made it into `pruned`; r-a failed and was skipped.
        expect(res.data.pruned).toEqual(['r-b']);
      }
    });
  });

  describe('WT-009 pruneStaleWorktrees terminal `prune` failure bubbles up', () => {
    it('WT-009: `git worktree prune` non-zero exit → PRUNE_FAILED', async () => {
      const fs = makeFs();
      fs.existing.add('/userData/worktrees');
      fs.dirContents.set('/userData/worktrees', []);
      const { manager, spawner } = makeManager({ fs });
      const promise = manager.pruneStaleWorktrees({
        repoPath: '/abs/repo',
        activeRunIds: new Set(),
      });
      // No removals (dir is empty), then the trailing `prune` call fails.
      await exitSequence(spawner, [{ code: 1, stderr: 'pickled' }]);
      const res = await promise;
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('PRUNE_FAILED');
      }
    });
  });

  describe('WT-010 pathFor returns runId joined under worktreesRoot', () => {
    it('WT-010: pathFor(runId) joins root + runId via path.join (platform-correct separators)', () => {
      const { manager } = makeManager({ worktreesRoot: '/custom/root' });
      expect(manager.pathFor('r-42')).toBe(wtPath('/custom/root', 'r-42'));
    });
  });
});

// Quell unused-import lint.
void vi;
