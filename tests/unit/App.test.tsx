// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import App from '../../src/renderer/App';
import type { IpcApi, IpcResult, PingResponse } from '../../src/shared/ipc';

/**
 * Minimal IpcApi stub for renderer tests. App.tsx only uses `api.ping`, but
 * `IpcApi` requires `claude` too (added in #2), so we satisfy the type with
 * vi.fn() shims that never actually run for these tests.
 */
function makeIpcApiStub(pingResponse: PingResponse): IpcApi {
  const unusedErr = (): IpcResult<never> => ({
    ok: false,
    error: { code: 'NOT_USED_IN_FE_TESTS', message: '' },
  });
  return {
    ping: vi.fn<IpcApi['ping']>().mockResolvedValue(pingResponse),
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
  };
}

/**
 * FE-001..003: Renderer-level tests for <App />.
 *
 * Setup notes:
 *   - jsdom env is enabled via the file-level `// @vitest-environment`
 *     pragma above, so the suite stays self-contained even if vitest
 *     config defaults to `node`.
 *   - `window.api` is the contextBridge'd IpcApi the preload exposes.
 *     We stub it per-test on the global `window` object.
 *   - For FE-003 we delete `window.api` to simulate the IPC bridge
 *     being unavailable (e.g. running in a plain browser, or in a
 *     misconfigured Electron build with contextIsolation broken).
 *     The component MUST handle this gracefully — it must mount, and
 *     clicking Ping must not throw.
 */

declare global {
  // The preload script declares this; we redeclare here so the test
  // can assign/delete it without TS errors.
  interface Window {
    api?: IpcApi;
  }
}

const SUBTITLE = 'Desktop AI Ticket → PR Automation';

afterEach(() => {
  cleanup();
  // Reset window.api between tests so state never leaks.
  delete (window as { api?: IpcApi }).api;
  vi.restoreAllMocks();
});

describe('<App /> — FE-001: initial render with stubbed window.api', () => {
  beforeEach(() => {
    const pingResponse: PingResponse = { reply: 'pong: hello', receivedAt: 0 };
    (window as { api?: IpcApi }).api = makeIpcApiStub(pingResponse);
  });

  it('FE-001: renders title, subtitle, and ping button', () => {
    render(<App />);

    expect(screen.getByTestId('app-title')).toHaveTextContent('e-frank');
    expect(screen.getByTestId('app-subtitle')).toHaveTextContent(SUBTITLE);
    expect(screen.getByTestId('ping-button')).toBeInTheDocument();
    expect(screen.getByTestId('ping-result')).toBeInTheDocument();
  });
});

describe('<App /> — FE-002: clicking Ping resolves and renders reply', () => {
  beforeEach(() => {
    const pingResponse: PingResponse = { reply: 'pong: hello', receivedAt: 0 };
    (window as { api?: IpcApi }).api = makeIpcApiStub(pingResponse);
  });

  it('FE-002: clicking ping-button populates ping-result with "pong: hello"', async () => {
    render(<App />);

    const button = screen.getByTestId('ping-button');
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByTestId('ping-result')).toHaveTextContent('pong: hello');
    });

    // Sanity: the stub was actually invoked with the contractual payload.
    const stubbed = (window as { api?: IpcApi }).api?.ping as ReturnType<typeof vi.fn>;
    expect(stubbed).toHaveBeenCalledTimes(1);
    expect(stubbed).toHaveBeenCalledWith({ message: 'hello' });
  });
});

describe('<App /> — FE-003: graceful behavior when window.api is undefined', () => {
  beforeEach(() => {
    // Explicitly remove the bridge.
    delete (window as { api?: IpcApi }).api;
  });

  it('FE-003: App mounts without throwing when window.api is undefined', () => {
    expect(() => render(<App />)).not.toThrow();

    // Static structure must still render.
    expect(screen.getByTestId('app-title')).toHaveTextContent('e-frank');
    expect(screen.getByTestId('ping-button')).toBeInTheDocument();
    expect(screen.getByTestId('ping-result')).toBeInTheDocument();
  });

  it('FE-003: clicking Ping with no IPC bridge does not throw and shows non-empty graceful state', async () => {
    render(<App />);

    const button = screen.getByTestId('ping-button');
    expect(() => fireEvent.click(button)).not.toThrow();

    // Allow React to flush any pending state updates from the click
    // handler's error path. We assert the result element exists and
    // contains some non-empty text — the exact wording is left to the
    // implementer, but it must not be empty (so the user sees feedback
    // rather than silence) and must NOT contain "pong:" (because no
    // ping ever succeeded).
    await waitFor(() => {
      const result = screen.getByTestId('ping-result');
      const text = (result.textContent ?? '').trim();
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/pong:/);
    });
  });
});
