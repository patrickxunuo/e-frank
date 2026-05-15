// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Skills } from '../../src/renderer/views/Skills';
import type {
  IpcApi,
  IpcResult,
  SkillSummary,
  SkillsListResponse,
} from '../../src/shared/ipc';

/**
 * VIEW-SKILLS-001..007 — <Skills /> view tests.
 *
 * The Skills view exposes the following testids:
 *   skills-page             — root container
 *   skills-title            — page heading
 *   skills-refresh          — Refresh ghost button
 *   skills-find-button      — primary "Find Skill" button
 *   skills-loading          — skeleton state (only when loading & list empty)
 *   skills-empty            — empty-state card (only when count===0)
 *   skills-empty-cta        — empty-state "Find Skill" CTA
 *   skills-error            — error banner
 *   skills-retry            — error-banner retry button
 *   skills-table            — DataTable wrapper
 *   skill-row-{id}          — one row per skill
 *   skill-row-{id}-open     — row "Open" action button
 *
 * The earlier VIEW-SKILLS-CACHE-001..003 tests covered the FindSkillDialog
 * streaming-result cache (find-skill-cache.ts), which was removed in
 * GH-93 alongside the Claude-subprocess pipeline — the new skills.sh
 * direct-search dialog is stateless across reopen, so those cache tests
 * no longer have a behavior to assert.
 */

declare global {
  interface Window {
    api?: IpcApi;
  }
}

const userSkill: SkillSummary = {
  id: 'ef-feature',
  name: 'ef-feature',
  description: 'Human-paced ticket-to-PR workflow',
  source: 'user',
  dirPath: 'C:\\Users\\me\\.claude\\skills\\ef-feature',
  skillMdPath: 'C:\\Users\\me\\.claude\\skills\\ef-feature\\SKILL.md',
};

const projectSkill: SkillSummary = {
  id: 'frontend-design',
  name: 'frontend-design',
  description: 'Create distinctive, production-grade frontend interfaces',
  source: 'project',
  dirPath: 'D:\\e-frank\\.claude\\skills\\frontend-design',
  skillMdPath: 'D:\\e-frank\\.claude\\skills\\frontend-design\\SKILL.md',
};

interface ApiStub {
  api: IpcApi;
  list: ReturnType<typeof vi.fn>;
  openPath: ReturnType<typeof vi.fn>;
  install: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
}

function installApi(opts?: {
  listResult?: IpcResult<SkillsListResponse>;
}): ApiStub {
  const unusedErr = (): IpcResult<never> => ({
    ok: false,
    error: { code: 'NOT_USED_IN_FE_TESTS', message: '' },
  });

  const list = vi
    .fn()
    .mockResolvedValue(opts?.listResult ?? { ok: true, data: { skills: [] } });
  const openPath = vi.fn().mockResolvedValue({ ok: true, data: null });
  const install = vi.fn().mockResolvedValue(unusedErr());
  const remove = vi.fn().mockResolvedValue(unusedErr());
  const search = vi
    .fn()
    .mockResolvedValue({ ok: true, data: { skills: [], count: 0 } });

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
      list,
      install,
      remove,
      search,
    } as unknown as IpcApi['skills'],
    shell: {
      openPath,
    } as unknown as IpcApi['shell'],
    appConfig: {
      get: vi.fn().mockResolvedValue({ ok: false, error: { code: 'NOT_USED_IN_FE_TESTS', message: '' } }),
      set: vi.fn().mockResolvedValue({ ok: false, error: { code: 'NOT_USED_IN_FE_TESTS', message: '' } }),
    },

  } as IpcApi;

  (window as { api?: IpcApi }).api = api;

  return {
    api,
    list,
    openPath,
    install,
    remove,
    search,
  };
}

afterEach(() => {
  cleanup();
  delete (window as { api?: IpcApi }).api;
  vi.restoreAllMocks();
});

