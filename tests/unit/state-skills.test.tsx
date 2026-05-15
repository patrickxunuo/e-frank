// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { useSkills, type RemoveSkillResult } from '../../src/renderer/state/skills';
import type {
  IpcApi,
  IpcResult,
  SkillSummary,
  SkillsListResponse,
  SkillsRemoveResponse,
} from '../../src/shared/ipc';
import {
  __resetNotificationsForTests,
  getToasts,
} from '../../src/renderer/state/notifications';

/**
 * HOOK-SKILLS-001..005 — `useSkills` hook tests.
 *
 * Mirrors `tests/unit/state-connections.test.tsx`:
 *  - Tiny <HookConsumer /> drives the hook and stashes the latest value.
 *  - window.api stub captures `skills.list` calls so the test can
 *    assert call count / order.
 *  - For HOOK-SKILLS-005 we delete `window.api` before render and assert the
 *    hook resolves to { loading: false, error: 'IPC bridge unavailable' }
 *    rather than throwing.
 */

declare global {
  interface Window {
    api?: IpcApi;
  }
}

interface UseSkillsResult {
  skills: SkillSummary[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  remove: (ref: string, displayName?: string) => Promise<RemoveSkillResult>;
}

interface CapturedHook {
  latest: UseSkillsResult | null;
  history: UseSkillsResult[];
}

function HookConsumer({
  capture,
}: {
  capture: CapturedHook;
}): null {
  const value = useSkills();
  useEffect(() => {
    capture.latest = value;
    capture.history.push(value);
  }, [value, capture]);
  return null;
}

interface ApiStub {
  api: IpcApi;
  skillsList: Mock;
  skillsRemove: Mock;
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

function installApi(opts?: {
  listResult?: IpcResult<SkillsListResponse>;
  removeResult?: IpcResult<SkillsRemoveResponse>;
}): ApiStub {
  const unusedErr = (): IpcResult<never> => ({
    ok: false,
    error: { code: 'NOT_USED_IN_FE_TESTS', message: '' },
  });
  const skillsList = vi
    .fn()
    .mockResolvedValue(opts?.listResult ?? { ok: true, data: { skills: [] } });
  const skillsRemove = vi.fn().mockResolvedValue(
    opts?.removeResult ?? {
      ok: true,
      data: { status: 'installed', stdout: '', stderr: '', exitCode: 0 },
    },
  );

  // Build a minimal IpcApi where only `skills` is used. Other namespaces are
  // filled with throw-style stubs so accidental access surfaces as a typed
  // test failure rather than a silent pass.
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
      list: vi.fn<IpcApi['projects']['list']>().mockResolvedValue(unusedErr()),
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
      testConnection: vi.fn<IpcApi['jira']['testConnection']>().mockResolvedValue(unusedErr()),
      refreshPollers: vi.fn<IpcApi['jira']['refreshPollers']>().mockResolvedValue(unusedErr()),
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
      list: skillsList,
      install: vi.fn().mockResolvedValue(unusedErr()),
      remove: skillsRemove,
      search: vi.fn().mockResolvedValue(unusedErr()),
    } as unknown as IpcApi['skills'],
    shell: {
      openPath: vi.fn().mockResolvedValue({ ok: true, data: null }),
      openExternal: vi.fn().mockResolvedValue({ ok: true, data: null }),
      openLogDirectory: vi.fn().mockResolvedValue({ ok: true, data: null }),
    } as unknown as IpcApi['shell'],
    appConfig: {
      get: vi.fn().mockResolvedValue({ ok: false, error: { code: 'NOT_USED_IN_FE_TESTS', message: '' } }),
      set: vi.fn().mockResolvedValue({ ok: false, error: { code: 'NOT_USED_IN_FE_TESTS', message: '' } }),
    },

  } as IpcApi;

  (window as { api?: IpcApi }).api = api;
  return { api, skillsList, skillsRemove };
}

afterEach(() => {
  cleanup();
  delete (window as { api?: IpcApi }).api;
  __resetNotificationsForTests();
  vi.restoreAllMocks();
});

