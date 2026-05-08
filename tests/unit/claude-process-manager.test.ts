import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ClaudeProcessManager,
  type ExitEvent,
  type OutputEvent,
} from '../../src/main/modules/claude-process-manager';
import { FakeSpawner } from '../../src/main/modules/spawner';

/**
 * ClaudeProcessManager tests — drives the manager through the FakeSpawner
 * test double so no real `claude` CLI is invoked.
 *
 * Each test maps directly to an acceptance ID (CPM-001 ... CPM-022) so the
 * test report can be cross-referenced with the spec. Tests are grouped by
 * concern (streaming, validation, lifecycle, cancel, timeout, stdin,
 * spawn-error, status, runId uniqueness).
 */

const VALID_TICKET = 'ABC-123';
const VALID_CWD = '/abs/path';

interface Captured {
  output: OutputEvent[];
  exit: ExitEvent[];
}

function attach(manager: ClaudeProcessManager): Captured {
  const captured: Captured = { output: [], exit: [] };
  manager.on('output', (e) => {
    captured.output.push(e);
  });
  manager.on('exit', (e) => {
    captured.exit.push(e);
  });
  return captured;
}

describe('ClaudeProcessManager', () => {
  let spawner: FakeSpawner;
  let manager: ClaudeProcessManager;

  beforeEach(() => {
    spawner = new FakeSpawner();
    manager = new ClaudeProcessManager({ spawner });
  });

  // ---------------------------------------------------------------
  // CPM-001..004 — streaming
  // ---------------------------------------------------------------
  describe('CPM-001..004 streaming', () => {
    it('CPM-001: happy path: run → stream → exit', () => {
      const captured = attach(manager);

      const result = manager.run({
        ticketKey: VALID_TICKET,
        cwd: VALID_CWD,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(typeof result.data.runId).toBe('string');
      expect(result.data.runId.length).toBeGreaterThan(0);
      const runId = result.data.runId;

      const proc = spawner.lastSpawned;
      expect(proc).not.toBeNull();
      proc?.emitStdout('hello\n');
      proc?.emitExit(0, null);

      expect(captured.output).toHaveLength(1);
      expect(captured.output[0]).toMatchObject({
        runId,
        stream: 'stdout',
        line: 'hello',
      });
      expect(typeof captured.output[0]?.timestamp).toBe('number');

      expect(captured.exit).toHaveLength(1);
      expect(captured.exit[0]).toMatchObject({
        runId,
        exitCode: 0,
        reason: 'completed',
      });
      expect(typeof captured.exit[0]?.durationMs).toBe('number');
    });

    it('CPM-002: line buffering across chunks', () => {
      const captured = attach(manager);
      manager.run({ ticketKey: VALID_TICKET, cwd: VALID_CWD });
      const proc = spawner.lastSpawned;

      proc?.emitStdout('foo\nb');
      proc?.emitStdout('ar\n');

      const stdoutLines = captured.output
        .filter((e) => e.stream === 'stdout')
        .map((e) => e.line);
      expect(stdoutLines).toEqual(['foo', 'bar']);
    });

    it('CPM-003: trailing partial line is flushed on exit', () => {
      const captured = attach(manager);
      manager.run({ ticketKey: VALID_TICKET, cwd: VALID_CWD });
      const proc = spawner.lastSpawned;

      proc?.emitStdout('final-line');
      proc?.emitExit(0, null);

      const stdoutLines = captured.output
        .filter((e) => e.stream === 'stdout')
        .map((e) => e.line);
      expect(stdoutLines).toContain('final-line');
    });

    it('CPM-004: stderr is separately tagged', () => {
      const captured = attach(manager);
      manager.run({ ticketKey: VALID_TICKET, cwd: VALID_CWD });
      const proc = spawner.lastSpawned;

      proc?.emitStderr('oops\n');
      proc?.emitExit(0, null);

      const stderrEvents = captured.output.filter(
        (e) => e.stream === 'stderr',
      );
      expect(stderrEvents).toHaveLength(1);
      expect(stderrEvents[0]).toMatchObject({
        stream: 'stderr',
        line: 'oops',
      });
    });
  });

  // ---------------------------------------------------------------
  // CPM-005..008 — validation + lifecycle
  // ---------------------------------------------------------------
  describe('CPM-005..008 validation + lifecycle', () => {
    it('CPM-005: ticketKey validation rejects bad input — no spawn happens', () => {
      // Sanity: lastSpawned starts null
      expect(spawner.lastSpawned).toBeNull();

      const result = manager.run({ ticketKey: 'abc-123', cwd: VALID_CWD });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_TICKET_KEY');
      // Importantly: no spawn happened
      expect(spawner.lastSpawned).toBeNull();
    });

    it('CPM-005 (extras): rejects empty, lowercase, missing-number ticket keys', () => {
      const bad = ['', 'abc', 'ABC', 'ABC-', '-123', '1ABC-1', 'abc-1'];
      for (const k of bad) {
        const result = manager.run({ ticketKey: k, cwd: VALID_CWD });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('INVALID_TICKET_KEY');
        }
      }
      expect(spawner.lastSpawned).toBeNull();
    });

    it('CPM-006: cwd validation rejects relative paths', () => {
      const result = manager.run({
        ticketKey: 'A-1',
        cwd: 'relative/path',
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('INVALID_CWD');
      expect(spawner.lastSpawned).toBeNull();
    });

    it('CPM-007: single active run — second run while active is rejected', () => {
      const first = manager.run({ ticketKey: VALID_TICKET, cwd: VALID_CWD });
      expect(first.ok).toBe(true);

      const second = manager.run({ ticketKey: 'XYZ-9', cwd: VALID_CWD });
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.error.code).toBe('ALREADY_RUNNING');
    });

    it('CPM-008: run after previous exited is allowed', () => {
      const first = manager.run({ ticketKey: VALID_TICKET, cwd: VALID_CWD });
      expect(first.ok).toBe(true);
      spawner.lastSpawned?.emitExit(0, null);

      const second = manager.run({ ticketKey: 'XYZ-9', cwd: VALID_CWD });
      expect(second.ok).toBe(true);
    });

    // -- #37 ----------------------------------------------------------
    it('CPM-008b: spawn argv contains `"/ef-auto-feature <ticketKey>"` (quoted skill prompt) by default', () => {
      const result = manager.run({ ticketKey: VALID_TICKET, cwd: VALID_CWD });
      expect(result.ok).toBe(true);
      // First positional after the safety flag is the slash-command
      // invocation, wrapped in `"..."` so `shell: true` (default, needed
      // for Windows .cmd shims) doesn't split it on the embedded space.
      // Both cmd.exe and POSIX sh strip the surrounding quotes before
      // passing to claude as one argv. Default skill is `ef-auto-feature`
      // — e-frank's autonomous companion to `ef-feature`.
      const args = spawner.lastOptions?.args ?? [];
      expect(args).toEqual([
        '--dangerously-skip-permissions',
        `"/ef-auto-feature ${VALID_TICKET}"`,
      ]);
    });

    it('CPM-008c: skillName option overrides the default skill', () => {
      const customSpawner = new FakeSpawner();
      const customManager = new ClaudeProcessManager({
        spawner: customSpawner,
        skillName: 'custom-skill',
      });
      const result = customManager.run({ ticketKey: VALID_TICKET, cwd: VALID_CWD });
      expect(result.ok).toBe(true);
      const args = customSpawner.lastOptions?.args ?? [];
      expect(args[1]).toBe(`"/custom-skill ${VALID_TICKET}"`);
    });
  });

  // ---------------------------------------------------------------
  // CPM-009..013 — cancel
  // ---------------------------------------------------------------
  describe('CPM-009..013 cancel', () => {
    it('CPM-009: cancel sends SIGTERM', () => {
      const r = manager.run({ ticketKey: VALID_TICKET, cwd: VALID_CWD });
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      const proc = spawner.lastSpawned;
      const killSpy = vi.spyOn(proc!, 'kill');

      const cancelResult = manager.cancel(r.data.runId);
      expect(cancelResult.ok).toBe(true);
      expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    });

    it('CPM-010: cancel escalates to SIGKILL after grace', () => {
      vi.useFakeTimers();
      try {
        const localSpawner = new FakeSpawner();
        const localManager = new ClaudeProcessManager({
          spawner: localSpawner,
          killGraceMs: 50,
        });

        const r = localManager.run({
          ticketKey: VALID_TICKET,
          cwd: VALID_CWD,
        });
        expect(r.ok).toBe(true);
        if (!r.ok) return;

        const proc = localSpawner.lastSpawned;
        const killSpy = vi.spyOn(proc!, 'kill');

        localManager.cancel(r.data.runId);
        expect(killSpy).toHaveBeenCalledWith('SIGTERM');

        // Process does NOT exit; advance past the grace window.
        vi.advanceTimersByTime(60);

        expect(killSpy).toHaveBeenCalledWith('SIGKILL');
      } finally {
        vi.useRealTimers();
      }
    });

    it('CPM-011: cancel with no active run returns NOT_RUNNING', () => {
      const result = manager.cancel('any-id');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('NOT_RUNNING');
    });

    it('CPM-012: cancel with wrong runId returns NOT_RUNNING', () => {
      const r = manager.run({ ticketKey: VALID_TICKET, cwd: VALID_CWD });
      expect(r.ok).toBe(true);

      const result = manager.cancel('wrong-id');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('NOT_RUNNING');
    });

    it('CPM-013: cancel exit event has reason "cancelled"', () => {
      const captured = attach(manager);
      const r = manager.run({ ticketKey: VALID_TICKET, cwd: VALID_CWD });
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      manager.cancel(r.data.runId);
      // Simulate the OS confirming SIGTERM took effect.
      spawner.lastSpawned?.emitExit(null, 'SIGTERM');

      expect(captured.exit).toHaveLength(1);
      expect(captured.exit[0]).toMatchObject({
        runId: r.data.runId,
        reason: 'cancelled',
      });
    });
  });

  // ---------------------------------------------------------------
  // CPM-014..015 — timeout
  // ---------------------------------------------------------------
  describe('CPM-014..015 timeout', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('CPM-014: timeout fires automatically', () => {
      vi.useFakeTimers();
      const localSpawner = new FakeSpawner();
      const localManager = new ClaudeProcessManager({
        spawner: localSpawner,
        timeoutMs: 100,
      });
      const captured = attach(localManager);

      const r = localManager.run({
        ticketKey: VALID_TICKET,
        cwd: VALID_CWD,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      const proc = localSpawner.lastSpawned;
      const killSpy = vi.spyOn(proc!, 'kill');

      vi.advanceTimersByTime(150);
      expect(killSpy).toHaveBeenCalledWith('SIGTERM');

      // Simulate the process actually exiting in response to SIGTERM.
      proc?.emitExit(null, 'SIGTERM');

      expect(captured.exit).toHaveLength(1);
      expect(captured.exit[0]).toMatchObject({
        runId: r.data.runId,
        reason: 'timeout',
      });
    });

    it('CPM-015: timeout per-run override beats default', () => {
      vi.useFakeTimers();
      const localSpawner = new FakeSpawner();
      const localManager = new ClaudeProcessManager({
        spawner: localSpawner,
        timeoutMs: 100_000, // default high
      });
      const captured = attach(localManager);

      const r = localManager.run({
        ticketKey: VALID_TICKET,
        cwd: VALID_CWD,
        timeoutMs: 100, // override low
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      const proc = localSpawner.lastSpawned;
      const killSpy = vi.spyOn(proc!, 'kill');

      vi.advanceTimersByTime(150);
      expect(killSpy).toHaveBeenCalledWith('SIGTERM');

      proc?.emitExit(null, 'SIGTERM');

      expect(captured.exit).toHaveLength(1);
      expect(captured.exit[0]?.reason).toBe('timeout');
    });
  });

  // ---------------------------------------------------------------
  // CPM-016..018 — stdin write
  // ---------------------------------------------------------------
  describe('CPM-016..018 stdin write', () => {
    it('CPM-016: write to stdin succeeds', () => {
      const r = manager.run({ ticketKey: VALID_TICKET, cwd: VALID_CWD });
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      const writeResult = manager.write({
        runId: r.data.runId,
        text: 'yes\n',
      });
      expect(writeResult.ok).toBe(true);
      if (!writeResult.ok) return;
      expect(writeResult.data.bytesWritten).toBe(4);

      expect(spawner.lastSpawned?.stdinWrites).toContain('yes\n');
    });

    it('CPM-017: write before run returns NOT_RUNNING', () => {
      const result = manager.write({ runId: 'x', text: 'hi' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('NOT_RUNNING');
    });

    it('CPM-018: write after exit returns NOT_RUNNING', () => {
      const r = manager.run({ ticketKey: VALID_TICKET, cwd: VALID_CWD });
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      spawner.lastSpawned?.emitExit(0, null);

      const result = manager.write({ runId: r.data.runId, text: 'hi' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('NOT_RUNNING');
    });
  });

  // ---------------------------------------------------------------
  // CPM-019 — spawn error
  // ---------------------------------------------------------------
  describe('CPM-019 spawn error', () => {
    it('CPM-019: spawn error surfaces as exit + stderr line', () => {
      const captured = attach(manager);
      const r = manager.run({ ticketKey: VALID_TICKET, cwd: VALID_CWD });
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      spawner.lastSpawned?.emitError(new Error('ENOENT: claude not found'));

      const stderrEvents = captured.output.filter(
        (e) => e.stream === 'stderr',
      );
      expect(stderrEvents.length).toBeGreaterThanOrEqual(1);
      const matched = stderrEvents.some((e) => e.line.includes('ENOENT'));
      expect(matched).toBe(true);

      expect(captured.exit).toHaveLength(1);
      expect(captured.exit[0]).toMatchObject({
        runId: r.data.runId,
        reason: 'error',
        exitCode: null,
      });
      expect(captured.exit[0]?.signal).toBeNull();
    });
  });

  // ---------------------------------------------------------------
  // CPM-020..022 — status + runId uniqueness
  // ---------------------------------------------------------------
  describe('CPM-020..022 status + runId uniqueness', () => {
    it('CPM-020: status reports active run matching the run response', () => {
      const r = manager.run({ ticketKey: VALID_TICKET, cwd: VALID_CWD });
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      const s = manager.status();
      expect(s).not.toBeNull();
      expect(s).toEqual({
        runId: r.data.runId,
        pid: r.data.pid,
        startedAt: r.data.startedAt,
      });
    });

    it('CPM-021: status returns null when idle', () => {
      expect(manager.status()).toBeNull();
    });

    it('CPM-021 (extra): status returns null after a run exits', () => {
      manager.run({ ticketKey: VALID_TICKET, cwd: VALID_CWD });
      spawner.lastSpawned?.emitExit(0, null);
      expect(manager.status()).toBeNull();
    });

    it('CPM-022: runIds are unique across runs', () => {
      const first = manager.run({ ticketKey: VALID_TICKET, cwd: VALID_CWD });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      spawner.lastSpawned?.emitExit(0, null);

      const second = manager.run({ ticketKey: 'XYZ-9', cwd: VALID_CWD });
      expect(second.ok).toBe(true);
      if (!second.ok) return;

      expect(second.data.runId).not.toBe(first.data.runId);
      expect(second.data.runId.length).toBeGreaterThan(0);
    });
  });
});
