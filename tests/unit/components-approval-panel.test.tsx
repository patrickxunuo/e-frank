// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ApprovalPanel } from '../../src/renderer/components/ApprovalPanel';
import type { ApprovalRequest, IpcApi, IpcResult } from '../../src/shared/ipc';

/**
 * CMP-APPROVAL-001..017 — <ApprovalPanel> component.
 *
 * Behavior summary (acceptance/approval-interface.md):
 *   - root has data-testid="approval-panel-root"
 *   - sticky header reads "Approval Required"
 *   - plan / files-to-modify / diff sections each hide when payload empty
 *   - action bar: approve-button / modify-button / reject-button
 *   - Approve → onApprove(runId) (default: window.api.runs.approve)
 *   - Reject  → onReject(runId)  (default: window.api.runs.reject)
 *   - Modify  → reveals a <PromptInput> pre-filled with the plan;
 *               on submit calls onModify(runId, text) (default: runs.modify)
 *   - all three buttons disabled while pendingAction !== null OR `disabled` prop
 *   - empty Modify text → Send disabled (PromptInput's existing rule)
 */

declare global {
  interface Window {
    api?: IpcApi;
  }
}

afterEach(() => {
  cleanup();
  delete (window as { api?: IpcApi }).api;
  vi.restoreAllMocks();
});

interface ApiStub {
  api: IpcApi;
  approve: Mock;
  reject: Mock;
  modify: Mock;
  claudeWrite: Mock;
}

function unusedErr<T>(): IpcResult<T> {
  return { ok: false, error: { code: 'NOT_USED_IN_FE_TESTS', message: '' } };
}