describe('useSkills — HOOK-SKILLS', () => {
  // -------------------------------------------------------------------------
  // HOOK-SKILLS-001 — Returns loading: true on initial render
  // -------------------------------------------------------------------------
  it('HOOK-SKILLS-001: returns loading: true initially', async () => {
    installApi({ listResult: { ok: true, data: { skills: [] } } });
    const cap: CapturedHook = { latest: null, history: [] };

    render(<HookConsumer capture={cap} />);

    // The very first captured value should reflect the initial mount —
    // before `list()` resolves — and therefore loading: true.
    expect(cap.history[0]?.loading).toBe(true);
    expect(cap.history[0]?.skills).toEqual([]);
    expect(cap.history[0]?.error).toBeNull();
  });

  // -------------------------------------------------------------------------
  // HOOK-SKILLS-002 — Populates skills from a successful list response
  // -------------------------------------------------------------------------
  it('HOOK-SKILLS-002: populates skills array from window.api.skills.list() ok response', async () => {
    installApi({
      listResult: { ok: true, data: { skills: [userSkill, projectSkill] } },
    });
    const cap: CapturedHook = { latest: null, history: [] };

    render(<HookConsumer capture={cap} />);

    await waitFor(() => {
      expect(cap.latest?.loading).toBe(false);
    });
    expect(cap.latest?.skills).toHaveLength(2);
    expect(cap.latest?.skills.map((s) => s.id)).toEqual([
      'ef-feature',
      'frontend-design',
    ]);
    expect(cap.latest?.error).toBeNull();
  });

  // -------------------------------------------------------------------------
  // HOOK-SKILLS-003 — Surfaces error when list() returns ok: false
  // -------------------------------------------------------------------------
  it('HOOK-SKILLS-003: sets error when list() returns ok: false', async () => {
    installApi({
      listResult: {
        ok: false,
        error: { code: 'SCAN_FAILED', message: 'scan failed' },
      },
    });
    const cap: CapturedHook = { latest: null, history: [] };

    render(<HookConsumer capture={cap} />);

    await waitFor(() => {
      expect(cap.latest?.loading).toBe(false);
    });
    expect(cap.latest?.error).not.toBeNull();
    // The hook may surface either the message or the code.
    expect(cap.latest?.error).toMatch(/scan failed|SCAN_FAILED/);
    expect(cap.latest?.skills).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // HOOK-SKILLS-004 — refresh() re-calls list() and updates state
  // -------------------------------------------------------------------------
  it('HOOK-SKILLS-004: refresh() re-invokes list() and updates state', async () => {
    const stub = installApi({
      listResult: { ok: true, data: { skills: [userSkill] } },
    });
    const cap: CapturedHook = { latest: null, history: [] };

    render(<HookConsumer capture={cap} />);

    await waitFor(() => {
      expect(stub.skillsList).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(cap.latest?.skills).toHaveLength(1);
    });

    // Update the mock so the refresh sees a different result, then call it.
    stub.skillsList.mockResolvedValueOnce({
      ok: true,
      data: { skills: [userSkill, projectSkill] },
    });
    await act(async () => {
      await cap.latest?.refresh();
    });

    await waitFor(() => {
      expect(stub.skillsList).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(cap.latest?.skills).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // HOOK-SKILLS-005 — window.api === undefined → error 'IPC bridge unavailable'
  // -------------------------------------------------------------------------
  it("HOOK-SKILLS-005: sets error 'IPC bridge unavailable' when window.api is missing", async () => {
    delete (window as { api?: IpcApi }).api;
    const cap: CapturedHook = { latest: null, history: [] };

    expect(() => {
      render(<HookConsumer capture={cap} />);
    }).not.toThrow();

    await waitFor(() => {
      expect(cap.latest?.loading).toBe(false);
    });
    expect(cap.latest?.error).toBe('IPC bridge unavailable');
    expect(cap.latest?.skills).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // HOOK-SKILLS-REMOVE-TOAST — Successful remove dispatches a success toast
  // -------------------------------------------------------------------------
  it('HOOK-SKILLS-REMOVE-TOAST-001: successful remove dispatches `Removed <name>` toast', async () => {
    const stub = installApi();
    const cap: CapturedHook = { latest: null, history: [] };
    render(<HookConsumer capture={cap} />);
    await waitFor(() => {
      expect(cap.latest?.loading).toBe(false);
    });
    expect(getToasts()).toEqual([]);

    const resultBox: { current: RemoveSkillResult | null } = { current: null };
    await act(async () => {
      resultBox.current = (await cap.latest?.remove('ef-feature', 'ef-feature')) ?? null;
    });
    expect(resultBox.current?.ok).toBe(true);
    const toasts = getToasts();
    expect(toasts.length).toBe(1);
    expect(toasts[0]?.type).toBe('success');
    expect(toasts[0]?.title).toBe('Removed ef-feature');
    expect(stub.skillsRemove).toHaveBeenCalledTimes(1);
  });

  it('HOOK-SKILLS-REMOVE-TOAST-002: IPC-error remove does NOT dispatch a toast', async () => {
    installApi({
      removeResult: {
        ok: false,
        error: { code: 'NPM_FAILED', message: 'package not found' },
      },
    });
    const cap: CapturedHook = { latest: null, history: [] };
    render(<HookConsumer capture={cap} />);
    await waitFor(() => {
      expect(cap.latest?.loading).toBe(false);
    });

    const resultBox: { current: RemoveSkillResult | null } = { current: null };
    await act(async () => {
      resultBox.current = (await cap.latest?.remove('nope', 'nope')) ?? null;
    });
    expect(resultBox.current?.ok).toBe(false);
    expect(getToasts()).toEqual([]);
  });

  it('HOOK-SKILLS-REMOVE-TOAST-003: status:failed remove does NOT dispatch a toast', async () => {
    installApi({
      removeResult: {
        ok: true,
        data: { status: 'failed', stdout: '', stderr: 'ENOENT', exitCode: 1 },
      },
    });
    const cap: CapturedHook = { latest: null, history: [] };
    render(<HookConsumer capture={cap} />);
    await waitFor(() => {
      expect(cap.latest?.loading).toBe(false);
    });

    const resultBox: { current: RemoveSkillResult | null } = { current: null };
    await act(async () => {
      resultBox.current = (await cap.latest?.remove('ef-feature')) ?? null;
    });
    expect(resultBox.current?.ok).toBe(false);
    expect(getToasts()).toEqual([]);
  });
});
