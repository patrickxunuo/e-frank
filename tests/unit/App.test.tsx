// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import App from '../../src/renderer/App';
import type {
  IpcApi,
  IpcResult,
  PingResponse,
  ProjectInstanceDto,
} from '../../src/shared/ipc';

/**
 * APP-001/002/005/006 unchanged from #5.
 * APP-007 / APP-008 (added in #6) replace the original APP-003 / APP-004,
 * which targeted the now-deleted DetailPlaceholder. Both new tests drive
 * through the real <ProjectDetail> view, so the IPC stub also needs
 * `projects.get` to succeed for the navigated-to project id.
 *
 * Strategy:
 *  - APP-001/002/006: empty-list mock so ProjectList renders (no rows).
 *  - APP-007/008: populated-list mock for ProjectList AND a `projects.get`
 *    stub that returns a matching project; jira.list returns empty so we
 *    don't have to fight an async tickets fetch. Click `Open` → assert the
 *    project name shows in the detail header. Click Back → assert ProjectList
 *    heading is back.
 *  - APP-005: delete `window.api` and assert `render(<App />)` doesn't throw.
 */

declare global {
  interface Window {
    api?: IpcApi;
  }
}

function makeIpcApiStub(
  pingResponse: PingResponse,
  projectsListResponse: IpcResult<ProjectInstanceDto[]> = { ok: true, data: [] },
  /**
   * Used by APP-007 / APP-008 so ProjectDetail's `projects.get({ id })`
   * returns a real project (rather than the default unusedErr). For tests
   * that don't navigate into detail, the default unused-error is fine.
   */
  projectsByIdForGet: Record<string, ProjectInstanceDto> = {},
): IpcApi {
  const unusedErr = (): IpcResult<never> => ({
    ok: false,
    error: { code: 'NOT_USED_IN_FE_TESTS', message: '' },
  });
  const projectsGet = vi
    .fn<IpcApi['projects']['get']>()
    .mockImplementation(async ({ id }) => {
      const found = projectsByIdForGet[id];
      if (found) {
        return { ok: true, data: found };
      }
      return { ok: false, error: { code: 'NOT_FOUND', message: 'not found' } };
    });
  return {
    ping: vi.fn<IpcApi['ping']>().mockResolvedValue(pingResponse),
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
      list: vi.fn<IpcApi['projects']['list']>().mockResolvedValue(projectsListResponse),
      get: projectsGet,
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
      // For APP-007/008 we want jira.list to succeed with an empty ticket
      // array — that way ProjectDetail completes its mount cycle without
      // tripping a failure banner. Tests that don't enter detail are
      // unaffected.
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
    runs: {
      start: vi.fn<IpcApi['runs']['start']>().mockResolvedValue(unusedErr()),
      cancel: vi.fn<IpcApi['runs']['cancel']>().mockResolvedValue(unusedErr()),
      approve: vi.fn<IpcApi['runs']['approve']>().mockResolvedValue(unusedErr()),
      reject: vi.fn<IpcApi['runs']['reject']>().mockResolvedValue(unusedErr()),
      modify: vi.fn<IpcApi['runs']['modify']>().mockResolvedValue(unusedErr()),
      current: vi
        .fn<IpcApi['runs']['current']>()
        .mockResolvedValue({ ok: true, data: { run: null } }),
      listActive: vi
        .fn<IpcApi['runs']['listActive']>()
        .mockResolvedValue({ ok: true, data: { runs: [] } }),
      listHistory: vi
        .fn<IpcApi['runs']['listHistory']>()
        .mockResolvedValue(unusedErr()),
      get: vi.fn() as unknown as IpcApi['runs']['get'],
      onCurrentChanged: vi.fn<IpcApi['runs']['onCurrentChanged']>(() => () => {}),
      onListChanged: vi.fn<IpcApi['runs']['onListChanged']>(() => () => {}),
      onStateChanged: vi.fn<IpcApi['runs']['onStateChanged']>(() => () => {}),
      // #8: extend with readLog. Agent B owns the typed signature on IpcApi;
      // we attach a runtime stub so any view code that calls it is satisfied.
      readLog: vi.fn().mockResolvedValue({ ok: true, data: { entries: [] } }),
    } as unknown as IpcApi['runs'],
    // #24 Connections — App may navigate to the Connections view, which
    // calls list() on mount. Stub it to a successful empty list so the
    // route doesn't error.
    connections: {
      list: vi
        .fn<IpcApi['connections']['list']>()
        .mockResolvedValue({ ok: true, data: [] }),
      get: vi.fn<IpcApi['connections']['get']>().mockResolvedValue(unusedErr()),
      create: vi.fn<IpcApi['connections']['create']>().mockResolvedValue(unusedErr()),
      update: vi.fn<IpcApi['connections']['update']>().mockResolvedValue(unusedErr()),
      delete: vi.fn<IpcApi['connections']['delete']>().mockResolvedValue(unusedErr()),
      test: vi.fn<IpcApi['connections']['test']>().mockResolvedValue(unusedErr()),
      listRepos: vi.fn<IpcApi['connections']['listRepos']>().mockResolvedValue(unusedErr()),
      listJiraProjects: vi
        .fn<IpcApi['connections']['listJiraProjects']>()
        .mockResolvedValue(unusedErr()),
      listBranches: vi
        .fn<IpcApi['connections']['listBranches']>()
        .mockResolvedValue(unusedErr()),
    },
    dialog: {
      selectFolder: vi
        .fn<IpcApi['dialog']['selectFolder']>()
        .mockResolvedValue({ ok: true, data: { path: null } }),
    },
    tickets: {
      list: vi.fn<IpcApi['tickets']['list']>().mockResolvedValue(unusedErr()),
    },
    pulls: {
      list: vi.fn<IpcApi['pulls']['list']>().mockResolvedValue(unusedErr()),
    },
    // #50 Custom titlebar — the renderer mounts <Titlebar /> at the root,
    // which calls chrome.getState() on mount and subscribes to state
    // changes. Stub it as an empty/quiet implementation so App tests stay
    // focused on routing/sidebar behavior.
    chrome: {
      minimize: vi
        .fn<IpcApi['chrome']['minimize']>()
        .mockResolvedValue({ ok: true, data: null }),
      maximize: vi
        .fn<IpcApi['chrome']['maximize']>()
        .mockResolvedValue({ ok: true, data: null }),
      close: vi
        .fn<IpcApi['chrome']['close']>()
        .mockResolvedValue({ ok: true, data: null }),
      getState: vi
        .fn<IpcApi['chrome']['getState']>()
        .mockResolvedValue({
          ok: true,
          data: { isMaximized: false, platform: 'win32' },
        }),
      onStateChanged: vi.fn<IpcApi['chrome']['onStateChanged']>(() => () => {}),
    },
    skills: {
      list: vi.fn<IpcApi['skills']['list']>().mockResolvedValue(unusedErr()),
      install: vi.fn<IpcApi['skills']['install']>().mockResolvedValue(unusedErr()),
      remove: vi.fn<IpcApi['skills']['remove']>().mockResolvedValue(unusedErr()),
      search: vi.fn<IpcApi['skills']['search']>().mockResolvedValue(unusedErr()),
    },
    shell: {
      openPath: vi.fn<IpcApi['shell']['openPath']>().mockResolvedValue({ ok: true, data: null }),
      openExternal: vi
        .fn<IpcApi['shell']['openExternal']>()
        .mockResolvedValue({ ok: true, data: null }),
      openLogDirectory: vi
        .fn<IpcApi['shell']['openLogDirectory']>()
        .mockResolvedValue({ ok: true, data: null }),
    },
    appConfig: {
      get: vi.fn().mockResolvedValue({ ok: false, error: { code: 'NOT_USED_IN_FE_TESTS', message: '' } }),
      set: vi.fn().mockResolvedValue({ ok: false, error: { code: 'NOT_USED_IN_FE_TESTS', message: '' } }),
    },

  };
}

