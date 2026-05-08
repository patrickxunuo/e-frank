// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Titlebar } from '../../src/renderer/components/Titlebar';
import type {
  ChromeState,
  ChromeStateChangedEvent,
  IpcApi,
  IpcResult,
} from '../../src/shared/ipc';

/**
 * TITLEBAR-001..006 — custom 32px frameless titlebar (issue #50).
 *
 * Strategy: stub `window.api.chrome` with vi mocks, drive renders by
 * platform + maximize state, assert what's painted + what gets called.
 * The chrome API is the only API the Titlebar reaches into, so the rest
 * of `window.api` can be omitted.
 */

declare global {
  interface Window {
    api?: IpcApi;
  }
}

interface ChromeApiStubControls {
  emitStateChanged: (e: ChromeStateChangedEvent) => void;
  api: IpcApi['chrome'];
  minimizeMock: ReturnType<typeof vi.fn>;
  maximizeMock: ReturnType<typeof vi.fn>;
  closeMock: ReturnType<typeof vi.fn>;
}

function makeChromeStub(initial: ChromeState): ChromeApiStubControls {
  const listeners = new Set<(e: ChromeStateChangedEvent) => void>();
  const ok = <T,>(data: T): IpcResult<T> => ({ ok: true, data });

  const minimizeMock = vi.fn().mockResolvedValue(ok(null));
  const maximizeMock = vi.fn().mockResolvedValue(ok(null));
  const closeMock = vi.fn().mockResolvedValue(ok(null));

  const api: IpcApi['chrome'] = {
    minimize: minimizeMock as IpcApi['chrome']['minimize'],
    maximize: maximizeMock as IpcApi['chrome']['maximize'],
    close: closeMock as IpcApi['chrome']['close'],
    getState: vi.fn().mockResolvedValue(ok(initial)),
    onStateChanged: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    api,
    minimizeMock,
    maximizeMock,
    closeMock,
    emitStateChanged: (e) => {
      for (const l of listeners) l(e);
    },
  };
}

function installChromeStub(stub: ChromeApiStubControls): void {
  (window as { api?: Partial<IpcApi> }).api = {
    chrome: stub.api,
  } as IpcApi;
}

afterEach(() => {
  cleanup();
  delete (window as { api?: IpcApi }).api;
  vi.restoreAllMocks();
});

describe('<Titlebar /> — TITLEBAR-001..006', () => {
  it('TITLEBAR-001: renders the testid on Windows with all three controls', async () => {
    const stub = makeChromeStub({ isMaximized: false, platform: 'win32' });
    installChromeStub(stub);
    render(<Titlebar />);

    await waitFor(() => {
      const bar = screen.getByTestId('app-titlebar');
      expect(bar).toBeInTheDocument();
      expect(bar.getAttribute('data-platform')).toBe('win32');
    });
    expect(screen.getByTestId('app-titlebar-min')).toBeInTheDocument();
    expect(screen.getByTestId('app-titlebar-max')).toBeInTheDocument();
    expect(screen.getByTestId('app-titlebar-close')).toBeInTheDocument();
  });

  it('TITLEBAR-002: hides the right-side controls on macOS', async () => {
    const stub = makeChromeStub({ isMaximized: false, platform: 'darwin' });
    installChromeStub(stub);
    render(<Titlebar />);

    await waitFor(() => {
      const bar = screen.getByTestId('app-titlebar');
      expect(bar.getAttribute('data-platform')).toBe('darwin');
    });
    expect(screen.queryByTestId('app-titlebar-min')).not.toBeInTheDocument();
    expect(screen.queryByTestId('app-titlebar-max')).not.toBeInTheDocument();
    expect(screen.queryByTestId('app-titlebar-close')).not.toBeInTheDocument();
  });

  it('TITLEBAR-003: clicking min/max/close calls the chrome API', async () => {
    const stub = makeChromeStub({ isMaximized: false, platform: 'win32' });
    installChromeStub(stub);
    render(<Titlebar />);

    const min = await screen.findByTestId('app-titlebar-min');
    const max = screen.getByTestId('app-titlebar-max');
    const close = screen.getByTestId('app-titlebar-close');

    fireEvent.click(min);
    fireEvent.click(max);
    fireEvent.click(close);

    expect(stub.minimizeMock).toHaveBeenCalledTimes(1);
    expect(stub.maximizeMock).toHaveBeenCalledTimes(1);
    expect(stub.closeMock).toHaveBeenCalledTimes(1);
  });

  it('TITLEBAR-004: max button reflects initial isMaximized=true with aria-pressed and Restore label', async () => {
    const stub = makeChromeStub({ isMaximized: true, platform: 'win32' });
    installChromeStub(stub);
    render(<Titlebar />);

    const max = await screen.findByTestId('app-titlebar-max');
    await waitFor(() => {
      expect(max.getAttribute('aria-pressed')).toBe('true');
      expect(max.getAttribute('aria-label')).toBe('Restore');
    });
  });

  it('TITLEBAR-005: state-changed event flips the max button aria-pressed live', async () => {
    const stub = makeChromeStub({ isMaximized: false, platform: 'win32' });
    installChromeStub(stub);
    render(<Titlebar />);

    const max = await screen.findByTestId('app-titlebar-max');
    expect(max.getAttribute('aria-pressed')).toBe('false');

    act(() => {
      stub.emitStateChanged({ isMaximized: true });
    });
    await waitFor(() => {
      expect(max.getAttribute('aria-pressed')).toBe('true');
      expect(max.getAttribute('aria-label')).toBe('Restore');
    });

    act(() => {
      stub.emitStateChanged({ isMaximized: false });
    });
    await waitFor(() => {
      expect(max.getAttribute('aria-pressed')).toBe('false');
      expect(max.getAttribute('aria-label')).toBe('Maximize');
    });
  });

  it('TITLEBAR-006: renders nothing if window.api is missing (preload not loaded)', () => {
    delete (window as { api?: IpcApi }).api;
    const { container } = render(<Titlebar />);
    expect(container.firstChild).toBeNull();
  });
});
