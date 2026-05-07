// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { useRunLog } from '../../src/renderer/state/run-log';
import type {
  ClaudeOutputEvent,
  ClaudeStatusResponse,
  IpcApi,
  IpcResult,
  Run,
  RunStateEvent,
} from '../../src/shared/ipc';
import type { RunLogEntry } from '../../src/shared/schema/run';

/**
 * RUNLOG-HOOK-001..008 — `useRunLog(run)` renderer hook.
 *
 * Pattern mirrors `state-active-run.test.tsx`:
 *  - Build a tiny <HookConsumer /> that calls the hook and stashes the
 *    latest result into an external `cap` object so tests can inspect.
 *  - Capture the registered listeners (claude.onOutput, runs.onStateChanged)
 *    via `mockImplementation`s so tests can fire events directly.
 *  - `afterEach` deletes window.api and resets all mocks.
 */

declare global {
  interface Window {
    api?: IpcApi;
  }
}

interface CapturedHook {
  latest: ReturnType<typeof useRunLog> | null;
  history: ReturnType<typeof useRunLog>[];
}

function HookConsumer({
  run,
  capture,
}: {
  run: Run | null;
  capture: CapturedHook;
}): null {
  const value = useRunLog(run);
  useEffect(() => {
    capture.latest = value;
    capture.history.push(value);
  }, [value, capture]);
  return null;
}

interface ApiStub {
  api: IpcApi;
  onOutput: Mock;
  onStateChanged: Mock;
  readLog: Mock;
  status: Mock;
  current: Mock;
  /** Manual fire — invokes the listener registered via claude.onOutput. */
  fireOutput: (e: ClaudeOutputEvent) => void;
  /** Manual fire — invokes the listener registered via runs.onStateChanged. */
  fireStateChanged: (e: RunStateEvent) => void;
}

