// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { useActiveRuns } from '../../src/renderer/state/active-run';
import type { IpcApi, IpcResult } from '../../src/shared/ipc';
import type { Run } from '../../src/shared/schema/run';

/**
 * ACTIVE-RUNS-001..006 — `useActiveRuns(projectId)` hook tests (#GH-81).
 *
 * The plural hook subscribes to `window.api.runs.{ listActive(), onListChanged() }`.
 * Mirrors the same patterns as the deleted `useActiveRun` (singular) tests:
 *  - Build a full `IpcApi` stub via `installApi()` and pin it on `window.api`.
 *  - Capture the registered `onListChanged` listener via a `vi.fn()` mock
 *    so tests can fire events directly.
 *  - `afterEach` deletes `window.api` and resets all mocks.
 */

declare global {
  interface Window {
    api?: IpcApi;
  }
}

interface CapturedHook {
  /** Latest runs[] returned by the hook (re-rendered on every change). */
  latest: Run[];
  /** All values seen across renders (for ordering assertions). */
  history: Run[][];
}

function HookConsumer({
  projectId,
  capture,
}: {
  projectId: string;
  capture: CapturedHook;
}): null {
  const value = useActiveRuns(projectId);
  useEffect(() => {
    capture.latest = value;
    capture.history.push(value);
  }, [value, capture]);
  return null;
}

interface ApiStub {
  api: IpcApi;
  runsListActive: Mock;
  runsOnListChanged: Mock;
  /** Manual fire — invokes the listener registered via onListChanged. */
  fireListChanged: (e: { runs: Run[] }) => void;
}

