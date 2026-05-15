import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  IPC_CHANNELS,
  type IpcApi,
  type PingRequest,
  type PingResponse,
  type ClaudeRunRequest,
  type ClaudeRunResponse,
  type ClaudeCancelRequest,
  type ClaudeWriteRequest,
  type ClaudeStatusResponse,
  type ClaudeOutputEvent,
  type ClaudeExitEvent,
  type IpcResult,
} from '../../src/shared/ipc';

/**
 * IPC contract tests for the Claude Process Manager extension.
 *
 * Lives in a separate file from the original `ipc-contract.test.ts`
 * (issue #1's scaffold) so the original test stays untouched. Covers:
 *  - IPC-CPM-001: runtime channel-string contract for the new claude:* channels
 *  - IPC-CPM-002: TS type-shape contract for `IpcApi['claude']` methods
 *  - IPC-CPM-003: regression — the existing PING contract still holds
 */

describe('src/shared/ipc.ts — Claude Process Manager extension', () => {
  // -------------------------------------------------------------
  // IPC-CPM-001 — channel strings
  // -------------------------------------------------------------
  describe('IPC-CPM-001 channel strings', () => {
    it('CLAUDE_RUN === "claude:run"', () => {
      expect(IPC_CHANNELS.CLAUDE_RUN).toBe('claude:run');
    });

    it('CLAUDE_CANCEL === "claude:cancel"', () => {
      expect(IPC_CHANNELS.CLAUDE_CANCEL).toBe('claude:cancel');
    });

    it('CLAUDE_WRITE === "claude:write"', () => {
      expect(IPC_CHANNELS.CLAUDE_WRITE).toBe('claude:write');
    });

    it('CLAUDE_STATUS === "claude:status"', () => {
      expect(IPC_CHANNELS.CLAUDE_STATUS).toBe('claude:status');
    });

    it('CLAUDE_OUTPUT === "claude:output"', () => {
      expect(IPC_CHANNELS.CLAUDE_OUTPUT).toBe('claude:output');
    });

    it('CLAUDE_EXIT === "claude:exit"', () => {
      expect(IPC_CHANNELS.CLAUDE_EXIT).toBe('claude:exit');
    });

    it('all channel keys are present on IPC_CHANNELS', () => {
      const required = [
        'PING',
        'CLAUDE_RUN',
        'CLAUDE_CANCEL',
        'CLAUDE_WRITE',
        'CLAUDE_STATUS',
        'CLAUDE_OUTPUT',
        'CLAUDE_EXIT',
      ];
      for (const k of required) {
        expect(Object.keys(IPC_CHANNELS)).toContain(k);
      }
    });

    it('IPC_CHANNELS values are typed as their string literals (compile-time)', () => {
      expectTypeOf(IPC_CHANNELS.CLAUDE_RUN).toEqualTypeOf<'claude:run'>();
      expectTypeOf(IPC_CHANNELS.CLAUDE_CANCEL).toEqualTypeOf<'claude:cancel'>();
      expectTypeOf(IPC_CHANNELS.CLAUDE_WRITE).toEqualTypeOf<'claude:write'>();
      expectTypeOf(IPC_CHANNELS.CLAUDE_STATUS).toEqualTypeOf<'claude:status'>();
      expectTypeOf(IPC_CHANNELS.CLAUDE_OUTPUT).toEqualTypeOf<'claude:output'>();
      expectTypeOf(IPC_CHANNELS.CLAUDE_EXIT).toEqualTypeOf<'claude:exit'>();
    });
  });

  // -------------------------------------------------------------
  // IPC-CPM-002 — type contract for IpcApi.claude.*
  // -------------------------------------------------------------
  describe('IPC-CPM-002 IpcApi.claude type contract', () => {
    it('IpcApi has a `claude` namespace with the expected methods', () => {
      expectTypeOf<IpcApi>().toHaveProperty('claude');
      expectTypeOf<IpcApi['claude']>().toHaveProperty('run');
      expectTypeOf<IpcApi['claude']>().toHaveProperty('cancel');
      expectTypeOf<IpcApi['claude']>().toHaveProperty('write');
      expectTypeOf<IpcApi['claude']>().toHaveProperty('status');
      expectTypeOf<IpcApi['claude']>().toHaveProperty('onOutput');
      expectTypeOf<IpcApi['claude']>().toHaveProperty('onExit');
    });

    it('IpcApi.claude.run signature', () => {
      expectTypeOf<IpcApi['claude']['run']>().toEqualTypeOf<
        (req: ClaudeRunRequest) => Promise<IpcResult<ClaudeRunResponse>>
      >();
    });

    it('IpcApi.claude.cancel signature', () => {
      expectTypeOf<IpcApi['claude']['cancel']>().toEqualTypeOf<
        (req: ClaudeCancelRequest) => Promise<IpcResult<{ runId: string }>>
      >();
    });

    it('IpcApi.claude.write signature', () => {
      expectTypeOf<IpcApi['claude']['write']>().toEqualTypeOf<
        (
          req: ClaudeWriteRequest,
        ) => Promise<IpcResult<{ bytesWritten: number }>>
      >();
    });

    it('IpcApi.claude.status signature', () => {
      expectTypeOf<IpcApi['claude']['status']>().toEqualTypeOf<
        () => Promise<IpcResult<ClaudeStatusResponse>>
      >();
    });

    it('IpcApi.claude.onOutput signature returns an unsubscribe function', () => {
      expectTypeOf<IpcApi['claude']['onOutput']>().toEqualTypeOf<
        (listener: (e: ClaudeOutputEvent) => void) => () => void
      >();
    });

    it('IpcApi.claude.onExit signature returns an unsubscribe function', () => {
      expectTypeOf<IpcApi['claude']['onExit']>().toEqualTypeOf<
        (listener: (e: ClaudeExitEvent) => void) => () => void
      >();
    });

    it('payload types have the contractual fields', () => {
      // ClaudeRunRequest
      expectTypeOf<ClaudeRunRequest>().toHaveProperty('ticketKey');
      expectTypeOf<ClaudeRunRequest['ticketKey']>().toEqualTypeOf<string>();
      expectTypeOf<ClaudeRunRequest>().toHaveProperty('cwd');
      expectTypeOf<ClaudeRunRequest['cwd']>().toEqualTypeOf<string>();
      expectTypeOf<ClaudeRunRequest['timeoutMs']>().toEqualTypeOf<
        number | undefined
      >();

      // ClaudeRunResponse
      expectTypeOf<ClaudeRunResponse>().toHaveProperty('runId');
      expectTypeOf<ClaudeRunResponse['runId']>().toEqualTypeOf<string>();
      expectTypeOf<ClaudeRunResponse>().toHaveProperty('pid');
      expectTypeOf<ClaudeRunResponse['pid']>().toEqualTypeOf<
        number | undefined
      >();
      expectTypeOf<ClaudeRunResponse>().toHaveProperty('startedAt');
      expectTypeOf<ClaudeRunResponse['startedAt']>().toEqualTypeOf<number>();

      // ClaudeCancelRequest
      expectTypeOf<ClaudeCancelRequest>().toHaveProperty('runId');
      expectTypeOf<ClaudeCancelRequest['runId']>().toEqualTypeOf<string>();

      // ClaudeWriteRequest
      expectTypeOf<ClaudeWriteRequest>().toHaveProperty('runId');
      expectTypeOf<ClaudeWriteRequest['runId']>().toEqualTypeOf<string>();
      expectTypeOf<ClaudeWriteRequest>().toHaveProperty('text');
      expectTypeOf<ClaudeWriteRequest['text']>().toEqualTypeOf<string>();

      // ClaudeStatusResponse
      expectTypeOf<ClaudeStatusResponse>().toHaveProperty('active');
      expectTypeOf<ClaudeStatusResponse['active']>().toEqualTypeOf<
        | { runId: string; pid: number | undefined; startedAt: number }
        | null
      >();

      // ClaudeOutputEvent
      expectTypeOf<ClaudeOutputEvent>().toHaveProperty('runId');
      expectTypeOf<ClaudeOutputEvent['runId']>().toEqualTypeOf<string>();
      expectTypeOf<ClaudeOutputEvent>().toHaveProperty('stream');
      expectTypeOf<ClaudeOutputEvent['stream']>().toEqualTypeOf<
        'stdout' | 'stderr'
      >();
      expectTypeOf<ClaudeOutputEvent>().toHaveProperty('line');
      expectTypeOf<ClaudeOutputEvent['line']>().toEqualTypeOf<string>();
      expectTypeOf<ClaudeOutputEvent>().toHaveProperty('timestamp');
      expectTypeOf<ClaudeOutputEvent['timestamp']>().toEqualTypeOf<number>();

      // ClaudeExitEvent — note `signal` is serialized as `string | null`
      // across IPC (Signals are not structured-clonable as a literal type).
      expectTypeOf<ClaudeExitEvent>().toHaveProperty('runId');
      expectTypeOf<ClaudeExitEvent['runId']>().toEqualTypeOf<string>();
      expectTypeOf<ClaudeExitEvent>().toHaveProperty('exitCode');
      expectTypeOf<ClaudeExitEvent['exitCode']>().toEqualTypeOf<
        number | null
      >();
      expectTypeOf<ClaudeExitEvent>().toHaveProperty('signal');
      expectTypeOf<ClaudeExitEvent['signal']>().toEqualTypeOf<string | null>();
      expectTypeOf<ClaudeExitEvent>().toHaveProperty('durationMs');
      expectTypeOf<ClaudeExitEvent['durationMs']>().toEqualTypeOf<number>();
      expectTypeOf<ClaudeExitEvent>().toHaveProperty('reason');
      expectTypeOf<ClaudeExitEvent['reason']>().toEqualTypeOf<
        'completed' | 'cancelled' | 'timeout' | 'error'
      >();
    });

    it('IpcResult<T> is a discriminated union with ok flag', () => {
      type Sample = IpcResult<{ x: number }>;
      // ok: true branch
      expectTypeOf<Extract<Sample, { ok: true }>>().toEqualTypeOf<{
        ok: true;
        data: { x: number };
      }>();
      // ok: false branch
      expectTypeOf<Extract<Sample, { ok: false }>>().toEqualTypeOf<{
        ok: false;
        error: { code: string; message: string };
      }>();
    });
  });

  // -------------------------------------------------------------
  // IPC-CPM-003 — regression: PING contract from #1 still works
  // -------------------------------------------------------------
  describe('IPC-CPM-003 regression: PING contract from #1', () => {
    it('IPC_CHANNELS.PING is still "app:ping"', () => {
      expect(IPC_CHANNELS.PING).toBe('app:ping');
    });

    it('IPC_CHANNELS.PING is still typed as the literal "app:ping"', () => {
      expectTypeOf(IPC_CHANNELS.PING).toEqualTypeOf<'app:ping'>();
    });

    it('IpcApi.ping retains its original signature', () => {
      expectTypeOf<IpcApi['ping']>().toEqualTypeOf<
        (req: PingRequest) => Promise<PingResponse>
      >();
    });

    it('PingRequest / PingResponse shapes are unchanged', () => {
      expectTypeOf<PingRequest>().toHaveProperty('message');
      expectTypeOf<PingRequest['message']>().toEqualTypeOf<string>();
      expectTypeOf<PingResponse>().toHaveProperty('reply');
      expectTypeOf<PingResponse['reply']>().toEqualTypeOf<string>();
      expectTypeOf<PingResponse>().toHaveProperty('receivedAt');
      expectTypeOf<PingResponse['receivedAt']>().toEqualTypeOf<number>();
    });
  });

  // -------------------------------------------------------------
  // Drift guard — shared/ipc types vs claude-process-manager types
  // -------------------------------------------------------------
  // The shared/ipc module deliberately duplicates the manager's request /
  // response / event shapes (instead of re-exporting) so the renderer never
  // pulls in main-process-only deps. These compile-time assertions ensure
  // the two definitions stay structurally compatible. They use a
  // `typeof import('...')` type expression so no runtime import is needed.
  describe('shared ↔ manager type drift guard', () => {
    type ManagerModule = typeof import('../../src/main/modules/claude-process-manager');
    type ManagerInstance = InstanceType<ManagerModule['ClaudeProcessManager']>;

    it('ClaudeRunRequest is structurally assignable to manager RunRequest', () => {
      // The IPC type is an intentional subset of manager RunRequest: the
      // manager exposes a `command?: string` override (#GH-85) that the
      // workflow runner injects per-run from `appConfig.claudeCliPath`,
      // but the IPC handler in `src/main/index.ts` deliberately strips
      // unknown fields so a renderer cannot smuggle a command. We assert
      // structural assignability (ClaudeRunRequest → ManagerRunRequest)
      // instead of strict equality so this invariant is locked in.
      type ManagerRunRequest = Parameters<ManagerInstance['run']>[0];
      expectTypeOf<ClaudeRunRequest>().toMatchTypeOf<ManagerRunRequest>();
    });

    it('ClaudeRunResponse matches manager RunResponse (success branch of run())', () => {
      type ManagerRunResult = ReturnType<ManagerInstance['run']>;
      type ManagerRunResponse = Extract<ManagerRunResult, { ok: true }>['data'];
      expectTypeOf<ClaudeRunResponse>().toEqualTypeOf<ManagerRunResponse>();
    });

    it('ClaudeOutputEvent shape matches the IPC contract', () => {
      // The manager's OutputEvent is structurally identical except it's
      // not exported as a named type from the manager module — we pin the
      // IPC shape's required fields here.
      expectTypeOf<ClaudeOutputEvent['runId']>().toEqualTypeOf<string>();
      expectTypeOf<ClaudeOutputEvent['stream']>().toEqualTypeOf<'stdout' | 'stderr'>();
      expectTypeOf<ClaudeOutputEvent['line']>().toEqualTypeOf<string>();
      expectTypeOf<ClaudeOutputEvent['timestamp']>().toEqualTypeOf<number>();
    });

    it('ClaudeExitEvent matches manager ExitEvent except for `signal` (intentional IPC string-coercion)', () => {
      // ExitEvent.signal is `NodeJS.Signals | null` in the manager (Node typing)
      // but `string | null` over IPC because the renderer must not depend on
      // Node's `NodeJS.Signals` type. This test pins the IPC shape.
      expectTypeOf<ClaudeExitEvent['signal']>().toEqualTypeOf<string | null>();
      expectTypeOf<ClaudeExitEvent['exitCode']>().toEqualTypeOf<number | null>();
      expectTypeOf<ClaudeExitEvent['durationMs']>().toEqualTypeOf<number>();
      expectTypeOf<ClaudeExitEvent['reason']>().toEqualTypeOf<
        'completed' | 'cancelled' | 'timeout' | 'error'
      >();
      expectTypeOf<ClaudeExitEvent['runId']>().toEqualTypeOf<string>();
    });
  });
});