function installApi(opts?: {
  /** What runs.readLog returns. Defaults to ok+empty. */
  readLogResult?: IpcResult<{ entries: RunLogEntry[] }>;
  /** What claude.status returns. Defaults to no active run. */
  statusResult?: IpcResult<ClaudeStatusResponse>;
  /** What runs.current returns. Defaults to null. */
  currentResult?: IpcResult<{ run: Run | null }>;
}): ApiStub {
  const unusedErr = (): IpcResult<never> => ({
    ok: false,
    error: { code: 'NOT_USED_IN_FE_TESTS', message: '' },
  });

  let outputListener: ((e: ClaudeOutputEvent) => void) | null = null;
  let stateListener: ((e: RunStateEvent) => void) | null = null;

  const onOutput = vi.fn((cb: (e: ClaudeOutputEvent) => void) => {
    outputListener = cb;
    return () => {
      outputListener = null;
    };
  });
  const onStateChanged = vi.fn((cb: (e: RunStateEvent) => void) => {
    stateListener = cb;
    return () => {
      stateListener = null;
    };
  });
  const readLog = vi
    .fn()
    .mockResolvedValue(opts?.readLogResult ?? { ok: true, data: { entries: [] } });
  const status = vi
    .fn()
    .mockResolvedValue(
      opts?.statusResult ?? { ok: true, data: { active: null } },
    );
  const current = vi
    .fn()
    .mockResolvedValue(opts?.currentResult ?? { ok: true, data: { run: null } });

  const api: IpcApi = {
    ping: vi.fn<IpcApi['ping']>().mockResolvedValue({ reply: 'pong', receivedAt: 0 }),
    claude: {
      run: vi.fn<IpcApi['claude']['run']>().mockResolvedValue(unusedErr()),
      cancel: vi.fn<IpcApi['claude']['cancel']>().mockResolvedValue(unusedErr()),
      write: vi.fn<IpcApi['claude']['write']>().mockResolvedValue(unusedErr()),
      status: status as unknown as IpcApi['claude']['status'],
      onOutput: onOutput as unknown as IpcApi['claude']['onOutput'],
      onExit: vi.fn<IpcApi['claude']['onExit']>(() => () => {}),
    },
    projects: {
      list: vi.fn<IpcApi['projects']['list']>().mockResolvedValue(unusedErr()),
      get: vi.fn<IpcApi['projects']['get']>().mockResolvedValue(unusedErr()),
      create: vi.fn<IpcApi['projects']['create']>().mockResolvedValue(unusedErr()),
      update: vi.fn<IpcApi['projects']['update']>().mockResolvedValue(unusedErr()),
      delete: vi.fn<IpcApi['projects']['delete']>().mockResolvedValue(unusedErr()),
    },
    secrets: {
      set: vi.fn<IpcApi['secrets']['set']>().mockResolvedValue(unusedErr()),
      get: vi.fn<IpcApi['secrets']['get']>().mockResolvedValue(unusedErr()),
      delete: vi.fn<IpcApi['secrets']['delete']>().mockResolvedValue(unusedErr()),
      list: vi.fn<IpcApi['secrets']['list']>().mockResolvedValue(unusedErr()),
    },
    jira: {
      list: vi.fn<IpcApi['jira']['list']>().mockResolvedValue(unusedErr()),
      refresh: vi.fn<IpcApi['jira']['refresh']>().mockResolvedValue(unusedErr()),
      testConnection: vi
        .fn<IpcApi['jira']['testConnection']>()
        .mockResolvedValue(unusedErr()),
      refreshPollers: vi
        .fn<IpcApi['jira']['refreshPollers']>()
        .mockResolvedValue(unusedErr()),
      onTicketsChanged: vi.fn<IpcApi['jira']['onTicketsChanged']>(() => () => {}),
      onError: vi.fn<IpcApi['jira']['onError']>(() => () => {}),
    },
    connections: {
      list: vi.fn() as unknown as IpcApi['connections']['list'],
      get: vi.fn() as unknown as IpcApi['connections']['get'],
      create: vi.fn() as unknown as IpcApi['connections']['create'],
      update: vi.fn() as unknown as IpcApi['connections']['update'],
      delete: vi.fn() as unknown as IpcApi['connections']['delete'],
      test: vi.fn() as unknown as IpcApi['connections']['test'],
      listRepos: vi.fn() as unknown as IpcApi['connections']['listRepos'],
      listJiraProjects: vi.fn() as unknown as IpcApi['connections']['listJiraProjects'],
      listBranches: vi.fn() as unknown as IpcApi['connections']['listBranches'],
    },
    runs: {
      start: vi.fn() as unknown as IpcApi['runs']['start'],
      cancel: vi.fn() as unknown as IpcApi['runs']['cancel'],
      approve: vi.fn() as unknown as IpcApi['runs']['approve'],
      reject: vi.fn() as unknown as IpcApi['runs']['reject'],
      modify: vi.fn() as unknown as IpcApi['runs']['modify'],
      current: current as unknown as IpcApi['runs']['current'],
      listHistory: vi.fn() as unknown as IpcApi['runs']['listHistory'],
      onCurrentChanged: vi.fn(() => () => {}) as unknown as IpcApi['runs']['onCurrentChanged'],
      onStateChanged: onStateChanged as unknown as IpcApi['runs']['onStateChanged'],
      // Agent B is responsible for adding `readLog` to the typed IpcApi.
      // We patch it on the runtime stub via `unknown` cast.
      readLog: readLog,
    } as unknown as IpcApi['runs'],
    dialog: {
      selectFolder: vi.fn() as unknown as IpcApi['dialog']['selectFolder'],
    },
    tickets: {
      list: vi.fn() as unknown as IpcApi['tickets']['list'],
    },
  };

  (window as { api?: IpcApi }).api = api;
  return {
    api,
    onOutput,
    onStateChanged,
    readLog,
    status,
    current,
    fireOutput: (e) => {
      if (outputListener) outputListener(e);
    },
    fireStateChanged: (e) => {
      if (stateListener) stateListener(e);
    },
  };
}

