import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  IPC_CHANNELS,
  type IpcApi,
  type IpcResult,
  type ChromeState,
  type ChromeStateChangedEvent,
} from '../../src/shared/ipc';

/**
 * IPC contract tests for the window-chrome extension (issue #50).
 *
 * Covers:
 *  - IPC-CHROME-001: runtime channel-string contract for the 5 new channels
 *  - IPC-CHROME-002: TS type-shape contract for `IpcApi['chrome']`
 *  - IPC-CHROME-003: payload type shapes (ChromeState, ChromeStateChangedEvent)
 */

describe('src/shared/ipc.ts — chrome (frameless titlebar) extension', () => {
  // -------------------------------------------------------------
  // IPC-CHROME-001 — new channel strings
  // -------------------------------------------------------------
  describe('IPC-CHROME-001 new channel strings', () => {
    it('CHROME_MINIMIZE === "chrome:minimize"', () => {
      expect(IPC_CHANNELS.CHROME_MINIMIZE).toBe('chrome:minimize');
    });
    it('CHROME_MAXIMIZE === "chrome:maximize"', () => {
      expect(IPC_CHANNELS.CHROME_MAXIMIZE).toBe('chrome:maximize');
    });
    it('CHROME_CLOSE === "chrome:close"', () => {
      expect(IPC_CHANNELS.CHROME_CLOSE).toBe('chrome:close');
    });
    it('CHROME_GET_STATE === "chrome:get-state"', () => {
      expect(IPC_CHANNELS.CHROME_GET_STATE).toBe('chrome:get-state');
    });
    it('CHROME_STATE_CHANGED === "chrome:state-changed"', () => {
      expect(IPC_CHANNELS.CHROME_STATE_CHANGED).toBe('chrome:state-changed');
    });

    it('all 5 chrome channel keys present on IPC_CHANNELS', () => {
      const required = [
        'CHROME_MINIMIZE',
        'CHROME_MAXIMIZE',
        'CHROME_CLOSE',
        'CHROME_GET_STATE',
        'CHROME_STATE_CHANGED',
      ];
      for (const k of required) {
        expect(Object.keys(IPC_CHANNELS)).toContain(k);
      }
    });

    it('chrome channel values are typed as their string literals', () => {
      expectTypeOf(IPC_CHANNELS.CHROME_MINIMIZE).toEqualTypeOf<'chrome:minimize'>();
      expectTypeOf(IPC_CHANNELS.CHROME_MAXIMIZE).toEqualTypeOf<'chrome:maximize'>();
      expectTypeOf(IPC_CHANNELS.CHROME_CLOSE).toEqualTypeOf<'chrome:close'>();
      expectTypeOf(IPC_CHANNELS.CHROME_GET_STATE).toEqualTypeOf<'chrome:get-state'>();
      expectTypeOf(
        IPC_CHANNELS.CHROME_STATE_CHANGED,
      ).toEqualTypeOf<'chrome:state-changed'>();
    });
  });

  // -------------------------------------------------------------
  // IPC-CHROME-002 — IpcApi['chrome'] type shape
  // -------------------------------------------------------------
  describe('IPC-CHROME-002 IpcApi.chrome shape', () => {
    it('IpcApi exposes a `chrome` namespace', () => {
      expectTypeOf<IpcApi>().toHaveProperty('chrome');
    });

    it('chrome.minimize / maximize / close return Promise<IpcResult<null>>', () => {
      expectTypeOf<IpcApi['chrome']['minimize']>().toEqualTypeOf<
        () => Promise<IpcResult<null>>
      >();
      expectTypeOf<IpcApi['chrome']['maximize']>().toEqualTypeOf<
        () => Promise<IpcResult<null>>
      >();
      expectTypeOf<IpcApi['chrome']['close']>().toEqualTypeOf<
        () => Promise<IpcResult<null>>
      >();
    });

    it('chrome.getState returns Promise<IpcResult<ChromeState>>', () => {
      expectTypeOf<IpcApi['chrome']['getState']>().toEqualTypeOf<
        () => Promise<IpcResult<ChromeState>>
      >();
    });

    it('chrome.onStateChanged subscribes and returns an unsubscribe fn', () => {
      expectTypeOf<IpcApi['chrome']['onStateChanged']>().toEqualTypeOf<
        (listener: (e: ChromeStateChangedEvent) => void) => () => void
      >();
    });
  });

  // -------------------------------------------------------------
  // IPC-CHROME-003 — payload type shapes
  // -------------------------------------------------------------
  describe('IPC-CHROME-003 payload shapes', () => {
    it('ChromeState has isMaximized: boolean and platform: string', () => {
      expectTypeOf<ChromeState>().toHaveProperty('isMaximized');
      expectTypeOf<ChromeState['isMaximized']>().toEqualTypeOf<boolean>();
      expectTypeOf<ChromeState>().toHaveProperty('platform');
      // platform is widened to a union including string so renderer code
      // doesn't need to enumerate every Node platform.
      const sample: ChromeState = { isMaximized: false, platform: 'win32' };
      expect(sample.platform).toBe('win32');
    });

    it('ChromeStateChangedEvent has isMaximized: boolean', () => {
      expectTypeOf<ChromeStateChangedEvent>().toHaveProperty('isMaximized');
      expectTypeOf<
        ChromeStateChangedEvent['isMaximized']
      >().toEqualTypeOf<boolean>();
    });
  });
});
