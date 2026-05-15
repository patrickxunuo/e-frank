// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, expectTypeOf } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { AddProject } from '../../src/renderer/views/AddProject';
import { __resetConnectionResourceCaches } from '../../src/renderer/state/connection-resources';
import {
  IPC_CHANNELS,
  type IpcApi,
  type IpcResult,
  type ProjectInstanceDto,
} from '../../src/shared/ipc';
import type { Connection } from '../../src/shared/schema/connection';

/**
 * DIALOG-001..005 — Folder picker for Repository Path (issue #25 polish).
 *
 * Coverage:
 *  - DIALOG-001: channel constant `DIALOG_SELECT_FOLDER === 'dialog:select-folder'`.
 *  - DIALOG-002: `IpcApi.dialog.selectFolder` typed correctly (compile-time).
 *  - DIALOG-003: clicking `field-repo-local-path-browse` invokes
 *                `window.api.dialog.selectFolder`.
 *  - DIALOG-004: on success, the returned `path` is written into form state
 *                (visible via the repo-local-path input's value).
 *  - DIALOG-005: on cancel (`path: null`), `repoLocalPath` is unchanged.
 *
 * Imports `DialogSelectFolderRequest` / `DialogSelectFolderResponse` and
 * `IPC_CHANNELS.DIALOG_SELECT_FOLDER` from `shared/ipc`. Until Agent B ships
 * those, this file fails to type-check / import — that's the expected
 * pre-impl state.
 */

type DialogSelectFolderRequest = import('../../src/shared/ipc').DialogSelectFolderRequest;
type DialogSelectFolderResponse = import('../../src/shared/ipc').DialogSelectFolderResponse;

