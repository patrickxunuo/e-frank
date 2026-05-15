// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { useClaudeCli } from '../../src/renderer/state/claude-cli';
import type { IpcApi, ClaudeCliProbeResponse } from '../../src/shared/ipc';

/**
 * CLI-HOOK-001..009 — `useClaudeCli()` contract (#GH-85).
 *
 * Drives the hook through a Probe component that mirrors its return shape
 * into testable DOM nodes. Mirrors the pattern used by state-app-info.test.tsx.
 */

declare global {
  interface Window {
    api?: IpcApi;
  }
}

function Probe(): JSX.Element {
  const cli = useClaudeCli();
  return (
    <div>
      <span data-testid="probe-state">{cli.state}</span>
      <span data-testid="probe-resolved-path">{cli.resolvedPath ?? ''}</span>
      <span data-testid="probe-version">{cli.version ?? ''}</span>
      <span data-testid="probe-source">{cli.source}</span>
      <span data-testid="probe-error">{cli.error ?? ''}</span>
      <button
        type="button"
        data-testid="probe-refresh"
        onClick={() => {
          void cli.refresh();
        }}
      />
      <button
        type="button"
        data-testid="probe-save"
        onClick={() => {
          void cli.saveOverride('/new/claude');
        }}
      />
      <button
        type="button"
        data-testid="probe-clear"
        onClick={() => {
          void cli.clearOverride();
        }}
      />
      <button
        type="button"
        data-testid="probe-test"
        onClick={() => {
          void cli.testOverride('/test/path');
        }}
      />
    </div>
  );
}

function makeApi(
  probeResult: { ok: true; data: ClaudeCliProbeResponse } | { ok: false; error: { code: string; message: string } },
  overrides: Partial<{
    probeOverride: Mock;
    appConfigSet: Mock;
  }> = {},
): { probe: Mock; probeOverride: Mock; appConfigSet: Mock } {
  const probe = vi.fn().mockResolvedValue(probeResult);
  const probeOverride =
    overrides.probeOverride ??
    vi.fn().mockResolvedValue({
      ok: true,
      data: { resolvedPath: '/test/path', version: '1.0.0' },
    });
  const appConfigSet =
    overrides.appConfigSet ??
    vi.fn().mockResolvedValue({
      ok: true,
      data: {
        config: {
          theme: 'dark',
          claudeCliPath: null,
          defaultWorkflowMode: 'interactive',
          defaultPollingIntervalSec: 60,
          defaultRunTimeoutMin: 60,
        },
      },
    });
  const api = {
    claudeCli: { probe, probeOverride },
    appConfig: { get: vi.fn(), set: appConfigSet },
  } as unknown as IpcApi;
  (window as { api?: IpcApi }).api = api;
  return { probe, probeOverride, appConfigSet };
}

afterEach(() => {
  cleanup();
  delete (window as { api?: IpcApi }).api;
  vi.restoreAllMocks();
});