function makeRun(over: Partial<Run> = {}): Run {
  return {
    id: 'r-1',
    projectId: 'p-1',
    ticketKey: 'ABC-1',
    mode: 'interactive',
    branchName: 'feat/abc-1',
    state: 'running',
    status: 'running',
    steps: [],
    pendingApproval: null,
    startedAt: 1,
    ...over,
  };
}

function makeEntry(over: Partial<RunLogEntry> = {}): RunLogEntry {
  return {
    runId: 'r-1',
    stream: 'stdout',
    line: 'hello',
    timestamp: 1,
    state: 'running',
    ...over,
  };
}

afterEach(() => {
  cleanup();
  delete (window as { api?: IpcApi }).api;
  vi.restoreAllMocks();
});

describe('useRunLog — RUNLOG-HOOK', () => {
  // -------------------------------------------------------------------------
  // RUNLOG-HOOK-001 — Live run subscribes to claude.onOutput; lines bucketed
  // -------------------------------------------------------------------------
  describe('RUNLOG-HOOK-001 live run subscribes & buckets new lines', () => {
    it('RUNLOG-HOOK-001: live run subscribes to claude.onOutput; new line lands in current step', async () => {
      const stub = installApi();
      const cap: CapturedHook = { latest: null, history: [] };

      const run = makeRun({ id: 'r-1', state: 'running' });
      render(<HookConsumer run={run} capture={cap} />);

      await waitFor(() => {
        expect(stub.onOutput).toHaveBeenCalledTimes(1);
      });

      act(() => {
        stub.fireOutput({
          runId: 'r-1',
          stream: 'stdout',
          line: 'compiling...',
          timestamp: Date.now(),
        });
      });

      await waitFor(() => {
        const steps = cap.latest?.steps ?? [];
        const allLines = steps.flatMap((s) => s.lines);
        expect(allLines.some((l) => l.line === 'compiling...')).toBe(true);
      });
    });
  });

  // -------------------------------------------------------------------------
  // RUNLOG-HOOK-002 — Terminal run loads via runs.readLog; no claude subscription
  // -------------------------------------------------------------------------
  describe('RUNLOG-HOOK-002 terminal run reads log; no live subscription', () => {
    it('RUNLOG-HOOK-002: terminal run → readLog called, claude.onOutput NOT subscribed', async () => {
      const persisted: RunLogEntry[] = [
        makeEntry({ runId: 'r-done', line: 'first', state: 'running' }),
        makeEntry({ runId: 'r-done', line: 'second', state: 'committing' }),
      ];
      const stub = installApi({
        readLogResult: { ok: true, data: { entries: persisted } },
      });
      const cap: CapturedHook = { latest: null, history: [] };

      const run = makeRun({ id: 'r-done', state: 'done', status: 'done' });
      render(<HookConsumer run={run} capture={cap} />);

      await waitFor(() => {
        expect(stub.readLog).toHaveBeenCalledWith({ runId: 'r-done' });
      });

      // The hook should NOT have subscribed to claude output for a terminal
      // run — there's no live producer to stream from.
      expect(stub.onOutput).not.toHaveBeenCalled();

      // Persisted lines should appear in the steps.
      await waitFor(() => {
        const allLines = (cap.latest?.steps ?? []).flatMap((s) => s.lines);
        expect(allLines.some((l) => l.line === 'first')).toBe(true);
        expect(allLines.some((l) => l.line === 'second')).toBe(true);
      });
    });
  });

  // -------------------------------------------------------------------------
  // RUNLOG-HOOK-003 — Pause halts new lines; bufferedLineCount increments
  // -------------------------------------------------------------------------
  describe('RUNLOG-HOOK-003 pause buffers incoming lines', () => {
    it('RUNLOG-HOOK-003: setPaused(true) → new lines do not append; bufferedLineCount > 0', async () => {
      const stub = installApi();
      const cap: CapturedHook = { latest: null, history: [] };

      render(<HookConsumer run={makeRun()} capture={cap} />);
      await waitFor(() => {
        expect(stub.onOutput).toHaveBeenCalled();
      });

      // Establish baseline line count BEFORE pausing.
      const baselineLineCount = (cap.latest?.steps ?? []).flatMap(
        (s) => s.lines,
      ).length;

      // Pause via the hook's exposed setter.
      act(() => {
        cap.latest?.setPaused(true);
      });

      await waitFor(() => {
        expect(cap.latest?.paused).toBe(true);
      });

      act(() => {
        stub.fireOutput({
          runId: 'r-1',
          stream: 'stdout',
          line: 'paused-1',
          timestamp: 1,
        });
        stub.fireOutput({
          runId: 'r-1',
          stream: 'stdout',
          line: 'paused-2',
          timestamp: 2,
        });
      });

      await waitFor(() => {
        expect(cap.latest?.bufferedLineCount).toBe(2);
      });

      // Steps did NOT receive the buffered lines.
      const lineCountWhilePaused = (cap.latest?.steps ?? []).flatMap(
        (s) => s.lines,
      ).length;
      expect(lineCountWhilePaused).toBe(baselineLineCount);
    });
  });

  // -------------------------------------------------------------------------
  // RUNLOG-HOOK-004 — Resume flushes buffer; bufferedLineCount → 0
  // -------------------------------------------------------------------------
  describe('RUNLOG-HOOK-004 resume flushes buffer', () => {
    it('RUNLOG-HOOK-004: setPaused(false) flushes buffer; bufferedLineCount drops to 0', async () => {
      const stub = installApi();
      const cap: CapturedHook = { latest: null, history: [] };

      render(<HookConsumer run={makeRun()} capture={cap} />);
      await waitFor(() => {
        expect(stub.onOutput).toHaveBeenCalled();
      });

      act(() => {
        cap.latest?.setPaused(true);
      });
      await waitFor(() => {
        expect(cap.latest?.paused).toBe(true);
      });

      act(() => {
        stub.fireOutput({
          runId: 'r-1',
          stream: 'stdout',
          line: 'flush-me',
          timestamp: 1,
        });
      });
      await waitFor(() => {
        expect(cap.latest?.bufferedLineCount).toBe(1);
      });

      act(() => {
        cap.latest?.setPaused(false);
      });

      await waitFor(() => {
        expect(cap.latest?.bufferedLineCount).toBe(0);
      });
      // The flushed line should now appear in the steps.
      const allLines = (cap.latest?.steps ?? []).flatMap((s) => s.lines);
      expect(allLines.some((l) => l.line === 'flush-me')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // RUNLOG-HOOK-005 — State-change events update step status
  // -------------------------------------------------------------------------
  describe('RUNLOG-HOOK-005 state-changed updates step status', () => {
    it('RUNLOG-HOOK-005: onStateChanged event flips a running step to done', async () => {
      const stub = installApi();
      const cap: CapturedHook = { latest: null, history: [] };

      const run = makeRun({ id: 'r-1', state: 'running' });
      render(<HookConsumer run={run} capture={cap} />);
      await waitFor(() => {
        expect(stub.onStateChanged).toHaveBeenCalled();
      });

      // Fire a state event that advances the run from `running` → `committing`.
      // The hook is expected to mark the previous step (`running`) as `done`
      // and add/select a new current step (`committing`).
      const updatedRun: Run = {
        ...run,
        state: 'committing',
        status: 'running',
        steps: [
          {
            state: 'running',
            userVisibleLabel: 'Implementing feature',
            status: 'done',
            startedAt: 1,
            finishedAt: 2,
          },
          {
            state: 'committing',
            userVisibleLabel: 'Committing changes',
            status: 'running',
            startedAt: 2,
          },
        ],
      };
      act(() => {
        stub.fireStateChanged({ runId: 'r-1', run: updatedRun });
      });

      await waitFor(() => {
        const steps = cap.latest?.steps ?? [];
        // At least one step has flipped to status === 'done'.
        expect(steps.some((s) => s.state === 'running' && s.status === 'done')).toBe(
          true,
        );
        // And at least one is currently running (committing).
        expect(
          steps.some((s) => s.state === 'committing' && s.status === 'running'),
        ).toBe(true);
      });
    });
  });

  // -------------------------------------------------------------------------
  // RUNLOG-HOOK-006 — Unmount unsubscribes
  // -------------------------------------------------------------------------
  describe('RUNLOG-HOOK-006 unsubscribes on unmount', () => {
    it('RUNLOG-HOOK-006: unmount calls the unsubscribe fn returned by both subscriptions', async () => {
      const offOutput = vi.fn();
      const offState = vi.fn();
      const stub = installApi();
      stub.onOutput.mockImplementation(() => offOutput);
      stub.onStateChanged.mockImplementation(() => offState);

      const cap: CapturedHook = { latest: null, history: [] };
      const { unmount } = render(
        <HookConsumer run={makeRun()} capture={cap} />,
      );

      await waitFor(() => {
        expect(stub.onOutput).toHaveBeenCalled();
        expect(stub.onStateChanged).toHaveBeenCalled();
      });

      unmount();
      expect(offOutput).toHaveBeenCalled();
      expect(offState).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // RUNLOG-HOOK-007 — Lines for a non-current claude run are filtered out
  // -------------------------------------------------------------------------
  describe('RUNLOG-HOOK-007 filters foreign-runId lines', () => {
    it('RUNLOG-HOOK-007: output events whose runId !== active claude run are ignored', async () => {
      // The hook filters by the ACTIVE claude run id (resolved via
      // `claude.status()`), not the workflow runId. Set status to return
      // an active claude runId so the filter has something to compare.
      const stub = installApi({
        statusResult: {
          ok: true,
          data: { active: { runId: 'claude-active', pid: 1, startedAt: 0 } },
        },
      });
      const cap: CapturedHook = { latest: null, history: [] };

      render(<HookConsumer run={makeRun({ id: 'r-1' })} capture={cap} />);

      // Wait for the claude.status() resolution to complete so the filter
      // is armed before we fire events.
      await waitFor(() => {
        expect(stub.status).toHaveBeenCalled();
      });
      // Allow the status promise to settle.
      await new Promise((r) => setTimeout(r, 10));

      // Fire two output events with different runIds — only the matching
      // claude runId should land in the steps.
      act(() => {
        stub.fireOutput({
          runId: 'OTHER',
          stream: 'stdout',
          line: 'foreign-line',
          timestamp: 1,
        });
        stub.fireOutput({
          runId: 'claude-active',
          stream: 'stdout',
          line: 'mine-line',
          timestamp: 2,
        });
      });

      await waitFor(() => {
        const allLines = (cap.latest?.steps ?? []).flatMap((s) => s.lines);
        expect(allLines.some((l) => l.line === 'mine-line')).toBe(true);
      });

      const allLinesAfter = (cap.latest?.steps ?? []).flatMap((s) => s.lines);
      expect(allLinesAfter.some((l) => l.line === 'foreign-line')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // RUNLOG-HOOK-008 — window.api === undefined → no crash, empty steps
  // -------------------------------------------------------------------------
  describe('RUNLOG-HOOK-008 missing IPC bridge', () => {
    it('RUNLOG-HOOK-008: window.api === undefined → no crash, empty steps', async () => {
      delete (window as { api?: IpcApi }).api;
      const cap: CapturedHook = { latest: null, history: [] };

      expect(() => {
        render(<HookConsumer run={makeRun()} capture={cap} />);
      }).not.toThrow();

      // Allow microtasks to flush.
      await new Promise((r) => setTimeout(r, 10));
      expect(cap.latest?.steps ?? []).toEqual([]);
    });

    it('RUNLOG-HOOK-008: run === null → no crash, empty steps', async () => {
      installApi();
      const cap: CapturedHook = { latest: null, history: [] };

      expect(() => {
        render(<HookConsumer run={null} capture={cap} />);
      }).not.toThrow();

      await new Promise((r) => setTimeout(r, 10));
      expect(cap.latest?.steps ?? []).toEqual([]);
    });
  });
});
