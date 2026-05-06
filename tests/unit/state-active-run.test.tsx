// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { useActiveRun } from '../../src/renderer/state/active-run';
import type { IpcApi, IpcResult } from '../../src/shared/ipc';
import type { Run } from '../../src/shared/schema/run';

/**
 * ACTIVE-RUN-001..006 — `useActiveRun` hook tests.
 *
 * The hook subscribes to `window.api.runs.{ current(), onCurrentChanged() }`.
 * Since `@testing-library/react`'s `renderHook` may or may not be available
 * in this version, we render a tiny `<HookConsumer />` component that calls
 * the hook and stashes the latest value into a ref so tests can read it.
 *
 * Patterns mirror `tests/unit/views-project-detail.test.tsx`:
 *  - Build a full `IpcApi` stub via `installApi()` and pin it on `window.api`.
 *  - Capture the registered `onCurrentChanged` listener via a `vi.fn()`
 *    `.mockImplementation` so tests can fire events directly.
 *  - `afterEach` deletes `window.api` and resets all mocks.
 */

declare global {
  interface Window {
    api?: IpcApi;
  }
}

interface CapturedHook {
  /** Latest run returned by the hook (re-rendered on every change). */
  latest: Run | null;
  /** All values seen across renders (for ordering assertions). */
  history: (Run | null)[];
}

// Render a small consumer that drives the hook. We use a ref-style external
// captor so tests can inspect what the hook returned without depending on
// `renderHook` (whose API differs across React Testing Library versions).
function HookConsumer({
  projectId,
  capture,
}: {
  projectId: string;
  capture: CapturedHook;
}): null {
  const value = useActiveRun(projectId);
  useEffect(() => {
    capture.latest = value;
    capture.history.push(value);
    // We intentionally depend on the identity of `value` so every change is
    // observed.
  }, [value, capture]);
  return null;
}

interface ApiStub {
  api: IpcApi;
  runsCurrent: Mock;
  runsOnCurrentChanged: Mock;
  /** Manual fire — invokes the listener registered via onCurrentChanged. */
  fireCurrentChanged: (e: { run: Run | null }) => void;
}

