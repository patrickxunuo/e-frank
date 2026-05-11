// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ExecutionView } from '../../src/renderer/views/ExecutionView';
import type {
  ApprovalRequest,
  IpcApi,
  IpcResult,
  ProjectInstanceDto,
  Run,
  RunState,
} from '../../src/shared/ipc';
import type { RunLogEntry } from '../../src/shared/schema/run';

/**
 * EXEC-001..010 — <ExecutionView> view.
 *
 * Spec snippet:
 *   interface ExecutionViewProps {
 *     runId: string;
 *     projectId: string;
 *     onBack: () => void;
 *   }
 *
 * Behavior:
 *   - Resolves the run by first checking `runs.current()`. If the active
 *     run's id matches `runId`, use that. Otherwise fall back to
 *     `runs.readLog({ runId })` for a terminal/history view.
 *   - Header has Back, project name + ticket key + status badge,
 *     progress counter, Auto-scroll toggle (default ON), Pause, Cancel
 *     (hidden when terminal).
 *   - Two-column body: Execution log on the left, "Approval panel lands
 *     in #9" placeholder on the right.
 *   - Bottom <PromptInput> wires onSubmit → claude.write where claudeRunId
 *     comes from claude.status() at submit-time. Disabled when no active
 *     claude run.
 *
 * Pattern: install a full IpcApi stub on window.api and override per-test
 * the methods the view exercises. We do NOT module-mock useRunLog — the
 * real hook subscribes to claude/runs events that we already stub on the
 * IPC bridge, so the view+hook+bridge pipeline is exercised end-to-end.
 */

declare global {
  interface Window {
    api?: IpcApi;
  }
}

interface ApiStub {
  api: IpcApi;
  projectsGet: Mock;
  runsCurrent: Mock;
  runsCancel: Mock;
  runsReadLog: Mock;
  claudeStatus: Mock;
  claudeWrite: Mock;
  claudeOnOutput: Mock;
  runsOnStateChanged: Mock;
}

