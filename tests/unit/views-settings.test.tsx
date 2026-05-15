// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Settings } from '../../src/renderer/views/Settings';
import { useTheme } from '../../src/renderer/state/theme';
import type { IpcApi, IpcResult, AppConfig, ThemeMode, AppInfoResponse } from '../../src/shared/ipc';
import type { ResolvedTheme } from '../../src/renderer/state/theme';

/**
 * SETTINGS-FOUND-001..005 — `<Settings>` page shell (#GH-69 Foundation).
 * SETTINGS-THEME-001..004 — Theme section UI (#GH-84).
 * SETTINGS-ABOUT-001..005 — About section UI (#GH-87).
 *
 * Foundation tests assert the shell shape. Theme tests cover the
 * RadioCardGroup wiring against a mocked `useTheme` hook (the hook's
 * own behavior is tested in state-theme.test.tsx).
 */

vi.mock('../../src/renderer/state/theme', () => ({
  useTheme: vi.fn(),
}));

function makeAppInfo(over: Partial<AppInfoResponse> = {}): AppInfoResponse {
  return {
    appVersion: '9.9.9',
    buildCommit: 'abcdef0',
    platform: 'darwin',
    release: '24.0.0',
    electronVersion: '34.0.0',
    nodeVersion: '20.18.1',
    chromeVersion: '132.0.0.0',
    ...over,
  };
}

declare global {
  interface Window {
    api?: IpcApi;
  }
}

function makeConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    theme: 'dark',
    claudeCliPath: null,
    defaultWorkflowMode: 'interactive',
    defaultPollingIntervalSec: 60,
    defaultRunTimeoutMin: 30,
    ...over,
  };
}

function installApi(opts: {
  get?: { ok: true; data: AppConfig } | { ok: false; error: { code: string; message: string } };
  appInfo?: IpcResult<AppInfoResponse>;
  openLogDirectory?: Mock;
  openExternal?: Mock;
}): {
  configGet: Mock;
  appInfo: Mock;
  openLogDirectory: Mock;
  openExternal: Mock;
} {
  const getRes = opts.get
    ? opts.get.ok
      ? { ok: true, data: { config: opts.get.data } }
      : opts.get
    : { ok: true, data: { config: makeConfig() } };
  const configGet = vi.fn().mockResolvedValue(getRes);
  const appInfoRes: IpcResult<AppInfoResponse> =
    opts.appInfo ?? { ok: true, data: makeAppInfo() };
  const appInfo = vi.fn().mockResolvedValue(appInfoRes);
  const openLogDirectory =
    opts.openLogDirectory ?? vi.fn().mockResolvedValue({ ok: true, data: null });
  const openExternal =
    opts.openExternal ?? vi.fn().mockResolvedValue({ ok: true, data: null });
  const api = {
    appConfig: { get: configGet, set: vi.fn() },
    app: { info: appInfo },
    claudeCli: {
      probe: vi.fn().mockResolvedValue({ ok: false, error: { code: 'NOT_USED_IN_FE_TESTS', message: '' } }),
      probeOverride: vi.fn().mockResolvedValue({ ok: false, error: { code: 'NOT_USED_IN_FE_TESTS', message: '' } }),
    },
    shell: {
      openPath: vi.fn(),
      openExternal,
      openLogDirectory,
    },
  } as unknown as IpcApi;
  (window as { api?: IpcApi }).api = api;
  return { configGet, appInfo, openLogDirectory, openExternal };
}

function mockTheme(opts: {
  theme?: ThemeMode;
  resolvedTheme?: ResolvedTheme;
  loading?: boolean;
  setTheme?: Mock;
  toggle?: Mock;
} = {}): { setTheme: Mock; toggle: Mock } {
  const setTheme = opts.setTheme ?? vi.fn().mockResolvedValue(undefined);
  const toggle = opts.toggle ?? vi.fn().mockResolvedValue(undefined);
  (useTheme as unknown as Mock).mockReturnValue({
    theme: opts.theme ?? 'dark',
    resolvedTheme: opts.resolvedTheme ?? 'dark',
    loading: opts.loading ?? false,
    setTheme,
    toggle,
  });
  return { setTheme, toggle };
}

