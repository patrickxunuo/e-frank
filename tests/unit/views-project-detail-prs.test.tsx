// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ProjectDetail } from '../../src/renderer/views/ProjectDetail';
import { useActiveRuns } from '../../src/renderer/state/active-run';
import type {
  IpcApi,
  IpcResult,
  ProjectInstanceDto,
  PullDto,
  PullsListResponse,
} from '../../src/shared/ipc';

/**
 * PRS-001..010 — <ProjectDetail> PRs tab (#GH-67).
 *
 * Patterned after `views-project-detail.test.tsx`. Uses the same shape of
 * `installApi()` stub but trimmed to the surface this tab actually touches:
 * `projects.get`, `pulls.list`, and `shell.openExternal`.
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
  pullsList: Mock;
  shellOpenExternal: Mock;
}

function makeProject(overrides: Partial<ProjectInstanceDto> = {}): ProjectInstanceDto {
  return {
    id: 'p-1',
    name: 'Alpha',
    repo: {
      type: 'github',
      localPath: '/tmp/p-1',
      baseBranch: 'main',
      connectionId: 'conn-gh-1',
      slug: 'gazhang/alpha',
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

function makePull(n: number, overrides: Partial<PullDto> = {}): PullDto {
  return {
    number: n,
    title: `PR ${n}`,
    authorLogin: 'gazhang',
    state: 'open',
    reviewDecision: null,
    updatedAt: '2026-05-12T10:00:00Z',
    url: `https://github.com/gazhang/alpha/pull/${n}`,
    ...overrides,
  };
}

function installApi(opts?: {
  pullsResult?: IpcResult<PullsListResponse>;
}): ApiStub {
  const unusedErr = (): IpcResult<never> => ({
    ok: false,
    error: { code: 'NOT_USED_IN_FE_TESTS', message: '' },
  });

  const projectsGet = vi.fn().mockResolvedValue({ ok: true, data: makeProject() });
  const pullsList = vi
    .fn()
    .mockResolvedValue(opts?.pullsResult ?? { ok: true, data: { rows: [] } });
  const shellOpenExternal = vi.fn().mockResolvedValue({ ok: true, data: null });

  const api: IpcApi = {
    ping: vi.fn() as unknown as IpcApi['ping'],
    app: {
      info: vi.fn().mockResolvedValue({ ok: false, error: { code: 'NOT_USED_IN_FE_TESTS', message: '' } }),
    },
    claudeCli: {
      probe: vi.fn().mockResolvedValue({ ok: false, error: { code: 'NOT_USED_IN_FE_TESTS', message: '' } }),
      probeOverride: vi.fn().mockResolvedValue({ ok: false, error: { code: 'NOT_USED_IN_FE_TESTS', message: '' } }),
    },
    claude: {
      run: vi.fn() as unknown as IpcApi['claude']['run'],
      cancel: vi.fn() as unknown as IpcApi['claude']['cancel'],
      write: vi.fn() as unknown as IpcApi['claude']['write'],
      status: vi
        .fn()
        .mockResolvedValue({ ok: true, data: { active: null } }) as unknown as IpcApi['claude']['status'],
      onOutput: vi.fn(() => () => {}) as unknown as IpcApi['claude']['onOutput'],
      onExit: vi.fn(() => () => {}) as unknown as IpcApi['claude']['onExit'],
    },
    projects: {
      list: vi.fn().mockResolvedValue({ ok: true, data: [] }) as unknown as IpcApi['projects']['list'],
      get: projectsGet as unknown as IpcApi['projects']['get'],
      create: vi.fn().mockResolvedValue(unusedErr()) as unknown as IpcApi['projects']['create'],
      update: vi.fn().mockResolvedValue(unusedErr()) as unknown as IpcApi['projects']['update'],
      delete: vi.fn().mockResolvedValue(unusedErr()) as unknown as IpcApi['projects']['delete'],
    },
    secrets: {
      set: vi.fn().mockResolvedValue(unusedErr()) as unknown as IpcApi['secrets']['set'],
      get: vi.fn().mockResolvedValue(unusedErr()) as unknown as IpcApi['secrets']['get'],
      delete: vi.fn().mockResolvedValue(unusedErr()) as unknown as IpcApi['secrets']['delete'],
      list: vi.fn().mockResolvedValue(unusedErr()) as unknown as IpcApi['secrets']['list'],
    },
    jira: {
      list: vi
        .fn()
        .mockResolvedValue({ ok: true, data: { tickets: [] } }) as unknown as IpcApi['jira']['list'],
      refresh: vi
        .fn()
        .mockResolvedValue({ ok: true, data: { tickets: [] } }) as unknown as IpcApi['jira']['refresh'],
      testConnection: vi.fn() as unknown as IpcApi['jira']['testConnection'],
      refreshPollers: vi.fn() as unknown as IpcApi['jira']['refreshPollers'],
      onTicketsChanged: vi.fn(() => () => {}) as unknown as IpcApi['jira']['onTicketsChanged'],
      onError: vi.fn(() => () => {}) as unknown as IpcApi['jira']['onError'],
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
      start: vi.fn().mockResolvedValue(unusedErr()),
      cancel: vi.fn().mockResolvedValue(unusedErr()),
      approve: vi.fn().mockResolvedValue(unusedErr()),
      reject: vi.fn().mockResolvedValue(unusedErr()),
      modify: vi.fn().mockResolvedValue(unusedErr()),
      current: vi.fn().mockResolvedValue({ ok: true, data: { run: null } }),
      listHistory: vi.fn().mockResolvedValue({ ok: true, data: { runs: [] } }),
      delete: vi.fn().mockResolvedValue(unusedErr()),
      readLog: vi.fn().mockResolvedValue({ ok: true, data: { entries: [] } }),
      onCurrentChanged: vi.fn(() => () => {}),
      onStateChanged: vi.fn(() => () => {}),
    } as unknown as IpcApi['runs'],
    dialog: {
      selectFolder: vi.fn() as unknown as IpcApi['dialog']['selectFolder'],
    },
    tickets: {
      list: vi
        .fn()
        .mockResolvedValue({ ok: true, data: { rows: [] } }) as unknown as IpcApi['tickets']['list'],
    },
    pulls: {
      list: pullsList as unknown as IpcApi['pulls']['list'],
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
      findStart: vi.fn() as unknown as IpcApi['skills']['findStart'],
      findCancel: vi.fn() as unknown as IpcApi['skills']['findCancel'],
      onFindOutput: vi.fn(() => () => {}) as unknown as IpcApi['skills']['onFindOutput'],
      onFindExit: vi.fn(() => () => {}) as unknown as IpcApi['skills']['onFindExit'],
    },
    shell: {
      openPath: vi.fn() as unknown as IpcApi['shell']['openPath'],
      openExternal: shellOpenExternal as unknown as IpcApi['shell']['openExternal'],
      openLogDirectory: vi.fn() as unknown as IpcApi['shell']['openLogDirectory'],
    },
    appConfig: {
      get: vi.fn().mockResolvedValue({ ok: false, error: { code: 'NOT_USED_IN_FE_TESTS', message: '' } }),
      set: vi.fn().mockResolvedValue({ ok: false, error: { code: 'NOT_USED_IN_FE_TESTS', message: '' } }),
    },

  };

  (window as { api?: IpcApi }).api = api;
  return { api, projectsGet, pullsList, shellOpenExternal };
}

const noop = (): void => {};

async function renderAndOpenPrsTab(stub: ApiStub): Promise<void> {
  render(
    <ProjectDetail
      projectId="p-1"
      onBack={noop}
      onNavigateToConnections={noop}
    />,
  );
  // Wait for the project to load + pulls to fetch.
  await waitFor(() => {
    expect(stub.projectsGet).toHaveBeenCalled();
  });
  await waitFor(() => {
    expect(stub.pullsList).toHaveBeenCalled();
  });
  // Switch to the PRs tab.
  const tab = await screen.findByRole('tab', { name: /Pull Requests/i });
  await act(async () => {
    fireEvent.click(tab);
  });
}

beforeEach(() => {
  (useActiveRuns as unknown as Mock).mockReturnValue([]);
});

afterEach(() => {
  cleanup();
  delete (window as { api?: IpcApi }).api;
  vi.restoreAllMocks();
  (useActiveRuns as unknown as Mock).mockReset();
});

describe('<ProjectDetail> PRs tab — #GH-67', () => {
  it('PRS-001: invokes pulls.list({ projectId }) on mount', async () => {
    const stub = installApi();
    render(<ProjectDetail projectId="p-1" onBack={noop} />);
    await waitFor(() => {
      expect(stub.pullsList).toHaveBeenCalledWith({ projectId: 'p-1' });
    });
  });

  it('PRS-002: renders empty state when pulls.list returns zero rows', async () => {
    const stub = installApi({ pullsResult: { ok: true, data: { rows: [] } } });
    await renderAndOpenPrsTab(stub);
    await waitFor(() => {
      expect(screen.getByTestId('tab-empty-prs')).toBeInTheDocument();
    });
  });

  it('PRS-003: renders DataTable rows when pulls.list returns rows', async () => {
    const rows: PullDto[] = [makePull(42, { title: 'Add PRs tab' }), makePull(41)];
    const stub = installApi({ pullsResult: { ok: true, data: { rows } } });
    await renderAndOpenPrsTab(stub);
    expect(await screen.findByText('Add PRs tab')).toBeInTheDocument();
    expect(screen.getByTestId('pulls-table')).toBeInTheDocument();
    expect(screen.getByTestId('pull-row-42')).toBeInTheDocument();
    expect(screen.getByTestId('pull-row-41')).toBeInTheDocument();
  });

  it('PRS-004: state badge variant is `success` for merged, `warning` for closed', async () => {
    const rows: PullDto[] = [
      makePull(50, { state: 'merged' }),
      makePull(51, { state: 'closed' }),
      makePull(52, { state: 'draft' }),
      makePull(53, { state: 'open' }),
    ];
    const stub = installApi({ pullsResult: { ok: true, data: { rows } } });
    await renderAndOpenPrsTab(stub);
    // Merged + closed are hidden by default — flip those chips on so the
    // badge-variant assertions below have rows to query.
    await act(async () => {
      fireEvent.click(screen.getByTestId('pulls-filter-merged'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('pulls-filter-closed'));
    });
    const badge50 = await screen.findByTestId('pull-state-50');
    const badge51 = await screen.findByTestId('pull-state-51');
    const badge52 = await screen.findByTestId('pull-state-52');
    const badge53 = await screen.findByTestId('pull-state-53');
    expect(badge50).toHaveAttribute('data-variant', 'success');
    expect(badge51).toHaveAttribute('data-variant', 'warning');
    expect(badge52).toHaveAttribute('data-variant', 'neutral');
    expect(badge53).toHaveAttribute('data-variant', 'info');
  });

  it('PRS-005: page-level Refresh button calls pulls.list again when PRs tab is active', async () => {
    const stub = installApi();
    await renderAndOpenPrsTab(stub);
    expect(stub.pullsList).toHaveBeenCalledTimes(1);
    // No more inline `pulls-refresh-button` after the GH-67 follow-up
    // refactor — the page-level Refresh in the header dispatches per-tab.
    expect(screen.queryByTestId('pulls-refresh-button')).not.toBeInTheDocument();
    const refresh = await screen.findByTestId('refresh-button');
    await act(async () => {
      fireEvent.click(refresh);
    });
    await waitFor(() => {
      expect(stub.pullsList).toHaveBeenCalledTimes(2);
    });
  });

  it('PRS-006: AUTH error → reconnect banner renders + Reconnect button calls onNavigateToConnections', async () => {
    const stub = installApi({
      pullsResult: { ok: false, error: { code: 'AUTH', message: 'Bad credentials' } },
    });
    const onNavigate = vi.fn();
    render(
      <ProjectDetail
        projectId="p-1"
        onBack={noop}
        onNavigateToConnections={onNavigate}
      />,
    );
    await waitFor(() => {
      expect(stub.pullsList).toHaveBeenCalled();
    });
    const tab = await screen.findByRole('tab', { name: /Pull Requests/i });
    await act(async () => {
      fireEvent.click(tab);
    });
    expect(await screen.findByTestId('pulls-auth-error-banner')).toBeInTheDocument();
    const reconnect = screen.getByTestId('pulls-reconnect-button');
    fireEvent.click(reconnect);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it('PRS-007: RATE_LIMITED error renders rate-limit banner with the message verbatim', async () => {
    const stub = installApi({
      pullsResult: {
        ok: false,
        error: {
          code: 'RATE_LIMITED',
          message: 'GitHub rate limit exceeded. Resets at 2026-05-12T11:00:00.000Z.',
        },
      },
    });
    await renderAndOpenPrsTab(stub);
    const banner = await screen.findByTestId('pulls-rate-limit-banner');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent('Resets at 2026-05-12T11:00:00.000Z');
  });

  it('PRS-008: clicking a row invokes shell.openExternal({ url })', async () => {
    const rows: PullDto[] = [makePull(99, { title: 'Click me' })];
    const stub = installApi({ pullsResult: { ok: true, data: { rows } } });
    await renderAndOpenPrsTab(stub);
    const row = await screen.findByTestId('pull-row-99');
    await act(async () => {
      fireEvent.click(row);
    });
    expect(stub.shellOpenExternal).toHaveBeenCalledWith({
      url: 'https://github.com/gazhang/alpha/pull/99',
    });
  });

  it('PRS-009: clicking the per-row Open button also calls shell.openExternal (and stops row-click bubbling)', async () => {
    const rows: PullDto[] = [makePull(7)];
    const stub = installApi({ pullsResult: { ok: true, data: { rows } } });
    await renderAndOpenPrsTab(stub);
    const openBtn = await screen.findByTestId('pull-open-7');
    await act(async () => {
      fireEvent.click(openBtn);
    });
    expect(stub.shellOpenExternal).toHaveBeenCalledTimes(1);
    expect(stub.shellOpenExternal).toHaveBeenCalledWith({
      url: 'https://github.com/gazhang/alpha/pull/7',
    });
  });

  it('PRS-010: review-state column renders an em-dash when reviewDecision is null', async () => {
    const rows: PullDto[] = [makePull(33, { reviewDecision: null })];
    const stub = installApi({ pullsResult: { ok: true, data: { rows } } });
    await renderAndOpenPrsTab(stub);
    // No badge testid for the null review decision; the cell renders "—".
    expect(screen.queryByTestId('pull-review-33')).not.toBeInTheDocument();
    const row = await screen.findByTestId('pull-row-33');
    expect(row).toHaveTextContent('—');
  });

  it('PRS-012: status filter defaults to open + draft, hiding merged + closed rows', async () => {
    const rows: PullDto[] = [
      makePull(60, { state: 'open' }),
      makePull(61, { state: 'draft' }),
      makePull(62, { state: 'merged' }),
      makePull(63, { state: 'closed' }),
    ];
    const stub = installApi({ pullsResult: { ok: true, data: { rows } } });
    await renderAndOpenPrsTab(stub);
    // open + draft visible by default
    expect(await screen.findByTestId('pull-row-60')).toBeInTheDocument();
    expect(screen.getByTestId('pull-row-61')).toBeInTheDocument();
    // merged + closed hidden
    expect(screen.queryByTestId('pull-row-62')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pull-row-63')).not.toBeInTheDocument();
    // Filter chips reflect default `aria-pressed`/`data-active` state
    expect(screen.getByTestId('pulls-filter-open')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('pulls-filter-draft')).toHaveAttribute('data-active', 'true');
    expect(screen.getByTestId('pulls-filter-merged')).toHaveAttribute('data-active', 'false');
    expect(screen.getByTestId('pulls-filter-closed')).toHaveAttribute('data-active', 'false');
    // Counts come from the full unfiltered rows (so users can see what's there)
    expect(screen.getByTestId('pulls-filter-merged')).toHaveTextContent('1');
    expect(screen.getByTestId('pulls-filter-closed')).toHaveTextContent('1');
  });

  it('PRS-013: clicking a filter chip toggles row visibility', async () => {
    const rows: PullDto[] = [
      makePull(70, { state: 'open' }),
      makePull(71, { state: 'merged' }),
    ];
    const stub = installApi({ pullsResult: { ok: true, data: { rows } } });
    await renderAndOpenPrsTab(stub);
    expect(screen.queryByTestId('pull-row-71')).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByTestId('pulls-filter-merged'));
    });
    expect(await screen.findByTestId('pull-row-71')).toBeInTheDocument();
    // Toggling open OFF removes the open row
    await act(async () => {
      fireEvent.click(screen.getByTestId('pulls-filter-open'));
    });
    expect(screen.queryByTestId('pull-row-70')).not.toBeInTheDocument();
    expect(screen.getByTestId('pull-row-71')).toBeInTheDocument();
  });

  it('PRS-014: filter-empty state shows when rows exist but none match the filter', async () => {
    const rows: PullDto[] = [
      makePull(80, { state: 'merged' }),
      makePull(81, { state: 'closed' }),
    ];
    const stub = installApi({ pullsResult: { ok: true, data: { rows } } });
    await renderAndOpenPrsTab(stub);
    // Default filter hides both merged + closed — distinct empty state, not
    // the "no PRs at all" empty state.
    expect(await screen.findByTestId('pulls-filter-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('tab-empty-prs')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pulls-table')).not.toBeInTheDocument();
  });

  it('PRS-015: page-level Refresh label follows the active tab; disabled on Settings', async () => {
    const stub = installApi({ pullsResult: { ok: true, data: { rows: [makePull(1)] } } });
    render(<ProjectDetail projectId="p-1" onBack={noop} onNavigateToConnections={noop} />);
    await waitFor(() => {
      expect(stub.projectsGet).toHaveBeenCalled();
    });
    // Default tab is Tickets.
    const refresh = await screen.findByTestId('refresh-button');
    expect(refresh).toHaveTextContent(/Refresh tickets/i);
    expect(refresh).not.toBeDisabled();
    // Switch to PRs.
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: /Pull Requests/i }));
    });
    expect(screen.getByTestId('refresh-button')).toHaveTextContent(/Refresh PRs/i);
    expect(screen.getByTestId('refresh-button')).not.toBeDisabled();
    // Switch to Settings → disabled.
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: /Settings/i }));
    });
    expect(screen.getByTestId('refresh-button')).toBeDisabled();
  });

  it('PRS-016: clicking page-level Refresh while on PRs tab swaps stale rows for skeleton', async () => {
    // Hold the second fetch's resolution so we can observe the in-flight state.
    let resolveSecond: (r: IpcResult<PullsListResponse>) => void = () => {};
    const stub = installApi({
      pullsResult: { ok: true, data: { rows: [makePull(42, { title: 'Stale PR' })] } },
    });
    // After first call, subsequent calls return the pending promise.
    (stub.pullsList as Mock).mockImplementationOnce(() =>
      Promise.resolve({ ok: true, data: { rows: [makePull(42, { title: 'Stale PR' })] } }),
    );
    (stub.pullsList as Mock).mockImplementationOnce(
      () =>
        new Promise((res) => {
          resolveSecond = res;
        }),
    );
    await renderAndOpenPrsTab(stub);
    expect(await screen.findByText('Stale PR')).toBeInTheDocument();
    // Trigger the refresh; the second pulls.list call hangs.
    await act(async () => {
      fireEvent.click(screen.getByTestId('refresh-button'));
    });
    // Stale row gone; skeleton rendering (table still mounted via testid).
    await waitFor(() => {
      expect(screen.queryByText('Stale PR')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('pulls-table')).toBeInTheDocument();
    // Resolve the in-flight fetch.
    await act(async () => {
      resolveSecond({ ok: true, data: { rows: [makePull(43, { title: 'Fresh PR' })] } });
    });
    expect(await screen.findByText('Fresh PR')).toBeInTheDocument();
  });

  it('PRS-011: non-GitHub repos show explanatory empty state, not the error banner', async () => {
    const stub = installApi();
    // Override projects.get to return a bitbucket-backed project.
    (stub.projectsGet as Mock).mockResolvedValue({
      ok: true,
      data: makeProject({
        repo: {
          type: 'bitbucket',
          localPath: '/tmp/p-1',
          baseBranch: 'main',
          connectionId: 'conn-bb-1',
          slug: 'gazhang/alpha',
        },
      }),
    });
    render(<ProjectDetail projectId="p-1" onBack={noop} />);
    await waitFor(() => {
      expect(stub.projectsGet).toHaveBeenCalled();
    });
    const tab = await screen.findByRole('tab', { name: /Pull Requests/i });
    await act(async () => {
      fireEvent.click(tab);
    });
    expect(await screen.findByTestId('pulls-non-github')).toBeInTheDocument();
    // The catch-all error banner must NOT render.
    expect(screen.queryByTestId('pulls-error-banner')).not.toBeInTheDocument();
  });
});
