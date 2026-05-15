// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ProjectDetail } from '../../src/renderer/views/ProjectDetail';
import { useActiveRuns } from '../../src/renderer/state/active-run';
import type {
  IpcApi,
  IpcResult,
  ProjectInstanceDto,
  TicketDto,
} from '../../src/shared/ipc';

/**
 * DET-001..014 — <ProjectDetail> view.
 *
 * Pattern mirrors `views-add-project.test.tsx` — `installApi()` builds a
 * full `IpcApi` stub and pokes it onto window.api. Per-test we override
 * specific handlers via the returned `ApiStub` aliases.
 *
 * `useActiveRuns` is module-mocked so we can flip between null (default for
 * this PR) and a stub run (for the panel-shown case).
 */

vi.mock('../../src/renderer/state/active-run', () => ({
  useActiveRuns: vi.fn(),
}));

declare global {
  interface Window {
    api?: IpcApi;
  }
}

interface ApiStub {
  api: IpcApi;
  projectsGet: Mock;
  projectsList: Mock;
  jiraList: Mock;
  jiraRefresh: Mock;
  ticketsList: Mock;
  jiraOnTicketsChanged: Mock;
  jiraOnError: Mock;
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

function makeTicket(key: string, overrides: Partial<TicketDto> = {}): TicketDto {
  return {
    key,
    summary: `Summary for ${key}`,
    status: 'Ready for AI',
    priority: 'Medium',
    assignee: null,
    updatedAt: '2026-05-05T11:00:00.000Z',
    url: `https://example.atlassian.net/browse/${key}`,
    ...overrides,
  };
}

function installApi(opts?: {
  project?: ProjectInstanceDto | null;
  projectError?: { code: string; message: string };
  tickets?: TicketDto[];
  jiraListError?: { code: string; message: string };
  jiraRefreshError?: { code: string; message: string };
}): ApiStub {
  const unusedErr = (): IpcResult<never> => ({
    ok: false,
    error: { code: 'NOT_USED_IN_FE_TESTS', message: '' },
  });

  let projectGetResult: IpcResult<ProjectInstanceDto>;
  if (opts?.projectError) {
    projectGetResult = { ok: false, error: opts.projectError };
  } else if (opts?.project === null) {
    // Explicit null → represent as not-found error.
    projectGetResult = {
      ok: false,
      error: { code: 'NOT_FOUND', message: 'project not found' },
    };
  } else {
    projectGetResult = {
      ok: true,
      data: opts?.project ?? makeProject('p-1', 'Alpha'),
    };
  }

  const ticketsList = opts?.tickets ?? [];
  const jiraListResult: IpcResult<{ tickets: TicketDto[] }> = opts?.jiraListError
    ? { ok: false, error: opts.jiraListError }
    : { ok: true, data: { tickets: ticketsList } };
  const jiraRefreshResult: IpcResult<{ tickets: TicketDto[] }> = opts?.jiraRefreshError
    ? { ok: false, error: opts.jiraRefreshError }
    : { ok: true, data: { tickets: ticketsList } };
  // Paged-tickets contract (PR #40 expansion): same seed array, served as
  // a single page with no `nextCursor` so the infinite-scroll sentinel
  // doesn't fire in the unit env.
  const ticketsListResult: IpcResult<{ rows: TicketDto[]; nextCursor?: string }> =
    opts?.jiraListError
      ? { ok: false, error: opts.jiraListError }
      : { ok: true, data: { rows: ticketsList } };

  const projectsGet = vi.fn().mockResolvedValue(projectGetResult);
  const projectsList = vi.fn().mockResolvedValue({ ok: true, data: [] } as IpcResult<
    ProjectInstanceDto[]
  >);
  const jiraList = vi.fn().mockResolvedValue(jiraListResult);
  const jiraRefresh = vi.fn().mockResolvedValue(jiraRefreshResult);
  const ticketsListFn = vi.fn().mockResolvedValue(ticketsListResult);
  const jiraOnTicketsChanged = vi.fn(() => () => {});
  const jiraOnError = vi.fn(() => () => {});

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
      list: projectsList as unknown as IpcApi['projects']['list'],
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
      list: jiraList as unknown as IpcApi['jira']['list'],
      refresh: jiraRefresh as unknown as IpcApi['jira']['refresh'],
      testConnection: vi
        .fn<IpcApi['jira']['testConnection']>()
        .mockResolvedValue(unusedErr()),
      refreshPollers: vi
        .fn<IpcApi['jira']['refreshPollers']>()
        .mockResolvedValue(unusedErr()),
      onTicketsChanged:
        jiraOnTicketsChanged as unknown as IpcApi['jira']['onTicketsChanged'],
      onError: jiraOnError as unknown as IpcApi['jira']['onError'],
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
      start: vi.fn<IpcApi['runs']['start']>().mockResolvedValue(unusedErr()),
      cancel: vi.fn<IpcApi['runs']['cancel']>().mockResolvedValue(unusedErr()),
      approve: vi.fn<IpcApi['runs']['approve']>().mockResolvedValue(unusedErr()),
      reject: vi.fn<IpcApi['runs']['reject']>().mockResolvedValue(unusedErr()),
      modify: vi.fn<IpcApi['runs']['modify']>().mockResolvedValue(unusedErr()),
      current: vi
        .fn<IpcApi['runs']['current']>()
        .mockResolvedValue({ ok: true, data: { run: null } }),
      listHistory: vi
        .fn<IpcApi['runs']['listHistory']>()
        .mockResolvedValue(unusedErr()),
      onCurrentChanged: vi.fn<IpcApi['runs']['onCurrentChanged']>(() => () => {}),
      onStateChanged: vi.fn<IpcApi['runs']['onStateChanged']>(() => () => {}),
      // #8 adds runs.readLog. Agent B owns the typed signature; we patch it
      // on at runtime so legacy tests that don't care about it keep working.
      readLog: vi.fn().mockResolvedValue({ ok: true, data: { entries: [] } }),
    } as unknown as IpcApi['runs'],
    dialog: {
      selectFolder: vi.fn() as unknown as IpcApi['dialog']['selectFolder'],
    },
    tickets: {
      list: ticketsListFn as unknown as IpcApi['tickets']['list'],
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
    projectsGet,
    projectsList,
    jiraList,
    jiraRefresh,
    ticketsList: ticketsListFn,
    jiraOnTicketsChanged,
    jiraOnError,
  };
}

