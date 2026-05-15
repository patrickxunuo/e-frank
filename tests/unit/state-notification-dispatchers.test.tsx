// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useNotificationDispatchers } from '../../src/renderer/state/notification-dispatchers';
import {
  __resetNotificationsForTests,
  getToasts,
} from '../../src/renderer/state/notifications';
import type {
  ApprovalRequest,
  IpcApi,
  IpcResult,
  Run,
  RunsCurrentChangedEvent,
} from '../../src/shared/ipc';

/**
 * NOTIF-DISPATCH-001..010 — useNotificationDispatchers hook.
 *
 * Acceptance (GH-59 "Run-finish trigger" + "Approval trigger"):
 *  - run-done → success toast with "Open PR" action when prUrl set,
 *    8 000 ms ttl, dedupe-keyed so a follow-up state-changed event for
 *    the same run can't double-fire
 *  - run-failed → error toast with no ttl
 *  - run-cancelled → warning toast with 5 000 ms ttl
 *  - terminal-state fires once per run (re-emitting the same terminal
 *    snapshot must NOT stack a second toast)
 *  - approval flip null → set + currentExecutionRunId !== run.id → toast
 *  - approval flip null → set + currentExecutionRunId === run.id → suppressed
 *  - approval flip set → null → matching approval toast dismissed
 *  - navigating to ExecutionView (currentExecutionRunId set) dismisses
 *    any existing approval toast for that run
 *  - approval payload changes (different raw) refresh the existing toast
 *    in place (dedupeKey collision) rather than stacking a second one
 */

declare global {
  interface Window {
    api?: IpcApi;
  }
}

interface ApiStub {
  api: IpcApi;
  approve: Mock;
  reject: Mock;
  /** Emit a current-changed event with the supplied snapshot. */
  emit: (run: Run | null) => void;
}

function unusedErr<T>(): IpcResult<T> {
  return { ok: false, error: { code: 'NOT_USED_IN_FE_TESTS', message: '' } };
}

function installApi(): ApiStub {
  let listener: ((e: RunsCurrentChangedEvent) => void) | null = null;
  const approve = vi.fn().mockResolvedValue({ ok: true, data: { runId: 'r-x' } });
  const reject = vi.fn().mockResolvedValue({ ok: true, data: { runId: 'r-x' } });

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
      list: vi.fn<IpcApi['projects']['list']>().mockResolvedValue({ ok: true, data: [] }),
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
      list: vi
        .fn<IpcApi['jira']['list']>()
        .mockResolvedValue({ ok: true, data: { tickets: [] } }),
      refresh: vi
        .fn<IpcApi['jira']['refresh']>()
        .mockResolvedValue({ ok: true, data: { tickets: [] } }),
      testConnection: vi.fn<IpcApi['jira']['testConnection']>().mockResolvedValue(unusedErr()),
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
    dialog: {
      selectFolder: vi.fn() as unknown as IpcApi['dialog']['selectFolder'],
    },
    runs: {
      start: vi.fn() as unknown as IpcApi['runs']['start'],
      cancel: vi.fn() as unknown as IpcApi['runs']['cancel'],
      approve: approve as unknown as IpcApi['runs']['approve'],
      reject: reject as unknown as IpcApi['runs']['reject'],
      modify: vi.fn() as unknown as IpcApi['runs']['modify'],
      current: vi.fn() as unknown as IpcApi['runs']['current'],
      listActive: vi.fn() as unknown as IpcApi['runs']['listActive'],
      listHistory: vi.fn() as unknown as IpcApi['runs']['listHistory'],
      delete: vi.fn() as unknown as IpcApi['runs']['delete'],
      readLog: vi.fn() as unknown as IpcApi['runs']['readLog'],
      onCurrentChanged: vi.fn((l: (e: RunsCurrentChangedEvent) => void) => {
        listener = l;
        return () => {
          listener = null;
        };
      }) as unknown as IpcApi['runs']['onCurrentChanged'],
      onListChanged: vi.fn(() => () => {}) as unknown as IpcApi['runs']['onListChanged'],
      onStateChanged: vi.fn(() => () => {}) as unknown as IpcApi['runs']['onStateChanged'],
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
      search: vi.fn() as unknown as IpcApi['skills']['search'],
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
    approve,
    reject,
    emit: (run): void => {
      if (listener) listener({ run });
    },
  };
}

