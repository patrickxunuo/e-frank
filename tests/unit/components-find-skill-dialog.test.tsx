// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { FindSkillDialog } from '../../src/renderer/components/FindSkillDialog';
import type {
  IpcApi,
  IpcResult,
  SkillsFindExitEvent,
  SkillsFindOutputEvent,
} from '../../src/shared/ipc';

/**
 * DIALOG-FIND-001..010 — <FindSkillDialog /> tests.
 *
 * Streaming output is driven by capturing the listener fn passed to
 * `window.api.skills.onFindOutput` (and onFindExit) and invoking it
 * directly with synthetic events. We wrap those calls in `act()` so
 * React processes the resulting state updates synchronously.
 *
 * Testids exposed by the dialog per the GH-38 spec:
 *   find-skill-dialog          — Dialog wrapper
 *   find-skill-search          — query input
 *   find-skill-submit          — Search submit button (idle)
 *   find-skill-cancel          — Stop button (while a find is in flight)
 *   find-skill-stream          — streaming output container
 *   find-skill-error           — find-error banner
 *   find-skill-candidates      — detected-candidates list
 *   find-skill-install-{ref}   — inline Install button on a candidate
 *   find-skill-install-input   — manual install ref input
 *   find-skill-install-manual  — manual install button
 *   find-skill-install-error   — install error banner
 */

declare global {
  interface Window {
    api?: IpcApi;
  }
}

interface ApiStub {
  api: IpcApi;
  findStart: ReturnType<typeof vi.fn>;
  findCancel: ReturnType<typeof vi.fn>;
  install: ReturnType<typeof vi.fn>;
  emitOutput: (e: SkillsFindOutputEvent) => void;
  emitExit: (e: SkillsFindExitEvent) => void;
}

