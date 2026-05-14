// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { AddConnectionDialog } from '../../src/renderer/components/AddConnectionDialog';
import type { IpcApi, IpcResult } from '../../src/shared/ipc';
import type { Connection } from '../../src/shared/schema/connection';

/**
 * CMP-CONN-DIALOG-001..011 — <AddConnectionDialog /> tests.
 *
 * Tests both create-mode (no `editing` prop) and edit-mode (with `editing`
 * prop). The dialog surfaces these testids per the spec:
 *   add-connection-dialog
 *   connection-provider-select
 *   connection-label-input
 *   connection-host-input
 *   connection-email-input    (only when provider === 'jira')
 *   connection-token-input
 *   connection-test-button
 *   connection-test-result
 *   connection-save-button
 *   connection-cancel-button
 */

declare global {
  interface Window {
    api?: IpcApi;
  }
}

const githubConn: Connection = {
  id: 'conn-gh-1',
  provider: 'github',
  label: 'Personal',
  host: 'https://api.github.com',
  authMethod: 'pat',
  secretRef: 'connection:conn-gh-1:token',
  accountIdentity: { kind: 'github', login: 'gazhang', scopes: ['repo', 'read:user'] },
  lastVerifiedAt: 1700000000000,
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
};

interface ApiStub {
  api: IpcApi;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  test: ReturnType<typeof vi.fn>;
}

function installApi(opts?: {
  createResult?: IpcResult<Connection>;
  updateResult?: IpcResult<Connection>;
  testResult?: IpcResult<{
    identity: Connection['accountIdentity'];
    verifiedAt: number;
  }>;
}): ApiStub {
  const unusedErr = (): IpcResult<never> => ({
    ok: false,
    error: { code: 'NOT_USED_IN_FE_TESTS', message: '' },
  });

  const create = vi
    .fn()
    .mockResolvedValue(opts?.createResult ?? { ok: true, data: githubConn });
  const update = vi
    .fn()
    .mockResolvedValue(opts?.updateResult ?? { ok: true, data: githubConn });
  const test = vi.fn().mockResolvedValue(
    opts?.testResult ?? {
      ok: true,
      data: {
        identity: { kind: 'github', login: 'gazhang', scopes: ['repo'] },
        verifiedAt: Date.now(),
      },
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
      testConnection: vi
        .fn<IpcApi['jira']['testConnection']>()
        .mockResolvedValue(unusedErr()),
      refreshPollers: vi
        .fn<IpcApi['jira']['refreshPollers']>()
        .mockResolvedValue(unusedErr()),
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
      list: vi.fn().mockResolvedValue({ ok: true, data: [] }),
      get: vi.fn().mockResolvedValue(unusedErr()),
      create,
      update,
      delete: vi.fn().mockResolvedValue(unusedErr()),
      test,
    } as unknown as IpcApi['connections'],
    dialog: {
      selectFolder: vi
        .fn()
        .mockResolvedValue({ ok: true, data: { path: null } }),
    } as unknown as IpcApi['dialog'],
    tickets: {
      list: vi.fn().mockResolvedValue(unusedErr()),
    } as unknown as IpcApi['tickets'],
    pulls: {
      list: vi.fn().mockResolvedValue(unusedErr()),
    } as unknown as IpcApi['pulls'],
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
      list: vi.fn().mockResolvedValue(unusedErr()),
      install: vi.fn().mockResolvedValue(unusedErr()),
      findStart: vi.fn().mockResolvedValue(unusedErr()),
      findCancel: vi.fn().mockResolvedValue(unusedErr()),
      onFindOutput: vi.fn(() => () => {}),
      onFindExit: vi.fn(() => () => {}),
    } as unknown as IpcApi['skills'],
    shell: {
      openPath: vi.fn().mockResolvedValue({ ok: true, data: null }),
    } as unknown as IpcApi['shell'],
  } as IpcApi;

  (window as { api?: IpcApi }).api = api;
  return { api, create, update, test };
}

