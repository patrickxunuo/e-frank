import { describe, it, expect } from 'vitest';
import { StubPrCreator } from '../../src/main/modules/pr-creator';

/**
 * PR-STUB-001 — StubPrCreator returns a deterministic fake URL whose path
 * contains the branchName so #7 tests can assert end-to-end propagation
 * without standing up a real GitHub client (real impl lands in #11).
 */

describe('StubPrCreator', () => {
  describe('PR-STUB-001 create', () => {
    it('PR-STUB-001: create returns ok with a URL that contains the branchName', async () => {
      const pr = new StubPrCreator();
      const result = await pr.create({
        cwd: '/abs/repo',
        branchName: 'feature/ABC-1-add-thing',
        baseBranch: 'main',
        title: 'feat(ABC-1): add thing',
        body: 'PR body',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(typeof result.data.url).toBe('string');
      expect(result.data.url.length).toBeGreaterThan(0);
      // The deterministic URL must reference the branchName so end-to-end
      // tests can verify the value flowed through.
      expect(result.data.url).toContain('feature/ABC-1-add-thing');
      expect(typeof result.data.number).toBe('number');
    });

    it('PR-STUB-001: a different branchName produces a different URL', async () => {
      const pr = new StubPrCreator();
      const a = await pr.create({
        cwd: '/abs/repo',
        branchName: 'feat/X-1',
        baseBranch: 'main',
        title: 't',
        body: 'b',
      });
      const b = await pr.create({
        cwd: '/abs/repo',
        branchName: 'feat/Y-2',
        baseBranch: 'main',
        title: 't',
        body: 'b',
      });
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      expect(a.data.url).toContain('feat/X-1');
      expect(b.data.url).toContain('feat/Y-2');
      expect(a.data.url).not.toBe(b.data.url);
    });
  });
});