function installApi(opts?: {
  findStartResult?: IpcResult<{ findId: string; pid: number | undefined; startedAt: number }>;
  installResult?: IpcResult<{
    status: 'installed' | 'failed';
    stdout: string;
    stderr: string;
    exitCode: number | null;
  }>;
}): ApiStub {
  const unusedErr = (): IpcResult<never> => ({
    ok: false,
    error: { code: 'NOT_USED_IN_FE_TESTS', message: '' },
  });

  let capturedOutputListener: ((e: SkillsFindOutputEvent) => void) | null = null;
  let capturedExitListener: ((e: SkillsFindExitEvent) => void) | null = null;

  const findStart = vi.fn().mockResolvedValue(
    opts?.findStartResult ?? {
      ok: true,
      data: { findId: 'find-1', pid: undefined, startedAt: 0 },
    },
  );
  const findCancel = vi.fn().mockResolvedValue({ ok: true, data: { findId: 'find-1' } });
  const install = vi.fn().mockResolvedValue(
    opts?.installResult ?? {
      ok: true,
      data: { status: 'installed', stdout: '', stderr: '', exitCode: 0 },
    },
  );

  const api: IpcApi = {
    ping: vi.fn<IpcApi['ping']>().mockResolvedValue({ reply: 'pong', receivedAt: 0 }),
    claude: {
      run: vi.fn<IpcApi['claude']['run']>().mockResolvedValue(unusedErr()),
      cancel: vi.fn<IpcApi['claude']['cancel']>().mockResolvedValue(unusedErr()),
      write: vi.fn<IpcApi['claude']['write']>().mockResolvedValue(unusedErr()),
      status: vi.fn<IpcApi['claude']['status']>().mockResolvedValue({
        ok: true,
        data: { active: null },
      }),
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
      testConnection: vi.fn<IpcApi['jira']['testConnection']>().mockResolvedValue(unusedErr()),
      refreshPollers: vi.fn<IpcApi['jira']['refreshPollers']>().mockResolvedValue(unusedErr()),
      onTicketsChanged: vi.fn<IpcApi['jira']['onTicketsChanged']>(() => () => {}),
      onError: vi.fn<IpcApi['jira']['onError']>(() => () => {}),
    },
    runs: {
      start: vi.fn().mockResolvedValue(unusedErr()),
      cancel: vi.fn().mockResolvedValue(unusedErr()),
      approve: vi.fn().mockResolvedValue(unusedErr()),
      reject: vi.fn().mockResolvedValue(unusedErr()),
      modify: vi.fn().mockResolvedValue(unusedErr()),
      current: vi.fn().mockResolvedValue({ ok: true, data: { run: null } }),
      listHistory: vi.fn().mockResolvedValue(unusedErr()),
      readLog: vi.fn().mockResolvedValue({ ok: true, data: { entries: [] } }),
      onCurrentChanged: vi.fn(() => () => {}),
      onStateChanged: vi.fn(() => () => {}),
    } as unknown as IpcApi['runs'],
    connections: {
      list: vi.fn().mockResolvedValue(unusedErr()),
      get: vi.fn().mockResolvedValue(unusedErr()),
      create: vi.fn().mockResolvedValue(unusedErr()),
      update: vi.fn().mockResolvedValue(unusedErr()),
      delete: vi.fn().mockResolvedValue(unusedErr()),
      test: vi.fn().mockResolvedValue(unusedErr()),
    } as unknown as IpcApi['connections'],
    dialog: {
      selectFolder: vi
        .fn()
        .mockResolvedValue({ ok: true, data: { path: null } }),
    } as unknown as IpcApi['dialog'],
    tickets: {
      list: vi.fn().mockResolvedValue(unusedErr()),
    } as unknown as IpcApi['tickets'],
    chrome: {
      minimize: vi.fn().mockResolvedValue({ ok: true, data: null }),
      maximize: vi.fn().mockResolvedValue({ ok: true, data: null }),
      close: vi.fn().mockResolvedValue({ ok: true, data: null }),
      getState: vi
        .fn()
        .mockResolvedValue({ ok: true, data: { isMaximized: false, platform: 'win32' } }),
      onStateChanged: vi.fn(() => () => {}),
    } as unknown as IpcApi['chrome'],
    skills: {
      list: vi.fn().mockResolvedValue({ ok: true, data: { skills: [] } }),
      install,
      findStart,
      findCancel,
      onFindOutput: vi.fn((listener: (e: SkillsFindOutputEvent) => void) => {
        capturedOutputListener = listener;
        return () => {
          capturedOutputListener = null;
        };
      }),
      onFindExit: vi.fn((listener: (e: SkillsFindExitEvent) => void) => {
        capturedExitListener = listener;
        return () => {
          capturedExitListener = null;
        };
      }),
    } as unknown as IpcApi['skills'],
    shell: {
      openPath: vi.fn().mockResolvedValue({ ok: true, data: null }),
    } as unknown as IpcApi['shell'],
  } as IpcApi;

  (window as { api?: IpcApi }).api = api;

  const emitOutput = (e: SkillsFindOutputEvent): void => {
    if (capturedOutputListener) capturedOutputListener(e);
  };
  const emitExit = (e: SkillsFindExitEvent): void => {
    if (capturedExitListener) capturedExitListener(e);
  };

  return { api, findStart, findCancel, install, emitOutput, emitExit };
}

const noop = (): void => {};

afterEach(() => {
  cleanup();
  delete (window as { api?: IpcApi }).api;
  vi.restoreAllMocks();
});

