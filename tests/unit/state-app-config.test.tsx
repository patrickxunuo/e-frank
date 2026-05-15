// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { useAppConfig } from '../../src/renderer/state/app-config';
import type { IpcApi, AppConfig } from '../../src/shared/ipc';

/**
 * AC-HOOK-001..005 — `useAppConfig()` hook tests (#GH-69 Foundation).
 *
 * Pattern matches `state-active-run.test.tsx` — render a tiny consumer that
 * stashes the latest hook value into a ref captor so tests can assert
 * without depending on @testing-library's `renderHook` (whose API varies).
 */

declare global {
  interface Window {
    api?: IpcApi;
  }
}

interface CapturedHook {
  config: AppConfig | null;
  loading: boolean;
  error: string | null;
  history: { config: AppConfig | null; loading: boolean; error: string | null }[];
}

function HookConsumer({ capture }: { capture: CapturedHook }): null {
  const value = useAppConfig();
  useEffect(() => {
    capture.config = value.config;
    capture.loading = value.loading;
    capture.error = value.error;
    capture.history.push({ config: value.config, loading: value.loading, error: value.error });
    // Stash update for tests that need to invoke it.
    (capture as unknown as { update?: typeof value.update }).update = value.update;
  }, [value, capture]);
  return null;
}

function makeConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    theme: 'dark',
    claudeCliPath: null,
    defaultWorkflowMode: 'interactive',
    defaultPollingIntervalSec: 60,
    defaultRunTimeoutMin: 60,
    ...over,
  };
}

function installApi(opts: {
  get?: { ok: true; data: AppConfig } | { ok: false; error: { code: string; message: string } };
}): { configGet: Mock; configSet: Mock } {
  const getRes = opts.get
    ? opts.get.ok
      ? { ok: true, data: { config: opts.get.data } }
      : opts.get
    : { ok: true, data: { config: makeConfig() } };
  const configGet = vi.fn().mockResolvedValue(getRes);
  const configSet = vi.fn();
  const api = {
    appConfig: {
      get: configGet,
      set: configSet,
    },
  } as unknown as IpcApi;
  (window as { api?: IpcApi }).api = api;
  return { configGet, configSet };
}

afterEach(() => {
  cleanup();
  delete (window as { api?: IpcApi }).api;
  vi.restoreAllMocks();
});

describe('useAppConfig — AC-HOOK (#GH-69 Foundation)', () => {
  it('AC-HOOK-001: mount calls appConfig.get; loading→false; config populated', async () => {
    const stub = installApi({ get: { ok: true, data: makeConfig({ theme: 'light' }) } });
    const cap: CapturedHook = { config: null, loading: true, error: null, history: [] };

    render(<HookConsumer capture={cap} />);

    await waitFor(() => {
      expect(stub.configGet).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(cap.config).not.toBeNull();
    });
    expect(cap.loading).toBe(false);
    expect(cap.error).toBeNull();
    expect(cap.config?.theme).toBe('light');
  });

  it('AC-HOOK-002: missing window.api → loading=false, error set, config=null', async () => {
    delete (window as { api?: IpcApi }).api;
    const cap: CapturedHook = { config: null, loading: true, error: null, history: [] };
    render(<HookConsumer capture={cap} />);
    await waitFor(() => {
      expect(cap.loading).toBe(false);
    });
    expect(cap.config).toBeNull();
    expect(cap.error).toMatch(/bridge/i);
  });

  it('AC-HOOK-003: get returns error → config=null and error set', async () => {
    installApi({
      get: { ok: false, error: { code: 'IO_FAILURE', message: 'disk full' } },
    });
    const cap: CapturedHook = { config: null, loading: true, error: null, history: [] };
    render(<HookConsumer capture={cap} />);
    await waitFor(() => {
      expect(cap.loading).toBe(false);
    });
    expect(cap.config).toBeNull();
    expect(cap.error).toBe('disk full');
  });

  it('AC-HOOK-004: update(partial) calls appConfig.set; merged config returned from hook', async () => {
    const stub = installApi({ get: { ok: true, data: makeConfig() } });
    const updated = makeConfig({ theme: 'system' });
    stub.configSet.mockResolvedValue({ ok: true, data: { config: updated } });

    const cap: CapturedHook = { config: null, loading: true, error: null, history: [] };
    render(<HookConsumer capture={cap} />);

    await waitFor(() => {
      expect(cap.config).not.toBeNull();
    });

    const updateFn = (cap as unknown as { update?: (p: Partial<AppConfig>) => Promise<AppConfig | null> }).update;
    expect(updateFn).toBeDefined();
    await act(async () => {
      await updateFn?.({ theme: 'system' });
    });

    expect(stub.configSet).toHaveBeenCalledWith({ partial: { theme: 'system' } });
    expect(cap.config?.theme).toBe('system');
  });

  it('AC-HOOK-005: update with error response → returns null, sets error, keeps prior config', async () => {
    const stub = installApi({ get: { ok: true, data: makeConfig() } });
    stub.configSet.mockResolvedValue({
      ok: false,
      error: { code: 'VALIDATION_FAILED', message: 'bad value' },
    });
    const cap: CapturedHook = { config: null, loading: true, error: null, history: [] };
    render(<HookConsumer capture={cap} />);
    await waitFor(() => {
      expect(cap.config).not.toBeNull();
    });
    const priorConfig = cap.config;

    const updateFn = (cap as unknown as { update?: (p: Partial<AppConfig>) => Promise<AppConfig | null> }).update;
    let returned: AppConfig | null = null;
    await act(async () => {
      returned = (await updateFn?.({ theme: 'system' })) ?? null;
    });

    expect(returned).toBeNull();
    expect(cap.error).toBe('bad value');
    // Prior config preserved — we don't blow it away on a failed update.
    expect(cap.config).toEqual(priorConfig);
  });
});
