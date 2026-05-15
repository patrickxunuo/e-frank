import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverBinary,
  probeVersion,
  probe,
  runOnce,
  validateOverride,
} from '../../src/main/modules/claude-cli-probe';
import { FakeSpawner } from '../../src/main/modules/spawner';

/**
 * CLI-PROBE-001..018 — Claude CLI discovery + version probe + override
 * validation (#GH-85).
 *
 * All spawning goes through FakeSpawner; `validateOverride` is the only
 * function that touches the real filesystem (for `fs.access`), so its
 * tests use a tmpdir + real files.
 */

describe('runOnce — CLI-PROBE-RUNONCE', () => {
  it('CLI-PROBE-RUNONCE-001: accumulates stdout/stderr + resolves on exit(0)', async () => {
    const spawner = new FakeSpawner();
    const p = runOnce(spawner, 'echo', ['hi']);
    spawner.lastSpawned?.emitStdout('part1');
    spawner.lastSpawned?.emitStdout('part2\n');
    spawner.lastSpawned?.emitStderr('warn\n');
    spawner.lastSpawned?.emitExit(0, null);
    const r = await p;
    expect(r.stdout).toBe('part1part2\n');
    expect(r.stderr).toBe('warn\n');
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.spawnError).toBeNull();
  });

  it('CLI-PROBE-RUNONCE-002: propagates non-zero exit code', async () => {
    const spawner = new FakeSpawner();
    const p = runOnce(spawner, 'badcmd', []);
    spawner.lastSpawned?.emitExit(127, null);
    const r = await p;
    expect(r.exitCode).toBe(127);
    expect(r.spawnError).toBeNull();
  });

  it('CLI-PROBE-RUNONCE-003: spawn error becomes spawnError', async () => {
    const spawner = new FakeSpawner();
    const p = runOnce(spawner, 'noent', []);
    spawner.lastSpawned?.emitError(new Error('ENOENT'));
    const r = await p;
    expect(r.exitCode).toBeNull();
    expect(r.spawnError?.message).toBe('ENOENT');
  });

  it('CLI-PROBE-RUNONCE-004: timeout fires SIGTERM and reports timedOut=true', async () => {
    const spawner = new FakeSpawner();
    const p = runOnce(spawner, 'slow', [], { timeoutMs: 30 });
    // Don't emit exit until after the timeout fires.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(spawner.lastSpawned?.lastSignal).toBe('SIGTERM');
    // FakeSpawner won't emit exit on kill() automatically — simulate the
    // child obeying the signal.
    spawner.lastSpawned?.emitExit(null, 'SIGTERM');
    const r = await p;
    expect(r.timedOut).toBe(true);
  });
});

describe('discoverBinary — CLI-PROBE-DISCOVER', () => {
  it('CLI-PROBE-DISCOVER-001: posix → spawns `which claude`', async () => {
    const spawner = new FakeSpawner();
    const p = discoverBinary(spawner, 'linux');
    expect(spawner.lastOptions?.command).toBe('which');
    expect(spawner.lastOptions?.args).toEqual(['claude']);
    spawner.lastSpawned?.emitStdout('/usr/local/bin/claude\n');
    spawner.lastSpawned?.emitExit(0, null);
    const result = await p;
    expect(result).toBe('/usr/local/bin/claude');
  });

  it('CLI-PROBE-DISCOVER-002: win32 → spawns `where claude` and returns first line', async () => {
    const spawner = new FakeSpawner();
    const p = discoverBinary(spawner, 'win32');
    expect(spawner.lastOptions?.command).toBe('where');
    spawner.lastSpawned?.emitStdout('C:\\Users\\me\\claude.cmd\r\nC:\\Users\\me\\claude.ps1\r\n');
    spawner.lastSpawned?.emitExit(0, null);
    const result = await p;
    expect(result).toBe('C:\\Users\\me\\claude.cmd');
  });

  it('CLI-PROBE-DISCOVER-003: non-zero exit → null (not on PATH)', async () => {
    const spawner = new FakeSpawner();
    const p = discoverBinary(spawner, 'linux');
    spawner.lastSpawned?.emitExit(1, null);
    expect(await p).toBeNull();
  });

  it('CLI-PROBE-DISCOVER-004: spawn error → null', async () => {
    const spawner = new FakeSpawner();
    const p = discoverBinary(spawner, 'linux');
    spawner.lastSpawned?.emitError(new Error('ENOENT'));
    expect(await p).toBeNull();
  });
});

describe('probeVersion — CLI-PROBE-VERSION', () => {
  it('CLI-PROBE-VERSION-001: success → returns trimmed stdout', async () => {
    const spawner = new FakeSpawner();
    const p = probeVersion(spawner, '/usr/local/bin/claude');
    expect(spawner.lastOptions?.command).toBe('/usr/local/bin/claude');
    expect(spawner.lastOptions?.args).toEqual(['--version']);
    spawner.lastSpawned?.emitStdout('1.0.96 (Claude Code)\n');
    spawner.lastSpawned?.emitExit(0, null);
    const result = await p;
    expect(result.version).toBe('1.0.96 (Claude Code)');
    expect(result.error).toBeNull();
  });

  it('CLI-PROBE-VERSION-002: exit non-zero → NOT_EXECUTABLE', async () => {
    const spawner = new FakeSpawner();
    const p = probeVersion(spawner, '/broken');
    spawner.lastSpawned?.emitExit(1, null);
    const result = await p;
    expect(result.error).toBe('NOT_EXECUTABLE');
    expect(result.version).toBeNull();
    expect(result.errorMessage).toMatch(/exited with code 1/);
  });

  it('CLI-PROBE-VERSION-003: spawn error → NOT_EXECUTABLE', async () => {
    const spawner = new FakeSpawner();
    const p = probeVersion(spawner, '/missing');
    spawner.lastSpawned?.emitError(new Error('ENOENT'));
    const result = await p;
    expect(result.error).toBe('NOT_EXECUTABLE');
    expect(result.errorMessage).toBe('ENOENT');
  });

  it('CLI-PROBE-VERSION-004: empty stdout on success → version is null', async () => {
    const spawner = new FakeSpawner();
    const p = probeVersion(spawner, '/silent');
    spawner.lastSpawned?.emitExit(0, null);
    expect((await p).version).toBeNull();
  });
});

