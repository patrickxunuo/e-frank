// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { useConnections } from '../../src/renderer/state/connections';
import type { IpcApi, IpcResult } from '../../src/shared/ipc';
import type { Connection } from '../../src/shared/schema/connection';

/**
 * CONN-HOOK-001..005 — `useConnections` hook tests.
 *
 * Mirrors `tests/unit/state-active-run.test.tsx`:
 *  - Tiny <HookConsumer /> drives the hook and stashes the latest value.
 *  - window.api stub captures `connections.list` calls so the test can
 *    assert call count / order.
 *  - For CONN-HOOK-005 we delete `window.api` before render and assert the
 *    hook resolves to { loading: false, error: <something> } rather than
 *    throwing.
 */

declare global {
  interface Window {
    api?: IpcApi;
  }
}

interface UseConnectionsResult {
  connections: Connection[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

interface CapturedHook {
  latest: UseConnectionsResult | null;
  history: UseConnectionsResult[];
}

function HookConsumer({
  capture,
}: {
  capture: CapturedHook;
}): null {
  const value = useConnections();
  useEffect(() => {
    capture.latest = value;
    capture.history.push(value);
  }, [value, capture]);
  return null;
}

interface ApiStub {
  api: IpcApi;
  connectionsList: Mock;
}

const githubConn: Connection = {
  id: 'conn-gh-1',
  provider: 'github',
  label: 'Personal',
  host: 'https://api.github.com',
  authMethod: 'pat',
  secretRef: 'connection:conn-gh-1:token',
  accountIdentity: { kind: 'github', login: 'gazhang', scopes: ['repo', 'read:user'] },
  lastVerifiedAt: 1700000000000,
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
};

const jiraConn: Connection = {
  id: 'conn-jr-1',
  provider: 'jira',
  label: 'emonster',
  host: 'https://emonster.atlassian.net',
  authMethod: 'api-token',
  secretRef: 'connection:conn-jr-1:token',
  accountIdentity: {
    kind: 'jira',
    accountId: '5f1...',
    displayName: 'Gary Zhang',
    emailAddress: 'gazhang@emonster.tech',
  },
  lastVerifiedAt: 1700000000000,
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
};

function installApi(opts?: {
  listResult?: IpcResult<Connection[]>;
}): ApiStub {
  const unusedErr = (): IpcResult<never> => ({
    ok: false,
    error: { code: 'NOT_USED_IN_FE_TESTS', message: '' },
  });
  const connectionsList = vi
    .fn()
    .mockResolvedValue(opts?.listResult ?? { ok: true, data: [] });

  // Build a minimal IpcApi where only `connections` is used. Other
  // namespaces are filled with throw-style stubs so accidental access
  // surfaces as a typed test failure rather than a silent pass.
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
    // The connections namespace is the actual focus of these tests. We use
    // a structural cast — the unit-tested production code only ever reads
    // `list`, but we expose stubs for the other methods so any code path
    // that reaches into the namespace doesn't crash.
    connections: {
      list: connectionsList,
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
      list: vi.fn().mockResolvedValue(unusedErr()),
      install: vi.fn().mockResolvedValue(unusedErr()),
      findStart: vi.fn().mockResolvedValue(unusedErr()),
      findCancel: vi.fn().mockResolvedValue(unusedErr()),
      onFindOutput: vi.fn(() => () => {}),
      onFindExit: vi.fn(() => () => {}),
    } as unknown as IpcApi['skills'],
    shell: {
      openPath: vi.fn().mockResolvedValue({ ok: true, data: null }),
    } as unknown as IpcApi['shell'],
    appConfig: {
      get: vi.fn().mockResolvedValue({ ok: false, error: { code: 'NOT_USED_IN_FE_TESTS', message: '' } }),
      set: vi.fn().mockResolvedValue({ ok: false, error: { code: 'NOT_USED_IN_FE_TESTS', message: '' } }),
    },

  } as IpcApi;

  (window as { api?: IpcApi }).api = api;
  return { api, connectionsList };
}

afterEach(() => {
  cleanup();
  delete (window as { api?: IpcApi }).api;
  vi.restoreAllMocks();
});

describe('useConnections — CONN-HOOK', () => {
  // -------------------------------------------------------------------------
  // CONN-HOOK-001 — On mount, calls connections.list()
  // -------------------------------------------------------------------------
  it('CONN-HOOK-001: on mount, calls window.api.connections.list() exactly once', async () => {
    const stub = installApi({ listResult: { ok: true, data: [] } });
    const cap: CapturedHook = { latest: null, history: [] };

    render(<HookConsumer capture={cap} />);

    await waitFor(() => {
      expect(stub.connectionsList).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // CONN-HOOK-002 — Returns connections array on success
  // -------------------------------------------------------------------------
  it('CONN-HOOK-002: returns the connections array on success', async () => {
    installApi({ listResult: { ok: true, data: [githubConn, jiraConn] } });
    const cap: CapturedHook = { latest: null, history: [] };

    render(<HookConsumer capture={cap} />);

    await waitFor(() => {
      expect(cap.latest?.loading).toBe(false);
    });
    expect(cap.latest?.connections).toHaveLength(2);
    expect(cap.latest?.connections.map((c) => c.id)).toEqual(['conn-gh-1', 'conn-jr-1']);
    expect(cap.latest?.error).toBeNull();
  });

  // -------------------------------------------------------------------------
  // CONN-HOOK-003 — Surfaces error message on failure
  // -------------------------------------------------------------------------
  it('CONN-HOOK-003: surfaces an error message when list() returns ok:false', async () => {
    installApi({
      listResult: {
        ok: false,
        error: { code: 'IO_FAILURE', message: 'disk full' },
      },
    });
    const cap: CapturedHook = { latest: null, history: [] };

    render(<HookConsumer capture={cap} />);

    await waitFor(() => {
      expect(cap.latest?.loading).toBe(false);
    });
    expect(cap.latest?.error).not.toBeNull();
    // The hook may surface either the message or the code.
    expect(cap.latest?.error).toMatch(/disk full|IO_FAILURE/);
    expect(cap.latest?.connections).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // CONN-HOOK-004 — refresh() re-calls list()
  // -------------------------------------------------------------------------
  it('CONN-HOOK-004: refresh() re-calls window.api.connections.list()', async () => {
    const stub = installApi({ listResult: { ok: true, data: [githubConn] } });
    const cap: CapturedHook = { latest: null, history: [] };

    render(<HookConsumer capture={cap} />);

    await waitFor(() => {
      expect(stub.connectionsList).toHaveBeenCalledTimes(1);
    });

    // Update the mock so the refresh sees a different result, then call it.
    stub.connectionsList.mockResolvedValueOnce({
      ok: true,
      data: [githubConn, jiraConn],
    });
    await act(async () => {
      await cap.latest?.refresh();
    });

    await waitFor(() => {
      expect(stub.connectionsList).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(cap.latest?.connections).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // CONN-HOOK-005 — window.api === undefined → loading false, error set
  // -------------------------------------------------------------------------
  it('CONN-HOOK-005: window.api === undefined → loading false + error set, no throw', async () => {
    delete (window as { api?: IpcApi }).api;
    const cap: CapturedHook = { latest: null, history: [] };

    expect(() => {
      render(<HookConsumer capture={cap} />);
    }).not.toThrow();

    await waitFor(() => {
      expect(cap.latest?.loading).toBe(false);
    });
    expect(cap.latest?.error).not.toBeNull();
    expect(cap.latest?.connections).toEqual([]);
  });
});
