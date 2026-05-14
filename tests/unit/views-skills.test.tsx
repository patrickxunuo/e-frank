// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { Skills } from '../../src/renderer/views/Skills';
import type {
  IpcApi,
  IpcResult,
  SkillSummary,
  SkillsFindExitEvent,
  SkillsFindOutputEvent,
  SkillsListResponse,
} from '../../src/shared/ipc';
import {
  __resetFindSkillCacheForTests,
  getFindSkillCache,
} from '../../src/renderer/state/find-skill-cache';

/**
 * VIEW-SKILLS-001..007 — <Skills /> view tests.
 *
 * The Skills view exposes the following testids per the GH-38 spec:
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
  findStart: ReturnType<typeof vi.fn>;
  findCancel: ReturnType<typeof vi.fn>;
  emitFindOutput: (e: SkillsFindOutputEvent) => void;
  emitFindExit: (e: SkillsFindExitEvent) => void;
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
  // Default findStart succeeds so the cache-flow tests can simulate
  // a completed search. Individual tests still pass — older tests
  // never invoked findStart, so the result shape doesn't matter to
  // them.
  const findStart = vi
    .fn()
    .mockResolvedValue({ ok: true, data: { findId: 'find-1', pid: undefined, startedAt: 0 } });
  const findCancel = vi.fn().mockResolvedValue({ ok: true, data: { findId: 'find-1' } });

  let capturedOutputListener: ((e: SkillsFindOutputEvent) => void) | null = null;
  let capturedExitListener: ((e: SkillsFindExitEvent) => void) | null = null;

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
      findStart,
      findCancel,
      onFindOutput: vi.fn((listener: (e: SkillsFindOutputEvent) => void) => {
        capturedOutputListener = listener;
        return () => {
          capturedOutputListener = null;
        };
      }),
      onFindExit: vi.fn((listener: (e: SkillsFindExitEvent) => void) => {
        capturedExitListener = listener;
        return () => {
          capturedExitListener = null;
        };
      }),
    } as unknown as IpcApi['skills'],
    shell: {
      openPath,
    } as unknown as IpcApi['shell'],
  } as IpcApi;

  (window as { api?: IpcApi }).api = api;

  const emitFindOutput = (e: SkillsFindOutputEvent): void => {
    if (capturedOutputListener) capturedOutputListener(e);
  };
  const emitFindExit = (e: SkillsFindExitEvent): void => {
    if (capturedExitListener) capturedExitListener(e);
  };

  return {
    api,
    list,
    openPath,
    install,
    remove,
    findStart,
    findCancel,
    emitFindOutput,
    emitFindExit,
  };
}

afterEach(() => {
  cleanup();
  delete (window as { api?: IpcApi }).api;
  __resetFindSkillCacheForTests();
  vi.restoreAllMocks();
});

describe('<Skills /> — VIEW-SKILLS', () => {
  // -------------------------------------------------------------------------
  // VIEW-SKILLS-001 — Heading + title
  // -------------------------------------------------------------------------
  it('VIEW-SKILLS-001: renders skills-page + skills-title', async () => {
    installApi({ listResult: { ok: true, data: { skills: [] } } });
    render(<Skills />);

    await waitFor(() => {
      expect(screen.getByTestId('skills-page')).toBeInTheDocument();
    });
    expect(screen.getByTestId('skills-title')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // VIEW-SKILLS-002 — Empty state visible when 0 skills
  // -------------------------------------------------------------------------
  it('VIEW-SKILLS-002: empty state visible when 0 skills, with skills-empty + skills-empty-cta', async () => {
    installApi({ listResult: { ok: true, data: { skills: [] } } });
    render(<Skills />);

    const empty = await screen.findByTestId('skills-empty');
    expect(empty).toBeInTheDocument();
    expect(screen.getByTestId('skills-empty-cta')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // VIEW-SKILLS-003 — Empty-state CTA opens Find dialog pre-filled
  // -------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  // VIEW-SKILLS-004 — Table renders rows when skills exist
  // -------------------------------------------------------------------------
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

    // No empty-state when populated.
    expect(screen.queryByTestId('skills-empty')).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // VIEW-SKILLS-005 — Open action calls shell.openPath
  // -------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  // VIEW-SKILLS-006 — Refresh button triggers a second list() call
  // -------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  // VIEW-SKILLS-007 — Error banner renders when list() fails
  // -------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  // VIEW-SKILLS-CACHE-001 — Dialog close + reopen within Skills page preserves results
  //
  // Bug 2 regression coverage from GH-63. The component-level test
  // (DIALOG-FIND-CACHE-001) covers the FindSkillDialog in isolation;
  // this one drives the cache flow through the actual Skills.tsx
  // parent so the close + reopen path matches what users actually do.
  // -------------------------------------------------------------------------
  async function runFindThroughSkillsParent(stub: ApiStub): Promise<void> {
    const findButton = await screen.findByTestId('skills-find-button');
    fireEvent.click(findButton);
    const input = await screen.findByTestId('find-skill-search');
    fireEvent.change(input, { target: { value: 'create jira ticket' } });
    fireEvent.click(screen.getByTestId('find-skill-submit'));
    await waitFor(() => {
      expect(stub.findStart).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect((window.api as IpcApi).skills.onFindOutput).toHaveBeenCalled();
    });
    act(() => {
      stub.emitFindOutput({
        findId: 'find-1',
        stream: 'stdout',
        line: JSON.stringify([
          {
            name: 'jira-ticket-creator',
            ref: 'someone/skills@jira-ticket-creator',
            description: 'Create structured Jira tickets',
            stars: 12,
          },
        ]),
        timestamp: 1,
      });
      stub.emitFindExit({
        findId: 'find-1',
        exitCode: 0,
        signal: null,
        durationMs: 1,
        reason: 'completed',
      });
    });
    // Cards should render in the parent.
    await screen.findByTestId('find-skill-card-someone/skills@jira-ticket-creator');
  }

  it('VIEW-SKILLS-CACHE-001: dialog close + reopen via Find Skill button preserves cached results', async () => {
    const stub = installApi({
      listResult: { ok: true, data: { skills: [userSkill] } },
    });
    render(<Skills />);
    await runFindThroughSkillsParent(stub);

    // Close via Esc — Dialog handles Esc by calling onClose.
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('find-skill-dialog')).not.toBeInTheDocument();
    });

    // Reopen via the Find Skill button. Same trigger path users use.
    fireEvent.click(screen.getByTestId('skills-find-button'));
    await screen.findByTestId('find-skill-dialog');

    // The cached card MUST still be there. No new findStart was
    // invoked — only one (the original).
    expect(
      screen.getByTestId('find-skill-card-someone/skills@jira-ticket-creator'),
    ).toBeInTheDocument();
    expect(stub.findStart).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // VIEW-SKILLS-CACHE-002 — Unmounting the Skills page clears the cache
  //
  // Bug 3 from GH-63. The user explicitly clarified that the cache
  // should be erased when leaving the Skills page (e.g. navigating to
  // a different view), so that returning later shows the empty hint
  // instead of stale results from an earlier visit.
  // -------------------------------------------------------------------------
  it('VIEW-SKILLS-CACHE-002: unmounting the Skills page wipes the find-skill cache', async () => {
    const stub = installApi({
      listResult: { ok: true, data: { skills: [userSkill] } },
    });
    const { unmount } = render(<Skills />);
    await runFindThroughSkillsParent(stub);

    // Cache populated.
    expect(getFindSkillCache().lines.length).toBeGreaterThan(0);

    // Navigation away simulated by unmounting the view.
    unmount();

    // Cache is wiped — re-mounting the page would show an empty
    // dialog. We don't re-mount here (cleanup at afterEach handles
    // it); we just assert the state directly.
    expect(getFindSkillCache().lines.length).toBe(0);
    expect(getFindSkillCache().query).toBe('');
  });

  // -------------------------------------------------------------------------
  // VIEW-SKILLS-CACHE-003 — Re-mounting the Skills page after unmount
  // shows an empty find dialog (no stale cards from the previous visit).
  // -------------------------------------------------------------------------
  it('VIEW-SKILLS-CACHE-003: after Skills unmount + re-mount, opening Find dialog shows empty state', async () => {
    const stub = installApi({
      listResult: { ok: true, data: { skills: [userSkill] } },
    });
    const { unmount } = render(<Skills />);
    await runFindThroughSkillsParent(stub);

    unmount();

    // Re-render (simulates navigating back to the Skills page).
    render(<Skills />);
    fireEvent.click(await screen.findByTestId('skills-find-button'));
    await screen.findByTestId('find-skill-dialog');

    // No cards — the cache was wiped on unmount. The empty-state
    // hint is what should show now per the GH-63 acceptance criterion
    // ("navigating back shows the empty hint, not stale results").
    expect(screen.queryByTestId('find-skill-candidates')).not.toBeInTheDocument();
    expect(screen.getByText(/Search asks Claude/)).toBeInTheDocument();
  });
});