function installApi(opts?: {
  approveResult?: IpcResult<{ runId: string }>;
  rejectResult?: IpcResult<{ runId: string }>;
  modifyResult?: IpcResult<{ runId: string }>;
}): ApiStub {
  const approve = vi
    .fn()
    .mockResolvedValue(opts?.approveResult ?? { ok: true, data: { runId: 'r-1' } });
  const reject = vi
    .fn()
    .mockResolvedValue(opts?.rejectResult ?? { ok: true, data: { runId: 'r-1' } });
  const modify = vi
    .fn()
    .mockResolvedValue(opts?.modifyResult ?? { ok: true, data: { runId: 'r-1' } });
  const claudeWrite = vi
    .fn()
    .mockResolvedValue({ ok: true, data: { bytesWritten: 0 } });

  const api: IpcApi = {
    ping: vi.fn<IpcApi['ping']>().mockResolvedValue({ reply: 'pong', receivedAt: 0 }),
    claude: {
      run: vi.fn<IpcApi['claude']['run']>().mockResolvedValue(unusedErr()),
      cancel: vi.fn<IpcApi['claude']['cancel']>().mockResolvedValue(unusedErr()),
      write: claudeWrite as unknown as IpcApi['claude']['write'],
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
    dialog: {
      selectFolder: vi.fn() as unknown as IpcApi['dialog']['selectFolder'],
    },
    runs: {
      start: vi.fn() as unknown as IpcApi['runs']['start'],
      cancel: vi.fn() as unknown as IpcApi['runs']['cancel'],
      approve: approve as unknown as IpcApi['runs']['approve'],
      reject: reject as unknown as IpcApi['runs']['reject'],
      modify: modify as unknown as IpcApi['runs']['modify'],
      current: vi.fn() as unknown as IpcApi['runs']['current'],
      listHistory: vi.fn() as unknown as IpcApi['runs']['listHistory'],
      delete: vi.fn() as unknown as IpcApi['runs']['delete'],
      readLog: vi.fn() as unknown as IpcApi['runs']['readLog'],
      onCurrentChanged: vi.fn(() => () => {}) as unknown as IpcApi['runs']['onCurrentChanged'],
      onStateChanged: vi.fn(() => () => {}) as unknown as IpcApi['runs']['onStateChanged'],
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
    skills: {
      list: vi.fn() as unknown as IpcApi['skills']['list'],
      install: vi.fn() as unknown as IpcApi['skills']['install'],
      findStart: vi.fn() as unknown as IpcApi['skills']['findStart'],
      findCancel: vi.fn() as unknown as IpcApi['skills']['findCancel'],
      onFindOutput: vi.fn(() => () => {}) as unknown as IpcApi['skills']['onFindOutput'],
      onFindExit: vi.fn(() => () => {}) as unknown as IpcApi['skills']['onFindExit'],
    },
    shell: {
      openPath: vi.fn() as unknown as IpcApi['shell']['openPath'],
    },
  };

  (window as { api?: IpcApi }).api = api;
  return { api, approve, reject, modify, claudeWrite };
}

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

describe('<ApprovalPanel /> — CMP-APPROVAL', () => {
  // ---------------------------------------------------------------------------
  // CMP-APPROVAL-001 — root testid
  // ---------------------------------------------------------------------------
  it('CMP-APPROVAL-001: root has data-testid="approval-panel-root"', () => {
    installApi();
    render(<ApprovalPanel runId="r-1" approval={makeApproval()} />);
    expect(screen.getByTestId('approval-panel-root')).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // CMP-APPROVAL-002 — header text
  // ---------------------------------------------------------------------------
  it('CMP-APPROVAL-002: header text "Approval Required" rendered', () => {
    installApi();
    render(<ApprovalPanel runId="r-1" approval={makeApproval()} />);
    const root = screen.getByTestId('approval-panel-root');
    expect(root.textContent ?? '').toMatch(/approval required/i);
  });

  // ---------------------------------------------------------------------------
  // CMP-APPROVAL-003 — plan text rendered when set; hidden when empty
  // ---------------------------------------------------------------------------
  it('CMP-APPROVAL-003: plan text renders when present and is hidden when empty', () => {
    installApi();
    const { unmount } = render(
      <ApprovalPanel
        runId="r-1"
        approval={makeApproval({ plan: 'Add validation to foo' })}
      />,
    );
    const plan = screen.getByTestId('approval-plan');
    expect(plan).toHaveTextContent(/add validation to foo/i);
    unmount();

    // Empty plan → section hidden.
    render(
      <ApprovalPanel
        runId="r-1"
        approval={makeApproval({ plan: '' })}
      />,
    );
    expect(screen.queryByTestId('approval-plan')).not.toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // CMP-APPROVAL-004 — files-to-modify list rendered when non-empty
  // ---------------------------------------------------------------------------
  it('CMP-APPROVAL-004: files-to-modify list renders when filesToModify is non-empty', () => {
    installApi();
    render(
      <ApprovalPanel
        runId="r-1"
        approval={makeApproval({
          filesToModify: ['src/foo.ts', 'src/bar.py'],
        })}
      />,
    );
    expect(screen.getByTestId('approval-files')).toBeInTheDocument();
    expect(screen.getByTestId('approval-file-0')).toBeInTheDocument();
    expect(screen.getByTestId('approval-file-1')).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // CMP-APPROVAL-005 — files list shows file path
  // ---------------------------------------------------------------------------
  it('CMP-APPROVAL-005: each file row carries data-testid approval-file-{i} and shows the full path', () => {
    installApi();
    render(
      <ApprovalPanel
        runId="r-1"
        approval={makeApproval({
          filesToModify: ['src/foo.ts', 'src/bar.py', 'src/baz.go'],
        })}
      />,
    );
    expect(screen.getByTestId('approval-file-0')).toHaveTextContent('src/foo.ts');
    expect(screen.getByTestId('approval-file-1')).toHaveTextContent('src/bar.py');
    expect(screen.getByTestId('approval-file-2')).toHaveTextContent('src/baz.go');
  });

  // ---------------------------------------------------------------------------
  // CMP-APPROVAL-006 — diff renders <CodeDiff>
  // ---------------------------------------------------------------------------
  it('CMP-APPROVAL-006: diff section renders <CodeDiff> with approval.diff (testid approval-diff)', () => {
    installApi();
    render(<ApprovalPanel runId="r-1" approval={makeApproval()} />);
    expect(screen.getByTestId('approval-diff')).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // CMP-APPROVAL-007 — three action buttons with mandated testids
  // ---------------------------------------------------------------------------
  it('CMP-APPROVAL-007: action bar exposes approve-button, modify-button, reject-button', () => {
    installApi();
    render(<ApprovalPanel runId="r-1" approval={makeApproval()} />);
    expect(screen.getByTestId('approve-button')).toBeInTheDocument();
    expect(screen.getByTestId('modify-button')).toBeInTheDocument();
    expect(screen.getByTestId('reject-button')).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // CMP-APPROVAL-008 — Approve click calls onApprove(runId)
  // ---------------------------------------------------------------------------
  it('CMP-APPROVAL-008: clicking Approve calls onApprove(runId) once', async () => {
    installApi();
    const onApprove = vi.fn().mockResolvedValue(true);
    render(
      <ApprovalPanel
        runId="r-42"
        approval={makeApproval()}
        onApprove={onApprove}
      />,
    );

    fireEvent.click(screen.getByTestId('approve-button'));
    await waitFor(() => {
      expect(onApprove).toHaveBeenCalledTimes(1);
    });
    expect(onApprove).toHaveBeenCalledWith('r-42');
  });

  // ---------------------------------------------------------------------------
  // CMP-APPROVAL-009 — Default Approve handler hits window.api.runs.approve
  // ---------------------------------------------------------------------------
  it('CMP-APPROVAL-009: default onApprove calls window.api.runs.approve({ runId })', async () => {
    const stub = installApi();
    render(<ApprovalPanel runId="r-7" approval={makeApproval()} />);

    fireEvent.click(screen.getByTestId('approve-button'));
    await waitFor(() => {
      expect(stub.approve).toHaveBeenCalledTimes(1);
    });
    expect(stub.approve).toHaveBeenCalledWith({ runId: 'r-7' });
  });

  // ---------------------------------------------------------------------------
  // CMP-APPROVAL-010 — Reject click calls onReject (default → runs.reject)
  // ---------------------------------------------------------------------------
  it('CMP-APPROVAL-010: clicking Reject calls onReject (default → window.api.runs.reject)', async () => {
    const stub = installApi();
    const onReject = vi.fn().mockResolvedValue(true);
    const { unmount } = render(
      <ApprovalPanel
        runId="r-1"
        approval={makeApproval()}
        onReject={onReject}
      />,
    );
    fireEvent.click(screen.getByTestId('reject-button'));
    await waitFor(() => {
      expect(onReject).toHaveBeenCalledWith('r-1');
    });
    unmount();

    // Default handler path:
    render(<ApprovalPanel runId="r-9" approval={makeApproval()} />);
    fireEvent.click(screen.getByTestId('reject-button'));
    await waitFor(() => {
      expect(stub.reject).toHaveBeenCalledWith({ runId: 'r-9' });
    });
  });

  // ---------------------------------------------------------------------------
  // CMP-APPROVAL-011 — Modify reveals composer pre-filled with plan
  // ---------------------------------------------------------------------------
  it('CMP-APPROVAL-011: clicking Modify reveals composer pre-filled with approval.plan', async () => {
    installApi();
    const planText = 'Add validation to the foo function.';
    render(
      <ApprovalPanel
        runId="r-1"
        approval={makeApproval({ plan: planText })}
      />,
    );

    // Composer not visible before click.
    expect(screen.queryByTestId('approval-modify-input')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('modify-button'));

    // After click, the composer is rendered.
    const composer = (await screen.findByTestId(
      'approval-modify-input',
    )) as HTMLTextAreaElement;
    expect(composer.value).toBe(planText);
  });

  // ---------------------------------------------------------------------------
  // CMP-APPROVAL-012 — Composer Send → onModify(runId, text) (default → runs.modify)
  // ---------------------------------------------------------------------------
  it('CMP-APPROVAL-012: composer Send calls onModify(runId, text) (default → runs.modify)', async () => {
    const stub = installApi();
    const onModify = vi.fn().mockResolvedValue(true);
    const { unmount } = render(
      <ApprovalPanel
        runId="r-1"
        approval={makeApproval({ plan: 'initial plan' })}
        onModify={onModify}
      />,
    );

    fireEvent.click(screen.getByTestId('modify-button'));
    const ta = (await screen.findByTestId(
      'approval-modify-input',
    )) as HTMLTextAreaElement;
    // Replace value with a new plan.
    fireEvent.change(ta, { target: { value: 'edited plan' } });
    fireEvent.click(screen.getByTestId('approval-modify-send'));

    await waitFor(() => {
      expect(onModify).toHaveBeenCalledWith('r-1', 'edited plan');
    });
    unmount();

    // Default handler path:
    render(
      <ApprovalPanel
        runId="r-2"
        approval={makeApproval({ plan: 'initial plan' })}
      />,
    );
    fireEvent.click(screen.getByTestId('modify-button'));
    const ta2 = (await screen.findByTestId(
      'approval-modify-input',
    )) as HTMLTextAreaElement;
    fireEvent.change(ta2, { target: { value: 'second edit' } });
    fireEvent.click(screen.getByTestId('approval-modify-send'));

    await waitFor(() => {
      expect(stub.modify).toHaveBeenCalledWith({
        runId: 'r-2',
        text: 'second edit',
      });
    });
  });

  // ---------------------------------------------------------------------------
  // CMP-APPROVAL-013 — Empty Modify text → Send disabled, onModify not called
  // ---------------------------------------------------------------------------
  it('CMP-APPROVAL-013: empty Modify text → Send disabled and onModify is not called', async () => {
    installApi();
    const onModify = vi.fn().mockResolvedValue(true);
    render(
      <ApprovalPanel
        runId="r-1"
        approval={makeApproval({ plan: '' })}
        onModify={onModify}
      />,
    );

    fireEvent.click(screen.getByTestId('modify-button'));
    const send = (await screen.findByTestId(
      'approval-modify-send',
    )) as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    // Click anyway — no call.
    fireEvent.click(send);
    await new Promise((r) => setTimeout(r, 20));
    expect(onModify).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // CMP-APPROVAL-014 — While action in flight, all three buttons disabled
  // ---------------------------------------------------------------------------
  it('CMP-APPROVAL-014: while an action is in flight, all three buttons are disabled', async () => {
    installApi();
    let resolveApprove: (v: boolean) => void = () => {};
    const onApprove = vi.fn(
      () =>
        new Promise<boolean>((res) => {
          resolveApprove = res;
        }),
    );
    render(
      <ApprovalPanel
        runId="r-1"
        approval={makeApproval()}
        onApprove={onApprove}
      />,
    );

    fireEvent.click(screen.getByTestId('approve-button'));

    // Approve is in flight — all three buttons disabled.
    await waitFor(() => {
      const a = screen.getByTestId('approve-button') as HTMLButtonElement;
      const m = screen.getByTestId('modify-button') as HTMLButtonElement;
      const r = screen.getByTestId('reject-button') as HTMLButtonElement;
      expect(a.disabled).toBe(true);
      expect(m.disabled).toBe(true);
      expect(r.disabled).toBe(true);
    });

    // Resolve to clean up.
    resolveApprove(true);
    await waitFor(() => {
      expect(onApprove).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // CMP-APPROVAL-015 — disabled prop disables all three buttons regardless
  // ---------------------------------------------------------------------------
  it('CMP-APPROVAL-015: disabled prop disables all three buttons regardless of pendingAction', () => {
    installApi();
    render(
      <ApprovalPanel
        runId="r-1"
        approval={makeApproval()}
        disabled
      />,
    );
    expect((screen.getByTestId('approve-button') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByTestId('modify-button') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((screen.getByTestId('reject-button') as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  // ---------------------------------------------------------------------------
  // CMP-APPROVAL-016 — empty filesToModify and empty diff → hidden sections
  // ---------------------------------------------------------------------------
  it('CMP-APPROVAL-016: empty filesToModify and empty diff → those sections do not render', () => {
    installApi();
    render(
      <ApprovalPanel
        runId="r-1"
        approval={makeApproval({
          filesToModify: [],
          diff: '',
        })}
      />,
    );
    expect(screen.queryByTestId('approval-files')).not.toBeInTheDocument();
    expect(screen.queryByTestId('approval-diff')).not.toBeInTheDocument();
    // Plan still rendered.
    expect(screen.getByTestId('approval-plan')).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // CMP-APPROVAL-017 — Modify composer can be re-collapsed
  // ---------------------------------------------------------------------------
  it('CMP-APPROVAL-017: clicking Modify again hides the composer (toggle)', async () => {
    installApi();
    render(
      <ApprovalPanel
        runId="r-1"
        approval={makeApproval({ plan: 'starting plan' })}
      />,
    );

    // Open.
    fireEvent.click(screen.getByTestId('modify-button'));
    expect(await screen.findByTestId('approval-modify-input')).toBeInTheDocument();

    // Toggle closed.
    fireEvent.click(screen.getByTestId('modify-button'));
    await waitFor(() => {
      expect(screen.queryByTestId('approval-modify-input')).not.toBeInTheDocument();
    });
  });
});