function makeRun(over: Partial<Run> = {}): Run {
  return {
    id: 'r-1',
    projectId: 'p-1',
    ticketKey: 'GH-99',
    mode: 'interactive',
    branchName: 'feat/GH-99-something',
    state: 'running',
    status: 'running',
    steps: [],
    pendingApproval: null,
    startedAt: 0,
    ...over,
  };
}

function makeApproval(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    plan: 'Implement the toast notification system.',
    filesToModify: ['src/foo.ts'],
    diff: '',
    options: ['approve', 'reject'],
    raw: { id: 'a-1' },
    ...over,
  };
}

interface HarnessProps {
  currentExecutionRunId: string | null;
  onNavigateToExecution?: (runId: string, projectId: string) => void;
}

function Harness({ currentExecutionRunId, onNavigateToExecution }: HarnessProps): null {
  useNotificationDispatchers({ currentExecutionRunId, onNavigateToExecution });
  return null;
}

beforeEach(() => {
  __resetNotificationsForTests();
});

afterEach(() => {
  cleanup();
  __resetNotificationsForTests();
  delete (window as { api?: IpcApi }).api;
  vi.restoreAllMocks();
});

describe('useNotificationDispatchers — NOTIF-DISPATCH', () => {
  it('NOTIF-DISPATCH-001: run done with prUrl → success toast with Open PR + View run actions, 8 000ms ttl', () => {
    const stub = installApi();
    const onNavigate = vi.fn();
    render(<Harness currentExecutionRunId={null} onNavigateToExecution={onNavigate} />);

    act(() => {
      stub.emit(makeRun({ state: 'done', status: 'done', prUrl: 'https://github.com/o/r/pull/1' }));
    });

    const toasts = getToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.type).toBe('success');
    expect(toasts[0]?.title).toBe('GH-99 — done');
    expect(toasts[0]?.ttlMs).toBe(8_000);
    expect(toasts[0]?.dedupeKey).toBe('run-finish-r-1');
    expect(toasts[0]?.actions).toBeDefined();
    expect((toasts[0]?.actions ?? []).map((a) => a.label)).toEqual(['Open PR', 'View run']);
  });

  it('NOTIF-DISPATCH-002: run failed → error toast with no ttl', () => {
    const stub = installApi();
    render(<Harness currentExecutionRunId={null} onNavigateToExecution={vi.fn()} />);

    act(() => {
      stub.emit(makeRun({ state: 'failed', status: 'failed', error: 'boom' }));
    });

    const toasts = getToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.type).toBe('error');
    expect(toasts[0]?.ttlMs).toBeUndefined();
    expect(toasts[0]?.body).toBe('boom');
  });

  it('NOTIF-DISPATCH-003: run cancelled → warning toast, 5 000ms ttl', () => {
    const stub = installApi();
    render(<Harness currentExecutionRunId={null} />);

    act(() => {
      stub.emit(makeRun({ state: 'cancelled', status: 'cancelled' }));
    });

    const toasts = getToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.type).toBe('warning');
    expect(toasts[0]?.ttlMs).toBe(5_000);
  });

  it('NOTIF-DISPATCH-004: terminal-state fires exactly once even on repeat snapshots', () => {
    const stub = installApi();
    render(<Harness currentExecutionRunId={null} />);

    const done = makeRun({ state: 'done', status: 'done', prUrl: 'https://x/pr' });
    act(() => stub.emit(done));
    act(() => stub.emit(done)); // simulate a redundant follow-up event
    act(() => stub.emit({ ...done })); // and an unrelated reshape

    expect(getToasts()).toHaveLength(1);
  });

  it('NOTIF-DISPATCH-005: approval null → set + off-ExecutionView → approval toast appears', () => {
    const stub = installApi();
    render(<Harness currentExecutionRunId={null} onNavigateToExecution={vi.fn()} />);

    const approval = makeApproval({ raw: { id: 'a-1' } });
    act(() => {
      stub.emit(
        makeRun({ state: 'awaitingApproval', status: 'running', pendingApproval: approval }),
      );
    });

    const toasts = getToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.type).toBe('approval');
    expect(toasts[0]?.dedupeKey).toBe('approval-r-1');
    expect(toasts[0]?.title).toBe('GH-99 — awaiting approval');
    // Approve/Reject from window.api + View details from navigate.
    expect((toasts[0]?.actions ?? []).map((a) => a.label)).toEqual(['Approve', 'Reject', 'View details']);
  });

  it('NOTIF-DISPATCH-006: approval null → set + ON matching ExecutionView → suppressed', () => {
    const stub = installApi();
    render(<Harness currentExecutionRunId="r-1" />);

    act(() => {
      stub.emit(
        makeRun({
          state: 'awaitingApproval',
          status: 'running',
          pendingApproval: makeApproval(),
        }),
      );
    });

    expect(getToasts()).toHaveLength(0);
  });

  it('NOTIF-DISPATCH-007: approval set → null → matching approval toast dismissed', () => {
    const stub = installApi();
    render(<Harness currentExecutionRunId={null} />);

    act(() => {
      stub.emit(
        makeRun({
          state: 'awaitingApproval',
          status: 'running',
          pendingApproval: makeApproval(),
        }),
      );
    });
    expect(getToasts()).toHaveLength(1);

    act(() => {
      stub.emit(makeRun({ state: 'running', status: 'running', pendingApproval: null }));
    });
    expect(getToasts()).toHaveLength(0);
  });

  it('NOTIF-DISPATCH-008: navigating to matching ExecutionView dismisses approval toast', () => {
    const stub = installApi();
    const { rerender } = render(<Harness currentExecutionRunId={null} />);

    act(() => {
      stub.emit(
        makeRun({
          state: 'awaitingApproval',
          status: 'running',
          pendingApproval: makeApproval(),
        }),
      );
    });
    expect(getToasts()).toHaveLength(1);

    rerender(<Harness currentExecutionRunId="r-1" />);
    expect(getToasts()).toHaveLength(0);
  });

  it('NOTIF-DISPATCH-009: approval payload change refreshes existing toast (dedupe, no second toast)', () => {
    const stub = installApi();
    render(<Harness currentExecutionRunId={null} />);

    act(() => {
      stub.emit(
        makeRun({
          state: 'awaitingApproval',
          status: 'running',
          pendingApproval: makeApproval({ raw: { id: 'a-1' }, plan: 'Plan v1' }),
        }),
      );
    });
    expect(getToasts()).toHaveLength(1);
    const id1 = getToasts()[0]?.id;

    act(() => {
      stub.emit(
        makeRun({
          state: 'awaitingApproval',
          status: 'running',
          pendingApproval: makeApproval({ raw: { id: 'a-2' }, plan: 'Plan v2' }),
        }),
      );
    });
    const after = getToasts();
    expect(after).toHaveLength(1);
    expect(after[0]?.id).toBe(id1);
    expect(after[0]?.body).toContain('Plan v2');
  });

  it('NOTIF-DISPATCH-010: approval action calls runs.approve via window.api', () => {
    const stub = installApi();
    render(<Harness currentExecutionRunId={null} />);

    act(() => {
      stub.emit(
        makeRun({
          state: 'awaitingApproval',
          status: 'running',
          pendingApproval: makeApproval(),
        }),
      );
    });

    const approveAction = (getToasts()[0]?.actions ?? []).find((a) => a.label === 'Approve');
    expect(approveAction).toBeDefined();
    approveAction?.onClick();
    expect(stub.approve).toHaveBeenCalledWith({ runId: 'r-1' });
  });
});