function makeProject(id: string, name: string): ProjectInstanceDto {
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
    workflow: {
      mode: 'interactive',
      branchFormat: 'feature/{ticketKey}-{slug}',
    },
    createdAt: 0,
    updatedAt: 0,
  };
}

const PING: PingResponse = { reply: 'pong: hello', receivedAt: 0 };

afterEach(() => {
  cleanup();
  delete (window as { api?: IpcApi }).api;
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('<App /> — APP-001/002/006', () => {
  beforeEach(() => {
    (window as { api?: IpcApi }).api = makeIpcApiStub(PING, { ok: true, data: [] });
  });

  it('APP-001: renders AppShell with sidebar + main', async () => {
    render(<App />);
    // Sidebar testid is part of the AppShell. Main content area is also
    // present. We rely on data-testid="app-sidebar" and "app-main" per the
    // shell convention; if Agent B picks slightly different ids the spec
    // says all interactive/structural elements must have data-testid, so
    // these names are the natural choice.
    await waitFor(() => {
      expect(screen.getByTestId('sidebar')).toBeInTheDocument();
      expect(screen.getByTestId('app-main')).toBeInTheDocument();
    });
  });

  it('APP-002: renders ProjectList by default (view=list)', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId('page-title')).toHaveTextContent(/projects/i);
    });
  });

  it('APP-006: sidebar shows the paperplane brand lockup', async () => {
    render(<App />);
    await waitFor(() => {
      // The lockup carries `data-testid="app-logo"` and renders the
      // "paperplane" wordmark inside an SVG <text>.
      const logo = screen.getByTestId('app-logo');
      expect(logo).toBeInTheDocument();
      expect(logo).toHaveTextContent(/paperplane/i);
    });
  });
});

