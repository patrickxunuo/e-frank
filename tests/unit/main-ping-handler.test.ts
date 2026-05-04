import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handlePing } from '../../src/main/ping-handler';
import type { PingResponse } from '../../src/shared/ipc';

/**
 * IPC-002, IPC-003: Main process ping handler.
 *
 * Agent B places the IPC `app:ping` handler logic in
 * `src/main/ping-handler.ts`, exposed as a pure function `handlePing`
 * so it can be unit-tested without standing up an Electron BrowserWindow
 * or the `ipcMain.handle` plumbing. This is the "extract handler" path
 * referenced in the acceptance spec.
 *
 * `receivedAt` is asserted with a tolerant window via fake timers so
 * the test is deterministic regardless of real-clock jitter.
 */
describe('handlePing in src/main/ping-handler.ts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('IPC-002: returns { reply: "pong: hello", receivedAt: <Date.now()> } for { message: "hello" }', async () => {
    const fixedNow = 1_700_000_000_000; // arbitrary but deterministic
    vi.setSystemTime(fixedNow);

    const result: PingResponse = await handlePing({ message: 'hello' });

    expect(result).toEqual({
      reply: 'pong: hello',
      receivedAt: fixedNow,
    });
    expect(typeof result.receivedAt).toBe('number');
  });

  it('IPC-002: receivedAt is close to Date.now() (real-clock sanity, no fake timers)', async () => {
    // Run this assertion outside of fake timers to confirm the handler
    // actually calls Date.now() at handling time, not some hard-coded
    // constant. We restore real timers, capture before/after bounds,
    // and assert the response value sits inside the window.
    vi.useRealTimers();

    const before = Date.now();
    const result = await handlePing({ message: 'hello' });
    const after = Date.now();

    expect(result.receivedAt).toBeGreaterThanOrEqual(before);
    expect(result.receivedAt).toBeLessThanOrEqual(after);
  });

  it('IPC-003: echoes a multi-word/numeric message — "foo bar 123"', async () => {
    const fixedNow = 1_700_000_500_000;
    vi.setSystemTime(fixedNow);

    const result = await handlePing({ message: 'foo bar 123' });

    expect(result.reply).toBe('pong: foo bar 123');
    expect(result.receivedAt).toBe(fixedNow);
  });

  it('IPC-003: handles an empty string — reply is exactly "pong: "', async () => {
    // Edge case: ensure the handler does not trim/transform the message.
    const fixedNow = 1_700_000_900_000;
    vi.setSystemTime(fixedNow);

    const result = await handlePing({ message: '' });

    expect(result.reply).toBe('pong: ');
    expect(result.receivedAt).toBe(fixedNow);
  });
});
