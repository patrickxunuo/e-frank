// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import {
  useConnectionRepos,
  useConnectionJiraProjects,
  __resetConnectionResourceCaches,
  type RepoSummary,
  type JiraProjectSummary,
} from '../../src/renderer/state/connection-resources';
import type { IpcApi, IpcResult } from '../../src/shared/ipc';

/**
 * CONN-RES-HOOK-001..007 — `useConnectionRepos` / `useConnectionJiraProjects`
 *
 * Mirrors `state-connections.test.tsx`. A tiny <HookConsumer /> drives the
 * hook with a given `connectionId` and stashes the latest result into a
 * capture object so tests can assert on it.
 *
 * Per-session cache: the hook keeps a Map keyed by `connectionId` shared
 * across hook instances. CONN-RES-HOOK-005 mounts a second instance with
 * the SAME id and asserts the IPC mock isn't called a second time.
 */

declare global {
  interface Window {
    api?: IpcApi;
  }
}

interface HookResult<T> {
  data: ReadonlyArray<T>;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

interface CapturedHook<T> {
  latest: HookResult<T> | null;
  history: HookResult<T>[];
}

function ReposConsumer({
  connectionId,
  capture,
}: {
  connectionId: string | null;
  capture: CapturedHook<RepoSummary>;
}): null {
  const value = useConnectionRepos(connectionId);
  useEffect(() => {
    capture.latest = value;
    capture.history.push(value);
  }, [value, capture]);
  return null;
}

function JiraProjectsConsumer({
  connectionId,
  capture,
}: {
  connectionId: string | null;
  capture: CapturedHook<JiraProjectSummary>;
}): null {
  const value = useConnectionJiraProjects(connectionId);
  useEffect(() => {
    capture.latest = value;
    capture.history.push(value);
  }, [value, capture]);
  return null;
}

interface ApiStub {
  api: IpcApi;
  listRepos: Mock;
  listJiraProjects: Mock;
}

function installApi(opts?: {
  listReposResult?: IpcResult<{
    repos: Array<{ slug: string; defaultBranch: string; private: boolean }>;
  }>;
  listJiraProjectsResult?: IpcResult<{
    projects: Array<{ key: string; name: string }>;
  }>;
}): ApiStub {
  const unusedErr = (): IpcResult<never> => ({
    ok: false,
    error: { code: 'NOT_USED_IN_FE_TESTS', message: '' },
  });

  const listRepos = vi.fn().mockResolvedValue(
    opts?.listReposResult ?? {
      ok: true,
      data: {
        repos: [
          { slug: 'gazhang/frontend-app', defaultBranch: 'main', private: true },
          { slug: 'gazhang/backend-svc', defaultBranch: 'main', private: false },
        ],
      },
    },
  );
  const listJiraProjects = vi.fn().mockResolvedValue(
    opts?.listJiraProjectsResult ?? {
      ok: true,
      data: {
        projects: [
          { key: 'PROJ', name: 'Project' },
          { key: 'OPS', name: 'Ops' },
        ],
      },
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
      list: vi.fn<IpcApi['projects']['list']>().mockResolvedValue({ ok: true, data: [] }),
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
    connections: {
      list: vi.fn().mockResolvedValue({ ok: true, data: [] }),
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
  return { api, listRepos, listJiraProjects };
}

afterEach(() => {
  cleanup();
  delete (window as { api?: IpcApi }).api;
  vi.restoreAllMocks();
  // The hook's per-session cache is module-level; reset between tests so a
  // pre-existing entry doesn't short-circuit a fetch we want to observe.
  __resetConnectionResourceCaches();
});

describe('useConnectionRepos / useConnectionJiraProjects — CONN-RES-HOOK', () => {
  // -------------------------------------------------------------------------
  // CONN-RES-HOOK-001 — null id → idle, no IPC call
  // -------------------------------------------------------------------------
  it('CONN-RES-HOOK-001: connectionId === null → idle (no IPC call), data empty', async () => {
    const stub = installApi();
    const cap: CapturedHook<RepoSummary> = { latest: null, history: [] };

    render(<ReposConsumer connectionId={null} capture={cap} />);

    // Settle microtasks. Loading must be false (idle), data empty, no call.
    await waitFor(() => {
      expect(cap.latest).not.toBeNull();
    });
    expect(cap.latest?.loading).toBe(false);
    expect(cap.latest?.data).toEqual([]);
    expect(cap.latest?.error).toBeNull();
    expect(stub.listRepos).not.toHaveBeenCalled();
  });

  it('CONN-RES-HOOK-001 (jira variant): connectionId === null → idle', async () => {
    const stub = installApi();
    const cap: CapturedHook<JiraProjectSummary> = { latest: null, history: [] };

    render(<JiraProjectsConsumer connectionId={null} capture={cap} />);

    await waitFor(() => {
      expect(cap.latest).not.toBeNull();
    });
    expect(cap.latest?.loading).toBe(false);
    expect(cap.latest?.data).toEqual([]);
    expect(stub.listJiraProjects).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // CONN-RES-HOOK-002 — connectionId set → triggers the IPC
  // -------------------------------------------------------------------------
  it('CONN-RES-HOOK-002: connectionId set → useConnectionRepos calls listRepos with that id', async () => {
    const stub = installApi();
    const cap: CapturedHook<RepoSummary> = { latest: null, history: [] };

    render(<ReposConsumer connectionId="conn-gh-1" capture={cap} />);

    await waitFor(() => {
      expect(stub.listRepos).toHaveBeenCalledTimes(1);
    });
    const callArg = stub.listRepos.mock.calls[0]?.[0];
    expect(callArg).toEqual({ connectionId: 'conn-gh-1' });
  });

  it('CONN-RES-HOOK-002 (jira variant): connectionId set → useConnectionJiraProjects calls listJiraProjects', async () => {
    const stub = installApi();
    const cap: CapturedHook<JiraProjectSummary> = { latest: null, history: [] };

    render(<JiraProjectsConsumer connectionId="conn-jr-1" capture={cap} />);

    await waitFor(() => {
      expect(stub.listJiraProjects).toHaveBeenCalledTimes(1);
    });
    const callArg = stub.listJiraProjects.mock.calls[0]?.[0];
    expect(callArg).toEqual({ connectionId: 'conn-jr-1' });
  });

  // -------------------------------------------------------------------------
  // CONN-RES-HOOK-003 — Returns the data on success
  // -------------------------------------------------------------------------
  it('CONN-RES-HOOK-003: useConnectionRepos returns the repos array on success', async () => {
    installApi();
    const cap: CapturedHook<RepoSummary> = { latest: null, history: [] };

    render(<ReposConsumer connectionId="conn-gh-1" capture={cap} />);

    await waitFor(() => {
      expect(cap.latest?.loading).toBe(false);
    });
    expect(cap.latest?.data).toHaveLength(2);
    expect(cap.latest?.data.map((r) => r.slug)).toEqual([
      'gazhang/frontend-app',
      'gazhang/backend-svc',
    ]);
    expect(cap.latest?.error).toBeNull();
  });

  it('CONN-RES-HOOK-003 (jira variant): returns the projects array on success', async () => {
    installApi();
    const cap: CapturedHook<JiraProjectSummary> = { latest: null, history: [] };

    render(<JiraProjectsConsumer connectionId="conn-jr-1" capture={cap} />);

    await waitFor(() => {
      expect(cap.latest?.loading).toBe(false);
    });
    expect(cap.latest?.data).toHaveLength(2);
    expect(cap.latest?.data.map((p) => p.key)).toEqual(['PROJ', 'OPS']);
  });

  // -------------------------------------------------------------------------
  // CONN-RES-HOOK-004 — Surfaces error message on failure
  // -------------------------------------------------------------------------
  it('CONN-RES-HOOK-004: useConnectionRepos surfaces an error message when listRepos returns ok:false', async () => {
    installApi({
      listReposResult: {
        ok: false,
        error: { code: 'AUTH', message: 'unauthorized' },
      },
    });
    const cap: CapturedHook<RepoSummary> = { latest: null, history: [] };

    render(<ReposConsumer connectionId="conn-gh-1" capture={cap} />);

    await waitFor(() => {
      expect(cap.latest?.loading).toBe(false);
    });
    expect(cap.latest?.error).not.toBeNull();
    expect(cap.latest?.error).toMatch(/unauthorized|AUTH/);
    expect(cap.latest?.data).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // CONN-RES-HOOK-005 — Per-session cache keyed by connectionId
  // -------------------------------------------------------------------------
  it('CONN-RES-HOOK-005: a second hook with the same id renders cached data and does NOT re-fetch', async () => {
    const stub = installApi();
    const capA: CapturedHook<RepoSummary> = { latest: null, history: [] };
    const capB: CapturedHook<RepoSummary> = { latest: null, history: [] };

    // Mount the first consumer — populates the cache.
    const a = render(<ReposConsumer connectionId="conn-gh-1" capture={capA} />);
    await waitFor(() => {
      expect(stub.listRepos).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(capA.latest?.loading).toBe(false);
    });
    a.unmount();

    // Mount a second consumer with the same id. The cache MUST short-circuit
    // the IPC call.
    render(<ReposConsumer connectionId="conn-gh-1" capture={capB} />);
    // Give effects a chance to run.
    await waitFor(() => {
      expect(capB.latest).not.toBeNull();
    });
    // Confirm the data is present immediately from cache.
    await waitFor(() => {
      expect(capB.latest?.data).toHaveLength(2);
    });
    // And the IPC mock was NOT called a second time.
    expect(stub.listRepos).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // CONN-RES-HOOK-006 — refresh() clears the cache and re-fetches
  // -------------------------------------------------------------------------
  it('CONN-RES-HOOK-006: refresh() clears the cache entry and re-calls listRepos', async () => {
    const stub = installApi();
    const cap: CapturedHook<RepoSummary> = { latest: null, history: [] };

    render(<ReposConsumer connectionId="conn-gh-1" capture={cap} />);

    await waitFor(() => {
      expect(stub.listRepos).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(cap.latest?.loading).toBe(false);
    });

    // Update the mock response so the refresh observably differs.
    stub.listRepos.mockResolvedValueOnce({
      ok: true,
      data: {
        repos: [
          { slug: 'gazhang/refreshed', defaultBranch: 'main', private: false },
        ],
      },
    });

    await act(async () => {
      await cap.latest?.refresh();
    });

    await waitFor(() => {
      expect(stub.listRepos).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(cap.latest?.data).toHaveLength(1);
    });
    expect(cap.latest?.data[0]?.slug).toBe('gazhang/refreshed');
  });

  // -------------------------------------------------------------------------
  // CONN-RES-HOOK-007 — window.api === undefined → loading false, error set
  // -------------------------------------------------------------------------
  it('CONN-RES-HOOK-007: window.api === undefined → loading false + error set, no throw', async () => {
    delete (window as { api?: IpcApi }).api;
    const cap: CapturedHook<RepoSummary> = { latest: null, history: [] };

    expect(() => {
      render(<ReposConsumer connectionId="conn-gh-1" capture={cap} />);
    }).not.toThrow();

    await waitFor(() => {
      expect(cap.latest?.loading).toBe(false);
    });
    expect(cap.latest?.error).not.toBeNull();
    expect(cap.latest?.data).toEqual([]);
  });
});
