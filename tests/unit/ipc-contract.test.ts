import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  IPC_CHANNELS,
  type PingRequest,
  type PingResponse,
  type IpcApi,
} from '../../src/shared/ipc';

/**
 * IPC-001: IPC contract module exports correct shape.
 *
 * The module at `src/shared/ipc.ts` is the single source of truth for
 * channel names and payload shapes traveling across the main <-> renderer
 * boundary. This test asserts:
 *   - the runtime constant `IPC_CHANNELS` is the expected shape
 *   - the channel string for PING is exactly `app:ping`
 *   - the TS types `PingRequest`, `PingResponse`, and the `IpcApi`
 *     interface are exported with the contractually-correct shapes
 *
 * Type-level assertions use vitest's `expectTypeOf` so the build fails
 * if Agent B's implementation drifts from the contract.
 */
describe('src/shared/ipc.ts (IPC-001)', () => {
  it('IPC-001: exports IPC_CHANNELS with PING === "app:ping"', () => {
    expect(IPC_CHANNELS).toBeDefined();
    expect(IPC_CHANNELS.PING).toBe('app:ping');
  });

  it('IPC-001: IPC_CHANNELS is an object whose values are channel strings', () => {
    // The contract uses `as const` so each value is a literal string.
    // We can't directly assert "as const-ness" at runtime, but we can
    // assert: it's a non-null object, every value is a string, and the
    // keys we expect are present.
    expect(typeof IPC_CHANNELS).toBe('object');
    expect(IPC_CHANNELS).not.toBeNull();

    for (const value of Object.values(IPC_CHANNELS)) {
      expect(typeof value).toBe('string');
    }

    // PING is the only channel required by this scaffold.
    expect(Object.keys(IPC_CHANNELS)).toContain('PING');
  });

  it('IPC-001: PingRequest, PingResponse, IpcApi type shapes are correct', () => {
    // Compile-time assertions. If Agent B's types drift, `tsc` will fail.

    // PingRequest must have a `message: string` field.
    expectTypeOf<PingRequest>().toHaveProperty('message');
    expectTypeOf<PingRequest['message']>().toEqualTypeOf<string>();

    // PingResponse must have `reply: string` and `receivedAt: number`.
    expectTypeOf<PingResponse>().toHaveProperty('reply');
    expectTypeOf<PingResponse['reply']>().toEqualTypeOf<string>();
    expectTypeOf<PingResponse>().toHaveProperty('receivedAt');
    expectTypeOf<PingResponse['receivedAt']>().toEqualTypeOf<number>();

    // IpcApi must expose a `ping` method with the contractual signature.
    expectTypeOf<IpcApi>().toHaveProperty('ping');
    expectTypeOf<IpcApi['ping']>().toEqualTypeOf<
      (req: PingRequest) => Promise<PingResponse>
    >();
  });

  it('IPC-001: IPC_CHANNELS.PING is typed as the literal "app:ping" (compile-time)', () => {
    // The contract specifies `as const`, so this literal type narrowing
    // must hold. If Agent B drops `as const`, this assertion fails.
    expectTypeOf(IPC_CHANNELS.PING).toEqualTypeOf<'app:ping'>();
  });
});
