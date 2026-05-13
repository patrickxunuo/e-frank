import { describe, it, expect } from 'vitest';
import {
  installSkillViaNpx,
  uninstallSkillViaNpx,
  InvalidSkillRefError,
  SKILL_REF_REGEX,
} from '../../src/main/modules/skill-npx-installer';
import { FakeSpawner } from '../../src/main/modules/spawner';

/**
 * SkillNpxInstaller tests — drives the installer through FakeSpawner.
 * Asserts argv shape, ref-validation, exit-code → status mapping,
 * stdout/stderr capture, and timeout fallback.
 */

const VALID_CWD = '/abs/userData';

describe('SkillNpxInstaller', () => {
  describe('NPX-INSTALL-001..003 ref validation', () => {
    it('NPX-INSTALL-001: throws InvalidSkillRefError on shell metacharacters', async () => {
      const spawner = new FakeSpawner();
      await expect(
        installSkillViaNpx({ spawner, ref: 'foo; rm -rf /', cwd: VALID_CWD }),
      ).rejects.toBeInstanceOf(InvalidSkillRefError);
      expect(spawner.lastOptions).toBeNull();
    });

    it('NPX-INSTALL-002: throws on backticks', async () => {
      const spawner = new FakeSpawner();
      await expect(
        installSkillViaNpx({ spawner, ref: 'foo`evil`', cwd: VALID_CWD }),
      ).rejects.toBeInstanceOf(InvalidSkillRefError);
    });

    it('NPX-INSTALL-003: accepts bare names, scoped npm, owner/name, urls', () => {
      // Acceptance for refs the `skills` CLI actually takes.
      expect(SKILL_REF_REGEX.test('ef-feature')).toBe(true);
      expect(SKILL_REF_REGEX.test('@scope/pkg')).toBe(true);
      expect(SKILL_REF_REGEX.test('scope/pkg@1.0.0')).toBe(true);
      expect(SKILL_REF_REGEX.test('owner/repo')).toBe(true);
      expect(SKILL_REF_REGEX.test('a/b/c.d-1')).toBe(true);
      expect(SKILL_REF_REGEX.test('with spaces')).toBe(false);
      expect(SKILL_REF_REGEX.test('with"quote')).toBe(false);
      expect(SKILL_REF_REGEX.test('with$dollar')).toBe(false);
    });
  });

  describe('NPX-INSTALL-010..013 argv + success', () => {
    it('NPX-INSTALL-010: spawns `npx skills add <ref> -g -y` by default', async () => {
      const spawner = new FakeSpawner();
      const promise = installSkillViaNpx({
        spawner,
        ref: 'ef-feature',
        cwd: VALID_CWD,
      });
      const proc = spawner.lastSpawned;
      expect(proc).not.toBeNull();
      expect(spawner.lastOptions?.command).toBe('npx');
      expect(spawner.lastOptions?.args).toEqual(['skills', 'add', 'ef-feature', '-g', '-y']);
      expect(spawner.lastOptions?.cwd).toBe(VALID_CWD);

      proc?.emitExit(0, null);
      const result = await promise;
      expect(result.status).toBe('installed');
      expect(result.exitCode).toBe(0);
    });

    it('NPX-INSTALL-011: exit non-zero maps to status: failed', async () => {
      const spawner = new FakeSpawner();
      const promise = installSkillViaNpx({ spawner, ref: 'broken', cwd: VALID_CWD });
      spawner.lastSpawned?.emitStderr('npm ERR! 404\n');
      spawner.lastSpawned?.emitExit(1, null);
      const result = await promise;
      expect(result.status).toBe('failed');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('npm ERR! 404');
    });

    it('NPX-INSTALL-012: tails stdout/stderr (last 4KB only)', async () => {
      const spawner = new FakeSpawner();
      const promise = installSkillViaNpx({ spawner, ref: 'big', cwd: VALID_CWD });
      const proc = spawner.lastSpawned;
      // Push >5KB of stdout to verify tail clamp.
      proc?.emitStdout('A'.repeat(5000));
      proc?.emitStdout('TAIL\n');
      proc?.emitExit(0, null);
      const result = await promise;
      expect(result.stdout.length).toBeLessThanOrEqual(4 * 1024);
      expect(result.stdout.endsWith('TAIL\n')).toBe(true);
    });

    it('NPX-INSTALL-013: spawn error resolves as failed with diagnostic', async () => {
      const spawner = new FakeSpawner();
      const promise = installSkillViaNpx({ spawner, ref: 'noop', cwd: VALID_CWD });
      spawner.lastSpawned?.emitError(new Error('ENOENT npx'));
      const result = await promise;
      expect(result.status).toBe('failed');
      expect(result.exitCode).toBeNull();
      expect(result.stderr).toContain('ENOENT npx');
    });
  });

  describe('NPX-INSTALL-020 timeout', () => {
    it('NPX-INSTALL-020: kills child and resolves failed when timeout fires', async () => {
      const spawner = new FakeSpawner();
      const promise = installSkillViaNpx({
        spawner,
        ref: 'slow',
        cwd: VALID_CWD,
        timeoutMs: 5,
      });
      // Do not emit exit — let the timeout fire.
      const result = await promise;
      expect(result.status).toBe('failed');
      expect(result.exitCode).toBeNull();
      expect(spawner.lastSpawned?.lastSignal).toBe('SIGTERM');
      expect(result.stderr).toContain('timed out');
    });
  });

  describe('NPX-UNINSTALL-001..005 remove path', () => {
    it('NPX-UNINSTALL-001: spawns `npx skills remove <ref> -g -y` by default', async () => {
      // `-y` is critical: without it, npx waits on an interactive
      // "Are you sure?" prompt and the child hangs until the 5min
      // timeout — the user perceives this as "Remove runs forever".
      // Regression guard against accidentally dropping the flag.
      const spawner = new FakeSpawner();
      const promise = uninstallSkillViaNpx({
        spawner,
        ref: 'ef-feature',
        cwd: VALID_CWD,
      });
      expect(spawner.lastOptions?.command).toBe('npx');
      expect(spawner.lastOptions?.args).toEqual(['skills', 'remove', 'ef-feature', '-g', '-y']);
      expect(spawner.lastOptions?.cwd).toBe(VALID_CWD);
      spawner.lastSpawned?.emitExit(0, null);
      const result = await promise;
      expect(result.status).toBe('installed'); // shared union — "npm op succeeded"
      expect(result.exitCode).toBe(0);
    });

    it('NPX-UNINSTALL-002: rejects invalid ref before spawning', async () => {
      const spawner = new FakeSpawner();
      await expect(
        uninstallSkillViaNpx({ spawner, ref: 'foo; rm -rf /', cwd: VALID_CWD }),
      ).rejects.toBeInstanceOf(InvalidSkillRefError);
      expect(spawner.lastOptions).toBeNull();
    });

    it('NPX-UNINSTALL-003: non-zero exit → status: failed (with stderr tail)', async () => {
      const spawner = new FakeSpawner();
      const promise = uninstallSkillViaNpx({ spawner, ref: 'nope', cwd: VALID_CWD });
      spawner.lastSpawned?.emitStderr('npm ERR! not installed\n');
      spawner.lastSpawned?.emitExit(1, null);
      const result = await promise;
      expect(result.status).toBe('failed');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not installed');
    });

    it('NPX-UNINSTALL-004: timeout kills child + resolves failed', async () => {
      const spawner = new FakeSpawner();
      const promise = uninstallSkillViaNpx({
        spawner,
        ref: 'slow',
        cwd: VALID_CWD,
        timeoutMs: 5,
      });
      const result = await promise;
      expect(result.status).toBe('failed');
      expect(spawner.lastSpawned?.lastSignal).toBe('SIGTERM');
      expect(result.stderr).toContain('timed out');
    });

    it('NPX-UNINSTALL-005: spawn error resolves failed with diagnostic', async () => {
      const spawner = new FakeSpawner();
      const promise = uninstallSkillViaNpx({ spawner, ref: 'noop', cwd: VALID_CWD });
      spawner.lastSpawned?.emitError(new Error('ENOENT npx'));
      const result = await promise;
      expect(result.status).toBe('failed');
      expect(result.exitCode).toBeNull();
      expect(result.stderr).toContain('ENOENT npx');
    });
  });
});
