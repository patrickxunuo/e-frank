// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import type {
  IpcApi,
  IpcResult,
  ProjectInstanceDto,
  ProjectsCreateRequest,
} from '../../src/shared/ipc';
import type { Connection } from '../../src/shared/schema/connection';

/**
 * ADD-PROJ-001..011 — <AddProject> view (issue #25 picker rewrite).
 *
 * The form is now a connection picker + resource selector instead of a
 * credential capture form. Test Connection button is REMOVED from this view
 * — the Connections page owns that flow.
 *
 * Stubs window.api.{connections,projects} per-test. Uses `fireEvent` (no
 * `userEvent`). All assertions go through `getByTestId` / `queryByTestId`.
 */

declare global {
  interface Window {
    api?: IpcApi;
  }
}

interface ApiStub {
  api: IpcApi;
  connectionsList: ReturnType<typeof vi.fn>;
  listRepos: ReturnType<typeof vi.fn>;
  listJiraProjects: ReturnType<typeof vi.fn>;
  projectsCreate: ReturnType<typeof vi.fn>;
  projectsUpdate: ReturnType<typeof vi.fn>;
}

// ---------------------------------------------------------------------------
// Realistic fixtures (per spec)
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

function makeProject(id: string, name: string): ProjectInstanceDto {
  return {
    id,
    name,
    repo: {
      type: 'github',
      localPath: '/tmp/' + id,
      baseBranch: 'main',
      connectionId: ghConn.id,
      slug: 'gazhang/frontend-app',
    },
    tickets: {
      source: 'jira',
      connectionId: jiraConn.id,
      projectKey: 'PROJ',
    },
    workflow: { mode: 'interactive', branchFormat: 'feature/{ticketKey}-{slug}' },
    createdAt: 0,
    updatedAt: 0,
  };
}

function installApi(opts?: {
  connections?: Connection[];
  listReposResult?: IpcResult<typeof reposPayload>;
  listJiraProjectsResult?: IpcResult<typeof jiraProjectsPayload>;
  projectsCreateResult?: IpcResult<ProjectInstanceDto>;
  projectsUpdateResult?: IpcResult<ProjectInstanceDto>;
}): ApiStub {
  const unusedErr = (): IpcResult<never> => ({
    ok: false,
    error: { code: 'NOT_USED_IN_FE_TESTS', message: '' },
  });

  const connectionsList = vi.fn().mockResolvedValue({
    ok: true,
    data: opts?.connections ?? [ghConn, jiraConn],
  });
  const listRepos = vi
    .fn()
    .mockResolvedValue(opts?.listReposResult ?? { ok: true, data: reposPayload });
  const listJiraProjects = vi
    .fn()
    .mockResolvedValue(
      opts?.listJiraProjectsResult ?? { ok: true, data: jiraProjectsPayload },
    );
  const projectsCreate = vi.fn().mockResolvedValue(
    opts?.projectsCreateResult ?? {
      ok: true,
      data: makeProject('new-id', 'Created'),
    },
  );
  const projectsUpdate = vi.fn().mockResolvedValue(
    opts?.projectsUpdateResult ?? {
      ok: true,
      data: makeProject('p-1', 'Updated'),
    },
  );

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
      update: projectsUpdate as unknown as IpcApi['projects']['update'],
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
      list: connectionsList,
      get: vi.fn().mockResolvedValue(unusedErr()),
      create: vi.fn().mockResolvedValue(unusedErr()),
      update: vi.fn().mockResolvedValue(unusedErr()),
      delete: vi.fn().mockResolvedValue(unusedErr()),
      test: vi.fn().mockResolvedValue(unusedErr()),
      listRepos,
      listJiraProjects,
    } as unknown as IpcApi['connections'],
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
  };

  (window as { api?: IpcApi }).api = api;
  return {
    api,
    connectionsList,
    listRepos,
    listJiraProjects,
    projectsCreate,
    projectsUpdate,
  };
}

afterEach(() => {
  cleanup();
  delete (window as { api?: IpcApi }).api;
  vi.restoreAllMocks();
  // Connection-resource hooks share a module-level per-session cache; reset
  // it between tests so no test sees a pre-populated entry.
  __resetConnectionResourceCaches();
});

