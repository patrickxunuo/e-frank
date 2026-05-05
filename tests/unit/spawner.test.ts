import { describe, it, expect, beforeEach } from 'vitest';
import {
  FakeSpawner,
  type FakeSpawnedProcess,
  type SpawnOptions,
} from '../../src/main/modules/spawner';

/**
 * Tests for the FakeSpawner test double itself.
 *
 * The FakeSpawner is the deterministic test seam used by every
 * ClaudeProcessManager test. If it doesn't behave exactly as advertised
 * here, every higher-level test becomes unreliable. So we exercise its
 * surface directly: spawn shape, lastSpawned tracking, stream emission,
 * exit/error wiring, kill/signal recording, and stdin write capture.
 */

const baseOptions: SpawnOptions = Object.freeze({
  command: 'claude',
  args: Object.freeze(['--ticket', 'ABC-123']) as ReadonlyArray<string>,
  cwd: '/abs/path',
  shell: true,
});

describe('FakeSpawner', () => {
  let spawner: FakeSpawner;

  beforeEach(() => {
    spawner = new FakeSpawner();
  });

  describe('spawn()', () => {
    it('returns a FakeSpawnedProcess with the expected shape', () => {
      const proc: FakeSpawnedProcess = spawner.spawn(baseOptions);

      // Required SpawnedProcess surface
      expect(proc).toBeDefined();
      expect('pid' in proc).toBe(true);
      expect(proc.pid === undefined || typeof proc.pid === 'number').toBe(true);
      expect('stdout' in proc).toBe(true);
      expect('stderr' in proc).toBe(true);
      expect('stdin' in proc).toBe(true);
      expect(proc.exitCode === null || typeof proc.exitCode === 'number').toBe(
        true,
      );
      expect(typeof proc.killed).toBe('boolean');
      expect(typeof proc.kill).toBe('function');
      expect(typeof proc.on).toBe('function');

      // Test-helper extensions
      expect(typeof proc.emitStdout).toBe('function');
      expect(typeof proc.emitStderr).toBe('function');
      expect(typeof proc.emitExit).toBe('function');
      expect(typeof proc.emitError).toBe('function');
      expect(Array.isArray(proc.stdinWrites)).toBe(true);
    });

    it('starts with exitCode: null and killed: false', () => {
      const proc = spawner.spawn(baseOptions);
      expect(proc.exitCode).toBeNull();
      expect(proc.killed).toBe(false);
    });

    it('starts with empty stdinWrites', () => {
      const proc = spawner.spawn(baseOptions);
      expect(proc.stdinWrites).toEqual([]);
    });

    it('exposes stdout/stderr as readable streams (or null)', () => {
      const proc = spawner.spawn(baseOptions);
      // Real ChildProcess can have null streams when stdio is 'ignore',
      // but for the fake we expect concrete streams so listeners can attach.
      expect(proc.stdout).not.toBeNull();
      expect(proc.stderr).not.toBeNull();
      expect(proc.stdin).not.toBeNull();
    });
  });

  describe('lastSpawned tracking', () => {
    it('is null before any spawn() call', () => {
      expect(spawner.lastSpawned).toBeNull();
    });

    it('is updated on each spawn() call', () => {
      const first = spawner.spawn(baseOptions);
      expect(spawner.lastSpawned).toBe(first);

      const second = spawner.spawn(baseOptions);
      expect(spawner.lastSpawned).toBe(second);
      expect(spawner.lastSpawned).not.toBe(first);
    });
  });

  describe('emitStdout / emitStderr', () => {
    it('emitStdout pushes data on the stdout stream', () => {
      const proc = spawner.spawn(baseOptions);
      const chunks: string[] = [];
      proc.stdout?.on('data', (chunk: Buffer | string) => {
        chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      });

      proc.emitStdout('hello\n');
      proc.emitStdout('world');

      expect(chunks.join('')).toBe('hello\nworld');
    });

    it('emitStderr pushes data on the stderr stream (and not stdout)', () => {
      const proc = spawner.spawn(baseOptions);
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      proc.stdout?.on('data', (c: Buffer | string) => {
        stdoutChunks.push(typeof c === 'string' ? c : c.toString('utf8'));
      });
      proc.stderr?.on('data', (c: Buffer | string) => {
        stderrChunks.push(typeof c === 'string' ? c : c.toString('utf8'));
      });

      proc.emitStderr('oops\n');

      expect(stderrChunks.join('')).toBe('oops\n');
      expect(stdoutChunks.join('')).toBe('');
    });
  });

  describe('emitExit', () => {
    it('triggers the "exit" listener with code and signal', () => {
      const proc = spawner.spawn(baseOptions);
      const calls: Array<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }> = [];
      proc.on('exit', (code, signal) => {
        calls.push({ code, signal });
      });

      proc.emitExit(0, null);

      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({ code: 0, signal: null });
    });

    it('passes signal through when provided', () => {
      const proc = spawner.spawn(baseOptions);
      const calls: Array<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }> = [];
      proc.on('exit', (code, signal) => {
        calls.push({ code, signal });
      });

      proc.emitExit(null, 'SIGTERM');

      expect(calls).toHaveLength(1);
      expect(calls[0]?.code).toBeNull();
      expect(calls[0]?.signal).toBe('SIGTERM');
    });

    it('updates exitCode after emitExit', () => {
      const proc = spawner.spawn(baseOptions);
      proc.emitExit(0, null);
      expect(proc.exitCode).toBe(0);
    });

    it('marks killed=true when exit is signalled', () => {
      const proc = spawner.spawn(baseOptions);
      proc.emitExit(null, 'SIGTERM');
      expect(proc.killed).toBe(true);
    });
  });

  describe('emitError', () => {
    it('triggers the "error" listener', () => {
      const proc = spawner.spawn(baseOptions);
      const errors: Error[] = [];
      proc.on('error', (err) => {
        errors.push(err);
      });

      const e = new Error('ENOENT: claude not found');
      proc.emitError(e);

      expect(errors).toHaveLength(1);
      expect(errors[0]).toBe(e);
    });
  });

  describe('kill()', () => {
    it('records the signal and returns true', () => {
      const proc = spawner.spawn(baseOptions);
      const result = proc.kill('SIGTERM');
      expect(result).toBe(true);
    });

    it('flips killed to true after kill()', () => {
      const proc = spawner.spawn(baseOptions);
      proc.kill('SIGTERM');
      expect(proc.killed).toBe(true);
    });

    it('handles kill() with no signal arg (defaults to SIGTERM-equivalent)', () => {
      const proc = spawner.spawn(baseOptions);
      const result = proc.kill();
      expect(result).toBe(true);
      expect(proc.killed).toBe(true);
    });
  });

  describe('stdinWrites', () => {
    it('records each write to stdin', () => {
      const proc = spawner.spawn(baseOptions);
      proc.stdin?.write('yes\n');
      proc.stdin?.write('again\n');

      expect(proc.stdinWrites).toEqual(['yes\n', 'again\n']);
    });

    it('records writes as strings even if a Buffer is written', () => {
      const proc = spawner.spawn(baseOptions);
      proc.stdin?.write(Buffer.from('buf-data', 'utf8'));

      expect(proc.stdinWrites).toHaveLength(1);
      expect(proc.stdinWrites[0]).toContain('buf-data');
    });
  });
});