function installApi(opts: {
  /** runs[] returned from listActive on mount. */
  listActive?: { ok: true; data: Run[] } | { ok: false; error: { code: string; message: string } };
}): ApiStub {
  const unusedErr = (): IpcResult<never> => ({
    ok: false,
    error: { code: 'NOT_USED_IN_FE_TESTS', message: '' },
  });

  let listener: ((e: { runs: Run[] }) => void) | null = null;

  const listResult: IpcResult<{ runs: Run[] }> = opts.listActive
    ? opts.listActive.ok
      ? { ok: true, data: { runs: opts.listActive.data } }
      : opts.listActive
    : { ok: true, data: { runs: [] } };

  const runsListActive = vi.fn().mockResolvedValue(listResult);
  const runsOnListChanged = vi.fn((cb: (e: { runs: Run[] }) => void) => {
    listener = cb;
    return () => {
      listener = null;
    };
  });

  const api: IpcApi = {
    ping: vi.fn<IpcApi['ping']>().mockResolvedValue({ reply: 'pong', receivedAt: 0 }),
    app: {
      info: vi.fn().mockResolvedValue({ ok: false, error: { code: 'NOT_USED_IN_FE_TESTS', message: '' } }),
    },
    claudeCli: {
      probe: vi.fn().mockResolvedValue({ ok: false, error: { code: 'NOT_USED_IN_FE_TESTS', message: '' } }),
      probeOverride: vi.fn().mockResolvedValue({ ok: false, error: { code: 'NOT_USED_IN_FE_TESTS', message: '' } }),
    },
    claude: {
      run: vi.fn<IpcApi['claude']['run']>().mockResolvedValue(unusedErr()),
      cancel: vi.fn<IpcApi['claude']['cancel']>().mockResolvedValue(unusedErr()),
      write: vi.fn<IpcApi['claude']['write']>().mockResolvedValue(unusedErr()),
      status: vi
        .fn<IpcApi['claude']['status']>()
        .mockResolvedValue({ ok: true, data: { active: null } }),
      onOutput: vi.fn<IpcApi['claude']['onOutput']>(() => () => {}),
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
      current: vi.fn() as unknown as IpcApi['runs']['current'],
      listActive: runsListActive as unknown as IpcApi['runs']['listActive'],
      listHistory: vi.fn() as unknown as IpcApi['runs']['listHistory'],
      delete: vi.fn() as unknown as IpcApi['runs']['delete'],
      readLog: vi.fn().mockResolvedValue({ ok: true, data: { entries: [] } }),
      onCurrentChanged: vi.fn(() => () => {}) as unknown as IpcApi['runs']['onCurrentChanged'],
      onListChanged: runsOnListChanged as unknown as IpcApi['runs']['onListChanged'],
      onStateChanged: vi.fn(() => () => {}) as unknown as IpcApi['runs']['onStateChanged'],
    } as unknown as IpcApi['runs'],
    dialog: {
      selectFolder: vi.fn() as unknown as IpcApi['dialog']['selectFolder'],
    },
    tickets: {
      list: vi.fn() as unknown as IpcApi['tickets']['list'],
    },
    pulls: {
      list: vi.fn() as unknown as IpcApi['pulls']['list'],
    },
    chrome: {
      minimize: vi.fn() as unknown as IpcApi['chrome']['minimize'],
      maximize: vi.fn() as unknown as IpcApi['chrome']['maximize'],
      close: vi.fn() as unknown as IpcApi['chrome']['close'],
      getState: vi.fn() as unknown as IpcApi['chrome']['getState'],
      onStateChanged: vi.fn(() => () => {}) as unknown as IpcApi['chrome']['onStateChanged'],
    },
    skills: {
      list: vi.fn() as unknown as IpcApi['skills']['list'],
      install: vi.fn() as unknown as IpcApi['skills']['install'],
      remove: vi.fn() as unknown as IpcApi['skills']['remove'],
      findStart: vi.fn() as unknown as IpcApi['skills']['findStart'],
      findCancel: vi.fn() as unknown as IpcApi['skills']['findCancel'],
      onFindOutput: vi.fn(() => () => {}) as unknown as IpcApi['skills']['onFindOutput'],
      onFindExit: vi.fn(() => () => {}) as unknown as IpcApi['skills']['onFindExit'],
    },
    shell: {
      openPath: vi.fn() as unknown as IpcApi['shell']['openPath'],
      openExternal: vi.fn() as unknown as IpcApi['shell']['openExternal'],
      openLogDirectory: vi.fn() as unknown as IpcApi['shell']['openLogDirectory'],
    },
    appConfig: {
      get: vi.fn().mockResolvedValue({ ok: false, error: { code: 'NOT_USED_IN_FE_TESTS', message: '' } }),
      set: vi.fn().mockResolvedValue({ ok: false, error: { code: 'NOT_USED_IN_FE_TESTS', message: '' } }),
    },

  };

  (window as { api?: IpcApi }).api = api;
  return {
    api,
    runsListActive,
    runsOnListChanged,
    fireListChanged: (e) => {
      if (listener) listener(e);
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

afterEach(() => {
  cleanup();
  delete (window as { api?: IpcApi }).api;
  vi.restoreAllMocks();
});

describe('useActiveRuns — ACTIVE-RUNS (#GH-81)', () => {
  describe('ACTIVE-RUNS-001 mount + projectId filter', () => {
    it('ACTIVE-RUNS-001: mount → listActive called; matching projectId entries returned', async () => {
      const mine = makeRun({ id: 'r-1', projectId: 'p-1' });
      const other = makeRun({ id: 'r-2', projectId: 'OTHER' });
      const stub = installApi({ listActive: { ok: true, data: [mine, other] } });
      const cap: CapturedHook = { latest: [], history: [] };

      render(<HookConsumer projectId="p-1" capture={cap} />);

      await waitFor(() => {
        expect(stub.runsListActive).toHaveBeenCalledTimes(1);
      });
      await waitFor(() => {
        expect(cap.latest).toHaveLength(1);
      });
      expect(cap.latest[0]?.projectId).toBe('p-1');
      expect(cap.latest[0]?.id).toBe('r-1');
    });
  });

  describe('ACTIVE-RUNS-002 mount with zero matching runs', () => {
    it('ACTIVE-RUNS-002: only OTHER project runs in flight → empty array (NOT null)', async () => {
      const other = makeRun({ projectId: 'OTHER' });
      installApi({ listActive: { ok: true, data: [other] } });
      const cap: CapturedHook = { latest: [], history: [] };

      render(<HookConsumer projectId="p-1" capture={cap} />);
      await new Promise((r) => setTimeout(r, 20));
      expect(cap.latest).toEqual([]);
    });
  });

  describe('ACTIVE-RUNS-003 multiple concurrent runs for the project', () => {
    it('ACTIVE-RUNS-003: two matching + one other → returns 2-element array', async () => {
      const r1 = makeRun({ id: 'r-1', projectId: 'p-1', ticketKey: 'ABC-1' });
      const r2 = makeRun({ id: 'r-2', projectId: 'p-1', ticketKey: 'ABC-2' });
      const r3 = makeRun({ id: 'r-3', projectId: 'OTHER', ticketKey: 'XYZ-9' });
      installApi({ listActive: { ok: true, data: [r1, r2, r3] } });
      const cap: CapturedHook = { latest: [], history: [] };

      render(<HookConsumer projectId="p-1" capture={cap} />);
      await waitFor(() => {
        expect(cap.latest).toHaveLength(2);
      });
      expect(cap.latest.map((r) => r.id).sort()).toEqual(['r-1', 'r-2']);
    });
  });

  describe('ACTIVE-RUNS-004 onListChanged updates state', () => {
    it('ACTIVE-RUNS-004: list-changed event with new runs → hook value updates', async () => {
      const stub = installApi({ listActive: { ok: true, data: [] } });
      const cap: CapturedHook = { latest: [], history: [] };

      render(<HookConsumer projectId="p-1" capture={cap} />);
      await waitFor(() => {
        expect(stub.runsOnListChanged).toHaveBeenCalledTimes(1);
      });

      const r1 = makeRun({ id: 'r-1', projectId: 'p-1' });
      const r2 = makeRun({ id: 'r-2', projectId: 'p-1', state: 'planning' });
      act(() => {
        stub.fireListChanged({ runs: [r1, r2] });
      });

      await waitFor(() => {
        expect(cap.latest).toHaveLength(2);
      });
    });

    it('ACTIVE-RUNS-004: empty list-changed clears all entries (all runs terminal)', async () => {
      const stub = installApi({
        listActive: { ok: true, data: [makeRun({ projectId: 'p-1' })] },
      });
      const cap: CapturedHook = { latest: [], history: [] };

      render(<HookConsumer projectId="p-1" capture={cap} />);
      await waitFor(() => {
        expect(cap.latest).toHaveLength(1);
      });

      act(() => {
        stub.fireListChanged({ runs: [] });
      });
      await waitFor(() => {
        expect(cap.latest).toEqual([]);
      });
    });
  });

  describe('ACTIVE-RUNS-005 unsubscribe on unmount', () => {
    it('ACTIVE-RUNS-005: unmount calls the unsubscribe returned by onListChanged', async () => {
      const unsub = vi.fn();
      const stub = installApi({ listActive: { ok: true, data: [] } });
      stub.runsOnListChanged.mockImplementation(() => unsub);

      const cap: CapturedHook = { latest: [], history: [] };
      const { unmount } = render(<HookConsumer projectId="p-1" capture={cap} />);
      await waitFor(() => {
        expect(stub.runsOnListChanged).toHaveBeenCalledTimes(1);
      });
      unmount();
      expect(unsub).toHaveBeenCalled();
    });
  });

  describe('ACTIVE-RUNS-006 missing IPC bridge', () => {
    it('ACTIVE-RUNS-006: window.api === undefined → hook returns empty array without throwing', async () => {
      delete (window as { api?: IpcApi }).api;
      const cap: CapturedHook = { latest: [], history: [] };
      expect(() => {
        render(<HookConsumer projectId="p-1" capture={cap} />);
      }).not.toThrow();
      await new Promise((r) => setTimeout(r, 10));
      expect(cap.latest).toEqual([]);
    });
  });
});