describe('useClaudeCli() — CLI-HOOK (#GH-85)', () => {
  it('CLI-HOOK-001: probe success with path source → state=found, resolvedPath+version+source set', async () => {
    const { probe } = makeApi({
      ok: true,
      data: { resolvedPath: '/usr/bin/claude', version: '1.0.96', source: 'path' },
    });
    render(<Probe />);
    await waitFor(() => {
      expect(screen.getByTestId('probe-state')).toHaveTextContent('found');
    });
    expect(screen.getByTestId('probe-resolved-path')).toHaveTextContent('/usr/bin/claude');
    expect(screen.getByTestId('probe-version')).toHaveTextContent('1.0.96');
    expect(screen.getByTestId('probe-source')).toHaveTextContent('path');
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('CLI-HOOK-002: probe success with override source → state=found, source=override', async () => {
    makeApi({
      ok: true,
      data: { resolvedPath: '/custom/claude', version: '1.0.96', source: 'override' },
    });
    render(<Probe />);
    await waitFor(() => {
      expect(screen.getByTestId('probe-state')).toHaveTextContent('found');
    });
    expect(screen.getByTestId('probe-source')).toHaveTextContent('override');
  });

  it('CLI-HOOK-003: probe returns source=not-found → state=not-found', async () => {
    makeApi({
      ok: true,
      data: { resolvedPath: null, version: null, source: 'not-found' },
    });
    render(<Probe />);
    await waitFor(() => {
      expect(screen.getByTestId('probe-state')).toHaveTextContent('not-found');
    });
  });

  it('CLI-HOOK-004: override path exists but version is null → state=not-found', async () => {
    // Override is configured but `--version` failed — the runner would still
    // try to spawn it (and fail). The hook surfaces this as not-found so the
    // section shows the install/clear-override affordance.
    makeApi({
      ok: true,
      data: { resolvedPath: '/broken/claude', version: null, source: 'override' },
    });
    render(<Probe />);
    await waitFor(() => {
      expect(screen.getByTestId('probe-state')).toHaveTextContent('not-found');
    });
  });

  it('CLI-HOOK-005: probe returns ok=false → state=error, error message surfaces', async () => {
    makeApi({ ok: false, error: { code: 'IO_FAILURE', message: 'sentinel-fail' } });
    render(<Probe />);
    await waitFor(() => {
      expect(screen.getByTestId('probe-state')).toHaveTextContent('error');
    });
    expect(screen.getByTestId('probe-error')).toHaveTextContent('sentinel-fail');
  });

  it('CLI-HOOK-006: missing IPC bridge → state=error synchronously, no probe call', async () => {
    delete (window as { api?: IpcApi }).api;
    render(<Probe />);
    expect(screen.getByTestId('probe-state')).toHaveTextContent('error');
    expect(screen.getByTestId('probe-error')).toHaveTextContent(/bridge/i);
  });

  it('CLI-HOOK-007: refresh re-invokes probe', async () => {
    const { probe } = makeApi({
      ok: true,
      data: { resolvedPath: '/usr/bin/claude', version: '1.0.0', source: 'path' },
    });
    render(<Probe />);
    await waitFor(() => {
      expect(screen.getByTestId('probe-state')).toHaveTextContent('found');
    });
    await act(async () => {
      screen.getByTestId('probe-refresh').click();
    });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('CLI-HOOK-008: saveOverride calls appConfig.set then re-probes', async () => {
    const { probe, appConfigSet } = makeApi({
      ok: true,
      data: { resolvedPath: '/usr/bin/claude', version: '1.0.0', source: 'path' },
    });
    render(<Probe />);
    await waitFor(() => {
      expect(screen.getByTestId('probe-state')).toHaveTextContent('found');
    });
    await act(async () => {
      screen.getByTestId('probe-save').click();
    });
    expect(appConfigSet).toHaveBeenCalledWith({ partial: { claudeCliPath: '/new/claude' } });
    // probe was called 2x: initial mount + post-save refresh.
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('CLI-HOOK-009: clearOverride calls appConfig.set with claudeCliPath=null + re-probes', async () => {
    const { probe, appConfigSet } = makeApi({
      ok: true,
      data: { resolvedPath: '/usr/bin/claude', version: '1.0.0', source: 'override' },
    });
    render(<Probe />);
    await waitFor(() => {
      expect(screen.getByTestId('probe-state')).toHaveTextContent('found');
    });
    await act(async () => {
      screen.getByTestId('probe-clear').click();
    });
    expect(appConfigSet).toHaveBeenCalledWith({ partial: { claudeCliPath: null } });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('CLI-HOOK-010: testOverride invokes claudeCli.probeOverride (no persist)', async () => {
    const probeOverride = vi.fn().mockResolvedValue({
      ok: true,
      data: { resolvedPath: '/test/path', version: '1.0.0' },
    });
    const { appConfigSet } = makeApi(
      { ok: true, data: { resolvedPath: '/usr/bin/claude', version: '1.0.0', source: 'path' } },
      { probeOverride },
    );
    render(<Probe />);
    await waitFor(() => {
      expect(screen.getByTestId('probe-state')).toHaveTextContent('found');
    });
    await act(async () => {
      screen.getByTestId('probe-test').click();
    });
    expect(probeOverride).toHaveBeenCalledWith({ path: '/test/path' });
    expect(appConfigSet).not.toHaveBeenCalled();
  });
});