// Helper: drives the form to a fully-valid state using the picker testids.
// Since pickers are <Dropdown> components that render a hidden native
// <select>, fireEvent.change on the testid still works.
async function fillValidForm(): Promise<void> {
  // Project name
  fireEvent.change(screen.getByTestId('field-name'), {
    target: { value: 'My Project' },
  });

  // Pick GitHub connection — populates repo dropdown via listRepos.
  fireEvent.change(screen.getByTestId('field-repo-connection'), {
    target: { value: ghConn.id },
  });
  // Wait for the repo list IPC to resolve.
  await waitFor(() => {
    expect(screen.queryByTestId('field-repo-slug')).toBeInTheDocument();
  });
  fireEvent.change(screen.getByTestId('field-repo-slug'), {
    target: { value: 'gazhang/frontend-app' },
  });

  fireEvent.change(screen.getByTestId('field-repo-local-path'), {
    target: { value: '/abs/path/repo' },
  });
  fireEvent.change(screen.getByTestId('field-repo-base-branch'), {
    target: { value: 'main' },
  });

  // Pick Jira connection — populates project dropdown via listJiraProjects.
  fireEvent.change(screen.getByTestId('field-tickets-connection'), {
    target: { value: jiraConn.id },
  });
  await waitFor(() => {
    expect(screen.queryByTestId('field-tickets-project-key')).toBeInTheDocument();
  });
  fireEvent.change(screen.getByTestId('field-tickets-project-key'), {
    target: { value: 'PROJ' },
  });

  // Branch format
  fireEvent.change(screen.getByTestId('field-branch-format'), {
    target: { value: 'feature/{ticketKey}-{slug}' },
  });
}