describe('<FindSkillDialog /> — DIALOG-FIND', () => {
  // -------------------------------------------------------------------------
  // DIALOG-FIND-001 — Dialog renders when open=true
  // -------------------------------------------------------------------------
  it('DIALOG-FIND-001: dialog renders with find-skill-dialog testid when open=true', () => {
    installApi();
    render(<FindSkillDialog open={true} onClose={noop} />);

    expect(screen.getByTestId('find-skill-dialog')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // DIALOG-FIND-002 — Input pre-fills from initialQuery prop
  // -------------------------------------------------------------------------
  it('DIALOG-FIND-002: search input pre-fills from initialQuery prop', () => {
    installApi();
    render(
      <FindSkillDialog open={true} initialQuery="image cropping" onClose={noop} />,
    );

    const input = screen.getByTestId('find-skill-search') as HTMLInputElement;
    expect(input.value).toBe('image cropping');
  });

  // -------------------------------------------------------------------------
  // DIALOG-FIND-003 — Submit calls findStart with the query value
  // -------------------------------------------------------------------------
  it('DIALOG-FIND-003: clicking submit calls skills.findStart({query}) and subscribes to onFindOutput', async () => {
    const stub = installApi();
    render(<FindSkillDialog open={true} initialQuery="ef-feature" onClose={noop} />);

    const submit = screen.getByTestId('find-skill-submit');
    fireEvent.click(submit);

    await waitFor(() => {
      expect(stub.findStart).toHaveBeenCalledTimes(1);
    });
    const call = stub.findStart.mock.calls[0]?.[0] as { query?: string };
    expect(call?.query).toBe('ef-feature');

    // Subscribing happens after findStart resolves and the dialog flips into
    // its "active find" state, so wait for the onFindOutput stub to fire.
    const skills = (window.api as IpcApi).skills;
    await waitFor(() => {
      expect(skills.onFindOutput).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // DIALOG-FIND-004 — Streaming lines appear in the stream area
  // -------------------------------------------------------------------------
  it('DIALOG-FIND-004: streamed lines via onFindOutput appear in the stream area', async () => {
    const stub = installApi();
    render(<FindSkillDialog open={true} initialQuery="ef-feature" onClose={noop} />);

    fireEvent.click(screen.getByTestId('find-skill-submit'));
    await waitFor(() => {
      expect(stub.findStart).toHaveBeenCalledTimes(1);
    });
    // Wait until the dialog has subscribed (so capturedOutputListener is set).
    await waitFor(() => {
      const skills = (window.api as IpcApi).skills;
      expect(skills.onFindOutput).toHaveBeenCalled();
    });

    act(() => {
      stub.emitOutput({
        findId: 'find-1',
        stream: 'stdout',
        line: 'Searching for relevant skills...',
        timestamp: 1,
      });
    });

    const streamArea = screen.getByTestId('find-skill-stream');
    expect(streamArea).toHaveTextContent('Searching for relevant skills...');
  });

  // -------------------------------------------------------------------------
  // DIALOG-FIND-005 — Candidate line surfaces inline install card
  // -------------------------------------------------------------------------
  it('DIALOG-FIND-005: a JSON-array stdout payload surfaces find-skill-install-{ref} card with description', async () => {
    const stub = installApi();
    render(<FindSkillDialog open={true} initialQuery="ef-feature" onClose={noop} />);

    fireEvent.click(screen.getByTestId('find-skill-submit'));
    await waitFor(() => {
      expect(stub.findStart).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      const skills = (window.api as IpcApi).skills;
      expect(skills.onFindOutput).toHaveBeenCalled();
    });

    // The finder is now driven by a structured-output prompt — Claude is
    // expected to respond with a JSON array; the dialog parses that into
    // candidate cards.
    act(() => {
      stub.emitOutput({
        findId: 'find-1',
        stream: 'stdout',
        line: '[{"name":"ef-feature","ref":"ef-feature","description":"Human-paced ticket-to-PR workflow","stars":42}]',
        timestamp: 2,
      });
    });

    expect(screen.getByTestId('find-skill-install-ef-feature')).toBeInTheDocument();
    const candidates = screen.getByTestId('find-skill-candidates');
    expect(candidates).toHaveTextContent(/Human-paced ticket-to-PR workflow/);
    // Stars badge renders the count.
    expect(candidates).toHaveTextContent(/42/);
  });

  // -------------------------------------------------------------------------
  // DIALOG-FIND-006 — Clicking install on a candidate calls install({ref})
  // -------------------------------------------------------------------------
  it('DIALOG-FIND-006: clicking find-skill-install-{ref} calls skills.install({ref})', async () => {
    const stub = installApi();
    render(<FindSkillDialog open={true} initialQuery="ef-feature" onClose={noop} />);

    fireEvent.click(screen.getByTestId('find-skill-submit'));
    await waitFor(() => {
      expect(stub.findStart).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      const skills = (window.api as IpcApi).skills;
      expect(skills.onFindOutput).toHaveBeenCalled();
    });

    act(() => {
      stub.emitOutput({
        findId: 'find-1',
        stream: 'stdout',
        line: '[{"name":"ef-feature","ref":"ef-feature","description":"Human-paced ticket-to-PR workflow","stars":null}]',
        timestamp: 3,
      });
    });

    const installBtn = await screen.findByTestId('find-skill-install-ef-feature');
    fireEvent.click(installBtn);

    await waitFor(() => {
      expect(stub.install).toHaveBeenCalledTimes(1);
    });
    const call = stub.install.mock.calls[0]?.[0] as { ref?: string };
    expect(call?.ref).toBe('ef-feature');
  });

  // -------------------------------------------------------------------------
  // DIALOG-FIND-007 — Manual install input + button
  // -------------------------------------------------------------------------
  it('DIALOG-FIND-007: typing a manual ref + clicking the manual button calls install({ref})', async () => {
    const stub = installApi();
    render(<FindSkillDialog open={true} onClose={noop} />);

    const manualInput = screen.getByTestId('find-skill-install-input') as HTMLInputElement;
    fireEvent.change(manualInput, { target: { value: 'svg-logo-designer' } });
    expect(manualInput.value).toBe('svg-logo-designer');

    const manualBtn = screen.getByTestId('find-skill-install-manual');
    fireEvent.click(manualBtn);

    await waitFor(() => {
      expect(stub.install).toHaveBeenCalledTimes(1);
    });
    const call = stub.install.mock.calls[0]?.[0] as { ref?: string };
    expect(call?.ref).toBe('svg-logo-designer');
  });

  // -------------------------------------------------------------------------
  // DIALOG-FIND-008 — While finding, submit is replaced by Stop button
  // -------------------------------------------------------------------------
  it('DIALOG-FIND-008: while finding, submit is replaced by find-skill-cancel; clicking it calls findCancel({findId})', async () => {
    const stub = installApi();
    render(<FindSkillDialog open={true} initialQuery="ef-feature" onClose={noop} />);

    fireEvent.click(screen.getByTestId('find-skill-submit'));

    // After findStart resolves, the dialog should swap submit → cancel.
    const cancelBtn = await screen.findByTestId('find-skill-cancel');
    expect(cancelBtn).toBeInTheDocument();
    expect(screen.queryByTestId('find-skill-submit')).not.toBeInTheDocument();

    fireEvent.click(cancelBtn);

    await waitFor(() => {
      expect(stub.findCancel).toHaveBeenCalledTimes(1);
    });
    const call = stub.findCancel.mock.calls[0]?.[0] as { findId?: string };
    expect(call?.findId).toBe('find-1');
  });

  // -------------------------------------------------------------------------
  // DIALOG-FIND-009 — Install failure (status='failed') surfaces error banner
  // -------------------------------------------------------------------------
  it("DIALOG-FIND-009: install failure (status='failed' with stderr) surfaces find-skill-install-error banner", async () => {
    const stub = installApi({
      installResult: {
        ok: true,
        data: {
          status: 'failed',
          stdout: '',
          stderr: 'Error: skill not found in registry',
          exitCode: 1,
        },
      },
    });
    render(<FindSkillDialog open={true} onClose={noop} />);

    const manualInput = screen.getByTestId('find-skill-install-input') as HTMLInputElement;
    fireEvent.change(manualInput, { target: { value: 'nonexistent-skill' } });
    fireEvent.click(screen.getByTestId('find-skill-install-manual'));

    await waitFor(() => {
      expect(stub.install).toHaveBeenCalledTimes(1);
    });

    const banner = await screen.findByTestId('find-skill-install-error');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent(/skill not found in registry/);
  });

  // -------------------------------------------------------------------------
  // DIALOG-FIND-010 — Closing the dialog mid-find calls findCancel
  // -------------------------------------------------------------------------
  it('DIALOG-FIND-010: closing the dialog while a find is in flight calls findCancel', async () => {
    const stub = installApi();
    const onClose = vi.fn();
    const { rerender } = render(
      <FindSkillDialog open={true} initialQuery="ef-feature" onClose={onClose} />,
    );

    // Kick off a find so activeFindId becomes 'find-1'.
    fireEvent.click(screen.getByTestId('find-skill-submit'));
    await screen.findByTestId('find-skill-cancel');

    // Simulate closing via the Dialog's Esc/backdrop path. The dialog
    // delegates that to its `onClose` prop, which (per FindSkillDialog)
    // invokes handleCancel() before calling the parent onClose. Press Esc
    // to drive that path through the real Dialog event handler.
    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(stub.findCancel).toHaveBeenCalledTimes(1);
    });
    expect(onClose).toHaveBeenCalled();

    // Silence unused-var warning for rerender; helper exists for future use.
    void rerender;
  });
});
