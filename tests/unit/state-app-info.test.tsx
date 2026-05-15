// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useAppInfo } from '../../src/renderer/state/app-info';
import type { AppInfoResponse, IpcApi, IpcResult } from '../../src/shared/ipc';

/**
 * APP-INFO-001..004 — `useAppInfo()` hook contract (#GH-87).
 *
 * Drives the hook from a minimal probe component that mirrors the
 * hook's return shape into testable DOM nodes. Avoids @testing-library/
 * react-hooks (deprecated for React 18) — render-with-probe is the
 * project pattern used by state-theme.test.tsx.
 */

declare global {
  interface Window {
    api?: IpcApi;
  }
}

function Probe(): JSX.Element {
  const { info, loading, error } = useAppInfo();
  return (
    <div>
      <span data-testid="probe-loading">{loading ? '1' : '0'}</span>
      <span data-testid="probe-error">{error ?? ''}</span>
      <span data-testid="probe-app-version">{info?.appVersion ?? ''}</span>
      <span data-testid="probe-platform">{info?.platform ?? ''}</span>
    </div>
  );
}

function installApi(appInfo: IpcResult<AppInfoResponse>): { info: Mock } {
  const info = vi.fn().mockResolvedValue(appInfo);
  const api = {
    app: { info },
    shell: {
      openExternal: vi.fn(),
      openPath: vi.fn(),
      openLogDirectory: vi.fn(),
    },
  } as unknown as IpcApi;
  (window as { api?: IpcApi }).api = api;
  return { info };
}

function makeInfo(over: Partial<AppInfoResponse> = {}): AppInfoResponse {
  return {
    appVersion: '1.2.3',
    buildCommit: 'cafebabe',
    platform: 'linux',
    release: '6.11.0',
    electronVersion: '34.0.0',
    nodeVersion: '20.18.1',
    chromeVersion: '132.0.0.0',
    ...over,
  };
}

afterEach(() => {
  cleanup();
  delete (window as { api?: IpcApi }).api;
  vi.restoreAllMocks();
});

describe('useAppInfo() — APP-INFO (#GH-87)', () => {
  it('APP-INFO-001: ok=true → exposes the response, loading flips to 0, no error', async () => {
    const { info } = installApi({ ok: true, data: makeInfo({ appVersion: '4.2.0' }) });
    render(<Probe />);
    await waitFor(() => {
      expect(screen.getByTestId('probe-loading')).toHaveTextContent('0');
    });
    expect(screen.getByTestId('probe-app-version')).toHaveTextContent('4.2.0');
    expect(screen.getByTestId('probe-platform')).toHaveTextContent('linux');
    expect(screen.getByTestId('probe-error')).toHaveTextContent('');
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('APP-INFO-002: ok=false → falls back to build-time defines + surfaces error message', async () => {
    installApi({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'sentinel-fail' },
    });
    render(<Probe />);
    await waitFor(() => {
      expect(screen.getByTestId('probe-loading')).toHaveTextContent('0');
    });
    expect(screen.getByTestId('probe-error')).toHaveTextContent('sentinel-fail');
    // Fallback platform === 'unknown' (build-time defines only cover version/commit).
    expect(screen.getByTestId('probe-platform')).toHaveTextContent('unknown');
    // Fallback appVersion comes from `__APP_VERSION__` injected by vitest.config.ts.
    expect(screen.getByTestId('probe-app-version')).toHaveTextContent('0.0.0-test');
  });

  it('APP-INFO-003: throwing IPC call → falls back without crashing, error message surfaces', async () => {
    const info = vi.fn().mockRejectedValue(new Error('bridge-crash'));
    const api = {
      app: { info },
      shell: {
        openExternal: vi.fn(),
        openPath: vi.fn(),
        openLogDirectory: vi.fn(),
      },
    } as unknown as IpcApi;
    (window as { api?: IpcApi }).api = api;
    render(<Probe />);
    await waitFor(() => {
      expect(screen.getByTestId('probe-loading')).toHaveTextContent('0');
    });
    expect(screen.getByTestId('probe-error')).toHaveTextContent('bridge-crash');
    expect(screen.getByTestId('probe-app-version')).toHaveTextContent('0.0.0-test');
  });

  it('APP-INFO-004: missing IPC bridge → renders fallback synchronously, error explains why', async () => {
    delete (window as { api?: IpcApi }).api;
    render(<Probe />);
    await waitFor(() => {
      expect(screen.getByTestId('probe-loading')).toHaveTextContent('0');
    });
    expect(screen.getByTestId('probe-error')).toHaveTextContent(/bridge/i);
    expect(screen.getByTestId('probe-app-version')).toHaveTextContent('0.0.0-test');
    expect(screen.getByTestId('probe-platform')).toHaveTextContent('unknown');
  });
});