const noop = (): void => {};

beforeEach(() => {
  // Default: no active run — most tests assume the panel is hidden.
  (useActiveRuns as unknown as Mock).mockReturnValue([]);
});

afterEach(() => {
  cleanup();
  delete (window as { api?: IpcApi }).api;
  localStorage.clear();
  vi.restoreAllMocks();
  // Re-mock useActiveRuns (restoreAllMocks would clear it).
  (useActiveRuns as unknown as Mock).mockReset();
  // Defensive: restore real timers in case a test set fake ones and
  // didn't reach its own teardown (e.g. timed out). Fake timers leaking
  // from one test into the next breaks debounced renders elsewhere.
  vi.useRealTimers();
  // Strip any clipboard stub the COPY-* tests installed so unrelated
  // tests downstream see a clean navigator.
  if ('clipboard' in navigator) {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    delete (navigator as { clipboard?: unknown }).clipboard;
  }
});

describe('<ProjectDetail /> — DET', () => {
  describe('DET-001 fetches project and renders name', () => {
    it('DET-001: calls projects.get on mount and renders the project name in header', async () => {
      const stub = installApi({ project: makeProject('p-1', 'Alpha Project') });

      render(
        <ProjectDetail
          projectId="p-1"
          onBack={noop}
        />,
      );

      await waitFor(() => {
        expect(stub.projectsGet).toHaveBeenCalledWith({ id: 'p-1' });
      });

      await waitFor(() => {
        // Project name renders in BOTH the breadcrumb crumb and the h1 title;
        // assert via the title testid to avoid multi-match ambiguity.
        expect(screen.getByTestId('project-detail-title')).toHaveTextContent(
          /alpha project/i,
        );
      });
    });
  });

  describe('DET-002 not found / error', () => {
    it('DET-002: project not found → error/not-found banner; no tabs/table', async () => {
      installApi({
        projectError: { code: 'NOT_FOUND', message: 'project not found' },
      });

      render(
        <ProjectDetail
          projectId="missing"
          onBack={noop}
        />,
      );

      await waitFor(() => {
        // Not-found / error state is visible. Match the testid we expect
        // Agent B to use (project-detail-error / -not-found) OR fall back
        // to text content matching.
        const errorMarker =
          screen.queryByTestId('project-detail-error') ??
          screen.queryByTestId('project-detail-not-found') ??
          screen.queryByText(/not found|could not load|error/i);
        expect(errorMarker).not.toBeNull();
      });

      // Tabs and the ticket table must NOT render in the error state.
      expect(screen.queryByTestId('project-tabs')).not.toBeInTheDocument();
      expect(screen.queryByTestId('tickets-table')).not.toBeInTheDocument();
    });
  });

  describe('DET-003 ticket list seeded on mount', () => {
    it('DET-003: calls tickets.list (paged) for the projectId; tickets render', async () => {
      const tickets = [
        makeTicket('ABC-1', { summary: 'First ticket' }),
        makeTicket('ABC-2', { summary: 'Second ticket' }),
      ];
      const stub = installApi({ tickets });

      render(
        <ProjectDetail
          projectId="p-1"
          onBack={noop}
        />,
      );

      await waitFor(() => {
        expect(stub.ticketsList).toHaveBeenCalled();
      });
      // First call must be for this project, page-1 (no cursor), with the
      // hook's PAGE_SIZE limit. Sort defaults to priority desc for Jira.
      const firstCall = stub.ticketsList.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(firstCall).toMatchObject({ projectId: 'p-1', limit: 20 });
      expect(firstCall.cursor).toBeUndefined();

      await waitFor(() => {
        expect(screen.getByTestId('ticket-row-ABC-1')).toBeInTheDocument();
        expect(screen.getByTestId('ticket-row-ABC-2')).toBeInTheDocument();
      });
    });
  });

  describe('DET-004 refresh', () => {
    it('DET-004: refresh button restarts pagination via tickets.list', async () => {
      const tickets = [makeTicket('ABC-1')];
      const stub = installApi({ tickets });

      render(
        <ProjectDetail
          projectId="p-1"
          onBack={noop}
        />,
      );

      // Wait for initial load to settle.
      await screen.findByTestId('ticket-row-ABC-1');
      const initialCalls = stub.ticketsList.mock.calls.length;

      const refreshBtn = screen.getByTestId('refresh-button');
      fireEvent.click(refreshBtn);

      // Refresh fires another page-1 request.
      await waitFor(() => {
        expect(stub.ticketsList.mock.calls.length).toBeGreaterThan(initialCalls);
      });
      const lastCall = stub.ticketsList.mock.calls.at(-1)?.[0] as Record<string, unknown>;
      expect(lastCall).toMatchObject({ projectId: 'p-1', limit: 20 });
      expect(lastCall.cursor).toBeUndefined();
    });
  });

  describe('DET-005 empty list', () => {
    it('DET-005: empty ticket list → empty-state inside Tickets tab; Run Selected disabled', async () => {
      installApi({ tickets: [] });

      render(
        <ProjectDetail
          projectId="p-1"
          onBack={noop}
        />,
      );

      // Wait for the page to settle (header rendered).
      await screen.findByTestId('refresh-button');

      // Multi-select was removed — there's no `Run Selected` button. Per-row
      // Run lives in the leftmost column instead. Just confirm zero rows.
      expect(screen.queryByTestId(/^ticket-row-/)).not.toBeInTheDocument();
      expect(screen.queryByTestId('run-selected-button')).not.toBeInTheDocument();
    });
  });

  describe('DET-006 auto-mode persists per-project', () => {
    it('DET-006: toggling Auto Mode writes auto-mode:p-1 to localStorage', async () => {
      installApi({ project: makeProject('p-1', 'Alpha') });

      render(
        <ProjectDetail
          projectId="p-1"
          onBack={noop}
        />,
      );

      const toggle = await screen.findByTestId('auto-mode-toggle');
      fireEvent.click(toggle);

      // Per-project localStorage key. Either "true" or JSON-encoded true.
      const stored = localStorage.getItem('auto-mode:p-1');
      expect(stored).not.toBeNull();
      expect(stored).toMatch(/true/i);

      // Crucially, the GLOBAL (`auto-mode`) key should NOT be set by this
      // toggle — the per-project keying is the whole point of the change.
      expect(localStorage.getItem('auto-mode')).toBeNull();
    });
  });

  describe('DET-007 per-row Run', () => {
    // Superseded by DET-RUN-001 — ProjectDetail no longer accepts an `onRun`
    // prop callback; per-row Run now hits `window.api.runs.start` directly.
    it.skip('DET-007 (superseded by DET-RUN-001): per-row Run hits runs.start', () => {});
  });

  describe('DET-008 multi-select Run Selected', () => {
    // Superseded by DET-RUN-003 — Run Selected starts the FIRST checked
    // ticket via runs.start and reports the queued count in a banner; there
    // is no longer an `onRunSelected` prop callback.
    it.skip('DET-008 (superseded by DET-RUN-003): Run Selected starts first + queues remainder', () => {});
  });

  describe('DET-008 (legacy)', () => {
    it.skip('legacy: select multiple via per-row checkboxes → onRunSelected with keys in TABLE order', async () => {
      const tickets = [
        makeTicket('ABC-1'),
        makeTicket('ABC-2'),
        makeTicket('ABC-3'),
      ];
      installApi({ tickets });
      const onRunSelected = vi.fn();

      render(
        <ProjectDetail
          projectId="p-1"
          onBack={noop}
        />,
      );

      // Wait for rows to render.
      await screen.findByTestId('ticket-row-ABC-1');

      // Initially Run Selected is disabled.
      const runSelected = screen.getByTestId(
        'run-selected-button',
      ) as HTMLButtonElement;
      expect(runSelected.disabled).toBe(true);

      // Check ABC-3 first, then ABC-1 — selection order intentionally
      // out of table order. Per spec, callback should still fire with
      // keys in TABLE ORDER ['ABC-1', 'ABC-3'].
      const row3 = screen.getByTestId('ticket-row-ABC-3');
      const row1 = screen.getByTestId('ticket-row-ABC-1');
      const cb3 = within(row3).getByTestId('ticket-checkbox-ABC-3');
      const cb1 = within(row1).getByTestId('ticket-checkbox-ABC-1');

      fireEvent.click(cb3);
      fireEvent.click(cb1);

      // Now enabled.
      await waitFor(() => {
        expect(
          (screen.getByTestId('run-selected-button') as HTMLButtonElement).disabled,
        ).toBe(false);
      });

      fireEvent.click(screen.getByTestId('run-selected-button'));

      expect(onRunSelected).toHaveBeenCalledTimes(1);
      const call = onRunSelected.mock.calls[0];
      expect(call).toBeDefined();
      const keys = (call as unknown[])[0] as string[];
      // Table order, not selection order.
      expect(keys).toEqual(['ABC-1', 'ABC-3']);
    });
  });

  describe('DET-009 master checkbox + indeterminate (superseded)', () => {
    // Superseded — multi-select was theater (the runner enforces a single
    // active run; git can't check out two branches in one working dir).
    // Checkboxes + master + Run Selected button + queued banner all
    // removed; per-row Run is the leftmost column now.
    it.skip('DET-009 (superseded): multi-select removed', () => {});
  });

  describe('DET-010 tab switching', () => {
    it('DET-010: switching to Runs / PRs / Settings shows empty-state; back to Tickets restores table', async () => {
      const tickets = [makeTicket('ABC-1')];
      installApi({ tickets });

      render(
        <ProjectDetail
          projectId="p-1"
          onBack={noop}
        />,
      );

      // Tickets is the default tab.
      await screen.findByTestId('ticket-row-ABC-1');

      const tabsRoot = screen.getByTestId('project-tabs');
      const tabs = within(tabsRoot).getAllByRole('tab');

      const runsTab = tabs.find((t) => /^runs$/i.test(t.textContent ?? ''));
      const prsTab = tabs.find((t) => /pull requests|prs/i.test(t.textContent ?? ''));
      const settingsTab = tabs.find((t) => /settings/i.test(t.textContent ?? ''));
      const ticketsTab = tabs.find((t) => /tickets/i.test(t.textContent ?? ''));

      expect(runsTab).toBeDefined();
      expect(prsTab).toBeDefined();
      expect(settingsTab).toBeDefined();
      expect(ticketsTab).toBeDefined();

      // Switch to Runs → table hidden, empty-state visible.
      fireEvent.click(runsTab!);
      await waitFor(() => {
        expect(screen.queryByTestId('ticket-row-ABC-1')).not.toBeInTheDocument();
      });

      // Switch to PRs → still no table.
      fireEvent.click(prsTab!);
      await waitFor(() => {
        expect(screen.queryByTestId('ticket-row-ABC-1')).not.toBeInTheDocument();
      });

      // Switch to Settings → still no table.
      fireEvent.click(settingsTab!);
      await waitFor(() => {
        expect(screen.queryByTestId('ticket-row-ABC-1')).not.toBeInTheDocument();
      });

      // Back to Tickets → table is back.
      fireEvent.click(ticketsTab!);
      await waitFor(() => {
        expect(screen.getByTestId('ticket-row-ABC-1')).toBeInTheDocument();
      });
    });
  });

  describe('DET-011 active execution panel hidden', () => {
    it('DET-011: useActiveRuns() returns null → panel is hidden', async () => {
      (useActiveRuns as unknown as Mock).mockReturnValue([]);
      installApi({ tickets: [makeTicket('ABC-1')] });

      render(
        <ProjectDetail
          projectId="p-1"
          onBack={noop}
        />,
      );

      await screen.findByTestId('ticket-row-ABC-1');

      // None of the active-execution testids should be present.
      expect(screen.queryByTestId('active-execution-panel')).not.toBeInTheDocument();
      expect(screen.queryByTestId('active-execution-cancel')).not.toBeInTheDocument();
      expect(
        screen.queryByTestId('active-execution-open-details'),
      ).not.toBeInTheDocument();
    });
  });

  describe('DET-012 active execution panel shown', () => {
    it('DET-012: live run → Cancel + Open Details buttons visible (Open Details restored in #8)', async () => {
      // The Active Execution panel now consumes the real `Run` shape from
      // #7's schema. We stub useActiveRuns to return a minimal ready-state
      // run snapshot. Open Details was removed during #7 review and
      // restored in #8 alongside the ExecutionView route.
      (useActiveRuns as unknown as Mock).mockReturnValue([{
        id: 'run-1',
        projectId: 'p-1',
        ticketKey: 'ABC-7',
        mode: 'interactive',
        branchName: 'feat/ABC-7',
        state: 'running',
        status: 'running',
        steps: [],
        pendingApproval: null,
        startedAt: 0,
      }]);
      installApi({ tickets: [makeTicket('ABC-7', { summary: 'A live ticket' })] });
      installRunsStub();

      render(
        <ProjectDetail
          projectId="p-1"
          onBack={noop}
          onOpenExecution={() => {}}
        />,
      );

      const cancel = await screen.findByTestId('active-execution-cancel');
      expect(cancel).toBeInTheDocument();

      // Open Details is restored in #8 — must be on the panel.
      expect(
        screen.getByTestId('active-execution-open-details'),
      ).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------
  // DET-COPY-001..004 — Copy Branch button on the active execution panel (#44)
  // ---------------------------------------------------------------------
  describe('DET-COPY-001 branch name rendered on active execution panel', () => {
    it('DET-COPY-001: panel shows the active run\'s branch name', async () => {
      (useActiveRuns as unknown as Mock).mockReturnValue([{
        id: 'run-1',
        projectId: 'p-1',
        ticketKey: 'ABC-7',
        mode: 'interactive',
        branchName: 'feat/GH-44-copy-branch-button',
        state: 'running',
        status: 'running',
        steps: [],
        pendingApproval: null,
        startedAt: 0,
      }]);
      installApi({ tickets: [makeTicket('ABC-7')] });
      installRunsStub();

      render(<ProjectDetail projectId="p-1" onBack={noop} onOpenExecution={() => {}} />);

      const branch = await screen.findByTestId('active-execution-branch');
      expect(branch).toHaveTextContent('feat/GH-44-copy-branch-button');
    });
  });

  describe('DET-COPY-002 click writes branch name to clipboard + flips label', () => {
    it('DET-COPY-002: click → navigator.clipboard.writeText called; "Copy" → "Copied" → reverts after 1500ms', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(globalThis.navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
      });

      (useActiveRuns as unknown as Mock).mockReturnValue([{
        id: 'run-1',
        projectId: 'p-1',
        ticketKey: 'ABC-7',
        mode: 'interactive',
        branchName: 'feat/GH-44-copy-branch-button',
        state: 'running',
        status: 'running',
        steps: [],
        pendingApproval: null,
        startedAt: 0,
      }]);
      installApi({ tickets: [makeTicket('ABC-7')] });
      installRunsStub();

      render(<ProjectDetail projectId="p-1" onBack={noop} onOpenExecution={() => {}} />);

      // Wait for render with real timers (debounced search effect needs them).
      const btn = await screen.findByTestId('active-execution-copy-branch');
      expect(btn).toHaveTextContent(/^copy$/i);

      // Switch to fake timers AFTER mount so we can deterministically advance
      // the 1.5s reversion timer without slowing the suite. Microtask queue
      // (the clipboard.writeText Promise) is flushed by advanceTimersByTimeAsync.
      vi.useFakeTimers();
      try {
        fireEvent.click(btn);
        expect(writeText).toHaveBeenCalledWith('feat/GH-44-copy-branch-button');

        // Flush microtasks so the .then(...) handler runs setCopied(true).
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(
          screen.getByTestId('active-execution-copy-branch'),
        ).toHaveTextContent(/copied/i);

        // Advance past 1.5s — label reverts.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1600);
        });
        expect(
          screen.getByTestId('active-execution-copy-branch'),
        ).toHaveTextContent(/^copy$/i);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('DET-COPY-003 silent failure on clipboard rejection', () => {
    it('DET-COPY-003: clipboard.writeText rejection → no throw, label stays "Copy", no error banner', async () => {
      const writeText = vi.fn().mockRejectedValue(new Error('clipboard blocked'));
      Object.defineProperty(globalThis.navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
      });

      (useActiveRuns as unknown as Mock).mockReturnValue([{
        id: 'run-1',
        projectId: 'p-1',
        ticketKey: 'ABC-7',
        mode: 'interactive',
        branchName: 'feat/GH-44-copy-branch-button',
        state: 'running',
        status: 'running',
        steps: [],
        pendingApproval: null,
        startedAt: 0,
      }]);
      installApi({ tickets: [makeTicket('ABC-7')] });
      installRunsStub();

      render(<ProjectDetail projectId="p-1" onBack={noop} onOpenExecution={() => {}} />);

      const btn = await screen.findByTestId('active-execution-copy-branch');
      fireEvent.click(btn);

      await waitFor(() => {
        expect(writeText).toHaveBeenCalledTimes(1);
      });
      // Label never flips to "Copied" — label remains "Copy".
      expect(btn).toHaveTextContent(/^copy$/i);
      expect(btn).not.toHaveTextContent(/copied/i);
      // No run-error-banner from this failure (silent per spec).
      expect(screen.queryByTestId('run-error-banner')).not.toBeInTheDocument();
    });
  });

  describe('DET-COPY-004 clipboard API unavailable → silent no-op', () => {
    it('DET-COPY-004: navigator.clipboard undefined → click does nothing, no error', async () => {
      Object.defineProperty(globalThis.navigator, 'clipboard', {
        configurable: true,
        value: undefined,
      });

      (useActiveRuns as unknown as Mock).mockReturnValue([{
        id: 'run-1',
        projectId: 'p-1',
        ticketKey: 'ABC-7',
        mode: 'interactive',
        branchName: 'feat/GH-44-copy-branch-button',
        state: 'running',
        status: 'running',
        steps: [],
        pendingApproval: null,
        startedAt: 0,
      }]);
      installApi({ tickets: [makeTicket('ABC-7')] });
      installRunsStub();

      render(<ProjectDetail projectId="p-1" onBack={noop} onOpenExecution={() => {}} />);

      const btn = await screen.findByTestId('active-execution-copy-branch');
      // Should not throw despite missing clipboard API.
      fireEvent.click(btn);
      expect(btn).toHaveTextContent(/^copy$/i);
    });
  });

  // ---------------------------------------------------------------------
  // NAV-001..002 — Open Details navigation (#8 restoration)
  // ---------------------------------------------------------------------
  //
  // Per the spec, `App.tsx` is the router. ProjectDetail receives an
  // `onOpenExecution: (runId: string) => void` prop and invokes it when
  // the user clicks Open Details on the Active Execution panel.
  //
  // NAV-003 (ExecutionView Back returns to ProjectDetail) is covered in
  // tests/unit/views-execution-view.test.tsx (EXEC-006).
  // ---------------------------------------------------------------------

  describe('NAV-001 Open Details button restored on Active Execution panel', () => {
    it('NAV-001: panel rendered → active-execution-open-details testid exists', async () => {
      (useActiveRuns as unknown as Mock).mockReturnValue([{
        id: 'run-1',
        projectId: 'p-1',
        ticketKey: 'ABC-7',
        mode: 'interactive',
        branchName: 'feat/ABC-7',
        state: 'running',
        status: 'running',
        steps: [],
        pendingApproval: null,
        startedAt: 0,
      }]);
      installApi({ tickets: [makeTicket('ABC-7')] });
      installRunsStub();

      render(
        <ProjectDetail
          projectId="p-1"
          onBack={noop}
          onOpenExecution={() => {}}
        />,
      );

      const open = await screen.findByTestId('active-execution-open-details');
      expect(open).toBeInTheDocument();
    });
  });

  describe('NAV-002 Open Details click invokes onOpenExecution(runId)', () => {
    it('NAV-002: click → onOpenExecution called with the active run id', async () => {
      (useActiveRuns as unknown as Mock).mockReturnValue([{
        id: 'run-42',
        projectId: 'p-1',
        ticketKey: 'ABC-7',
        mode: 'interactive',
        branchName: 'feat/ABC-7',
        state: 'running',
        status: 'running',
        steps: [],
        pendingApproval: null,
        startedAt: 0,
      }]);
      installApi({ tickets: [makeTicket('ABC-7')] });
      installRunsStub();

      const onOpenExecution = vi.fn();
      render(
        <ProjectDetail
          projectId="p-1"
          onBack={noop}
          onOpenExecution={onOpenExecution}
        />,
      );

      const open = await screen.findByTestId('active-execution-open-details');
      fireEvent.click(open);

      expect(onOpenExecution).toHaveBeenCalledTimes(1);
      expect(onOpenExecution).toHaveBeenCalledWith('run-42');
    });
  });

  describe('DET-013 priority badges', () => {
    it('DET-013: priority badges render with color encoding (high/medium/low/neutral)', async () => {
      const tickets = [
        makeTicket('HIGH-1', { priority: 'Highest' }),
        makeTicket('MED-1', { priority: 'Medium' }),
        makeTicket('LOW-1', { priority: 'Lowest' }),
        makeTicket('UNK-1', { priority: 'Banana' }),
      ];
      installApi({ tickets });

      render(
        <ProjectDetail
          projectId="p-1"
          onBack={noop}
        />,
      );

      await screen.findByTestId('ticket-row-HIGH-1');

      // The Badge primitive sets `data-variant` to its variant. Per spec
      // the priority encoder maps Jira priority → 'high' | 'medium' | 'low'
      // | 'neutral'. Agent B is free to either:
      //   (a) reuse Badge with a new variant set ('high' / 'medium' / etc.)
      //   (b) keep Badge's 'idle/running/...' set and add CSS classes via
      //       a wrapper data attribute.
      // Either way the DOM should expose the priority class encoding via a
      // queryable attribute. We accept data-priority OR data-variant.
      function readPriorityEncoding(rowTestId: string): string | null {
        const row = screen.getByTestId(rowTestId);
        const candidates = Array.from(
          row.querySelectorAll<HTMLElement>(
            '[data-priority], [data-variant]',
          ),
        );
        for (const c of candidates) {
          const p = c.getAttribute('data-priority');
          if (p) return p;
          const v = c.getAttribute('data-variant');
          if (v && /^(high|medium|low|neutral)$/.test(v)) return v;
        }
        return null;
      }

      expect(readPriorityEncoding('ticket-row-HIGH-1')).toBe('high');
      expect(readPriorityEncoding('ticket-row-MED-1')).toBe('medium');
      expect(readPriorityEncoding('ticket-row-LOW-1')).toBe('low');
      expect(readPriorityEncoding('ticket-row-UNK-1')).toBe('neutral');
    });
  });

  describe('DET-014 ticket subscription event filter', () => {
    // Superseded by the server-paginated read path (PR #40 expansion). The
    // renderer no longer subscribes to `jira.onTicketsChanged` for the
    // tickets table — the table re-fetches `tickets.list` whenever the
    // sort/search query changes and on Refresh. The push-based ticket-
    // changed event still fires from main but is not wired into the
    // renderer's tickets state, so this test no longer applies.
    it.skip('DET-014 (superseded): onTicketsChanged event filter — tickets table is now server-paginated, no subscription', () => {});
  });

  // ---------------------------------------------------------------------
  // DET-RUN-001..003 — Run handlers wired through window.api.runs.start
  // ---------------------------------------------------------------------
  //
  // The existing `installApi()` helper does not include the `runs` namespace
  // (it pre-dates issue #7). For the DET-RUN-* tests we patch a `runs` stub
  // onto the API after `installApi()` returns. Agent B's ProjectDetail wiring
  // is expected to call `window.api.runs.start({ projectId, ticketKey })` on
  // both per-row Run and Run Selected.
  //
  // For the error-banner test, the spec only mandates "an inline banner" —
  // the matcher is tolerant: any element with a testid containing `error`
  // and `run` (e.g. `runs-start-error-banner`) OR any role="alert" that
  // contains the error text Agent B chose to display.
  //
  // For the queued-banner test (DET-RUN-003), the spec text says:
  //   "Run Selected starts the FIRST checked ticket; remaining keys
  //    mentioned in a banner ('4 more queued — start them after this run
  //    completes')"
  // We assert that runs.start is called with the FIRST selected key (in
  // table order) and that the remaining count appears somewhere on screen.
  // -----------------------------------------------------------------------

  function installRunsStub(): {
    runsStart: Mock;
    runsCancel: Mock;
    runsCurrent: Mock;
    runsOnCurrentChanged: Mock;
    setStartResult: (
      r: IpcResult<{
        run: { id: string; projectId: string; ticketKey: string };
      }>,
    ) => void;
  } {
    const api = (window as { api?: IpcApi }).api;
    if (!api) throw new Error('installRunsStub() must run after installApi()');

    let nextResult: IpcResult<{
      run: { id: string; projectId: string; ticketKey: string };
    }> = {
      ok: true,
      data: {
        run: { id: 'r-1', projectId: 'p-1', ticketKey: 'ABC-1' },
      },
    };

    const runsStart = vi.fn(async () => nextResult);
    const runsCancel = vi.fn(async () => ({
      ok: true,
      data: { runId: 'r-1' },
    }));
    const runsCurrent = vi.fn(async () => ({ ok: true, data: null }));
    const runsOnCurrentChanged = vi.fn(() => () => {});

    // Patch a `runs` namespace onto the existing api. We cast through unknown
    // to satisfy TS without depending on Agent B's exact `IpcApi['runs']`
    // shape — the runtime methods are what ProjectDetail will reach for.
    (api as unknown as { runs: Record<string, unknown> }).runs = {
      start: runsStart,
      cancel: runsCancel,
      approve: vi.fn(),
      reject: vi.fn(),
      modify: vi.fn(),
      current: runsCurrent,
      listHistory: vi.fn(),
      onCurrentChanged: runsOnCurrentChanged,
      onStateChanged: vi.fn(() => () => {}),
    };

    return {
      runsStart,
      runsCancel,
      runsCurrent,
      runsOnCurrentChanged,
      setStartResult: (r) => {
        nextResult = r;
      },
    };
  }

  describe('DET-RUN-001 per-row Run hits runs.start', () => {
    it('DET-RUN-001: clicking per-row Run calls window.api.runs.start({ projectId, ticketKey })', async () => {
      const tickets = [makeTicket('ABC-1'), makeTicket('ABC-2')];
      installApi({ tickets });
      const runs = installRunsStub();

      render(
        <ProjectDetail
          projectId="p-1"
          onBack={noop}
        />,
      );

      const runBtn = await screen.findByTestId('ticket-run-button-ABC-2');
      fireEvent.click(runBtn);

      await waitFor(() => {
        expect(runs.runsStart).toHaveBeenCalledTimes(1);
      });
      expect(runs.runsStart).toHaveBeenCalledWith({
        projectId: 'p-1',
        ticketKey: 'ABC-2',
      });
    });
  });

  describe('DET-RUN-002 runs.start error → inline banner', () => {
    it('DET-RUN-002: runs.start error response surfaces as an inline banner', async () => {
      const tickets = [makeTicket('ABC-1')];
      installApi({ tickets });
      const runs = installRunsStub();
      runs.setStartResult({
        ok: false,
        error: { code: 'ALREADY_RUNNING', message: 'a run is already active' },
      });

      render(
        <ProjectDetail
          projectId="p-1"
          onBack={noop}
        />,
      );

      const runBtn = await screen.findByTestId('ticket-run-button-ABC-1');
      fireEvent.click(runBtn);

      // Tolerant match: any banner-like node containing the error message
      // OR a testid that names "runs"+"error" / "run"+"error".
      await waitFor(() => {
        const byMessage = screen.queryByText(/a run is already active/i);
        const byCode = screen.queryByText(/ALREADY_RUNNING/);
        // Common testid candidates Agent B might pick.
        const byTestId =
          screen.queryByTestId('runs-start-error-banner') ??
          screen.queryByTestId('runs-error-banner') ??
          screen.queryByTestId('run-error-banner') ??
          screen.queryByTestId('runs-error');
        const found = byMessage ?? byCode ?? byTestId;
        expect(found).not.toBeNull();
      });
    });
  });

  describe('DET-RUN-003 Run Selected (superseded)', () => {
    // Superseded with the multi-select removal. The runner is single-
    // active-run by design; multi-select implied parallelism that
    // never existed. UI now exposes per-row Run only — covered by
    // DET-RUN-001.
    it.skip('DET-RUN-003 (superseded): Run Selected button removed', () => {});
  });

  // ---------------------------------------------------------------------
  // GH-52 #2 / #3 — widget breathing + inline approve/reject
  // ---------------------------------------------------------------------
  describe('DET-WIDGET-BREATH non-terminal run breathes the progress bar', () => {
    it('DET-WIDGET-BREATH: ProgressBar.fill carries data-running="true" while running', async () => {
      (useActiveRuns as unknown as Mock).mockReturnValue([{
        id: 'run-1',
        projectId: 'p-1',
        ticketKey: 'ABC-7',
        mode: 'interactive',
        branchName: 'feat/ABC-7',
        state: 'implementing',
        status: 'running',
        steps: [],
        pendingApproval: null,
        startedAt: 0,
      }]);
      installApi({ tickets: [makeTicket('ABC-7')] });
      installRunsStub();

      render(
        <ProjectDetail
          projectId="p-1"
          onBack={noop}
          onOpenExecution={() => {}}
        />,
      );

      const progress = await screen.findByTestId('active-execution-progress');
      const fill = progress.querySelector('[data-testid="progress-fill"]');
      expect(fill).not.toBeNull();
      expect(fill?.getAttribute('data-running')).toBe('true');
    });

    it('DET-WIDGET-NO-BREATH: terminal status sets data-running="false"', async () => {
      (useActiveRuns as unknown as Mock).mockReturnValue([{
        id: 'run-1',
        projectId: 'p-1',
        ticketKey: 'ABC-7',
        mode: 'interactive',
        branchName: 'feat/ABC-7',
        state: 'done',
        status: 'done',
        steps: [],
        pendingApproval: null,
        startedAt: 0,
      }]);
      installApi({ tickets: [makeTicket('ABC-7')] });
      installRunsStub();

      render(
        <ProjectDetail
          projectId="p-1"
          onBack={noop}
          onOpenExecution={() => {}}
        />,
      );

      const progress = await screen.findByTestId('active-execution-progress');
      const fill = progress.querySelector('[data-testid="progress-fill"]');
      expect(fill?.getAttribute('data-running')).toBe('false');
    });
  });

  describe('DET-WIDGET-APPROVE inline approve/reject when awaitingApproval', () => {
    it('DET-WIDGET-APPROVE: pendingApproval !== null → Approve + Reject buttons visible', async () => {
      (useActiveRuns as unknown as Mock).mockReturnValue([{
        id: 'run-1',
        projectId: 'p-1',
        ticketKey: 'ABC-7',
        mode: 'interactive',
        branchName: 'feat/ABC-7',
        state: 'awaitingApproval',
        status: 'running',
        steps: [],
        pendingApproval: { plan: 'check', raw: { plan: 'check' } },
        startedAt: 0,
      }]);
      installApi({ tickets: [makeTicket('ABC-7')] });
      installRunsStub();

      render(
        <ProjectDetail
          projectId="p-1"
          onBack={noop}
          onOpenExecution={() => {}}
        />,
      );

      expect(
        await screen.findByTestId('panel-approve'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('panel-reject'),
      ).toBeInTheDocument();
    });

    it('DET-WIDGET-APPROVE-CLICK: clicking Approve dispatches runs.approve({ runId })', async () => {
      (useActiveRuns as unknown as Mock).mockReturnValue([{
        id: 'run-42',
        projectId: 'p-1',
        ticketKey: 'ABC-7',
        mode: 'interactive',
        branchName: 'feat/ABC-7',
        state: 'awaitingApproval',
        status: 'running',
        steps: [],
        pendingApproval: { plan: 'check', raw: { plan: 'check' } },
        startedAt: 0,
      }]);
      installApi({ tickets: [makeTicket('ABC-7')] });
      const stub = installRunsStub();
      const api = (window as { api?: IpcApi }).api!;
      const approveSpy = vi.fn(async () => ({ ok: true, data: { runId: 'run-42' } }));
      (api as unknown as { runs: Record<string, unknown> }).runs = {
        ...(api as unknown as { runs: Record<string, unknown> }).runs,
        approve: approveSpy,
      };

      render(
        <ProjectDetail
          projectId="p-1"
          onBack={noop}
          onOpenExecution={() => {}}
        />,
      );

      const approveBtn = await screen.findByTestId('panel-approve');
      await act(async () => {
        fireEvent.click(approveBtn);
      });
      await waitFor(() => {
        expect(approveSpy).toHaveBeenCalledWith({ runId: 'run-42' });
      });
      // Cancel reference so the helper isn't flagged unused — installRunsStub
      // patches the namespace; we keep it for parity with sibling tests.
      void stub;
    });
  });
});