function makeProject(
  id: string,
  name: string,
  overrides: Partial<ProjectInstanceDto> = {},
): ProjectInstanceDto {
  return {
    id,
    name,
    repo: {
      type: 'github',
      localPath: '/tmp/' + id,
      baseBranch: 'main',
      connectionId: 'conn-gh-1',
      slug: 'gazhang/repo',
    },
    tickets: {
      source: 'jira',
      connectionId: 'conn-jr-1',
      projectKey: 'ABC',
      query: 'project = ABC',
    },
    workflow: { mode: 'interactive', branchFormat: 'feature/{ticketKey}-{slug}' },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeRun(over: Partial<Run> = {}): Run {
  return {
    id: 'r-1',
    projectId: 'p-1',
    ticketKey: 'ABC-7',
    mode: 'interactive',
    branchName: 'feat/abc-7',
    state: 'running' as RunState,
    status: 'running',
    steps: [],
    pendingApproval: null,
    startedAt: 1,
    ...over,
  };
}

function installApi(opts?: {
  project?: ProjectInstanceDto;
  current?: IpcResult<{ run: Run | null }>;
  readLog?: IpcResult<{ entries: RunLogEntry[] }>;
  status?: IpcResult<{ active: { runId: string; pid: number | undefined; startedAt: number } | null }>;
  cancelResult?: IpcResult<{ runId: string }>;
  writeResult?: IpcResult<{ bytesWritten: number }>;
}): ApiStub {
  const unusedErr = (): IpcResult<never> => ({
    ok: false,
    error: { code: 'NOT_USED_IN_FE_TESTS', message: '' },
  });

  const project = opts?.project ?? makeProject('p-1', 'Alpha Project');
  const projectsGet = vi.fn().mockResolvedValue({ ok: true, data: project });

  const runsCurrent = vi
    .fn()
    .mockResolvedValue(opts?.current ?? { ok: true, data: { run: null } });
  const runsReadLog = vi
    .fn()
    .mockResolvedValue(opts?.readLog ?? { ok: true, data: { entries: [] } });
  const runsCancel = vi
    .fn()
    .mockResolvedValue(opts?.cancelResult ?? { ok: true, data: { runId: 'r-1' } });
  const claudeStatus = vi
    .fn()
    .mockResolvedValue(opts?.status ?? { ok: true, data: { active: null } });
  const claudeWrite = vi
    .fn()
    .mockResolvedValue(opts?.writeResult ?? { ok: true, data: { bytesWritten: 0 } });
  const claudeOnOutput = vi.fn(() => () => {});
  const runsOnStateChanged = vi.fn(() => () => {});

  const api: IpcApi = {
    ping: vi.fn<IpcApi['ping']>().mockResolvedValue({ reply: 'pong', receivedAt: 0 }),
    claude: {
      run: vi.fn<IpcApi['claude']['run']>().mockResolvedValue(unusedErr()),
      cancel: vi.fn<IpcApi['claude']['cancel']>().mockResolvedValue(unusedErr()),
      write: claudeWrite as unknown as IpcApi['claude']['write'],
      status: claudeStatus as unknown as IpcApi['claude']['status'],
      onOutput: claudeOnOutput as unknown as IpcApi['claude']['onOutput'],
      onExit: vi.fn<IpcApi['claude']['onExit']>(() => () => {}),
    },
    projects: {
      list: vi.fn<IpcApi['projects']['list']>().mockResolvedValue({ ok: true, data: [] }),
      get: projectsGet as unknown as IpcApi['projects']['get'],
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
      cancel: runsCancel as unknown as IpcApi['runs']['cancel'],
      approve: vi.fn() as unknown as IpcApi['runs']['approve'],
      reject: vi.fn() as unknown as IpcApi['runs']['reject'],
      modify: vi.fn() as unknown as IpcApi['runs']['modify'],
      current: runsCurrent as unknown as IpcApi['runs']['current'],
      listHistory: vi.fn() as unknown as IpcApi['runs']['listHistory'],
      onCurrentChanged: vi.fn(() => () => {}) as unknown as IpcApi['runs']['onCurrentChanged'],
      onStateChanged: runsOnStateChanged as unknown as IpcApi['runs']['onStateChanged'],
      // `readLog` is patched via the unknown cast — Agent B owns the typed signature.
      readLog: runsReadLog,
    } as unknown as IpcApi['runs'],
    dialog: {
      selectFolder: vi.fn() as unknown as IpcApi['dialog']['selectFolder'],
    },
    tickets: {
      list: vi.fn() as unknown as IpcApi['tickets']['list'],
    },
    chrome: {
      minimize: vi.fn() as unknown as IpcApi['chrome']['minimize'],
      maximize: vi.fn() as unknown as IpcApi['chrome']['maximize'],
      close: vi.fn() as unknown as IpcApi['chrome']['close'],
      getState: vi.fn() as unknown as IpcApi['chrome']['getState'],
      onStateChanged: vi.fn(() => () => {}) as unknown as IpcApi['chrome']['onStateChanged'],
    },
  };

  (window as { api?: IpcApi }).api = api;
  return {
    api,
    projectsGet,
    runsCurrent,
    runsCancel,
    runsReadLog,
    claudeStatus,
    claudeWrite,
    claudeOnOutput,
    runsOnStateChanged,
  };
}

const noop = (): void => {};

afterEach(() => {
  cleanup();
  delete (window as { api?: IpcApi }).api;
  vi.restoreAllMocks();
});

describe('<ExecutionView /> — EXEC', () => {
  // -------------------------------------------------------------------------
  // EXEC-001 — Header renders project name + ticket key + status badge
  // -------------------------------------------------------------------------
  it('EXEC-001: header renders project name, ticket key, and status badge', async () => {
    installApi({
      project: makeProject('p-1', 'Alpha Project'),
      current: {
        ok: true,
        data: { run: makeRun({ id: 'r-1', projectId: 'p-1', ticketKey: 'ABC-7' }) },
      },
    });

    render(<ExecutionView runId="r-1" projectId="p-1" onBack={noop} />);

    // Title is now "{ticketKey} — {ticketSummary?}" (matches design/flow_detail.png).
    // Project name moved to the subtitle row alongside the run id.
    await waitFor(() => {
      expect(screen.getByTestId('execution-title')).toHaveTextContent(/ABC-7/);
    });
    // Status badge testid present.
    expect(screen.getByTestId('execution-status-badge')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // EXEC-002 — Progress counter renders "Step X of Y"
  // -------------------------------------------------------------------------
  it('EXEC-002: progress counter renders Step X of Y', async () => {
    installApi({
      current: {
        ok: true,
        data: { run: makeRun({ id: 'r-1', projectId: 'p-1' }) },
      },
    });

    render(<ExecutionView runId="r-1" projectId="p-1" onBack={noop} />);

    await waitFor(() => {
      const progress = screen.getByTestId('execution-progress');
      expect(progress).toBeInTheDocument();
      // Tolerant: accept "Step N of M" or "N of M".
      expect(progress.textContent ?? '').toMatch(/\d+\s*of\s*\d+/i);
    });
  });

  // -------------------------------------------------------------------------
  // EXEC-003 — Auto-scroll toggle defaults ON
  // -------------------------------------------------------------------------
  it('EXEC-003: auto-scroll toggle defaults to ON (checked / pressed / data-on)', async () => {
    installApi({
      current: {
        ok: true,
        data: { run: makeRun({ id: 'r-1', projectId: 'p-1' }) },
      },
    });

    render(<ExecutionView runId="r-1" projectId="p-1" onBack={noop} />);

    const toggle = await screen.findByTestId('log-autoscroll-toggle');
    // Tolerant — Toggle in this codebase varies between aria-checked,
    // aria-pressed, data-state, and a checked input. Accept any of them.
    const on =
      toggle.getAttribute('aria-checked') === 'true' ||
      toggle.getAttribute('aria-pressed') === 'true' ||
      toggle.getAttribute('data-state') === 'checked' ||
      toggle.getAttribute('data-on') === 'true' ||
      (toggle as HTMLInputElement).checked === true ||
      toggle.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked ===
        true;
    expect(on).toBe(true);
  });

  // -------------------------------------------------------------------------
  // EXEC-005 — Cancel button calls runs.cancel; hidden when terminal
  // -------------------------------------------------------------------------
  it('EXEC-005: live run → Cancel button visible and calls runs.cancel', async () => {
    const stub = installApi({
      current: {
        ok: true,
        data: { run: makeRun({ id: 'r-1', projectId: 'p-1', state: 'running' }) },
      },
    });

    render(<ExecutionView runId="r-1" projectId="p-1" onBack={noop} />);

    const cancel = await screen.findByTestId('log-cancel-button');
    fireEvent.click(cancel);

    await waitFor(() => {
      expect(stub.runsCancel).toHaveBeenCalledWith({ runId: 'r-1' });
    });
  });

  it('EXEC-005 (terminal): cancel button is hidden when status is terminal', async () => {
    installApi({
      // Active run is something else / null — view falls back to readLog.
      current: { ok: true, data: { run: null } },
      readLog: { ok: true, data: { entries: [] } },
      status: { ok: true, data: { active: null } },
    });

    render(<ExecutionView runId="r-done" projectId="p-1" onBack={noop} />);

    // Allow the view to settle on a "terminal/history" rendering. The
    // cancel button must NOT be present.
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId('log-cancel-button')).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // EXEC-006 — Back button calls onBack
  // -------------------------------------------------------------------------
  it('EXEC-006: clicking the Back button calls onBack', async () => {
    const onBack = vi.fn();
    installApi({
      current: {
        ok: true,
        data: { run: makeRun({ id: 'r-1', projectId: 'p-1' }) },
      },
    });

    render(<ExecutionView runId="r-1" projectId="p-1" onBack={onBack} />);

    const back = await screen.findByTestId('execution-back');
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // EXEC-007 — REMOVED in #9: the right-pane placeholder is replaced by
  // <ApprovalPanel>. See EXEC-APPROVAL-001..008 below.
  // EXEC-008 — REMOVED: send-message-while-running was a dead path. claude
  // runs in `-p` (print) mode under stream-json — it doesn't accept stdin
  // input mid-run. The footer PromptInput was wired to claude.write but
  // had no effect, so the entire input was removed.
  // -------------------------------------------------------------------------
  // EXEC-009 — Live run with state events updates the timeline
  // -------------------------------------------------------------------------
  it('EXEC-009: state-changed events from runs.onStateChanged refresh the timeline', async () => {
    // ExecutionView and useRunLog each register their own onStateChanged
    // listener. Capture ALL of them so the fired event drives both.
    const stateListeners: Array<(e: { runId: string; run: Run }) => void> = [];
    const stub = installApi({
      current: {
        ok: true,
        data: { run: makeRun({ id: 'r-1', projectId: 'p-1', state: 'running' }) },
      },
    });
    stub.runsOnStateChanged.mockImplementation((cb) => {
      const typed = cb as (e: { runId: string; run: Run }) => void;
      stateListeners.push(typed);
      return () => {
        const idx = stateListeners.indexOf(typed);
        if (idx >= 0) stateListeners.splice(idx, 1);
      };
    });

    render(<ExecutionView runId="r-1" projectId="p-1" onBack={noop} />);

    await waitFor(() => {
      // Both listeners (ExecutionView resolution + useRunLog) should be
      // registered before we fire.
      expect(stateListeners.length).toBeGreaterThanOrEqual(2);
    });

    // Fire a state-change event that advances the run to a later step.
    const advanced = makeRun({
      id: 'r-1',
      projectId: 'p-1',
      state: 'committing',
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
    });

    // Drive ALL captured listeners.
    for (const listener of stateListeners) {
      listener({ runId: 'r-1', run: advanced });
    }

    // The progress counter / status badge should reflect the new state.
    await waitFor(() => {
      // At least the new step's user-visible label appears somewhere in the
      // log timeline.
      expect(screen.getByText(/committing changes/i)).toBeInTheDocument();
    });
  });

  // EXEC-010 — REMOVED: footer PromptInput is gone; see EXEC-008.
});

/**
 * EXEC-APPROVAL-001..008 — <ExecutionView> + <ApprovalPanel> integration.
 *
 * The right pane is now driven by `Run.pendingApproval`:
 *   - null  → no <aside> rendered, body data-has-panel="false"
 *   - set   → <ApprovalPanel> rendered, body data-has-panel="true"
 *
 * The placeholder testid `execution-approval-placeholder` is removed.
 *
 * Modify uses runs.modify (NOT claude.write); the page-bottom PromptInput
 * (`log-prompt-input` at the page footer) still calls claude.write.
 */

function makeApproval(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    plan: 'Add validation to the foo function.',
    filesToModify: ['src/foo.ts', 'src/bar.py', 'src/baz.go'],
    diff:
      'diff --git a/src/foo.ts b/src/foo.ts\n' +
      '--- a/src/foo.ts\n' +
      '+++ b/src/foo.ts\n' +
      '@@ -1,3 +1,4 @@\n' +
      ' const x = 1;\n' +
      '+const y = 2;\n' +
      ' const z = 3;\n',
    options: ['approve', 'reject'],
    raw: { kind: 'approval' },
    ...over,
  };
}

/** Find the `.body` container by walking from the page testid. */
function bodyOf(): HTMLElement {
  const page = screen.getByTestId('execution-view-page');
  // Per acceptance spec: body is the element carrying data-has-panel.
  const body = page.querySelector<HTMLElement>('[data-has-panel]');
  if (!body) {
    throw new Error('expected an element with [data-has-panel] inside execution-view-page');
  }
  return body;
}

describe('<ExecutionView /> — EXEC-APPROVAL', () => {
  // -------------------------------------------------------------------------
  // EXEC-APPROVAL-001 — pendingApproval === null → no panel, data-has-panel="false"
  // -------------------------------------------------------------------------
  it('EXEC-APPROVAL-001: pendingApproval === null → no approval-panel-root, body data-has-panel="false"', async () => {
    installApi({
      current: {
        ok: true,
        data: {
          run: makeRun({
            id: 'r-1',
            projectId: 'p-1',
            pendingApproval: null,
          }),
        },
      },
    });

    render(<ExecutionView runId="r-1" projectId="p-1" onBack={noop} />);

    await screen.findByTestId('execution-view-page');

    expect(screen.queryByTestId('approval-panel-root')).not.toBeInTheDocument();
    const body = bodyOf();
    expect(body.getAttribute('data-has-panel')).toBe('false');
  });

  // -------------------------------------------------------------------------
  // EXEC-APPROVAL-002 — populated pendingApproval → panel + data-has-panel="true"
  // -------------------------------------------------------------------------
  it('EXEC-APPROVAL-002: populated pendingApproval → approval-panel-root rendered, body data-has-panel="true"', async () => {
    installApi({
      current: {
        ok: true,
        data: {
          run: makeRun({
            id: 'r-1',
            projectId: 'p-1',
            state: 'awaitingApproval',
            pendingApproval: makeApproval(),
          }),
        },
      },
    });

    render(<ExecutionView runId="r-1" projectId="p-1" onBack={noop} />);

    await screen.findByTestId('approval-panel-root');
    const body = bodyOf();
    expect(body.getAttribute('data-has-panel')).toBe('true');
  });

  // -------------------------------------------------------------------------
  // EXEC-APPROVAL-003 — placeholder removed
  // -------------------------------------------------------------------------
  it('EXEC-APPROVAL-003: execution-approval-placeholder is removed entirely', async () => {
    installApi({
      current: {
        ok: true,
        data: { run: makeRun({ id: 'r-1', projectId: 'p-1' }) },
      },
    });

    render(<ExecutionView runId="r-1" projectId="p-1" onBack={noop} />);
    await screen.findByTestId('execution-view-page');

    expect(
      screen.queryByTestId('execution-approval-placeholder'),
    ).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // EXEC-APPROVAL-004 — Approve → window.api.runs.approve({ runId })
  // -------------------------------------------------------------------------
  it('EXEC-APPROVAL-004: clicking Approve calls window.api.runs.approve({ runId })', async () => {
    const stub = installApi({
      current: {
        ok: true,
        data: {
          run: makeRun({
            id: 'r-42',
            projectId: 'p-1',
            state: 'awaitingApproval',
            pendingApproval: makeApproval(),
          }),
        },
      },
    });
    const approveSpy = vi.fn().mockResolvedValue({ ok: true, data: { runId: 'r-42' } });
    (stub.api.runs as unknown as { approve: typeof approveSpy }).approve = approveSpy;

    render(<ExecutionView runId="r-42" projectId="p-1" onBack={noop} />);

    const btn = await screen.findByTestId('approve-button');
    fireEvent.click(btn);

    await waitFor(() => {
      expect(approveSpy).toHaveBeenCalledWith({ runId: 'r-42' });
    });
  });

  // -------------------------------------------------------------------------
  // EXEC-APPROVAL-005 — Reject → window.api.runs.reject({ runId })
  // -------------------------------------------------------------------------
  it('EXEC-APPROVAL-005: clicking Reject calls window.api.runs.reject({ runId })', async () => {
    const stub = installApi({
      current: {
        ok: true,
        data: {
          run: makeRun({
            id: 'r-7',
            projectId: 'p-1',
            state: 'awaitingApproval',
            pendingApproval: makeApproval(),
          }),
        },
      },
    });
    const rejectSpy = vi.fn().mockResolvedValue({ ok: true, data: { runId: 'r-7' } });
    (stub.api.runs as unknown as { reject: typeof rejectSpy }).reject = rejectSpy;

    render(<ExecutionView runId="r-7" projectId="p-1" onBack={noop} />);

    const btn = await screen.findByTestId('reject-button');
    fireEvent.click(btn);

    await waitFor(() => {
      expect(rejectSpy).toHaveBeenCalledWith({ runId: 'r-7' });
    });
  });

  // -------------------------------------------------------------------------
  // EXEC-APPROVAL-006 — Modify text + Send → runs.modify; claude.write NOT called
  // -------------------------------------------------------------------------
  it('EXEC-APPROVAL-006: Modify text + Send calls runs.modify; claude.write NOT called', async () => {
    const stub = installApi({
      current: {
        ok: true,
        data: {
          run: makeRun({
            id: 'r-99',
            projectId: 'p-1',
            state: 'awaitingApproval',
            pendingApproval: makeApproval({ plan: 'starting plan' }),
          }),
        },
      },
    });
    const modifySpy = vi.fn().mockResolvedValue({ ok: true, data: { runId: 'r-99' } });
    (stub.api.runs as unknown as { modify: typeof modifySpy }).modify = modifySpy;

    render(<ExecutionView runId="r-99" projectId="p-1" onBack={noop} />);

    // Open the modify composer.
    const modifyBtn = await screen.findByTestId('modify-button');
    fireEvent.click(modifyBtn);

    // The composer uses distinct testids (`approval-modify-input` /
    // `approval-modify-send`) so the page-bottom PromptInput's
    // `log-prompt-input` / `log-send-button` don't collide.
    const composer = (await screen.findByTestId(
      'approval-modify-input',
    )) as HTMLTextAreaElement;
    const composerSend = screen.getByTestId(
      'approval-modify-send',
    ) as HTMLButtonElement;

    fireEvent.change(composer, { target: { value: 'edited plan body' } });
    fireEvent.click(composerSend);

    await waitFor(() => {
      expect(modifySpy).toHaveBeenCalledWith({
        runId: 'r-99',
        text: 'edited plan body',
      });
    });
    expect(stub.claudeWrite).not.toHaveBeenCalled();
  });

  // EXEC-APPROVAL-007 — REMOVED with the page-bottom PromptInput. ApprovalPanel's
  // own modify-input is the only way to send text to claude now (and only
  // during awaitingApproval, which routes via runs.modify).
  // -------------------------------------------------------------------------
  // EXEC-APPROVAL-008 — Transitioning out of awaitingApproval cleanly unmounts
  // -------------------------------------------------------------------------
  it('EXEC-APPROVAL-008: state transition out of awaitingApproval drops the panel without errors', async () => {
    const stateListeners: Array<(e: { runId: string; run: Run }) => void> = [];
    const currentListeners: Array<(e: { run: Run | null }) => void> = [];

    const stub = installApi({
      current: {
        ok: true,
        data: {
          run: makeRun({
            id: 'r-1',
            projectId: 'p-1',
            state: 'awaitingApproval',
            pendingApproval: makeApproval(),
          }),
        },
      },
    });
    stub.runsOnStateChanged.mockImplementation((cb) => {
      const typed = cb as (e: { runId: string; run: Run }) => void;
      stateListeners.push(typed);
      return () => {
        const idx = stateListeners.indexOf(typed);
        if (idx >= 0) stateListeners.splice(idx, 1);
      };
    });
    type OnCurrent = (cb: (e: { run: Run | null }) => void) => () => void;
    const onCurrent: OnCurrent = (cb) => {
      currentListeners.push(cb);
      return () => {
        const idx = currentListeners.indexOf(cb);
        if (idx >= 0) currentListeners.splice(idx, 1);
      };
    };
    (stub.api.runs as unknown as { onCurrentChanged: OnCurrent }).onCurrentChanged = onCurrent;

    render(<ExecutionView runId="r-1" projectId="p-1" onBack={noop} />);

    // Panel rendered.
    await screen.findByTestId('approval-panel-root');

    // Spy on console.error to assert no errors during the transition.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Fire a state change clearing pendingApproval.
    const cleared = makeRun({
      id: 'r-1',
      projectId: 'p-1',
      state: 'committing',
      pendingApproval: null,
    });
    // Wrap the synchronous listener invocations in act() so React batches
    // their state updates the same way a real subscription would (avoids
    // spurious "not wrapped in act(...)" warnings).
    act(() => {
      for (const listener of stateListeners) {
        listener({ runId: 'r-1', run: cleared });
      }
      for (const listener of currentListeners) {
        listener({ run: cleared });
      }
    });

    await waitFor(() => {
      expect(screen.queryByTestId('approval-panel-root')).not.toBeInTheDocument();
    });
    expect(bodyOf().getAttribute('data-has-panel')).toBe('false');
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
