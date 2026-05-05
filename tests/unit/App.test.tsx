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
 * APP-001..006 — Replaces FE-001/002/003 from issue #1.
 *
 * The new <App /> renders an AppShell + ProjectList by default. We stub
 * `window.api.projects.list` to return either an empty list (for steady-state
 * shell tests) or seed rows (for navigation tests).
 *
 * Strategy:
 *  - APP-001/002/006: empty-list mock so ProjectList renders (no rows).
 *    Sidebar and main both visible.
 *  - APP-003/004: populated-list mock — click `Open →` on a row, assert
 *    DetailPlaceholder text appears, then click Back, assert ProjectList
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
): IpcApi {
  const unusedErr = (): IpcResult<never> => ({
    ok: false,
    error: { code: 'NOT_USED_IN_FE_TESTS', message: '' },
  });
  return {
    ping: vi.fn<IpcApi['ping']>().mockResolvedValue(pingResponse),
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
    },
    tickets: {
      source: 'jira',
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

  it('APP-006: sidebar shows e-frank product name', async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId('sidebar')).toHaveTextContent(/e-frank/i);
    });
  });
});

describe('<App /> — APP-003/004 navigation', () => {
  beforeEach(() => {
    (window as { api?: IpcApi }).api = makeIpcApiStub(PING, {
      ok: true,
      data: [makeProject('p-1', 'Alpha'), makeProject('p-2', 'Beta')],
    });
  });

  it('APP-003: clicking row Open switches to detail placeholder', async () => {
    render(<App />);
    // Wait for projects to load + render
    const openBtn = await screen.findByTestId('project-open-p-1');
    fireEvent.click(openBtn);

    await waitFor(() => {
      // DetailPlaceholder text per spec: "Project detail view lands in #6"
      expect(screen.getByText(/project detail view/i)).toBeInTheDocument();
    });
  });

  it('APP-004: DetailPlaceholder Back button returns to list view', async () => {
    render(<App />);
    const openBtn = await screen.findByTestId('project-open-p-1');
    fireEvent.click(openBtn);

    const backBtn = await screen.findByTestId('detail-back');
    fireEvent.click(backBtn);

    await waitFor(() => {
      // Back to ProjectList
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
