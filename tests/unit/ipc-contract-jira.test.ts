import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  IPC_CHANNELS,
  type IpcApi,
  type IpcResult,
  type PingRequest,
  type PingResponse,
  type TicketDto,
  type JiraListRequest,
  type JiraListResponse,
  type JiraRefreshRequest,
  type JiraRefreshResponse,
  type JiraTestConnectionRequest,
  type JiraTestConnectionResponse,
  type JiraTicketsChangedEvent,
  type JiraErrorEvent,
} from '../../src/shared/ipc';

/**
 * IPC contract tests for the Jira polling extension (issue #4).
 *
 * Covers:
 *  - IPC-J-001: runtime channel-string contract for the 6 new channels
 *  - IPC-J-002: TS type-shape contract for `IpcApi['jira']`
 *  - IPC-J-003: regression — PING + CLAUDE_* + PROJECTS_* + SECRETS_*
 *               channels still present and typed
 *  - IPC-J-004: drift guard — `TicketDto` from ipc.ts ≡ `Ticket` from
 *               schema/ticket.ts (use the `import('...')` type form)
 */

describe('src/shared/ipc.ts — Jira extension', () => {
  // -------------------------------------------------------------
  // IPC-J-001 — new channel strings
  // -------------------------------------------------------------
  describe('IPC-J-001 new channel strings', () => {
    it('JIRA_LIST === "jira:list"', () => {
      expect(IPC_CHANNELS.JIRA_LIST).toBe('jira:list');
    });
    it('JIRA_REFRESH === "jira:refresh"', () => {
      expect(IPC_CHANNELS.JIRA_REFRESH).toBe('jira:refresh');
    });
    it('JIRA_TEST_CONNECTION === "jira:test-connection"', () => {
      expect(IPC_CHANNELS.JIRA_TEST_CONNECTION).toBe('jira:test-connection');
    });
    it('JIRA_REFRESH_POLLERS === "jira:refresh-pollers"', () => {
      expect(IPC_CHANNELS.JIRA_REFRESH_POLLERS).toBe('jira:refresh-pollers');
    });
    it('JIRA_TICKETS_CHANGED === "jira:tickets-changed"', () => {
      expect(IPC_CHANNELS.JIRA_TICKETS_CHANGED).toBe('jira:tickets-changed');
    });
    it('JIRA_ERROR === "jira:error"', () => {
      expect(IPC_CHANNELS.JIRA_ERROR).toBe('jira:error');
    });

    it('all 6 new channel keys present on IPC_CHANNELS', () => {
      const required = [
        'JIRA_LIST',
        'JIRA_REFRESH',
        'JIRA_TEST_CONNECTION',
        'JIRA_REFRESH_POLLERS',
        'JIRA_TICKETS_CHANGED',
        'JIRA_ERROR',
      ];
      for (const k of required) {
        expect(Object.keys(IPC_CHANNELS)).toContain(k);
      }
    });

    it('IPC_CHANNELS values are typed as their string literals (compile-time)', () => {
      expectTypeOf(IPC_CHANNELS.JIRA_LIST).toEqualTypeOf<'jira:list'>();
      expectTypeOf(IPC_CHANNELS.JIRA_REFRESH).toEqualTypeOf<'jira:refresh'>();
      expectTypeOf(
        IPC_CHANNELS.JIRA_TEST_CONNECTION,
      ).toEqualTypeOf<'jira:test-connection'>();
      expectTypeOf(
        IPC_CHANNELS.JIRA_REFRESH_POLLERS,
      ).toEqualTypeOf<'jira:refresh-pollers'>();
      expectTypeOf(
        IPC_CHANNELS.JIRA_TICKETS_CHANGED,
      ).toEqualTypeOf<'jira:tickets-changed'>();
      expectTypeOf(IPC_CHANNELS.JIRA_ERROR).toEqualTypeOf<'jira:error'>();
    });
  });

  // -------------------------------------------------------------
  // IPC-J-002 — IpcApi.jira type contract (6 methods)
  // -------------------------------------------------------------
  describe('IPC-J-002 IpcApi.jira type contract', () => {
    it('IpcApi has a `jira` namespace with the expected 6 methods', () => {
      expectTypeOf<IpcApi>().toHaveProperty('jira');
      expectTypeOf<IpcApi['jira']>().toHaveProperty('list');
      expectTypeOf<IpcApi['jira']>().toHaveProperty('refresh');
      expectTypeOf<IpcApi['jira']>().toHaveProperty('testConnection');
      expectTypeOf<IpcApi['jira']>().toHaveProperty('refreshPollers');
      expectTypeOf<IpcApi['jira']>().toHaveProperty('onTicketsChanged');
      expectTypeOf<IpcApi['jira']>().toHaveProperty('onError');
    });

    it('IpcApi.jira.list signature', () => {
      expectTypeOf<IpcApi['jira']['list']>().toEqualTypeOf<
        (req: JiraListRequest) => Promise<IpcResult<JiraListResponse>>
      >();
    });

    it('IpcApi.jira.refresh signature', () => {
      expectTypeOf<IpcApi['jira']['refresh']>().toEqualTypeOf<
        (req: JiraRefreshRequest) => Promise<IpcResult<JiraRefreshResponse>>
      >();
    });

    it('IpcApi.jira.testConnection signature', () => {
      expectTypeOf<IpcApi['jira']['testConnection']>().toEqualTypeOf<
        (
          req: JiraTestConnectionRequest,
        ) => Promise<IpcResult<JiraTestConnectionResponse>>
      >();
    });

    it('IpcApi.jira.refreshPollers signature', () => {
      expectTypeOf<IpcApi['jira']['refreshPollers']>().toEqualTypeOf<
        () => Promise<IpcResult<{ projectIds: string[] }>>
      >();
    });

    it('IpcApi.jira.onTicketsChanged returns an unsubscribe function', () => {
      expectTypeOf<IpcApi['jira']['onTicketsChanged']>().toEqualTypeOf<
        (listener: (e: JiraTicketsChangedEvent) => void) => () => void
      >();
    });

    it('IpcApi.jira.onError returns an unsubscribe function', () => {
      expectTypeOf<IpcApi['jira']['onError']>().toEqualTypeOf<
        (listener: (e: JiraErrorEvent) => void) => () => void
      >();
    });

    it('payload types have the contractual fields', () => {
      // JiraListRequest / JiraRefreshRequest
      expectTypeOf<JiraListRequest>().toHaveProperty('projectId');
      expectTypeOf<JiraListRequest['projectId']>().toEqualTypeOf<string>();
      expectTypeOf<JiraRefreshRequest>().toHaveProperty('projectId');
      expectTypeOf<JiraRefreshRequest['projectId']>().toEqualTypeOf<string>();

      // JiraListResponse / JiraRefreshResponse
      expectTypeOf<JiraListResponse>().toHaveProperty('tickets');
      expectTypeOf<JiraListResponse['tickets']>().toEqualTypeOf<TicketDto[]>();
      expectTypeOf<JiraRefreshResponse>().toHaveProperty('tickets');
      expectTypeOf<JiraRefreshResponse['tickets']>().toEqualTypeOf<TicketDto[]>();

      // JiraTestConnectionRequest
      expectTypeOf<JiraTestConnectionRequest>().toHaveProperty('host');
      expectTypeOf<JiraTestConnectionRequest['host']>().toEqualTypeOf<string>();
      expectTypeOf<JiraTestConnectionRequest>().toHaveProperty('email');
      expectTypeOf<JiraTestConnectionRequest['email']>().toEqualTypeOf<string>();
      expectTypeOf<JiraTestConnectionRequest>().toHaveProperty('apiToken');
      expectTypeOf<JiraTestConnectionRequest['apiToken']>().toEqualTypeOf<string>();

      // JiraTestConnectionResponse
      expectTypeOf<JiraTestConnectionResponse>().toHaveProperty('accountId');
      expectTypeOf<JiraTestConnectionResponse['accountId']>().toEqualTypeOf<string>();
      expectTypeOf<JiraTestConnectionResponse>().toHaveProperty('displayName');
      expectTypeOf<
        JiraTestConnectionResponse['displayName']
      >().toEqualTypeOf<string>();
      expectTypeOf<JiraTestConnectionResponse>().toHaveProperty('emailAddress');
      expectTypeOf<
        JiraTestConnectionResponse['emailAddress']
      >().toEqualTypeOf<string>();

      // Event payloads
      expectTypeOf<JiraTicketsChangedEvent>().toHaveProperty('projectId');
      expectTypeOf<
        JiraTicketsChangedEvent['projectId']
      >().toEqualTypeOf<string>();
      expectTypeOf<JiraTicketsChangedEvent>().toHaveProperty('tickets');
      expectTypeOf<
        JiraTicketsChangedEvent['tickets']
      >().toEqualTypeOf<TicketDto[]>();
      expectTypeOf<JiraTicketsChangedEvent>().toHaveProperty('timestamp');
      expectTypeOf<
        JiraTicketsChangedEvent['timestamp']
      >().toEqualTypeOf<number>();

      expectTypeOf<JiraErrorEvent>().toHaveProperty('projectId');
      expectTypeOf<JiraErrorEvent['projectId']>().toEqualTypeOf<string>();
      expectTypeOf<JiraErrorEvent>().toHaveProperty('code');
      expectTypeOf<JiraErrorEvent['code']>().toEqualTypeOf<string>();
      expectTypeOf<JiraErrorEvent>().toHaveProperty('message');
      expectTypeOf<JiraErrorEvent['message']>().toEqualTypeOf<string>();
      expectTypeOf<JiraErrorEvent>().toHaveProperty('consecutiveErrors');
      expectTypeOf<
        JiraErrorEvent['consecutiveErrors']
      >().toEqualTypeOf<number>();
    });
  });

  // -------------------------------------------------------------
  // IPC-J-003 — regression: prior channels still present
  // -------------------------------------------------------------
  describe('IPC-J-003 regression: prior contracts unchanged', () => {
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

    it('IpcApi retains its prior namespaces', () => {
      expectTypeOf<IpcApi>().toHaveProperty('ping');
      expectTypeOf<IpcApi>().toHaveProperty('claude');
      expectTypeOf<IpcApi>().toHaveProperty('projects');
      expectTypeOf<IpcApi>().toHaveProperty('secrets');
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
  });

  // -------------------------------------------------------------
  // IPC-J-004 — drift guard: TicketDto ≡ schema's Ticket
  // -------------------------------------------------------------
  describe('IPC-J-004 drift guard: TicketDto ↔ schema.Ticket', () => {
    it('TicketDto from ipc.ts is structurally equivalent to schema.Ticket', () => {
      // `Ticket` is an interface (type-only export) so we use the
      // `import('...').Ticket` type-expression form (same pattern used by
      // `ipc-contract-projects.test.ts` for ProjectInstance).
      type SchemaTicket = import('../../src/shared/schema/ticket').Ticket;
      expectTypeOf<TicketDto>().toEqualTypeOf<SchemaTicket>();
    });

    it('TicketDto has all the contractual fields with correct types', () => {
      expectTypeOf<TicketDto>().toHaveProperty('key');
      expectTypeOf<TicketDto['key']>().toEqualTypeOf<string>();
      expectTypeOf<TicketDto>().toHaveProperty('summary');
      expectTypeOf<TicketDto['summary']>().toEqualTypeOf<string>();
      expectTypeOf<TicketDto>().toHaveProperty('status');
      expectTypeOf<TicketDto['status']>().toEqualTypeOf<string>();
      expectTypeOf<TicketDto>().toHaveProperty('priority');
      expectTypeOf<TicketDto['priority']>().toEqualTypeOf<string>();
      expectTypeOf<TicketDto>().toHaveProperty('assignee');
      expectTypeOf<TicketDto['assignee']>().toEqualTypeOf<string | null>();
      expectTypeOf<TicketDto>().toHaveProperty('updatedAt');
      expectTypeOf<TicketDto['updatedAt']>().toEqualTypeOf<string>();
      expectTypeOf<TicketDto>().toHaveProperty('url');
      expectTypeOf<TicketDto['url']>().toEqualTypeOf<string>();
    });
  });
});
