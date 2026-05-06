import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  IPC_CHANNELS,
  type IpcApi,
  type IpcResult,
  type PingRequest,
  type PingResponse,
} from '../../src/shared/ipc';
import type {
  Run as IpcRun,
  RunStateEvent as IpcRunStateEvent,
} from '../../src/shared/ipc';
import type { RunLogEntry } from '../../src/shared/schema/run';

/**
 * IPC contract tests for the Workflow Runner extension (issue #7).
 *
 * Covers:
 *  - IPC-RUNS-001: runtime channel-string contract for the 9 new channels
 *  - IPC-RUNS-002: TS type-shape contract for `IpcApi['runs']`
 *  - IPC-RUNS-003: regression — PING + claude:* + projects:* + secrets:* +
 *                  jira:* channels still present and typed
 *  - IPC-RUNS-004: drift guard — `Run` / `RunStateEvent` re-exported from
 *                  ipc.ts match the shapes in `shared/schema/run.ts`
 */

describe('src/shared/ipc.ts — Runs (workflow runner) extension', () => {
  // -------------------------------------------------------------
  // IPC-RUNS-001 — new channel strings
  // -------------------------------------------------------------
  describe('IPC-RUNS-001 new channel strings', () => {
    it('RUNS_START === "runs:start"', () => {
      expect(IPC_CHANNELS.RUNS_START).toBe('runs:start');
    });
    it('RUNS_CANCEL === "runs:cancel"', () => {
      expect(IPC_CHANNELS.RUNS_CANCEL).toBe('runs:cancel');
    });
    it('RUNS_APPROVE === "runs:approve"', () => {
      expect(IPC_CHANNELS.RUNS_APPROVE).toBe('runs:approve');
    });
    it('RUNS_REJECT === "runs:reject"', () => {
      expect(IPC_CHANNELS.RUNS_REJECT).toBe('runs:reject');
    });
    it('RUNS_MODIFY === "runs:modify"', () => {
      expect(IPC_CHANNELS.RUNS_MODIFY).toBe('runs:modify');
    });
    it('RUNS_CURRENT === "runs:current"', () => {
      expect(IPC_CHANNELS.RUNS_CURRENT).toBe('runs:current');
    });
    it('RUNS_LIST_HISTORY === "runs:list-history"', () => {
      expect(IPC_CHANNELS.RUNS_LIST_HISTORY).toBe('runs:list-history');
    });
    it('RUNS_CURRENT_CHANGED === "runs:current-changed"', () => {
      expect(IPC_CHANNELS.RUNS_CURRENT_CHANGED).toBe('runs:current-changed');
    });
    it('RUNS_STATE_CHANGED === "runs:state-changed"', () => {
      expect(IPC_CHANNELS.RUNS_STATE_CHANGED).toBe('runs:state-changed');
    });

    it('all 9 new channel keys present on IPC_CHANNELS', () => {
      const required = [
        'RUNS_START',
        'RUNS_CANCEL',
        'RUNS_APPROVE',
        'RUNS_REJECT',
        'RUNS_MODIFY',
        'RUNS_CURRENT',
        'RUNS_LIST_HISTORY',
        'RUNS_CURRENT_CHANGED',
        'RUNS_STATE_CHANGED',
      ];
      for (const k of required) {
        expect(Object.keys(IPC_CHANNELS)).toContain(k);
      }
    });

    it('IPC_CHANNELS values are typed as their string literals (compile-time)', () => {
      expectTypeOf(IPC_CHANNELS.RUNS_START).toEqualTypeOf<'runs:start'>();
      expectTypeOf(IPC_CHANNELS.RUNS_CANCEL).toEqualTypeOf<'runs:cancel'>();
      expectTypeOf(IPC_CHANNELS.RUNS_APPROVE).toEqualTypeOf<'runs:approve'>();
      expectTypeOf(IPC_CHANNELS.RUNS_REJECT).toEqualTypeOf<'runs:reject'>();
      expectTypeOf(IPC_CHANNELS.RUNS_MODIFY).toEqualTypeOf<'runs:modify'>();
      expectTypeOf(IPC_CHANNELS.RUNS_CURRENT).toEqualTypeOf<'runs:current'>();
      expectTypeOf(IPC_CHANNELS.RUNS_LIST_HISTORY).toEqualTypeOf<'runs:list-history'>();
      expectTypeOf(IPC_CHANNELS.RUNS_CURRENT_CHANGED).toEqualTypeOf<'runs:current-changed'>();
      expectTypeOf(IPC_CHANNELS.RUNS_STATE_CHANGED).toEqualTypeOf<'runs:state-changed'>();
    });
  });

  // -------------------------------------------------------------
  // IPC-RUNS-002 — IpcApi.runs type contract (9 methods)
  // -------------------------------------------------------------
  describe('IPC-RUNS-002 IpcApi.runs type contract', () => {
    it('IpcApi has a `runs` namespace with the expected 9 methods', () => {
      expectTypeOf<IpcApi>().toHaveProperty('runs');
      expectTypeOf<IpcApi['runs']>().toHaveProperty('start');
      expectTypeOf<IpcApi['runs']>().toHaveProperty('cancel');
      expectTypeOf<IpcApi['runs']>().toHaveProperty('approve');
      expectTypeOf<IpcApi['runs']>().toHaveProperty('reject');
      expectTypeOf<IpcApi['runs']>().toHaveProperty('modify');
      expectTypeOf<IpcApi['runs']>().toHaveProperty('current');
      expectTypeOf<IpcApi['runs']>().toHaveProperty('listHistory');
      expectTypeOf<IpcApi['runs']>().toHaveProperty('onCurrentChanged');
      expectTypeOf<IpcApi['runs']>().toHaveProperty('onStateChanged');
    });

    it('IpcApi.runs.start signature: takes projectId+ticketKey(+modeOverride?), returns Run', () => {
      type StartFn = IpcApi['runs']['start'];
      // Argument has the contractual fields.
      type Arg0 = StartFn extends (req: infer A) => unknown ? A : never;
      expectTypeOf<Arg0>().toHaveProperty('projectId');
      expectTypeOf<Arg0>().toHaveProperty('ticketKey');
      // Return is a Promise<IpcResult<{ run: Run }>>.
      type Ret = ReturnType<StartFn>;
      expectTypeOf<Ret>().toEqualTypeOf<Promise<IpcResult<{ run: IpcRun }>>>();
    });

    it('IpcApi.runs.cancel signature: takes runId, returns runId', () => {
      type Fn = IpcApi['runs']['cancel'];
      type Arg0 = Fn extends (req: infer A) => unknown ? A : never;
      expectTypeOf<Arg0>().toHaveProperty('runId');
      type Ret = ReturnType<Fn>;
      expectTypeOf<Ret>().toEqualTypeOf<Promise<IpcResult<{ runId: string }>>>();
    });

    it('IpcApi.runs.approve / reject signatures', () => {
      type ApproveFn = IpcApi['runs']['approve'];
      type RejectFn = IpcApi['runs']['reject'];
      type ApproveArg = ApproveFn extends (req: infer A) => unknown ? A : never;
      type RejectArg = RejectFn extends (req: infer A) => unknown ? A : never;
      expectTypeOf<ApproveArg>().toHaveProperty('runId');
      expectTypeOf<RejectArg>().toHaveProperty('runId');
      expectTypeOf<ReturnType<ApproveFn>>().toEqualTypeOf<
        Promise<IpcResult<{ runId: string }>>
      >();
      expectTypeOf<ReturnType<RejectFn>>().toEqualTypeOf<
        Promise<IpcResult<{ runId: string }>>
      >();
    });

    it('IpcApi.runs.modify signature: takes runId + text', () => {
      type Fn = IpcApi['runs']['modify'];
      type Arg0 = Fn extends (req: infer A) => unknown ? A : never;
      expectTypeOf<Arg0>().toHaveProperty('runId');
      expectTypeOf<Arg0>().toHaveProperty('text');
      expectTypeOf<ReturnType<Fn>>().toEqualTypeOf<
        Promise<IpcResult<{ runId: string }>>
      >();
    });

    it('IpcApi.runs.current signature: () → Promise<IpcResult<{ run: Run | null }>>', () => {
      type Fn = IpcApi['runs']['current'];
      // Argless.
      expectTypeOf<Parameters<Fn>>().toEqualTypeOf<[]>();
      type Ret = ReturnType<Fn>;
      // The IPC wrapper returns `{ run: Run | null }`, not `Run | null` directly,
      // so renderer code can extend the response shape later without breaking.
      expectTypeOf<Ret>().toEqualTypeOf<Promise<IpcResult<{ run: IpcRun | null }>>>();
    });

    it('IpcApi.runs.listHistory signature: takes projectId(+limit?), returns Run[]', () => {
      type Fn = IpcApi['runs']['listHistory'];
      type Arg0 = Fn extends (req: infer A) => unknown ? A : never;
      type Ret = ReturnType<Fn>;
      expectTypeOf<Arg0>().toHaveProperty('projectId');
      // The exact return is `Promise<IpcResult<{ runs: Run[] }>>`. Agent B
      // owns the exact wrapper choice; we pin the contractual fields here.
      expectTypeOf<Ret>().toEqualTypeOf<Promise<IpcResult<{ runs: IpcRun[] }>>>();
    });

    it('IpcApi.runs.onCurrentChanged returns an unsubscribe function', () => {
      expectTypeOf<IpcApi['runs']['onCurrentChanged']>().toEqualTypeOf<
        (listener: (e: { run: IpcRun | null }) => void) => () => void
      >();
    });

    it('IpcApi.runs.onStateChanged returns an unsubscribe function', () => {
      expectTypeOf<IpcApi['runs']['onStateChanged']>().toEqualTypeOf<
        (listener: (e: IpcRunStateEvent) => void) => () => void
      >();
    });
  });

  // -------------------------------------------------------------
  // IPC-RUNS-003 — regression: prior channels still present
  // -------------------------------------------------------------
  describe('IPC-RUNS-003 regression: prior contracts unchanged', () => {
    it('PING channel still "app:ping"', () => {
      expect(IPC_CHANNELS.PING).toBe('app:ping');
      expectTypeOf(IPC_CHANNELS.PING).toEqualTypeOf<'app:ping'>();
    });

    it('all 6 CLAUDE_* channels still present and correct', () => {
      expect(IPC_CHANNELS.CLAUDE_RUN).toBe('claude:run');
      expect(IPC_CHANNELS.CLAUDE_CANCEL).toBe('claude:cancel');
      expect(IPC_CHANNELS.CLAUDE_WRITE).toBe('claude:write');
      expect(IPC_CHANNELS.CLAUDE_STATUS).toBe('claude:status');
      expect(IPC_CHANNELS.CLAUDE_OUTPUT).toBe('claude:output');
      expect(IPC_CHANNELS.CLAUDE_EXIT).toBe('claude:exit');
    });

    it('all 5 PROJECTS_* channels still present and correct', () => {
      expect(IPC_CHANNELS.PROJECTS_LIST).toBe('projects:list');
      expect(IPC_CHANNELS.PROJECTS_GET).toBe('projects:get');
      expect(IPC_CHANNELS.PROJECTS_CREATE).toBe('projects:create');
      expect(IPC_CHANNELS.PROJECTS_UPDATE).toBe('projects:update');
      expect(IPC_CHANNELS.PROJECTS_DELETE).toBe('projects:delete');
    });

    it('all 4 SECRETS_* channels still present and correct', () => {
      expect(IPC_CHANNELS.SECRETS_SET).toBe('secrets:set');
      expect(IPC_CHANNELS.SECRETS_GET).toBe('secrets:get');
      expect(IPC_CHANNELS.SECRETS_DELETE).toBe('secrets:delete');
      expect(IPC_CHANNELS.SECRETS_LIST).toBe('secrets:list');
    });

    it('all 6 JIRA_* channels still present and correct', () => {
      expect(IPC_CHANNELS.JIRA_LIST).toBe('jira:list');
      expect(IPC_CHANNELS.JIRA_REFRESH).toBe('jira:refresh');
      expect(IPC_CHANNELS.JIRA_TEST_CONNECTION).toBe('jira:test-connection');
      expect(IPC_CHANNELS.JIRA_REFRESH_POLLERS).toBe('jira:refresh-pollers');
      expect(IPC_CHANNELS.JIRA_TICKETS_CHANGED).toBe('jira:tickets-changed');
      expect(IPC_CHANNELS.JIRA_ERROR).toBe('jira:error');
    });

    it('IpcApi retains its prior namespaces', () => {
      expectTypeOf<IpcApi>().toHaveProperty('ping');
      expectTypeOf<IpcApi>().toHaveProperty('claude');
      expectTypeOf<IpcApi>().toHaveProperty('projects');
      expectTypeOf<IpcApi>().toHaveProperty('secrets');
      expectTypeOf<IpcApi>().toHaveProperty('jira');
    });

    it('IpcApi.ping retains its original signature', () => {
      expectTypeOf<IpcApi['ping']>().toEqualTypeOf<
        (req: PingRequest) => Promise<PingResponse>
      >();
    });

    it('IpcApi.claude retains all 6 methods', () => {
      expectTypeOf<IpcApi['claude']>().toHaveProperty('run');
      expectTypeOf<IpcApi['claude']>().toHaveProperty('cancel');
      expectTypeOf<IpcApi['claude']>().toHaveProperty('write');
      expectTypeOf<IpcApi['claude']>().toHaveProperty('status');
      expectTypeOf<IpcApi['claude']>().toHaveProperty('onOutput');
      expectTypeOf<IpcApi['claude']>().toHaveProperty('onExit');
    });

    it('IpcApi.projects retains all 5 methods', () => {
      expectTypeOf<IpcApi['projects']>().toHaveProperty('list');
      expectTypeOf<IpcApi['projects']>().toHaveProperty('get');
      expectTypeOf<IpcApi['projects']>().toHaveProperty('create');
      expectTypeOf<IpcApi['projects']>().toHaveProperty('update');
      expectTypeOf<IpcApi['projects']>().toHaveProperty('delete');
    });

    it('IpcApi.secrets retains all 4 methods', () => {
      expectTypeOf<IpcApi['secrets']>().toHaveProperty('set');
      expectTypeOf<IpcApi['secrets']>().toHaveProperty('get');
      expectTypeOf<IpcApi['secrets']>().toHaveProperty('delete');
      expectTypeOf<IpcApi['secrets']>().toHaveProperty('list');
    });

    it('IpcApi.jira retains all 6 methods', () => {
      expectTypeOf<IpcApi['jira']>().toHaveProperty('list');
      expectTypeOf<IpcApi['jira']>().toHaveProperty('refresh');
      expectTypeOf<IpcApi['jira']>().toHaveProperty('testConnection');
      expectTypeOf<IpcApi['jira']>().toHaveProperty('refreshPollers');
      expectTypeOf<IpcApi['jira']>().toHaveProperty('onTicketsChanged');
      expectTypeOf<IpcApi['jira']>().toHaveProperty('onError');
    });
  });

  // -------------------------------------------------------------
  // IPC-RUNS-004 — drift guard: ipc.ts Run/RunStateEvent ↔ schema/run.ts
  // -------------------------------------------------------------
  describe('IPC-RUNS-004 drift guard: ipc.ts Run/RunStateEvent ↔ schema.Run', () => {
    it('IPC-RUNS-004: `Run` re-exported from ipc.ts is structurally equivalent to schema.Run', () => {
      type SchemaRun = import('../../src/shared/schema/run').Run;
      expectTypeOf<IpcRun>().toEqualTypeOf<SchemaRun>();
    });

    it('IPC-RUNS-004: `RunStateEvent` re-exported from ipc.ts is structurally equivalent to schema.RunStateEvent', () => {
      type SchemaEvent = import('../../src/shared/schema/run').RunStateEvent;
      expectTypeOf<IpcRunStateEvent>().toEqualTypeOf<SchemaEvent>();
    });
  });

  // -------------------------------------------------------------
  // IPC-RUNS-005 — `runs:read-log` channel + `IpcApi.runs.readLog` (issue #8)
  // -------------------------------------------------------------
  describe('IPC-RUNS-005 readLog channel + IpcApi entry', () => {
    it('IPC-RUNS-005: RUNS_READ_LOG === "runs:read-log"', () => {
      // Cast through unknown so this assertion fails loudly if the key is
      // missing rather than failing to type-check the test file.
      const channels = IPC_CHANNELS as unknown as Record<string, string>;
      expect(channels.RUNS_READ_LOG).toBe('runs:read-log');
    });

    it('IPC-RUNS-005: IpcApi.runs has a readLog method', () => {
      expectTypeOf<IpcApi['runs']>().toHaveProperty('readLog');
    });

    it('IPC-RUNS-005: IpcApi.runs.readLog signature: (req) → Promise<IpcResult<{ entries: RunLogEntry[] }>>', () => {
      type Fn = IpcApi['runs']['readLog'];
      type Arg0 = Fn extends (req: infer A) => unknown ? A : never;
      expectTypeOf<Arg0>().toHaveProperty('runId');
      type Ret = ReturnType<Fn>;
      expectTypeOf<Ret>().toEqualTypeOf<
        Promise<IpcResult<{ entries: RunLogEntry[] }>>
      >();
    });
  });
});
