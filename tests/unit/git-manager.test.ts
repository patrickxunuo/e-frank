import { describe, it, expect } from 'vitest';
import { StubGitManager } from '../../src/main/modules/git-manager';

/**
 * GIT-STUB-001..004 — StubGitManager always returns ok.
 *
 * The real GitManager lands in #10. The stub keeps the workflow runner
 * end-to-end testable in #7 without spawning real `git` commands; these tests
 * pin the contract so #10's swap-in won't change the success-path shape.
 */

describe('StubGitManager', () => {
  // -------------------------------------------------------------------------
  // GIT-STUB-001 — prepareRepo
  // -------------------------------------------------------------------------
  describe('GIT-STUB-001 prepareRepo', () => {
    it('GIT-STUB-001: prepareRepo returns ok with a baseSha', async () => {
      const git = new StubGitManager();
      const result = await git.prepareRepo({
        projectId: 'p-1',
        cwd: '/abs/repo',
        baseBranch: 'main',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(typeof result.data.baseSha).toBe('string');
      expect(result.data.baseSha.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // GIT-STUB-002 — createBranch
  // -------------------------------------------------------------------------
  describe('GIT-STUB-002 createBranch', () => {
    it('GIT-STUB-002: createBranch returns ok and echoes the requested branchName', async () => {
      const git = new StubGitManager();
      const result = await git.createBranch({
        cwd: '/abs/repo',
        branchName: 'feature/ABC-1-add-thing',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.branchName).toBe('feature/ABC-1-add-thing');
    });
  });

  // -------------------------------------------------------------------------
  // GIT-STUB-003 — commit
  // -------------------------------------------------------------------------
  describe('GIT-STUB-003 commit', () => {
    it('GIT-STUB-003: commit returns ok with a non-empty stub sha', async () => {
      const git = new StubGitManager();
      const result = await git.commit({
        cwd: '/abs/repo',
        message: 'feat(ABC-1): add thing',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(typeof result.data.sha).toBe('string');
      expect(result.data.sha.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // GIT-STUB-004 — push
  // -------------------------------------------------------------------------
  describe('GIT-STUB-004 push', () => {
    it('GIT-STUB-004: push returns ok', async () => {
      const git = new StubGitManager();
      const result = await git.push({
        cwd: '/abs/repo',
        branchName: 'feature/ABC-1-add-thing',
      });
      expect(result.ok).toBe(true);
      // `remoteUrl` is optional; if present it should be a string.
      if (!result.ok) return;
      if (result.data.remoteUrl !== undefined) {
        expect(typeof result.data.remoteUrl).toBe('string');
      }
    });
  });
});