declare global {
  interface Window {
    api?: IpcApi;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ghConn: Connection = {
  id: 'conn-gh-1',
  provider: 'github',
  label: 'Personal',
  host: 'https://api.github.com',
  authMethod: 'pat',
  secretRef: 'connection:conn-gh-1:token',
  accountIdentity: { kind: 'github', login: 'gazhang', scopes: ['repo'] },
  lastVerifiedAt: 1_700_000_000_000,
  verificationStatus: 'verified',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

const jiraConn: Connection = {
  id: 'conn-jr-1',
  provider: 'jira',
  label: 'Acme',
  host: 'https://acme.atlassian.net',
  authMethod: 'api-token',
  secretRef: 'connection:conn-jr-1:token',
  accountIdentity: { kind: 'jira', accountId: '5f1', displayName: 'Gary' },
  lastVerifiedAt: 1_700_000_000_000,
  verificationStatus: 'verified',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

const reposPayload = {
  repos: [
    { slug: 'gazhang/frontend-app', defaultBranch: 'main', private: true },
    { slug: 'gazhang/backend-svc', defaultBranch: 'main', private: false },
  ],
};

const jiraProjectsPayload = {
  projects: [
    { key: 'PROJ', name: 'Project' },
    { key: 'OPS', name: 'Ops' },
  ],
};

interface ApiStub {
  api: IpcApi;
  selectFolder: ReturnType<typeof vi.fn>;
}

function installApi(opts?: {
  selectFolderResult?: IpcResult<DialogSelectFolderResponse>;
}): ApiStub {
  const unusedErr = (): IpcResult<never> => ({
    ok: false,
    error: { code: 'NOT_USED_IN_FE_TESTS', message: '' },
  });

  const selectFolder = vi.fn().mockResolvedValue(
    opts?.selectFolderResult ?? {
      ok: true,
      data: { path: '/picked/by/dialog' },
    },
  );

  const projectsCreate = vi.fn().mockResolvedValue({
    ok: true,
    data: {
      id: 'new-id',
      name: 'X',
      repo: {
        type: 'github',
        localPath: '/picked/by/dialog',
        baseBranch: 'main',
        connectionId: ghConn.id,
        slug: 'gazhang/frontend-app',
      },
      tickets: {
        source: 'jira',
        connectionId: jiraConn.id,
        projectKey: 'PROJ',
      },
      workflow: { mode: 'interactive', branchFormat: 'feature/{ticketKey}' },
      createdAt: 0,
      updatedAt: 0,
    } as ProjectInstanceDto,
  });

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
      list: vi
        .fn<IpcApi['projects']['list']>()
        .mockResolvedValue({ ok: true, data: [] }),
      get: vi.fn<IpcApi['projects']['get']>().mockResolvedValue(unusedErr()),
      create: projectsCreate as unknown as IpcApi['projects']['create'],
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
    connections: {
      list: vi.fn().mockResolvedValue({ ok: true, data: [ghConn, jiraConn] }),
      get: vi.fn().mockResolvedValue(unusedErr()),
      create: vi.fn().mockResolvedValue(unusedErr()),
      update: vi.fn().mockResolvedValue(unusedErr()),
      delete: vi.fn().mockResolvedValue(unusedErr()),
      test: vi.fn().mockResolvedValue(unusedErr()),
      listRepos: vi.fn().mockResolvedValue({ ok: true, data: reposPayload }),
      listJiraProjects: vi
        .fn()
        .mockResolvedValue({ ok: true, data: jiraProjectsPayload }),
    } as unknown as IpcApi['connections'],
    runs: {
      start: vi.fn().mockResolvedValue(unusedErr()),
      cancel: vi.fn().mockResolvedValue(unusedErr()),
      approve: vi.fn().mockResolvedValue(unusedErr()),
      reject: vi.fn().mockResolvedValue(unusedErr()),
      modify: vi.fn().mockResolvedValue(unusedErr()),
      current: vi.fn().mockResolvedValue({ ok: true, data: { run: null } }),
      listHistory: vi.fn().mockResolvedValue(unusedErr()),
      get: vi.fn() as unknown as IpcApi['runs']['get'],
      readLog: vi.fn().mockResolvedValue({ ok: true, data: { entries: [] } }),
      onCurrentChanged: vi.fn(() => () => {}),
      onStateChanged: vi.fn(() => () => {}),
    } as unknown as IpcApi['runs'],
    // Agent B adds the `dialog` namespace; until then, this assignment forces
    // a compile error if the field is missing — exactly what we want.
    dialog: {
      selectFolder,
    },
  } as unknown as IpcApi;

  (window as { api?: IpcApi }).api = api;
  return { api, selectFolder };
}

afterEach(() => {
  cleanup();
  delete (window as { api?: IpcApi }).api;
  vi.restoreAllMocks();
  __resetConnectionResourceCaches();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Folder picker — DIALOG', () => {
  // -------------------------------------------------------------------------
  // DIALOG-001 — channel constant
  // -------------------------------------------------------------------------
  it('DIALOG-001: DIALOG_SELECT_FOLDER === "dialog:select-folder"', () => {
    expect(IPC_CHANNELS.DIALOG_SELECT_FOLDER).toBe('dialog:select-folder');
  });

  it('DIALOG-001: DIALOG_SELECT_FOLDER keeps its literal-string type (compile-time)', () => {
    expectTypeOf(
      IPC_CHANNELS.DIALOG_SELECT_FOLDER,
    ).toEqualTypeOf<'dialog:select-folder'>();
  });

  it('DIALOG-001: DIALOG_SELECT_FOLDER key is present on IPC_CHANNELS', () => {
    expect(Object.keys(IPC_CHANNELS)).toContain('DIALOG_SELECT_FOLDER');
  });

  // -------------------------------------------------------------------------
  // DIALOG-002 — IpcApi.dialog.selectFolder typed correctly
  // -------------------------------------------------------------------------
  it('DIALOG-002: IpcApi.dialog namespace exists with selectFolder method', () => {
    expectTypeOf<IpcApi>().toHaveProperty('dialog');
    expectTypeOf<IpcApi['dialog']>().toHaveProperty('selectFolder');
  });

  it('DIALOG-002: IpcApi.dialog.selectFolder signature', () => {
    expectTypeOf<IpcApi['dialog']['selectFolder']>().toEqualTypeOf<
      (
        req: DialogSelectFolderRequest,
      ) => Promise<IpcResult<DialogSelectFolderResponse>>
    >();
  });

  it('DIALOG-002: DialogSelectFolderRequest carries optional defaultPath + title', () => {
    // Compile-time: defaultPath is optional string, title is optional string.
    const req: DialogSelectFolderRequest = {};
    expect(req).toBeDefined();
    const reqWithFields: DialogSelectFolderRequest = {
      defaultPath: '/abs/start',
      title: 'Select repository folder',
    };
    expect(reqWithFields.title).toBe('Select repository folder');
  });

  it('DIALOG-002: DialogSelectFolderResponse.path is string | null', () => {
    expectTypeOf<DialogSelectFolderResponse>().toHaveProperty('path');
    expectTypeOf<DialogSelectFolderResponse['path']>().toEqualTypeOf<
      string | null
    >();
  });

  // -------------------------------------------------------------------------
  // DIALOG-003 — Browse button calls dialog.selectFolder
  // -------------------------------------------------------------------------
  it('DIALOG-003: clicking field-repo-local-path-browse invokes window.api.dialog.selectFolder', async () => {
    const stub = installApi();
    render(<AddProject onClose={() => {}} onCreated={async () => {}} />);

    await waitFor(() => {
      expect(screen.queryByTestId('field-repo-local-path-browse')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('field-repo-local-path-browse'));

    await waitFor(() => {
      expect(stub.selectFolder).toHaveBeenCalledTimes(1);
    });
    // The call argument should be a DialogSelectFolderRequest (possibly with
    // a `title`). We check that an object was passed (per spec).
    const callArg = stub.selectFolder.mock.calls[0]?.[0];
    expect(typeof callArg).toBe('object');
  });

  // -------------------------------------------------------------------------
  // DIALOG-004 — Success path → repoLocalPath updated
  // -------------------------------------------------------------------------
  it('DIALOG-004: on success, the picked path is written to repoLocalPath form state', async () => {
    installApi({
      selectFolderResult: { ok: true, data: { path: '/picked/by/dialog' } },
    });
    render(<AddProject onClose={() => {}} onCreated={async () => {}} />);

    await waitFor(() => {
      expect(screen.queryByTestId('field-repo-local-path-browse')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('field-repo-local-path-browse'));

    // The local-path Input's value updates once the dialog resolves.
    await waitFor(() => {
      const el = screen.getByTestId('field-repo-local-path') as HTMLInputElement;
      expect(el.value).toBe('/picked/by/dialog');
    });
  });

  // -------------------------------------------------------------------------
  // DIALOG-005 — Cancel (path: null) → repoLocalPath unchanged
  // -------------------------------------------------------------------------
  it('DIALOG-005: on cancel (path: null), repoLocalPath is unchanged', async () => {
    installApi({
      selectFolderResult: { ok: true, data: { path: null } },
    });
    render(<AddProject onClose={() => {}} onCreated={async () => {}} />);

    await waitFor(() => {
      expect(screen.queryByTestId('field-repo-local-path-browse')).toBeInTheDocument();
    });

    // Type something into the local-path field first so we can detect a
    // change (or lack thereof) after Browse cancels.
    const beforeInput = screen.getByTestId('field-repo-local-path') as HTMLInputElement;
    fireEvent.change(beforeInput, { target: { value: '/typed/by/user' } });
    expect(beforeInput.value).toBe('/typed/by/user');

    fireEvent.click(screen.getByTestId('field-repo-local-path-browse'));

    // Allow the (resolved) cancel result to propagate. Since cancel is a
    // no-op, the input's value MUST still equal the typed-by-user value.
    await new Promise((r) => setTimeout(r, 0));
    const afterInput = screen.getByTestId('field-repo-local-path') as HTMLInputElement;
    expect(afterInput.value).toBe('/typed/by/user');
  });
});