describe('<Skills /> — VIEW-SKILLS', () => {
  it('VIEW-SKILLS-001: renders skills-page + skills-title', async () => {
    installApi({ listResult: { ok: true, data: { skills: [] } } });
    render(<Skills />);

    await waitFor(() => {
      expect(screen.getByTestId('skills-page')).toBeInTheDocument();
    });
    expect(screen.getByTestId('skills-title')).toBeInTheDocument();
  });

  it('VIEW-SKILLS-002: empty state visible when 0 skills, with skills-empty + skills-empty-cta', async () => {
    installApi({ listResult: { ok: true, data: { skills: [] } } });
    render(<Skills />);

    const empty = await screen.findByTestId('skills-empty');
    expect(empty).toBeInTheDocument();
    expect(screen.getByTestId('skills-empty-cta')).toBeInTheDocument();
  });

  it("VIEW-SKILLS-003: clicking empty-state CTA opens the Find dialog pre-filled with 'ef-feature'", async () => {
    installApi({ listResult: { ok: true, data: { skills: [] } } });
    render(<Skills />);

    const cta = await screen.findByTestId('skills-empty-cta');
    fireEvent.click(cta);

    await waitFor(() => {
      expect(screen.getByTestId('find-skill-dialog')).toBeInTheDocument();
    });
    const input = screen.getByTestId('find-skill-search') as HTMLInputElement;
    expect(input.value).toBe('ef-feature');
  });

  it('VIEW-SKILLS-004: table renders rows when skills exist with name + description + source badge', async () => {
    installApi({
      listResult: { ok: true, data: { skills: [userSkill, projectSkill] } },
    });
    render(<Skills />);

    await waitFor(() => {
      expect(screen.getByTestId('skill-row-ef-feature')).toBeInTheDocument();
    });
    const userRow = screen.getByTestId('skill-row-ef-feature');
    expect(within(userRow).getByText('ef-feature')).toBeInTheDocument();
    expect(
      within(userRow).getByText(/Human-paced ticket-to-PR workflow/),
    ).toBeInTheDocument();
    expect(within(userRow).getByText('User')).toBeInTheDocument();

    const projRow = screen.getByTestId('skill-row-frontend-design');
    expect(within(projRow).getByText('frontend-design')).toBeInTheDocument();
    expect(
      within(projRow).getByText(/Create distinctive, production-grade/),
    ).toBeInTheDocument();
    expect(within(projRow).getByText('Project')).toBeInTheDocument();

    expect(screen.queryByTestId('skills-empty')).not.toBeInTheDocument();
  });

  it('VIEW-SKILLS-005: clicking skill-row-{id}-open calls window.api.shell.openPath with dirPath', async () => {
    const stub = installApi({
      listResult: { ok: true, data: { skills: [userSkill] } },
    });
    render(<Skills />);

    const openBtn = await screen.findByTestId('skill-row-ef-feature-open');
    fireEvent.click(openBtn);

    await waitFor(() => {
      expect(stub.openPath).toHaveBeenCalledTimes(1);
    });
    const call = stub.openPath.mock.calls[0]?.[0] as { path?: string };
    expect(call?.path).toBe(userSkill.dirPath);
  });

  it('VIEW-SKILLS-006: clicking skills-refresh triggers a second skills.list() call', async () => {
    const stub = installApi({
      listResult: { ok: true, data: { skills: [userSkill] } },
    });
    render(<Skills />);

    await waitFor(() => {
      expect(stub.list).toHaveBeenCalledTimes(1);
    });

    const refreshBtn = screen.getByTestId('skills-refresh');
    fireEvent.click(refreshBtn);

    await waitFor(() => {
      expect(stub.list).toHaveBeenCalledTimes(2);
    });
  });

  it('VIEW-SKILLS-007: error banner with skills-error renders when list fails', async () => {
    installApi({
      listResult: {
        ok: false,
        error: { code: 'SCAN_FAILED', message: 'permission denied' },
      },
    });
    render(<Skills />);

    const banner = await screen.findByTestId('skills-error');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent(/permission denied|SCAN_FAILED/);
  });
});