describe('validateOverride — CLI-PROBE-VALIDATE', () => {
  let dir = '';
  let realBinary = '';
  let fakeBinary = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gh85-probe-'));
    realBinary = join(dir, 'claude-mock');
    fakeBinary = join(dir, 'bash-mock');
    await writeFile(realBinary, '#!/bin/sh\n', { mode: 0o755 });
    await writeFile(fakeBinary, '#!/bin/sh\n', { mode: 0o755 });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('CLI-PROBE-VALIDATE-001: empty path → PATH_NOT_FOUND', async () => {
    const spawner = new FakeSpawner();
    const result = await validateOverride(spawner, '');
    expect(result.ok).toBe(false);
    if (result.ok) return; // narrow
    expect(result.error.code).toBe('PATH_NOT_FOUND');
  });

  it('CLI-PROBE-VALIDATE-002: missing file → PATH_NOT_FOUND', async () => {
    const spawner = new FakeSpawner();
    const result = await validateOverride(spawner, join(dir, 'does-not-exist'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('PATH_NOT_FOUND');
  });

  it('CLI-PROBE-VALIDATE-003: file exists but --version exits non-zero → NOT_EXECUTABLE', async () => {
    const spawner = new FakeSpawner();
    const p = validateOverride(spawner, realBinary);
    // file existed (access passes); now drive the --version probe to non-zero
    // Note: FakeSpawner is async-resilient — we wait for the spawn call to land.
    await new Promise((resolve) => setTimeout(resolve, 0));
    spawner.lastSpawned?.emitExit(2, null);
    const result = await p;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_EXECUTABLE');
  });

  it('CLI-PROBE-VALIDATE-004: --version output does not mention claude → NOT_CLAUDE', async () => {
    const spawner = new FakeSpawner();
    const p = validateOverride(spawner, fakeBinary);
    await new Promise((resolve) => setTimeout(resolve, 0));
    spawner.lastSpawned?.emitStdout('GNU bash, version 5.2.21(1)-release\n');
    spawner.lastSpawned?.emitExit(0, null);
    const result = await p;
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('NOT_CLAUDE');
  });

  it('CLI-PROBE-VALIDATE-005b: path with shell metacharacters is rejected with PATH_NOT_FOUND (no spawn)', async () => {
    const spawner = new FakeSpawner();
    for (const bad of ['/path & calc.exe', '`evil`', '$(id)', 'a; rm -rf /']) {
      const result = await validateOverride(spawner, bad);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe('PATH_NOT_FOUND');
    }
    // Never spawned.
    expect(spawner.lastOptions).toBeNull();
  });

  it('CLI-PROBE-VALIDATE-005: --version mentions claude → ok with resolved path + version', async () => {
    const spawner = new FakeSpawner();
    const p = validateOverride(spawner, realBinary);
    await new Promise((resolve) => setTimeout(resolve, 0));
    spawner.lastSpawned?.emitStdout('1.0.96 (Claude Code)\n');
    spawner.lastSpawned?.emitExit(0, null);
    const result = await p;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.resolvedPath).toBe(realBinary);
    expect(result.data.version).toBe('1.0.96 (Claude Code)');
  });
});

describe('probe (orchestrator) — CLI-PROBE-MAIN', () => {
  it('CLI-PROBE-MAIN-001: no override → discoverBinary then probeVersion (source: path)', async () => {
    const spawner = new FakeSpawner();
    const p = probe(spawner, null);
    // First spawn = which/where
    expect(spawner.lastOptions?.command).toMatch(/^(which|where)$/);
    spawner.lastSpawned?.emitStdout('/usr/bin/claude\n');
    spawner.lastSpawned?.emitExit(0, null);
    // Yield so the second spawn lands
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Second spawn = the resolved path
    expect(spawner.lastOptions?.command).toBe('/usr/bin/claude');
    expect(spawner.lastOptions?.args).toEqual(['--version']);
    spawner.lastSpawned?.emitStdout('1.0.96 (Claude Code)\n');
    spawner.lastSpawned?.emitExit(0, null);
    const result = await p;
    expect(result.resolvedPath).toBe('/usr/bin/claude');
    expect(result.version).toBe('1.0.96 (Claude Code)');
    expect(result.source).toBe('path');
  });

  it('CLI-PROBE-MAIN-002: discover returns null → source: not-found', async () => {
    const spawner = new FakeSpawner();
    const p = probe(spawner, null);
    spawner.lastSpawned?.emitExit(1, null); // not on PATH
    const result = await p;
    expect(result.resolvedPath).toBeNull();
    expect(result.version).toBeNull();
    expect(result.source).toBe('not-found');
  });

  it('CLI-PROBE-MAIN-003: override missing on disk → source: override + version null + resolvedPath = override', async () => {
    const spawner = new FakeSpawner();
    const result = await probe(spawner, '/totally/missing/claude');
    expect(result.resolvedPath).toBe('/totally/missing/claude');
    expect(result.version).toBeNull();
    expect(result.source).toBe('override');
  });
});
