// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import App from '../../src/renderer/App';
import { Connections } from '../../src/renderer/views/Connections';
import type { IpcApi, IpcResult } from '../../src/shared/ipc';
import type { Connection } from '../../src/shared/schema/connection';

/**
 * VIEW-CONN-001..009 — <Connections /> view tests.
 * APP-CONN-001..003 — <App /> integration tests for sidebar navigation.
 *
 * The Connections view exposes the following testids per the spec:
 *   connections-page             — root container
 *   connections-add-button       — primary "Add Connection" button
 *   connections-empty            — empty-state card (only when count===0)
 *   connections-row-{id}         — one row per connection
 *   connection-test-{id}         — Test action button on a row
 *   connection-edit-{id}         — Edit action button on a row
 *   connection-delete-{id}       — Delete action button on a row
 *
 * The Delete confirm dialog reuses the existing <Dialog> shell. We don't
 * pin the confirm-button testid here (Agent B's choice) — instead we look
 * for a button containing "delete" or "confirm" inside the <Dialog>.
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
  verificationStatus: 'verified',
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
};

const jiraConn: Connection = {
  id: 'conn-jr-1',
  provider: 'jira',
  label: 'emonster',
  host: 'https://emonster.atlassian.net',
  authMethod: 'api-token',
  secretRef: 'connection:conn-jr-1:token',
  accountIdentity: {
    kind: 'jira',
    accountId: '5f1...',
    displayName: 'Gary Zhang',
    emailAddress: 'gazhang@emonster.tech',
  },
  lastVerifiedAt: 1700000000000,
  verificationStatus: 'verified',
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
};

interface ApiStub {
  api: IpcApi;
  list: ReturnType<typeof vi.fn>;
  test: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
}

function installApi(opts?: {
  listResult?: IpcResult<Connection[]>;
  testResult?: IpcResult<{
    identity: Connection['accountIdentity'];
    verifiedAt: number;
  }>;
  deleteResult?: IpcResult<{ id: string }>;
}): ApiStub {
  const unusedErr = (): IpcResult<never> => ({
    ok: false,
    error: { code: 'NOT_USED_IN_FE_TESTS', message: '' },
  });

  const list = vi
    .fn()
    .mockResolvedValue(opts?.listResult ?? { ok: true, data: [] });
  const test = vi.fn().mockResolvedValue(
    opts?.testResult ?? {
      ok: true,
      data: {
        identity: { kind: 'github', login: 'gazhang', scopes: ['repo'] },
        verifiedAt: Date.now(),
      },
    },
  );
  const del = vi
    .fn()
    .mockResolvedValue(opts?.deleteResult ?? { ok: true, data: { id: 'x' } });
  const create = vi.fn().mockResolvedValue({ ok: true, data: githubConn });
  const update = vi.fn().mockResolvedValue({ ok: true, data: githubConn });

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
      status: vi.fn<IpcApi['claude']['status']>().mockResolvedValue({
        ok: true,
        data: { active: null },
      }),
      onOutput: vi.fn<IpcApi['claude']['onOutput']>(() => () => {}),
      onExit: vi.fn<IpcApi['claude']['onExit']>(() => () => {}),
    },
    projects: {
      list: vi
        .fn<IpcApi['projects']['list']>()
        .mockResolvedValue({ ok: true, data: [] }),
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
      listActive: vi.fn().mockResolvedValue({ ok: true, data: { runs: [] } }),
      listHistory: vi.fn().mockResolvedValue(unusedErr()),
      get: vi.fn() as unknown as IpcApi['runs']['get'],
      readLog: vi.fn().mockResolvedValue({ ok: true, data: { entries: [] } }),
      onCurrentChanged: vi.fn(() => () => {}),
      onListChanged: vi.fn(() => () => {}),
      onStateChanged: vi.fn(() => () => {}),
    } as unknown as IpcApi['runs'],
    connections: {
      list,
      get: vi.fn().mockResolvedValue(unusedErr()),
      create,
      update,
      delete: del,
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
      search: vi.fn().mockResolvedValue(unusedErr()),
    } as unknown as IpcApi['skills'],
    shell: {
      openPath: vi.fn().mockResolvedValue({ ok: true, data: null }),
    } as unknown as IpcApi['shell'],
    appConfig: {
      get: vi.fn().mockResolvedValue({ ok: false, error: { code: 'NOT_USED_IN_FE_TESTS', message: '' } }),
      set: vi.fn().mockResolvedValue({ ok: false, error: { code: 'NOT_USED_IN_FE_TESTS', message: '' } }),
    },

  } as IpcApi;

  (window as { api?: IpcApi }).api = api;
  return { api, list, test, delete: del, create, update };
}

afterEach(() => {
  cleanup();
  delete (window as { api?: IpcApi }).api;
  vi.restoreAllMocks();
});

describe('<Connections /> — VIEW-CONN', () => {
  // -------------------------------------------------------------------------
  // VIEW-CONN-001 — Heading + Add button
  // -------------------------------------------------------------------------
  it('VIEW-CONN-001: renders the page heading and the Add Connection button', async () => {
    installApi({ listResult: { ok: true, data: [] } });
    render(<Connections />);

    await waitFor(() => {
      expect(screen.getByTestId('connections-page')).toBeInTheDocument();
    });
    expect(screen.getByTestId('connections-add-button')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // VIEW-CONN-002 — Empty state (per GH-45 spec: title, description, CTA)
  // -------------------------------------------------------------------------
  it('VIEW-CONN-002: renders the empty-state card when connections.length === 0', async () => {
    installApi({ listResult: { ok: true, data: [] } });
    render(<Connections />);

    const empty = await screen.findByTestId('connections-empty');
    expect(empty).toBeInTheDocument();
    expect(within(empty).getByText('No connections yet')).toBeInTheDocument();
    expect(
      within(empty).getByText(/credentials PaperPlane uses to fetch tickets and open PRs/i),
    ).toBeInTheDocument();
    expect(within(empty).getByRole('button', { name: /^add connection$/i })).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // VIEW-CONN-002b — Empty-state CTA opens AddConnectionDialog (GH-45)
  // -------------------------------------------------------------------------
  it('VIEW-CONN-002b: clicking the empty-state "Add connection" button opens the Add dialog', async () => {
    installApi({ listResult: { ok: true, data: [] } });
    render(<Connections />);

    const cta = await screen.findByTestId('connections-empty-cta');
    fireEvent.click(cta);

    await waitFor(() => {
      expect(screen.getByTestId('add-connection-dialog')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // VIEW-CONN-003 — Populated rows
  // -------------------------------------------------------------------------
  it('VIEW-CONN-003: renders one row per connection with the row testid', async () => {
    installApi({ listResult: { ok: true, data: [githubConn, jiraConn] } });
    render(<Connections />);

    await waitFor(() => {
      expect(screen.getByTestId('connections-row-conn-gh-1')).toBeInTheDocument();
    });
    expect(screen.getByTestId('connections-row-conn-jr-1')).toBeInTheDocument();
    // No empty-state when populated
    expect(screen.queryByTestId('connections-empty')).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // VIEW-CONN-004 — "Not verified" pill when verificationStatus is undefined
  // -------------------------------------------------------------------------
  it('VIEW-CONN-004: row shows "Not verified" when verificationStatus is undefined', async () => {
    const unverified: Connection = {
      ...githubConn,
      id: 'conn-unv',
      accountIdentity: undefined,
      lastVerifiedAt: undefined,
      verificationStatus: undefined,
    };
    installApi({ listResult: { ok: true, data: [unverified] } });
    render(<Connections />);

    const row = await screen.findByTestId('connections-row-conn-unv');
    expect(within(row).getByText(/not verified/i)).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // VIEW-CONN-004b — Persistent green pill when verificationStatus='verified'
  // -------------------------------------------------------------------------
  it('VIEW-CONN-004b: row shows the @login pill when verificationStatus=verified', async () => {
    installApi({ listResult: { ok: true, data: [githubConn] } });
    render(<Connections />);

    const row = await screen.findByTestId('connections-row-conn-gh-1');
    // Persistent green pill — derived from server-side `verificationStatus`,
    // so navigating away and back leaves it visible.
    expect(within(row).getByText(/@gazhang/i)).toBeInTheDocument();
    expect(within(row).queryByText(/not verified/i)).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // VIEW-CONN-004c — auth-failed pill when verificationStatus='auth-failed'
  // -------------------------------------------------------------------------
  it('VIEW-CONN-004c: row shows the auth-failed pill when verificationStatus=auth-failed', async () => {
    const expired: Connection = {
      ...githubConn,
      id: 'conn-expired',
      verificationStatus: 'auth-failed',
    };
    installApi({ listResult: { ok: true, data: [expired] } });
    render(<Connections />);

    const row = await screen.findByTestId('connections-row-conn-expired');
    expect(within(row).getByText(/auth expired/i)).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // VIEW-CONN-005 — Test action calls connections.test
  // -------------------------------------------------------------------------
  it('VIEW-CONN-005: clicking the row Test button calls connections.test (mode: existing)', async () => {
    const stub = installApi({
      listResult: { ok: true, data: [githubConn] },
      testResult: {
        ok: true,
        data: {
          identity: { kind: 'github', login: 'gazhang', scopes: ['repo'] },
          verifiedAt: 1700000050000,
        },
      },
    });

    render(<Connections />);

    const testBtn = await screen.findByTestId('connection-test-conn-gh-1');
    fireEvent.click(testBtn);

    await waitFor(() => {
      expect(stub.test).toHaveBeenCalledTimes(1);
    });
    const call = stub.test.mock.calls[0]?.[0] as { mode?: string; id?: string };
    expect(call?.mode).toBe('existing');
    expect(call?.id).toBe('conn-gh-1');
  });

  // -------------------------------------------------------------------------
  // VIEW-CONN-006 — Edit action opens dialog
  // -------------------------------------------------------------------------
  it('VIEW-CONN-006: clicking Edit opens AddConnectionDialog', async () => {
    installApi({ listResult: { ok: true, data: [githubConn] } });
    render(<Connections />);

    const editBtn = await screen.findByTestId('connection-edit-conn-gh-1');
    fireEvent.click(editBtn);

    // The dialog testid is `add-connection-dialog` per the dialog spec.
    await waitFor(() => {
      expect(screen.getByTestId('add-connection-dialog')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // VIEW-CONN-007 — Delete action confirms via Dialog, then calls connections.delete
  // -------------------------------------------------------------------------
  it('VIEW-CONN-007: clicking Delete opens a confirm dialog; confirming calls connections.delete', async () => {
    const stub = installApi({
      listResult: { ok: true, data: [githubConn] },
      deleteResult: { ok: true, data: { id: 'conn-gh-1' } },
    });

    render(<Connections />);

    const delBtn = await screen.findByTestId('connection-delete-conn-gh-1');
    fireEvent.click(delBtn);

    // Confirm dialog renders. We look for a button inside the dialog that
    // says delete/confirm/remove.
    const dialog = await screen.findByTestId('dialog-panel');
    const confirmBtn =
      within(dialog).queryByRole('button', { name: /^delete$/i }) ??
      within(dialog).queryByRole('button', { name: /confirm/i }) ??
      within(dialog).queryByRole('button', { name: /remove/i });
    expect(confirmBtn).not.toBeNull();
    if (confirmBtn) fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(stub.delete).toHaveBeenCalledTimes(1);
    });
    const call = stub.delete.mock.calls[0]?.[0] as { id?: string };
    expect(call?.id).toBe('conn-gh-1');
  });

  // -------------------------------------------------------------------------
  // VIEW-CONN-008 — IN_USE error shows referencedBy list
  // -------------------------------------------------------------------------
  it('VIEW-CONN-008: IN_USE delete response surfaces the referencedBy list inside the dialog', async () => {
    installApi({
      listResult: { ok: true, data: [githubConn] },
      deleteResult: {
        ok: false,
        error: {
          code: 'IN_USE',
          message: 'connection in use',
        },
      },
    });

    // Override the delete stub to return the discriminated IN_USE error
    // with details.referencedBy populated.
    (window.api as IpcApi).connections.delete = vi.fn().mockResolvedValue({
      ok: false,
      error: {
        code: 'IN_USE',
        message: 'connection in use',
        details: { referencedBy: ['project-abc', 'project-xyz'] },
      },
    }) as unknown as IpcApi['connections']['delete'];

    render(<Connections />);

    const delBtn = await screen.findByTestId('connection-delete-conn-gh-1');
    fireEvent.click(delBtn);

    const dialog = await screen.findByTestId('dialog-panel');
    const confirmBtn =
      within(dialog).queryByRole('button', { name: /^delete$/i }) ??
      within(dialog).queryByRole('button', { name: /confirm/i }) ??
      within(dialog).queryByRole('button', { name: /remove/i });
    if (confirmBtn) fireEvent.click(confirmBtn);

    // Wait for the dialog to surface the referencedBy list.
    await waitFor(() => {
      expect(within(dialog).getByText(/project-abc/)).toBeInTheDocument();
    });
    expect(within(dialog).getByText(/project-xyz/)).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // VIEW-CONN-009 — Add button opens dialog
  // -------------------------------------------------------------------------
  it('VIEW-CONN-009: clicking the Add button opens AddConnectionDialog', async () => {
    installApi({ listResult: { ok: true, data: [] } });
    render(<Connections />);

    const addBtn = await screen.findByTestId('connections-add-button');
    fireEvent.click(addBtn);

    await waitFor(() => {
      expect(screen.getByTestId('add-connection-dialog')).toBeInTheDocument();
    });
  });
});

describe('<App /> — APP-CONN-001..003', () => {
  beforeEach(() => {
    installApi({ listResult: { ok: true, data: [] } });
  });

  // -------------------------------------------------------------------------
  // APP-CONN-001 — Sidebar Connections click navigates to Connections view
  // -------------------------------------------------------------------------
  it('APP-CONN-001: clicking the Connections nav item renders <Connections />', async () => {
    render(<App />);

    const navBtn = await screen.findByTestId('sidebar-nav-connections');
    fireEvent.click(navBtn);

    await waitFor(() => {
      expect(screen.getByTestId('connections-page')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // APP-CONN-002 — Sidebar Projects click returns to ProjectList
  // -------------------------------------------------------------------------
  it('APP-CONN-002: clicking Projects in the sidebar after Connections returns to ProjectList', async () => {
    render(<App />);

    // First navigate to Connections.
    const connectionsNav = await screen.findByTestId('sidebar-nav-connections');
    fireEvent.click(connectionsNav);
    await waitFor(() => {
      expect(screen.getByTestId('connections-page')).toBeInTheDocument();
    });

    // Then back to Projects.
    const projectsNav = screen.getByTestId('sidebar-nav-projects');
    fireEvent.click(projectsNav);

    await waitFor(() => {
      expect(screen.getByTestId('page-title')).toHaveTextContent(/projects/i);
    });
  });

  // -------------------------------------------------------------------------
  // APP-CONN-003 — Existing detail/execution views unchanged (regression)
  // -------------------------------------------------------------------------
  it('APP-CONN-003: rendering App still mounts the AppShell + sidebar (regression)', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId('sidebar')).toBeInTheDocument();
      expect(screen.getByTestId('app-main')).toBeInTheDocument();
    });
    // The original Projects nav item still exists.
    expect(screen.getByTestId('sidebar-nav-projects')).toBeInTheDocument();
    // Settings still exists too.
    expect(screen.getByTestId('sidebar-nav-settings')).toBeInTheDocument();
  });
});