function installApi(opts: {
  /** Test-friendly shorthand: `current.data` is the Run (or null) — the
   *  helper wraps it in the IPC `{ run: Run | null }` envelope. */
  current?: { ok: true; data: Run | null } | { ok: false; error: { code: string; message: string } };
}): ApiStub {
  const unusedErr = (): IpcResult<never> => ({
    ok: false,
    error: { code: 'NOT_USED_IN_FE_TESTS', message: '' },
  });

  let listener: ((e: { run: Run | null }) => void) | null = null;

  // Convert the test's flat `data: Run | null` into the IPC contract's
  // `data: { run: Run | null }` envelope so the hook (which destructures
  // `data.run`) sees the right shape.
  const currentResult: IpcResult<{ run: Run | null }> = opts.current
    ? opts.current.ok
      ? { ok: true, data: { run: opts.current.data } }
      : opts.current
    : { ok: true, data: { run: null } };

  const runsCurrent = vi.fn().mockResolvedValue(currentResult);
  const runsOnCurrentChanged = vi.fn(
    (cb: (e: { run: Run | null }) => void) => {
      listener = cb;
      return () => {
        listener = null;
      };
    },
  );

  // Build a complete `IpcApi` so renderer code that accidentally pokes other
  // namespaces doesn't blow up. Only `runs.current` and `runs.onCurrentChanged`
  // are exercised by these tests.
  const api: IpcApi = {
    ping: vi.fn<IpcApi['ping']>().mockResolvedValue({ reply: 'pong', receivedAt: 0 }),
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
    // Cast so we can install `runs` even though IpcApi['runs'] is a typed
    // interface — Agent B is responsible for the schema, we just need the
    // runtime shape for the hook to call against.
    runs: {
      start: vi.fn() as unknown as IpcApi['runs']['start'],
      cancel: vi.fn() as unknown as IpcApi['runs']['cancel'],
      approve: vi.fn() as unknown as IpcApi['runs']['approve'],
      reject: vi.fn() as unknown as IpcApi['runs']['reject'],
      modify: vi.fn() as unknown as IpcApi['runs']['modify'],
      current: runsCurrent as unknown as IpcApi['runs']['current'],
      listHistory: vi.fn() as unknown as IpcApi['runs']['listHistory'],
      onCurrentChanged:
        runsOnCurrentChanged as unknown as IpcApi['runs']['onCurrentChanged'],
      onStateChanged: vi.fn(() => () => {}) as unknown as IpcApi['runs']['onStateChanged'],
      // #8: extend with readLog. Hook tests don't exercise it, but a
      // complete bridge keeps any future code reachable from useActiveRun
      // happy.
      readLog: vi.fn().mockResolvedValue({ ok: true, data: { entries: [] } }),
    } as unknown as IpcApi['runs'],
  };

  (window as { api?: IpcApi }).api = api;
  return {
    api,
    runsCurrent,
    runsOnCurrentChanged,
    fireCurrentChanged: (e) => {
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

describe('useActiveRun — ACTIVE-RUN', () => {
  // -------------------------------------------------------------------------
  // ACTIVE-RUN-001 — mount calls runs.current; returns matching run
  // -------------------------------------------------------------------------
  describe('ACTIVE-RUN-001 mount + projectId match', () => {
    it('ACTIVE-RUN-001: mount → runs.current called; matching projectId returned', async () => {
      const run = makeRun({ projectId: 'p-1' });
      const stub = installApi({ current: { ok: true, data: run } });
      const cap: CapturedHook = { latest: null, history: [] };

      render(<HookConsumer projectId="p-1" capture={cap} />);

      await waitFor(() => {
        expect(stub.runsCurrent).toHaveBeenCalledTimes(1);
      });
      await waitFor(() => {
        expect(cap.latest).not.toBeNull();
      });
      expect(cap.latest?.projectId).toBe('p-1');
      expect(cap.latest?.id).toBe('r-1');
    });
  });

  // -------------------------------------------------------------------------
  // ACTIVE-RUN-002 — different projectId → null
  // -------------------------------------------------------------------------
  describe('ACTIVE-RUN-002 mount + projectId mismatch', () => {
    it('ACTIVE-RUN-002: active run is for OTHER project → returns null', async () => {
      const run = makeRun({ projectId: 'OTHER' });
      installApi({ current: { ok: true, data: run } });
      const cap: CapturedHook = { latest: null, history: [] };

      render(<HookConsumer projectId="p-1" capture={cap} />);

      // Allow the initial fetch to settle.
      await new Promise((r) => setTimeout(r, 20));
      expect(cap.latest).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // ACTIVE-RUN-003 — onCurrentChanged matching projectId updates state
  // -------------------------------------------------------------------------
  describe('ACTIVE-RUN-003 onCurrentChanged matching projectId', () => {
    it('ACTIVE-RUN-003: matching projectId event updates the hook value', async () => {
      const stub = installApi({ current: { ok: true, data: null } });
      const cap: CapturedHook = { latest: null, history: [] };

      render(<HookConsumer projectId="p-1" capture={cap} />);

      // Wait for the listener to be registered.
      await waitFor(() => {
        expect(stub.runsOnCurrentChanged).toHaveBeenCalledTimes(1);
      });

      const run = makeRun({ projectId: 'p-1', state: 'preparing' });
      act(() => {
        stub.fireCurrentChanged({ run });
      });

      await waitFor(() => {
        expect(cap.latest).not.toBeNull();
      });
      expect(cap.latest?.id).toBe('r-1');
      expect(cap.latest?.state).toBe('preparing');
    });
  });

  // -------------------------------------------------------------------------
  // ACTIVE-RUN-004 — onCurrentChanged non-matching projectId is ignored
  // -------------------------------------------------------------------------
  describe('ACTIVE-RUN-004 onCurrentChanged non-matching projectId', () => {
    it('ACTIVE-RUN-004: events for OTHER project do NOT change the hook value', async () => {
      const stub = installApi({ current: { ok: true, data: null } });
      const cap: CapturedHook = { latest: null, history: [] };

      render(<HookConsumer projectId="p-1" capture={cap} />);

      await waitFor(() => {
        expect(stub.runsOnCurrentChanged).toHaveBeenCalledTimes(1);
      });

      const otherRun = makeRun({ projectId: 'OTHER' });
      act(() => {
        stub.fireCurrentChanged({ run: otherRun });
      });

      // Allow microtasks to flush.
      await new Promise((r) => setTimeout(r, 10));
      expect(cap.latest).toBeNull();
    });

    it('ACTIVE-RUN-004: null event clears the hook value (run completed)', async () => {
      const stub = installApi({
        current: { ok: true, data: makeRun({ projectId: 'p-1' }) },
      });
      const cap: CapturedHook = { latest: null, history: [] };

      render(<HookConsumer projectId="p-1" capture={cap} />);

      await waitFor(() => {
        expect(cap.latest).not.toBeNull();
      });

      act(() => {
        stub.fireCurrentChanged({ run: null });
      });

      await waitFor(() => {
        expect(cap.latest).toBeNull();
      });
    });
  });

  // -------------------------------------------------------------------------
  // ACTIVE-RUN-005 — unsubscribe on unmount
  // -------------------------------------------------------------------------
  describe('ACTIVE-RUN-005 unsubscribe on unmount', () => {
    it('ACTIVE-RUN-005: unmount calls the unsubscribe returned by onCurrentChanged', async () => {
      const unsub = vi.fn();
      const stub = installApi({ current: { ok: true, data: null } });
      // Override the registration to inject our spy unsubscribe.
      stub.runsOnCurrentChanged.mockImplementation(() => unsub);

      const cap: CapturedHook = { latest: null, history: [] };
      const { unmount } = render(
        <HookConsumer projectId="p-1" capture={cap} />,
      );

      await waitFor(() => {
        expect(stub.runsOnCurrentChanged).toHaveBeenCalledTimes(1);
      });

      unmount();
      expect(unsub).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // ACTIVE-RUN-006 — window.api === undefined
  // -------------------------------------------------------------------------
  describe('ACTIVE-RUN-006 missing IPC bridge', () => {
    it('ACTIVE-RUN-006: window.api === undefined → hook returns null without throwing', async () => {
      // No `installApi()` call — window.api is unset.
      delete (window as { api?: IpcApi }).api;
      const cap: CapturedHook = { latest: null, history: [] };

      // Should NOT throw on render.
      expect(() => {
        render(<HookConsumer projectId="p-1" capture={cap} />);
      }).not.toThrow();

      await new Promise((r) => setTimeout(r, 10));
      expect(cap.latest).toBeNull();
    });
  });
});
