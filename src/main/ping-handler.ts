import type { PingRequest, PingResponse } from '../shared/ipc.js';

/**
 * Pure handler for the `app:ping` IPC channel.
 *
 * Lives in its own file (no Electron imports) so it can be unit-tested
 * directly with Vitest in a Node environment.
 */
export function handlePing(req: PingRequest): PingResponse {
  return {
    reply: 'pong: ' + req.message,
    receivedAt: Date.now(),
  };
}