describe('<App /> — APP-007/008 navigation through real ProjectDetail', () => {
  beforeEach(() => {
    const alpha = makeProject('p-1', 'Alpha');
    const beta = makeProject('p-2', 'Beta');
    (window as { api?: IpcApi }).api = makeIpcApiStub(
      PING,
      { ok: true, data: [alpha, beta] },
      // projects.get(id) returns the matching project so ProjectDetail
      // resolves successfully and renders its real header.
      { 'p-1': alpha, 'p-2': beta },
    );
  });

  it('APP-007: clicking row Open switches to detail and shows the project name', async () => {
    render(<App />);
    // Wait for projects to load + render in the list.
    const openBtn = await screen.findByTestId('project-open-p-1');
    fireEvent.click(openBtn);

    // Real <ProjectDetail> renders the project name in the header. The name
    // appears in both the breadcrumb and the h1, so use the title testid.
    await waitFor(() => {
      expect(screen.getByTestId('project-detail-title')).toHaveTextContent(/alpha/i);
    });
    // The Back button is part of ProjectDetail's header.
    expect(screen.getByTestId('detail-back')).toBeInTheDocument();
  });

  it('APP-008: detail Back button returns to list view', async () => {
    render(<App />);
    const openBtn = await screen.findByTestId('project-open-p-1');
    fireEvent.click(openBtn);

    // Wait for the ready-state header (its back button is the one we want).
    // The loading-state also renders a `detail-back` testid; clicking on
    // the loading-state element after it's been unmounted is a no-op.
    await screen.findByTestId('project-detail-title');
    const backBtn = screen.getByTestId('detail-back');
    fireEvent.click(backBtn);

    await waitFor(() => {
      expect(screen.getByTestId('page-title')).toHaveTextContent(/projects/i);
    });
  });
});

describe('<App /> — APP-005 graceful when window.api missing', () => {
  beforeEach(() => {
    delete (window as { api?: IpcApi }).api;
  });

  it('APP-005: renders without crashing when window.api is undefined', () => {
    expect(() => render(<App />)).not.toThrow();
    // Shell still mounts even if IPC bridge is missing
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    expect(screen.getByTestId('app-main')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// SIDEBAR-CONN-001..003 — sidebar Connections nav row + onNavigate plumbing
// ---------------------------------------------------------------------------
describe('<App /> — SIDEBAR-CONN', () => {
  beforeEach(() => {
    (window as { api?: IpcApi }).api = makeIpcApiStub(PING, { ok: true, data: [] });
  });

  it('SIDEBAR-CONN-001: Connections nav item is rendered between Projects and Settings', async () => {
    render(<App />);
    // Wait for the sidebar to mount fully.
    await waitFor(() => {
      expect(screen.getByTestId('sidebar-nav-projects')).toBeInTheDocument();
    });
    const projectsNav = screen.getByTestId('sidebar-nav-projects');
    const connectionsNav = screen.getByTestId('sidebar-nav-connections');
    const settingsNav = screen.getByTestId('sidebar-nav-settings');
    expect(connectionsNav).toBeInTheDocument();

    // DOCUMENT_POSITION_FOLLOWING = 4. Projects must come BEFORE Connections,
    // and Connections must come BEFORE Settings.
    expect(projectsNav.compareDocumentPosition(connectionsNav) & 4).toBeTruthy();
    expect(connectionsNav.compareDocumentPosition(settingsNav) & 4).toBeTruthy();
  });

  it('SIDEBAR-CONN-002: clicking Connections nav switches activeNav to "connections"', async () => {
    render(<App />);
    const navBtn = await screen.findByTestId('sidebar-nav-connections');

    // Pre-click: aria-current should NOT be set on the connections row.
    expect(navBtn.getAttribute('aria-current')).not.toBe('page');

    fireEvent.click(navBtn);

    // Post-click: connections row carries aria-current="page".
    await waitFor(() => {
      expect(
        screen.getByTestId('sidebar-nav-connections').getAttribute('aria-current'),
      ).toBe('page');
    });
  });

  it('SIDEBAR-CONN-003: activeNav="connections" applies aria-current to the row', async () => {
    render(<App />);
    const navBtn = await screen.findByTestId('sidebar-nav-connections');
    fireEvent.click(navBtn);

    // Connections nav has aria-current=page; Projects does NOT.
    await waitFor(() => {
      expect(
        screen.getByTestId('sidebar-nav-connections').getAttribute('aria-current'),
      ).toBe('page');
    });
    expect(
      screen.getByTestId('sidebar-nav-projects').getAttribute('aria-current'),
    ).not.toBe('page');
  });
});

// ---------------------------------------------------------------------------
// SIDEBAR-VERSION-001 — sidebar app version footer (GH-31)
// ---------------------------------------------------------------------------
describe('<App /> — SIDEBAR-VERSION', () => {
  beforeEach(() => {
    (window as { api?: IpcApi }).api = makeIpcApiStub(PING, { ok: true, data: [] });
  });

  it('SIDEBAR-VERSION-001: sidebar shows app version testid with v{version} format', async () => {
    render(<App />);
    const versionEl = await screen.findByTestId('sidebar-app-version');
    expect(versionEl).toBeInTheDocument();
    expect(versionEl.textContent).toMatch(/^v\d+\.\d+\.\d+/);
  });
});