describe('<AddProject /> — ADD-PROJ', () => {
  // -------------------------------------------------------------------------
  // ADD-PROJ-001 — Source section with connection picker
  // -------------------------------------------------------------------------
  describe('ADD-PROJ-001 source connection picker', () => {
    beforeEach(() => {
      installApi();
    });

    it('ADD-PROJ-001: renders Source section with field-repo-connection testid', async () => {
      render(<AddProject onClose={() => {}} onCreated={async () => {}} />);
      await waitFor(() => {
        expect(screen.queryByTestId('field-repo-connection')).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // ADD-PROJ-002 — Tickets section with connection picker
  // -------------------------------------------------------------------------
  describe('ADD-PROJ-002 tickets connection picker', () => {
    beforeEach(() => {
      installApi();
    });

    it('ADD-PROJ-002: renders Tickets section with field-tickets-connection testid', async () => {
      render(<AddProject onClose={() => {}} onCreated={async () => {}} />);
      await waitFor(() => {
        expect(screen.queryByTestId('field-tickets-connection')).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // ADD-PROJ-003 — Source empty state when no GitHub connections
  // -------------------------------------------------------------------------
  describe('ADD-PROJ-003 source empty state', () => {
    it('ADD-PROJ-003: no GitHub connections → add-project-source-empty rendered with CTA', async () => {
      // Only a Jira connection exists — no GitHub provider.
      installApi({ connections: [jiraConn] });
      render(<AddProject onClose={() => {}} onCreated={async () => {}} />);

      await waitFor(() => {
        expect(screen.queryByTestId('add-project-source-empty')).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // ADD-PROJ-004 — Picking a GitHub connection populates the repo dropdown
  // -------------------------------------------------------------------------
  describe('ADD-PROJ-004 picking GitHub connection populates repos', () => {
    it('ADD-PROJ-004: change repo connection → listRepos called once for that connectionId', async () => {
      const stub = installApi();
      render(<AddProject onClose={() => {}} onCreated={async () => {}} />);

      await waitFor(() => {
        expect(screen.queryByTestId('field-repo-connection')).toBeInTheDocument();
      });

      fireEvent.change(screen.getByTestId('field-repo-connection'), {
        target: { value: ghConn.id },
      });

      await waitFor(() => {
        expect(stub.listRepos).toHaveBeenCalledTimes(1);
      });
      expect(stub.listRepos.mock.calls[0]?.[0]).toEqual({
        connectionId: ghConn.id,
      });
    });
  });

  // -------------------------------------------------------------------------
  // ADD-PROJ-005 — Picking a Jira connection populates the project dropdown
  // -------------------------------------------------------------------------
  describe('ADD-PROJ-005 picking Jira connection populates projects', () => {
    it('ADD-PROJ-005: change tickets connection → listJiraProjects called once', async () => {
      const stub = installApi();
      render(<AddProject onClose={() => {}} onCreated={async () => {}} />);

      await waitFor(() => {
        expect(screen.queryByTestId('field-tickets-connection')).toBeInTheDocument();
      });

      fireEvent.change(screen.getByTestId('field-tickets-connection'), {
        target: { value: jiraConn.id },
      });

      await waitFor(() => {
        expect(stub.listJiraProjects).toHaveBeenCalledTimes(1);
      });
      expect(stub.listJiraProjects.mock.calls[0]?.[0]).toEqual({
        connectionId: jiraConn.id,
      });
    });
  });

  // -------------------------------------------------------------------------
  // ADD-PROJ-006 — Refresh button on repo picker re-calls listRepos
  // -------------------------------------------------------------------------
  describe('ADD-PROJ-006 repo refresh button', () => {
    it('ADD-PROJ-006: clicking add-project-repo-refresh re-calls listRepos (count = 2)', async () => {
      const stub = installApi();
      render(<AddProject onClose={() => {}} onCreated={async () => {}} />);

      await waitFor(() => {
        expect(screen.queryByTestId('field-repo-connection')).toBeInTheDocument();
      });

      fireEvent.change(screen.getByTestId('field-repo-connection'), {
        target: { value: ghConn.id },
      });

      await waitFor(() => {
        expect(stub.listRepos).toHaveBeenCalledTimes(1);
      });

      fireEvent.click(screen.getByTestId('add-project-repo-refresh'));

      await waitFor(() => {
        expect(stub.listRepos).toHaveBeenCalledTimes(2);
      });
    });
  });

  // -------------------------------------------------------------------------
  // ADD-PROJ-007 — Submit builds ProjectInstanceInput with the new shape
  // -------------------------------------------------------------------------
  describe('ADD-PROJ-007 submit builds new-shape input', () => {
    it('ADD-PROJ-007: projects.create input has repo.connectionId/slug + tickets.connectionId/projectKey', async () => {
      const stub = installApi();
      render(<AddProject onClose={() => {}} onCreated={async () => {}} />);

      await waitFor(() => {
        expect(screen.queryByTestId('field-repo-connection')).toBeInTheDocument();
      });
      await fillValidForm();
      fireEvent.click(screen.getByTestId('add-project-submit'));

      await waitFor(() => {
        expect(stub.projectsCreate).toHaveBeenCalled();
      });

      const callArgs = stub.projectsCreate.mock.calls[0];
      expect(callArgs).toBeDefined();
      const req = (callArgs as unknown[])[0] as ProjectsCreateRequest;
      expect(req.input.repo.connectionId).toBe(ghConn.id);
      expect(req.input.repo.slug).toBe('gazhang/frontend-app');
      expect(req.input.tickets.connectionId).toBe(jiraConn.id);
      expect(req.input.tickets.projectKey).toBe('PROJ');
      // Old credential fields must not be in the input.
      const repoUnknown = req.input.repo as unknown as Record<string, unknown>;
      const ticketsUnknown = req.input.tickets as unknown as Record<string, unknown>;
      expect(repoUnknown['host']).toBeUndefined();
      expect(repoUnknown['tokenRef']).toBeUndefined();
      expect(ticketsUnknown['host']).toBeUndefined();
      expect(ticketsUnknown['email']).toBeUndefined();
      expect(ticketsUnknown['tokenRef']).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // ADD-PROJ-008 — Submit derives repo.type from picked connection's provider
  // -------------------------------------------------------------------------
  describe('ADD-PROJ-008 repo.type derived from connection provider', () => {
    it('ADD-PROJ-008: GitHub connection picked → input.repo.type === "github"', async () => {
      const stub = installApi();
      render(<AddProject onClose={() => {}} onCreated={async () => {}} />);

      await waitFor(() => {
        expect(screen.queryByTestId('field-repo-connection')).toBeInTheDocument();
      });
      await fillValidForm();
      fireEvent.click(screen.getByTestId('add-project-submit'));

      await waitFor(() => {
        expect(stub.projectsCreate).toHaveBeenCalled();
      });

      const req = stub.projectsCreate.mock.calls[0]?.[0] as ProjectsCreateRequest;
      expect(req.input.repo.type).toBe('github');
    });
  });

  // -------------------------------------------------------------------------
  // ADD-PROJ-009 — Empty JQL → query field omitted from input
  // -------------------------------------------------------------------------
  describe('ADD-PROJ-009 empty JQL omits query', () => {
    it('ADD-PROJ-009: leaving field-ticket-query empty → input.tickets.query is undefined', async () => {
      const stub = installApi();
      render(<AddProject onClose={() => {}} onCreated={async () => {}} />);

      await waitFor(() => {
        expect(screen.queryByTestId('field-repo-connection')).toBeInTheDocument();
      });
      await fillValidForm();
      // Confirm the JQL textarea exists but is empty by default.
      const queryEl = screen.queryByTestId('field-ticket-query');
      expect(queryEl).toBeInTheDocument();
      // Sanity: don't fill the query field (default empty state).
      fireEvent.click(screen.getByTestId('add-project-submit'));

      await waitFor(() => {
        expect(stub.projectsCreate).toHaveBeenCalled();
      });

      const req = stub.projectsCreate.mock.calls[0]?.[0] as ProjectsCreateRequest;
      expect((req.input.tickets as unknown as Record<string, unknown>)['query']).toBeUndefined();
    });

    it('ADD-PROJ-009: non-empty JQL → input.tickets.query is the typed JQL', async () => {
      const stub = installApi();
      render(<AddProject onClose={() => {}} onCreated={async () => {}} />);

      await waitFor(() => {
        expect(screen.queryByTestId('field-repo-connection')).toBeInTheDocument();
      });
      await fillValidForm();
      fireEvent.change(screen.getByTestId('field-ticket-query'), {
        target: { value: 'project = PROJ AND status = "Ready for AI"' },
      });
      fireEvent.click(screen.getByTestId('add-project-submit'));

      await waitFor(() => {
        expect(stub.projectsCreate).toHaveBeenCalled();
      });

      const req = stub.projectsCreate.mock.calls[0]?.[0] as ProjectsCreateRequest;
      expect(req.input.tickets.query).toBe('project = PROJ AND status = "Ready for AI"');
    });
  });

  // -------------------------------------------------------------------------
  // ADD-PROJ-010 — EditProject mode with missing connection
  // -------------------------------------------------------------------------
  describe('ADD-PROJ-010 broken-connection banner in edit mode', () => {
    it('ADD-PROJ-010: editing a project whose repo.connectionId no longer exists → banner shown', async () => {
      // The user's GitHub connection has been deleted; only the Jira one
      // remains. The project still references conn-gh-1 in its repo.
      installApi({ connections: [jiraConn] });

      const orphanProject: ProjectInstanceDto = makeProject('p-1', 'Orphan');

      // Pass `editing` prop. If Agent B uses a different name (e.g. `project`
      // or `initial`), this test will need an update. We pass through `as`
      // because the AddProject typing in the renderer file will be evolving.
      render(
        <AddProject
          onClose={() => {}}
          onCreated={async () => {}}
          {...({ editing: orphanProject } as unknown as Record<string, unknown>)}
        />,
      );

      await waitFor(() => {
        expect(
          screen.queryByTestId('add-project-broken-connection-banner'),
        ).toBeInTheDocument();
      });
    });
  });

  // -------------------------------------------------------------------------
  // ADD-PROJ-011 — All field testids present
  // -------------------------------------------------------------------------
  describe('ADD-PROJ-011 testid coverage', () => {
    beforeEach(() => {
      installApi();
    });

    it('ADD-PROJ-011: all required field testids are rendered after picking connections', async () => {
      render(<AddProject onClose={() => {}} onCreated={async () => {}} />);

      await waitFor(() => {
        expect(screen.queryByTestId('field-repo-connection')).toBeInTheDocument();
      });

      // Pick connections so the dependent pickers render.
      fireEvent.change(screen.getByTestId('field-repo-connection'), {
        target: { value: ghConn.id },
      });
      fireEvent.change(screen.getByTestId('field-tickets-connection'), {
        target: { value: jiraConn.id },
      });

      await waitFor(() => {
        expect(screen.queryByTestId('field-repo-slug')).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.queryByTestId('field-tickets-project-key')).toBeInTheDocument();
      });

      const required = [
        'field-name',
        'field-repo-connection',
        'field-repo-slug',
        'field-repo-local-path',
        'field-repo-base-branch',
        'field-tickets-connection',
        'field-tickets-project-key',
        'field-ticket-query',
        'field-workflow-mode',
        'field-branch-format',
        'add-project-repo-refresh',
        'add-project-jira-projects-refresh',
      ];
      for (const tid of required) {
        expect(screen.queryByTestId(tid)).toBeInTheDocument();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Workflow section regression — mode + branchFormat unchanged
  // -------------------------------------------------------------------------
  describe('workflow section unchanged', () => {
    beforeEach(() => {
      installApi();
    });

    it('workflow: switching to YOLO mode → projects.create input.workflow.mode === "yolo"', async () => {
      const stub = installApi();
      render(<AddProject onClose={() => {}} onCreated={async () => {}} />);

      await waitFor(() => {
        expect(screen.queryByTestId('field-repo-connection')).toBeInTheDocument();
      });
      await fillValidForm();

      // Spec keeps the existing mode picker (YOLO toggle). The view exposes
      // either `mode-yolo` button OR `field-workflow-mode` dropdown. Try the
      // button first; if absent, fall back to the dropdown.
      const yoloBtn = screen.queryByTestId('mode-yolo');
      if (yoloBtn) {
        fireEvent.click(yoloBtn);
      } else {
        fireEvent.change(screen.getByTestId('field-workflow-mode'), {
          target: { value: 'yolo' },
        });
      }

      fireEvent.click(screen.getByTestId('add-project-submit'));

      await waitFor(() => {
        expect(stub.projectsCreate).toHaveBeenCalled();
      });

      const req = stub.projectsCreate.mock.calls[0]?.[0] as ProjectsCreateRequest;
      expect(req.input.workflow.mode).toBe('yolo');
    });
  });
});
