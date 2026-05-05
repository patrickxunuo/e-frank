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
import { useActiveRun } from '../../src/renderer/state/active-run';
import type {
  IpcApi,
  IpcResult,
  JiraTicketsChangedEvent,
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
 * `useActiveRun` is module-mocked so we can flip between null (default for
 * this PR) and a stub run (for the panel-shown case).
 */

vi.mock('../../src/renderer/state/active-run', () => ({
  useActiveRun: vi.fn(),
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
    repo: { type: 'github', localPath: '/tmp/' + id, baseBranch: 'main' },
    tickets: { source: 'jira', query: 'project = ABC' },
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

  const projectsGet = vi.fn().mockResolvedValue(projectGetResult);
  const projectsList = vi.fn().mockResolvedValue({ ok: true, data: [] } as IpcResult<
    ProjectInstanceDto[]
  >);
  const jiraList = vi.fn().mockResolvedValue(jiraListResult);
  const jiraRefresh = vi.fn().mockResolvedValue(jiraRefreshResult);
  const jiraOnTicketsChanged = vi.fn(() => () => {});
  const jiraOnError = vi.fn(() => () => {});

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
  };

  (window as { api?: IpcApi }).api = api;
  return {
    api,
    projectsGet,
    projectsList,
    jiraList,
    jiraRefresh,
    jiraOnTicketsChanged,
    jiraOnError,
  };
}

const noop = (): void => {};
const noopKey = (_: string): void => {};
const noopKeys = (_: string[]): void => {};

beforeEach(() => {
  // Default: no active run — most tests assume the panel is hidden.
  (useActiveRun as unknown as Mock).mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  delete (window as { api?: IpcApi }).api;
  localStorage.clear();
  vi.restoreAllMocks();
  // Re-mock useActiveRun (restoreAllMocks would clear it).
  (useActiveRun as unknown as Mock).mockReset();
});

describe('<ProjectDetail /> — DET', () => {
  describe('DET-001 fetches project and renders name', () => {
    it('DET-001: calls projects.get on mount and renders the project name in header', async () => {
      const stub = installApi({ project: makeProject('p-1', 'Alpha Project') });

      render(
        <ProjectDetail
          projectId="p-1"
          onBack={noop}
          onOpenExecution={noopKey}
          onRun={noopKey}
          onRunSelected={noopKeys}
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
          onOpenExecution={noopKey}
          onRun={noopKey}
          onRunSelected={noopKeys}
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
    it('DET-003: calls jira.list for the projectId; tickets render', async () => {
      const tickets = [
        makeTicket('ABC-1', { summary: 'First ticket' }),
        makeTicket('ABC-2', { summary: 'Second ticket' }),
      ];
      const stub = installApi({ tickets });

      render(
        <ProjectDetail
          projectId="p-1"
          onBack={noop}
          onOpenExecution={noopKey}
          onRun={noopKey}
          onRunSelected={noopKeys}
        />,
      );

      await waitFor(() => {
        expect(stub.jiraList).toHaveBeenCalledWith({ projectId: 'p-1' });
      });

      await waitFor(() => {
        expect(screen.getByTestId('ticket-row-ABC-1')).toBeInTheDocument();
        expect(screen.getByTestId('ticket-row-ABC-2')).toBeInTheDocument();
      });
    });
  });

  describe('DET-004 refresh', () => {
    it('DET-004: refresh button click calls jira.refresh', async () => {
      const tickets = [makeTicket('ABC-1')];
      const stub = installApi({ tickets });

      render(
        <ProjectDetail
          projectId="p-1"
          onBack={noop}
          onOpenExecution={noopKey}
          onRun={noopKey}
          onRunSelected={noopKeys}
        />,
      );

      // Wait for initial load to settle.
      await screen.findByTestId('ticket-row-ABC-1');

      const refreshBtn = screen.getByTestId('refresh-button');
      fireEvent.click(refreshBtn);

      await waitFor(() => {
        expect(stub.jiraRefresh).toHaveBeenCalledWith({ projectId: 'p-1' });
      });
    });
  });

  describe('DET-005 empty list', () => {
    it('DET-005: empty ticket list → empty-state inside Tickets tab; Run Selected disabled', async () => {
      installApi({ tickets: [] });

      render(
        <ProjectDetail
          projectId="p-1"
          onBack={noop}
          onOpenExecution={noopKey}
          onRun={noopKey}
          onRunSelected={noopKeys}
        />,
      );

      // Wait for the page to settle (header rendered).
      await screen.findByTestId('refresh-button');

      // Run Selected starts disabled (0 selected).
      const runSelected = screen.getByTestId(
        'run-selected-button',
      ) as HTMLButtonElement;
      expect(runSelected.disabled).toBe(true);

      // No ticket rows render.
      expect(screen.queryByTestId(/^ticket-row-/)).not.toBeInTheDocument();
    });
  });

  describe('DET-006 auto-mode persists per-project', () => {
    it('DET-006: toggling Auto Mode writes auto-mode:p-1 to localStorage', async () => {
      installApi({ project: makeProject('p-1', 'Alpha') });

      render(
        <ProjectDetail
          projectId="p-1"
          onBack={noop}
          onOpenExecution={noopKey}
          onRun={noopKey}
          onRunSelected={noopKeys}
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
    it('DET-007: per-row Run button click → onRun(key)', async () => {
      const tickets = [makeTicket('ABC-1'), makeTicket('ABC-2')];
      installApi({ tickets });
      const onRun = vi.fn();

      render(
        <ProjectDetail
          projectId="p-1"
          onBack={noop}
          onOpenExecution={noopKey}
          onRun={onRun}
          onRunSelected={noopKeys}
        />,
      );

      const runBtn = await screen.findByTestId('ticket-run-button-ABC-2');
      fireEvent.click(runBtn);

      expect(onRun).toHaveBeenCalledTimes(1);
      expect(onRun).toHaveBeenCalledWith('ABC-2');
    });
  });

  describe('DET-008 multi-select Run Selected', () => {
    it('DET-008: select multiple via per-row checkboxes → onRunSelected with keys in TABLE order', async () => {
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
          onOpenExecution={noopKey}
          onRun={noopKey}
          onRunSelected={onRunSelected}
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

  describe('DET-009 master checkbox + indeterminate', () => {
    it('DET-009: master checkbox toggles all visible; indeterminate when partial', async () => {
      const tickets = [makeTicket('ABC-1'), makeTicket('ABC-2'), makeTicket('ABC-3')];
      installApi({ tickets });
      const onRunSelected = vi.fn();

      render(
        <ProjectDetail
          projectId="p-1"
          onBack={noop}
          onOpenExecution={noopKey}
          onRun={noopKey}
          onRunSelected={onRunSelected}
        />,
      );

      await screen.findByTestId('ticket-row-ABC-1');

      // Click master → all selected.
      const master = screen.getByTestId('ticket-master-checkbox');
      fireEvent.click(master);

      // Run Selected should now be enabled.
      await waitFor(() => {
        expect(
          (screen.getByTestId('run-selected-button') as HTMLButtonElement).disabled,
        ).toBe(false);
      });

      // Submit and inspect — should be all 3 keys in table order.
      fireEvent.click(screen.getByTestId('run-selected-button'));
      const firstCall = onRunSelected.mock.calls[0];
      expect(firstCall).toBeDefined();
      const allKeys = (firstCall as unknown[])[0] as string[];
      expect(allKeys).toEqual(['ABC-1', 'ABC-2', 'ABC-3']);

      // Click master again → none selected.
      fireEvent.click(master);
      await waitFor(() => {
        expect(
          (screen.getByTestId('run-selected-button') as HTMLButtonElement).disabled,
        ).toBe(true);
      });

      // Now select just ABC-2 → master should be in indeterminate state
      // (some-but-not-all). The indeterminate marker is presentational — we
      // accept any of: data-indeterminate="true" / data-state="indeterminate"
      // / class substring "indeterminate" on the master or one of its
      // descendants.
      const cb2 = within(screen.getByTestId('ticket-row-ABC-2')).getByTestId(
        'ticket-checkbox-ABC-2',
      );
      fireEvent.click(cb2);

      await waitFor(() => {
        const masterEl = screen.getByTestId('ticket-master-checkbox');
        const indeterminateMarker =
          masterEl.getAttribute('data-indeterminate') === 'true' ||
          masterEl.getAttribute('data-state') === 'indeterminate' ||
          masterEl.closest('[data-indeterminate="true"]') !== null ||
          masterEl.closest('[data-state="indeterminate"]') !== null ||
          masterEl.querySelector('[data-indeterminate="true"]') !== null ||
          masterEl.querySelector('[data-state="indeterminate"]') !== null ||
          /indeterminate/i.test(masterEl.className) ||
          Array.from(masterEl.querySelectorAll('*')).some((el) =>
            /indeterminate/i.test((el as HTMLElement).className ?? ''),
          );
        expect(indeterminateMarker).toBe(true);
      });
    });
  });

  describe('DET-010 tab switching', () => {
    it('DET-010: switching to Runs / PRs / Settings shows empty-state; back to Tickets restores table', async () => {
      const tickets = [makeTicket('ABC-1')];
      installApi({ tickets });

      render(
        <ProjectDetail
          projectId="p-1"
          onBack={noop}
          onOpenExecution={noopKey}
          onRun={noopKey}
          onRunSelected={noopKeys}
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
    it('DET-011: useActiveRun() returns null → panel is hidden', async () => {
      (useActiveRun as unknown as Mock).mockReturnValue(null);
      installApi({ tickets: [makeTicket('ABC-1')] });

      render(
        <ProjectDetail
          projectId="p-1"
          onBack={noop}
          onOpenExecution={noopKey}
          onRun={noopKey}
          onRunSelected={noopKeys}
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
    it('DET-012: stubbed run → Cancel + Open Details visible; Open Details fires onOpenExecution(key)', async () => {
      (useActiveRun as unknown as Mock).mockReturnValue({
        ticketKey: 'ABC-7',
        ticketTitle: 'A live ticket',
        progress: 0.5,
        currentStep: 'Coding',
        totalSteps: 6,
        stepIndex: 3,
        recentLines: ['line one', 'line two'],
        runId: 'run-1',
      });
      installApi({ tickets: [makeTicket('ABC-7', { summary: 'A live ticket' })] });

      const onOpenExecution = vi.fn();
      render(
        <ProjectDetail
          projectId="p-1"
          onBack={noop}
          onOpenExecution={onOpenExecution}
          onRun={noopKey}
          onRunSelected={noopKeys}
        />,
      );

      const cancel = await screen.findByTestId('active-execution-cancel');
      const open = screen.getByTestId('active-execution-open-details');
      expect(cancel).toBeInTheDocument();
      expect(open).toBeInTheDocument();

      fireEvent.click(open);
      expect(onOpenExecution).toHaveBeenCalledTimes(1);
      expect(onOpenExecution).toHaveBeenCalledWith('ABC-7');
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
          onOpenExecution={noopKey}
          onRun={noopKey}
          onRunSelected={noopKeys}
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
    it('DET-014: onTicketsChanged for THIS projectId updates table; events for other projects do NOT', async () => {
      // Capture the registered listener so we can fire events at it.
      let ticketsChangedListener:
        | ((e: JiraTicketsChangedEvent) => void)
        | null = null;
      const stub = installApi({ tickets: [makeTicket('ABC-1')] });
      stub.jiraOnTicketsChanged.mockImplementation(
        (listener: (e: JiraTicketsChangedEvent) => void) => {
          ticketsChangedListener = listener;
          return () => {
            ticketsChangedListener = null;
          };
        },
      );

      render(
        <ProjectDetail
          projectId="p-1"
          onBack={noop}
          onOpenExecution={noopKey}
          onRun={noopKey}
          onRunSelected={noopKeys}
        />,
      );

      // Wait for mount + initial seed.
      await screen.findByTestId('ticket-row-ABC-1');
      // Listener was registered on mount.
      expect(stub.jiraOnTicketsChanged).toHaveBeenCalledTimes(1);
      expect(ticketsChangedListener).not.toBeNull();

      // Fire an event for a DIFFERENT project — should NOT update the table.
      act(() => {
        ticketsChangedListener?.({
          projectId: 'OTHER',
          tickets: [makeTicket('OTHER-1')],
          timestamp: Date.now(),
        });
      });
      // Still only the original ABC-1 row.
      expect(screen.getByTestId('ticket-row-ABC-1')).toBeInTheDocument();
      expect(screen.queryByTestId('ticket-row-OTHER-1')).not.toBeInTheDocument();

      // Fire an event for THIS project — table updates.
      act(() => {
        ticketsChangedListener?.({
          projectId: 'p-1',
          tickets: [makeTicket('XYZ-9'), makeTicket('XYZ-10')],
          timestamp: Date.now(),
        });
      });

      await waitFor(() => {
        expect(screen.getByTestId('ticket-row-XYZ-9')).toBeInTheDocument();
        expect(screen.getByTestId('ticket-row-XYZ-10')).toBeInTheDocument();
      });
      // Old row gone.
      expect(screen.queryByTestId('ticket-row-ABC-1')).not.toBeInTheDocument();
    });
  });
});