afterEach(() => {
  cleanup();
  delete (window as { api?: IpcApi }).api;
  vi.restoreAllMocks();
  (useTheme as unknown as Mock).mockReset();
});

describe('<Settings /> — SETTINGS-FOUND (#GH-69 Foundation)', () => {
  it('SETTINGS-FOUND-001: renders page title + theme/cli/about sections + 1 remaining placeholder', async () => {
    installApi({ get: { ok: true, data: makeConfig() } });
    mockTheme();
    render(<Settings />);
    expect(await screen.findByTestId('settings-title')).toBeInTheDocument();
    // Theme (#GH-84), Claude CLI (#GH-85), and About (#GH-87) are
    // implemented — they use real testids, not the placeholder variant.
    expect(screen.getByTestId('settings-theme-section')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-placeholder-theme')).toBeNull();
    expect(screen.getByTestId('settings-claude-cli-section')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-placeholder-claude-cli')).toBeNull();
    expect(screen.getByTestId('settings-about-section')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-placeholder-about')).toBeNull();
    // Workflow defaults still renders the placeholder (GH-86 follow-up).
    expect(screen.getByTestId('settings-placeholder-defaults')).toBeInTheDocument();
  });

  it('SETTINGS-FOUND-002: rail navigation has hash hrefs pointing at section ids', async () => {
    installApi({ get: { ok: true, data: makeConfig() } });
    mockTheme();
    render(<Settings />);
    await screen.findByTestId('settings-title');
    expect(screen.getByTestId('settings-rail-theme')).toHaveAttribute('href', '#theme');
    expect(screen.getByTestId('settings-rail-claude-cli')).toHaveAttribute('href', '#claude-cli');
    expect(screen.getByTestId('settings-rail-defaults')).toHaveAttribute('href', '#defaults');
    expect(screen.getByTestId('settings-rail-about')).toHaveAttribute('href', '#about');
  });

  it('SETTINGS-FOUND-003: section elements have matching DOM ids for the rail anchors', async () => {
    installApi({ get: { ok: true, data: makeConfig() } });
    mockTheme();
    render(<Settings />);
    await screen.findByTestId('settings-title');
    expect(screen.getByTestId('settings-section-theme')).toHaveAttribute('id', 'theme');
    expect(screen.getByTestId('settings-section-claude-cli')).toHaveAttribute('id', 'claude-cli');
    expect(screen.getByTestId('settings-section-defaults')).toHaveAttribute('id', 'defaults');
    expect(screen.getByTestId('settings-section-about')).toHaveAttribute('id', 'about');
  });

  it('SETTINGS-FOUND-004: missing IPC bridge → error banner renders', async () => {
    delete (window as { api?: IpcApi }).api;
    mockTheme();
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByTestId('settings-error')).toBeInTheDocument();
    });
    // Other surfaces still render — error doesn't block the shell.
    expect(screen.getByTestId('settings-theme-section')).toBeInTheDocument();
    expect(screen.getByTestId('settings-claude-cli-section')).toBeInTheDocument();
    expect(screen.getByTestId('settings-about-section')).toBeInTheDocument();
    expect(screen.getByTestId('settings-placeholder-defaults')).toBeInTheDocument();
  });

  it('SETTINGS-FOUND-005: appConfig.get returns error → error banner renders', async () => {
    installApi({
      get: { ok: false, error: { code: 'IO_FAILURE', message: 'permission denied' } },
    });
    mockTheme();
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByTestId('settings-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('settings-error')).toHaveTextContent(/permission denied/i);
  });
});

describe('<Settings /> — SETTINGS-THEME (#GH-84 Theme section)', () => {
  it('SETTINGS-THEME-001: renders RadioCardGroup with all 3 mode options', async () => {
    installApi({ get: { ok: true, data: makeConfig({ theme: 'dark' }) } });
    mockTheme({ theme: 'dark', resolvedTheme: 'dark' });
    render(<Settings />);
    await screen.findByTestId('settings-title');
    // RadioCardGroup option testid pattern: `{rootTestid}-option-{value}`.
    expect(screen.getByTestId('settings-theme-radio-option-light')).toBeInTheDocument();
    expect(screen.getByTestId('settings-theme-radio-option-dark')).toBeInTheDocument();
    expect(screen.getByTestId('settings-theme-radio-option-system')).toBeInTheDocument();
  });

  it('SETTINGS-THEME-002: clicking a card calls setTheme with that value', async () => {
    installApi({ get: { ok: true, data: makeConfig({ theme: 'dark' }) } });
    const { setTheme } = mockTheme({ theme: 'dark', resolvedTheme: 'dark' });
    render(<Settings />);
    await screen.findByTestId('settings-title');
    fireEvent.click(screen.getByTestId('settings-theme-radio-option-light'));
    expect(setTheme).toHaveBeenCalledWith('light');
    fireEvent.click(screen.getByTestId('settings-theme-radio-option-system'));
    expect(setTheme).toHaveBeenCalledWith('system');
  });

  it('SETTINGS-THEME-003: the current theme value is marked as selected', async () => {
    installApi({ get: { ok: true, data: makeConfig({ theme: 'system' }) } });
    mockTheme({ theme: 'system', resolvedTheme: 'light' });
    render(<Settings />);
    await screen.findByTestId('settings-title');
    // RadioCardGroup marks the selected card via aria-checked="true".
    expect(screen.getByTestId('settings-theme-radio-option-system')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByTestId('settings-theme-radio-option-dark')).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('SETTINGS-THEME-004: hook in loading state shows the loading hint', async () => {
    installApi({ get: { ok: true, data: makeConfig() } });
    mockTheme({ loading: true });
    render(<Settings />);
    await screen.findByTestId('settings-title');
    expect(screen.getByTestId('settings-theme-loading')).toBeInTheDocument();
  });
});

describe('<Settings /> — SETTINGS-ABOUT (#GH-87 About section)', () => {
  it('SETTINGS-ABOUT-001: renders all 7 diagnostic rows from app:info', async () => {
    installApi({
      get: { ok: true, data: makeConfig() },
      appInfo: {
        ok: true,
        data: makeAppInfo({
          appVersion: '1.2.3',
          buildCommit: 'deadbee',
          platform: 'win32',
          release: '10.0.19045',
          electronVersion: '34.0.0',
          nodeVersion: '20.18.1',
          chromeVersion: '132.0.0.0',
        }),
      },
    });
    mockTheme();
    render(<Settings />);
    await screen.findByTestId('settings-title');
    await waitFor(() => {
      expect(screen.getByTestId('settings-about-app-version')).toHaveTextContent('1.2.3');
    });
    expect(screen.getByTestId('settings-about-build-commit')).toHaveTextContent('deadbee');
    expect(screen.getByTestId('settings-about-platform')).toHaveTextContent('win32');
    expect(screen.getByTestId('settings-about-release')).toHaveTextContent('10.0.19045');
    expect(screen.getByTestId('settings-about-electron')).toHaveTextContent('34.0.0');
    expect(screen.getByTestId('settings-about-node')).toHaveTextContent('20.18.1');
    expect(screen.getByTestId('settings-about-chrome')).toHaveTextContent('132.0.0.0');
  });

  it('SETTINGS-ABOUT-002: clicking Open-log-dir invokes shell.openLogDirectory', async () => {
    const openLogDirectory = vi.fn().mockResolvedValue({ ok: true, data: null });
    installApi({
      get: { ok: true, data: makeConfig() },
      appInfo: { ok: true, data: makeAppInfo() },
      openLogDirectory,
    });
    mockTheme();
    render(<Settings />);
    await screen.findByTestId('settings-title');
    await waitFor(() => {
      expect(screen.getByTestId('settings-about-open-logs')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-about-open-logs'));
    });
    expect(openLogDirectory).toHaveBeenCalledTimes(1);
  });

  it('SETTINGS-ABOUT-003: Report-an-issue opens the GitHub issues URL', async () => {
    const openExternal = vi.fn().mockResolvedValue({ ok: true, data: null });
    installApi({
      get: { ok: true, data: makeConfig() },
      appInfo: { ok: true, data: makeAppInfo() },
      openExternal,
    });
    mockTheme();
    render(<Settings />);
    await screen.findByTestId('settings-title');
    await waitFor(() => {
      expect(screen.getByTestId('settings-about-report-issue')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-about-report-issue'));
    });
    expect(openExternal).toHaveBeenCalledWith({
      url: 'https://github.com/patrickxunuo/paperplane/issues/new',
    });
  });

  it('SETTINGS-ABOUT-004: Check-for-updates opens the GitHub releases URL', async () => {
    const openExternal = vi.fn().mockResolvedValue({ ok: true, data: null });
    installApi({
      get: { ok: true, data: makeConfig() },
      appInfo: { ok: true, data: makeAppInfo() },
      openExternal,
    });
    mockTheme();
    render(<Settings />);
    await screen.findByTestId('settings-title');
    await waitFor(() => {
      expect(screen.getByTestId('settings-about-check-updates')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-about-check-updates'));
    });
    expect(openExternal).toHaveBeenCalledWith({
      url: 'https://github.com/patrickxunuo/paperplane/releases',
    });
  });

  it('SETTINGS-ABOUT-005: app:info ok=false → fallback values render + error hint surfaces', async () => {
    installApi({
      get: { ok: true, data: makeConfig() },
      appInfo: {
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'sentinel-failure' },
      },
    });
    mockTheme();
    render(<Settings />);
    await screen.findByTestId('settings-title');
    // useAppInfo falls back to build-time defines; renderer global.d.ts
    // declares these as `string`. The Vite test config defines them as
    // 'test-version' / 'test-commit' (see vitest.config).
    await waitFor(() => {
      expect(screen.getByTestId('settings-about-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('settings-about-error')).toHaveTextContent(/sentinel-failure/);
    // Fallback values still show in the grid.
    expect(screen.getByTestId('settings-about-app-version')).toBeInTheDocument();
    expect(screen.getByTestId('settings-about-build-commit')).toBeInTheDocument();
  });
});

describe('<Settings /> — SETTINGS-CLI (#GH-85 Claude CLI section)', () => {
  function installCliApi(opts: {
    probe?:
      | {
          ok: true;
          data: { resolvedPath: string | null; version: string | null; source: 'override' | 'path' | 'not-found' };
        }
      | { ok: false; error: { code: string; message: string } };
    probeOverride?:
      | { ok: true; data: { resolvedPath: string; version: string } }
      | { ok: false; error: { code: 'PATH_NOT_FOUND' | 'NOT_EXECUTABLE' | 'NOT_CLAUDE'; message: string } };
    appConfigSet?: Mock;
  } = {}): { probe: Mock; probeOverride: Mock; appConfigSet: Mock; openExternal: Mock } {
    const probe = vi.fn().mockResolvedValue(
      opts.probe ??
        {
          ok: true,
          data: { resolvedPath: '/usr/local/bin/claude', version: '1.0.96 (Claude Code)', source: 'path' },
        },
    );
    const probeOverride = vi.fn().mockResolvedValue(
      opts.probeOverride ?? { ok: true, data: { resolvedPath: '/x', version: '1.0.0' } },
    );
    const appConfigSet =
      opts.appConfigSet ??
      vi.fn().mockResolvedValue({
        ok: true,
        data: {
          config: {
            theme: 'dark',
            claudeCliPath: null,
            defaultWorkflowMode: 'interactive',
            defaultPollingIntervalSec: 60,
            defaultRunTimeoutMin: 30,
          },
        },
      });
    const openExternal = vi.fn().mockResolvedValue({ ok: true, data: null });
    const api = {
      appConfig: {
        get: vi
          .fn()
          .mockResolvedValue({ ok: true, data: { config: makeConfig() } }),
        set: appConfigSet,
      },
      app: {
        info: vi.fn().mockResolvedValue({
          ok: false,
          error: { code: 'NOT_USED', message: '' },
        }),
      },
      shell: { openExternal, openPath: vi.fn(), openLogDirectory: vi.fn() },
      claudeCli: { probe, probeOverride },
    } as unknown as IpcApi;
    (window as { api?: IpcApi }).api = api;
    return { probe, probeOverride, appConfigSet, openExternal };
  }

  it('SETTINGS-CLI-001: source=path → renders found status with resolved path + version', async () => {
    installCliApi({
      probe: {
        ok: true,
        data: { resolvedPath: '/usr/local/bin/claude', version: '1.0.96 (Claude Code)', source: 'path' },
      },
    });
    mockTheme();
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByTestId('settings-claude-cli-status-found')).toBeInTheDocument();
    });
    expect(screen.getByTestId('settings-claude-cli-resolved-path')).toHaveTextContent(
      '/usr/local/bin/claude',
    );
    expect(screen.getByTestId('settings-claude-cli-version')).toHaveTextContent(
      '1.0.96 (Claude Code)',
    );
    // Clear-override is disabled when source is `path` (no override to clear).
    expect(screen.getByTestId('settings-claude-cli-clear')).toBeDisabled();
  });

  it('SETTINGS-CLI-002: source=not-found → renders install-docs link', async () => {
    const { openExternal } = installCliApi({
      probe: {
        ok: true,
        data: { resolvedPath: null, version: null, source: 'not-found' },
      },
    });
    mockTheme();
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByTestId('settings-claude-cli-status-not-found')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-claude-cli-install-link'));
    });
    expect(openExternal).toHaveBeenCalledWith({
      url: 'https://docs.anthropic.com/en/docs/claude-code/quickstart',
    });
  });

  it('SETTINGS-CLI-003: Test+Save flow — Test enables Save, Save persists via appConfig.set', async () => {
    const { probeOverride, appConfigSet } = installCliApi();
    mockTheme();
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByTestId('settings-claude-cli-section')).toBeInTheDocument();
    });
    // Save starts disabled — no path entered yet.
    expect(screen.getByTestId('settings-claude-cli-save')).toBeDisabled();
    // Type a path.
    await act(async () => {
      fireEvent.change(screen.getByTestId('settings-claude-cli-override-input'), {
        target: { value: '/custom/claude' },
      });
    });
    // Save still disabled — must Test first.
    expect(screen.getByTestId('settings-claude-cli-save')).toBeDisabled();
    // Click Test.
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-claude-cli-test'));
    });
    expect(probeOverride).toHaveBeenCalledWith({ path: '/custom/claude' });
    // After successful Test, Save becomes enabled.
    await waitFor(() => {
      expect(screen.getByTestId('settings-claude-cli-validation-ok')).toBeInTheDocument();
    });
    expect(screen.getByTestId('settings-claude-cli-save')).toBeEnabled();
    // Click Save.
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-claude-cli-save'));
    });
    expect(appConfigSet).toHaveBeenCalledWith({
      partial: { claudeCliPath: '/custom/claude' },
    });
  });

  it('SETTINGS-CLI-004: Test returns NOT_CLAUDE → validation error displays, Save stays disabled', async () => {
    installCliApi({
      probeOverride: {
        ok: false,
        error: { code: 'NOT_CLAUDE', message: 'GNU bash, version 5.2' },
      },
    });
    mockTheme();
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByTestId('settings-claude-cli-section')).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId('settings-claude-cli-override-input'), {
        target: { value: '/bin/bash' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-claude-cli-test'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('settings-claude-cli-validation-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('settings-claude-cli-validation-error')).toHaveTextContent(
      /doesn't look like Claude CLI/,
    );
    expect(screen.getByTestId('settings-claude-cli-save')).toBeDisabled();
  });

  it('SETTINGS-CLI-005: source=override → Clear button is enabled + calls appConfig.set({ claudeCliPath: null })', async () => {
    const { appConfigSet } = installCliApi({
      probe: {
        ok: true,
        data: { resolvedPath: '/custom/claude', version: '1.0.0', source: 'override' },
      },
    });
    mockTheme();
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByTestId('settings-claude-cli-status-found')).toBeInTheDocument();
    });
    expect(screen.getByTestId('settings-claude-cli-clear')).toBeEnabled();
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-claude-cli-clear'));
    });
    expect(appConfigSet).toHaveBeenCalledWith({ partial: { claudeCliPath: null } });
  });

  it('SETTINGS-CLI-006: Refresh re-invokes probe', async () => {
    const { probe } = installCliApi();
    mockTheme();
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByTestId('settings-claude-cli-section')).toBeInTheDocument();
    });
    expect(probe).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(screen.getByTestId('settings-claude-cli-refresh'));
    });
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
