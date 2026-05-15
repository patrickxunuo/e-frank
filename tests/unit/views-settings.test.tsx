// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Settings } from '../../src/renderer/views/Settings';
import { useTheme } from '../../src/renderer/state/theme';
import type { IpcApi, AppConfig, ThemeMode } from '../../src/shared/ipc';
import type { ResolvedTheme } from '../../src/renderer/state/theme';

/**
 * SETTINGS-FOUND-001..005 — `<Settings>` page shell (#GH-69 Foundation).
 * SETTINGS-THEME-001..004 — Theme section UI (#GH-84).
 *
 * Foundation tests assert the shell shape. Theme tests cover the
 * RadioCardGroup wiring against a mocked `useTheme` hook (the hook's
 * own behavior is tested in state-theme.test.tsx).
 */

vi.mock('../../src/renderer/state/theme', () => ({
  useTheme: vi.fn(),
}));

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
}): { configGet: Mock } {
  const getRes = opts.get
    ? opts.get.ok
      ? { ok: true, data: { config: opts.get.data } }
      : opts.get
    : { ok: true, data: { config: makeConfig() } };
  const configGet = vi.fn().mockResolvedValue(getRes);
  const api = {
    appConfig: { get: configGet, set: vi.fn() },
  } as unknown as IpcApi;
  (window as { api?: IpcApi }).api = api;
  return { configGet };
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
  it('SETTINGS-FOUND-001: renders page title + theme section + 3 remaining placeholders', async () => {
    installApi({ get: { ok: true, data: makeConfig() } });
    mockTheme();
    render(<Settings />);
    expect(await screen.findByTestId('settings-title')).toBeInTheDocument();
    // Theme section is now implemented (#GH-84) — its testid is `settings-theme-section`,
    // not the legacy `settings-placeholder-theme`.
    expect(screen.getByTestId('settings-theme-section')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-placeholder-theme')).toBeNull();
    // The other three sections still render placeholders.
    expect(screen.getByTestId('settings-placeholder-claude-cli')).toBeInTheDocument();
    expect(screen.getByTestId('settings-placeholder-defaults')).toBeInTheDocument();
    expect(screen.getByTestId('settings-placeholder-about')).toBeInTheDocument();
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
    expect(screen.getByTestId('settings-placeholder-claude-cli')).toBeInTheDocument();
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