afterEach(() => {
  cleanup();
  delete (window as { api?: IpcApi }).api;
  vi.restoreAllMocks();
});

const noop = () => {};
const noopAsync = async () => {};

function fillRequiredCreateGithub(): void {
  // Provider defaults to github (or we set it explicitly; both work).
  fireEvent.change(screen.getByTestId('connection-provider-select'), {
    target: { value: 'github' },
  });
  fireEvent.change(screen.getByTestId('connection-label-input'), {
    target: { value: 'Personal' },
  });
  fireEvent.change(screen.getByTestId('connection-host-input'), {
    target: { value: 'https://api.github.com' },
  });
  fireEvent.change(screen.getByTestId('connection-token-input'), {
    target: { value: 'ghp_secrettoken' },
  });
}

describe('<AddConnectionDialog /> — CMP-CONN-DIALOG', () => {
  // -------------------------------------------------------------------------
  // CMP-CONN-DIALOG-001 — Provider select renders 3 options
  // -------------------------------------------------------------------------
  it('CMP-CONN-DIALOG-001: provider select renders GitHub, Jira, and Bitbucket', () => {
    installApi();
    render(
      <AddConnectionDialog open={true} onClose={noop} onSaved={noopAsync} />,
    );
    const select = screen.getByTestId('connection-provider-select') as HTMLSelectElement;
    const optionValues = Array.from(select.options).map((o) => o.value);
    expect(optionValues).toContain('github');
    expect(optionValues).toContain('jira');
    expect(optionValues).toContain('bitbucket');
  });

  // -------------------------------------------------------------------------
  // CMP-CONN-DIALOG-002 — Bitbucket option disabled
  // -------------------------------------------------------------------------
  it('CMP-CONN-DIALOG-002: Bitbucket option is disabled (coming soon)', () => {
    installApi();
    render(
      <AddConnectionDialog open={true} onClose={noop} onSaved={noopAsync} />,
    );
    const select = screen.getByTestId('connection-provider-select') as HTMLSelectElement;
    const bitbucket = Array.from(select.options).find((o) => o.value === 'bitbucket');
    expect(bitbucket).toBeDefined();
    expect(bitbucket?.disabled).toBe(true);
  });

  // -------------------------------------------------------------------------
  // CMP-CONN-DIALOG-003 — Switching provider updates host placeholder
  // -------------------------------------------------------------------------
  it('CMP-CONN-DIALOG-003: switching provider to Jira updates the host placeholder', () => {
    installApi();
    render(
      <AddConnectionDialog open={true} onClose={noop} onSaved={noopAsync} />,
    );
    const hostBefore = screen.getByTestId('connection-host-input') as HTMLInputElement;
    const placeholderBefore = hostBefore.placeholder;

    // Switch to jira
    fireEvent.change(screen.getByTestId('connection-provider-select'), {
      target: { value: 'jira' },
    });

    const hostAfter = screen.getByTestId('connection-host-input') as HTMLInputElement;
    const placeholderAfter = hostAfter.placeholder;

    // We don't pin the exact placeholder text — only that it differs after
    // changing provider, OR that the field's value was auto-filled to a
    // jira-like URL. Both are spec-compliant behaviours.
    const changed =
      placeholderBefore !== placeholderAfter ||
      /atlassian/i.test(hostAfter.value);
    expect(changed).toBe(true);
  });

  // -------------------------------------------------------------------------
  // CMP-CONN-DIALOG-004 — Email field shown only when provider === 'jira'
  // -------------------------------------------------------------------------
  it('CMP-CONN-DIALOG-004: email field is hidden for github, shown for jira', () => {
    installApi();
    render(
      <AddConnectionDialog open={true} onClose={noop} onSaved={noopAsync} />,
    );

    // Default provider is github → no email field.
    expect(screen.queryByTestId('connection-email-input')).not.toBeInTheDocument();

    // Switch to jira → email field appears.
    fireEvent.change(screen.getByTestId('connection-provider-select'), {
      target: { value: 'jira' },
    });

    expect(screen.getByTestId('connection-email-input')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // CMP-CONN-DIALOG-005 — Test Connection success pill
  // -------------------------------------------------------------------------
  it('CMP-CONN-DIALOG-005: Test Connection success → calls connections.test (mode: preview), shows identity pill', async () => {
    const stub = installApi({
      testResult: {
        ok: true,
        data: {
          identity: { kind: 'github', login: 'gazhang', scopes: ['repo'] },
          verifiedAt: Date.now(),
        },
      },
    });
    render(
      <AddConnectionDialog open={true} onClose={noop} onSaved={noopAsync} />,
    );

    fillRequiredCreateGithub();
    fireEvent.click(screen.getByTestId('connection-test-button'));

    await waitFor(() => {
      expect(stub.test).toHaveBeenCalledTimes(1);
    });
    const call = stub.test.mock.calls[0]?.[0] as { mode?: string; provider?: string };
    expect(call?.mode).toBe('preview');
    expect(call?.provider).toBe('github');

    // Success pill shows the login.
    await waitFor(() => {
      const pill = screen.getByTestId('connection-test-result');
      expect(pill).toBeInTheDocument();
      expect(pill.textContent).toMatch(/gazhang/i);
    });
  });

  // -------------------------------------------------------------------------
  // CMP-CONN-DIALOG-006 — Test Connection error pill
  // -------------------------------------------------------------------------
  it('CMP-CONN-DIALOG-006: Test Connection failure → shows code + message inline', async () => {
    installApi({
      testResult: {
        ok: false,
        error: { code: 'AUTH', message: 'Bad credentials' },
      },
    });
    render(
      <AddConnectionDialog open={true} onClose={noop} onSaved={noopAsync} />,
    );

    fillRequiredCreateGithub();
    fireEvent.click(screen.getByTestId('connection-test-button'));

    await waitFor(() => {
      const pill = screen.getByTestId('connection-test-result');
      expect(pill).toBeInTheDocument();
      // We expect either the code or the message to be visible.
      expect(pill.textContent).toMatch(/AUTH|Bad credentials/i);
    });
  });

  // -------------------------------------------------------------------------
  // CMP-CONN-DIALOG-007 — Save calls connections.create when no `editing`
  // -------------------------------------------------------------------------
  it('CMP-CONN-DIALOG-007: Save (create mode) calls connections.create', async () => {
    const stub = installApi();
    const onSaved = vi.fn().mockResolvedValue(undefined);
    render(
      <AddConnectionDialog open={true} onClose={noop} onSaved={onSaved} />,
    );

    fillRequiredCreateGithub();
    // Test connection first (UX safeguard — Save may be gated by it).
    fireEvent.click(screen.getByTestId('connection-test-button'));
    await waitFor(() => {
      expect(stub.test).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByTestId('connection-save-button'));

    await waitFor(() => {
      expect(stub.create).toHaveBeenCalledTimes(1);
    });
    expect(stub.update).not.toHaveBeenCalled();
    const call = stub.create.mock.calls[0]?.[0] as {
      input?: { provider?: string; label?: string; plaintextToken?: string };
    };
    expect(call?.input?.provider).toBe('github');
    expect(call?.input?.label).toBe('Personal');
    expect(call?.input?.plaintextToken).toBe('ghp_secrettoken');
  });

  // -------------------------------------------------------------------------
  // CMP-CONN-DIALOG-008 — Save calls connections.update when `editing` prop
  // -------------------------------------------------------------------------
  it('CMP-CONN-DIALOG-008: Save (edit mode) calls connections.update with the editing.id', async () => {
    const stub = installApi();
    render(
      <AddConnectionDialog
        open={true}
        onClose={noop}
        onSaved={noopAsync}
        editing={githubConn}
      />,
    );

    // Tweak the label only; leave token empty (don't rotate).
    fireEvent.change(screen.getByTestId('connection-label-input'), {
      target: { value: 'Renamed' },
    });

    fireEvent.click(screen.getByTestId('connection-save-button'));

    await waitFor(() => {
      expect(stub.update).toHaveBeenCalledTimes(1);
    });
    expect(stub.create).not.toHaveBeenCalled();
    const call = stub.update.mock.calls[0]?.[0] as {
      id?: string;
      input?: { label?: string; plaintextToken?: string };
    };
    expect(call?.id).toBe(githubConn.id);
    expect(call?.input?.label).toBe('Renamed');
    // Token left empty → not present in the update payload.
    expect(call?.input?.plaintextToken === undefined || call?.input?.plaintextToken === '').toBe(
      true,
    );
  });

  // -------------------------------------------------------------------------
  // CMP-CONN-DIALOG-009 — Edit mode: token field empty + helper text
  // -------------------------------------------------------------------------
  it('CMP-CONN-DIALOG-009: edit mode renders token field empty with "Leave empty to keep current" helper', () => {
    installApi();
    render(
      <AddConnectionDialog
        open={true}
        onClose={noop}
        onSaved={noopAsync}
        editing={githubConn}
      />,
    );

    const tokenInput = screen.getByTestId('connection-token-input') as HTMLInputElement;
    expect(tokenInput.value).toBe('');
    // Helper text is rendered somewhere inside the dialog.
    expect(screen.getByText(/leave empty to keep/i)).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // CMP-CONN-DIALOG-010 — LABEL_NOT_UNIQUE shown inline on the label field
  // -------------------------------------------------------------------------
  it('CMP-CONN-DIALOG-010: server LABEL_NOT_UNIQUE response surfaces as an inline label-field error', async () => {
    const stub = installApi({
      createResult: {
        ok: false,
        error: { code: 'LABEL_NOT_UNIQUE', message: 'label already taken' },
      },
    });
    render(
      <AddConnectionDialog open={true} onClose={noop} onSaved={noopAsync} />,
    );

    fillRequiredCreateGithub();
    fireEvent.click(screen.getByTestId('connection-test-button'));
    await waitFor(() => {
      expect(stub.test).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByTestId('connection-save-button'));

    await waitFor(() => {
      expect(stub.create).toHaveBeenCalled();
    });

    // The error is surfaced somewhere in the dialog. We accept either an
    // inline "label already taken" message (preferred) or the raw code.
    await waitFor(() => {
      const errorMatch = screen.queryByText(/label already taken/i) ??
        screen.queryByText(/LABEL_NOT_UNIQUE/);
      expect(errorMatch).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // CMP-CONN-DIALOG-011 — Save disabled until required fields filled
  // -------------------------------------------------------------------------
  it('CMP-CONN-DIALOG-011: Save button is disabled until required fields are filled', () => {
    installApi();
    render(
      <AddConnectionDialog open={true} onClose={noop} onSaved={noopAsync} />,
    );

    const save = screen.getByTestId('connection-save-button') as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    // Fill label only — should still be disabled (host + token still empty).
    fireEvent.change(screen.getByTestId('connection-label-input'), {
      target: { value: 'Personal' },
    });
    expect(save.disabled).toBe(true);

    // Fill host + token.
    fireEvent.change(screen.getByTestId('connection-host-input'), {
      target: { value: 'https://api.github.com' },
    });
    fireEvent.change(screen.getByTestId('connection-token-input'), {
      target: { value: 'ghp_secrettoken' },
    });

    // After all required fields, the button MAY be enabled (per spec, save
    // is "disabled until required fields filled"). The spec note says
    // "Test Connection has succeeded" is a soft gate — not hard. We accept
    // both. The hard contract is: with required fields missing, disabled.
    // Re-clear the token to verify the disabled-ness toggles back on.
    fireEvent.change(screen.getByTestId('connection-token-input'), {
      target: { value: '' },
    });
    expect(save.disabled).toBe(true);
  });
});
