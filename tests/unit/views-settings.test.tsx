// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Settings } from '../../src/renderer/views/Settings';
import type { IpcApi, AppConfig } from '../../src/shared/ipc';

/**
 * SETTINGS-FOUND-001..005 — `<Settings>` page shell (#GH-69 Foundation).
 *
 * Foundation only renders the page chrome + 4 placeholder section cards.
 * Tests assert the shell shape so each section follow-up PR (Theme,
 * Claude CLI, Workflow Defaults, About) has stable testids to scope
 * its own tests against.
 */

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

afterEach(() => {
  cleanup();
  delete (window as { api?: IpcApi }).api;
  vi.restoreAllMocks();
});

describe('<Settings /> — SETTINGS-FOUND (#GH-69 Foundation)', () => {
  it('SETTINGS-FOUND-001: renders page title + 4 section placeholders', async () => {
    installApi({ get: { ok: true, data: makeConfig() } });
    render(<Settings />);
    expect(await screen.findByTestId('settings-title')).toBeInTheDocument();
    // 4 section placeholders, each with a stable testid.
    expect(screen.getByTestId('settings-placeholder-theme')).toBeInTheDocument();
    expect(screen.getByTestId('settings-placeholder-claude-cli')).toBeInTheDocument();
    expect(screen.getByTestId('settings-placeholder-defaults')).toBeInTheDocument();
    expect(screen.getByTestId('settings-placeholder-about')).toBeInTheDocument();
  });

  it('SETTINGS-FOUND-002: rail navigation has hash hrefs pointing at section ids', async () => {
    installApi({ get: { ok: true, data: makeConfig() } });
    render(<Settings />);
    await screen.findByTestId('settings-title');
    const themeLink = screen.getByTestId('settings-rail-theme');
    expect(themeLink).toHaveAttribute('href', '#theme');
    expect(screen.getByTestId('settings-rail-claude-cli')).toHaveAttribute('href', '#claude-cli');
    expect(screen.getByTestId('settings-rail-defaults')).toHaveAttribute('href', '#defaults');
    expect(screen.getByTestId('settings-rail-about')).toHaveAttribute('href', '#about');
  });

  it('SETTINGS-FOUND-003: section elements have matching DOM ids for the rail anchors', async () => {
    installApi({ get: { ok: true, data: makeConfig() } });
    render(<Settings />);
    await screen.findByTestId('settings-title');
    expect(screen.getByTestId('settings-section-theme')).toHaveAttribute('id', 'theme');
    expect(screen.getByTestId('settings-section-claude-cli')).toHaveAttribute('id', 'claude-cli');
    expect(screen.getByTestId('settings-section-defaults')).toHaveAttribute('id', 'defaults');
    expect(screen.getByTestId('settings-section-about')).toHaveAttribute('id', 'about');
  });

  it('SETTINGS-FOUND-004: missing IPC bridge → error banner renders', async () => {
    delete (window as { api?: IpcApi }).api;
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByTestId('settings-error')).toBeInTheDocument();
    });
    // Still shows the four placeholders — error doesn't block the shell.
    expect(screen.getByTestId('settings-placeholder-theme')).toBeInTheDocument();
  });

  it('SETTINGS-FOUND-005: appConfig.get returns error → error banner renders', async () => {
    installApi({
      get: { ok: false, error: { code: 'IO_FAILURE', message: 'permission denied' } },
    });
    render(<Settings />);
    await waitFor(() => {
      expect(screen.getByTestId('settings-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('settings-error')).toHaveTextContent(/permission denied/i);
  });
});
