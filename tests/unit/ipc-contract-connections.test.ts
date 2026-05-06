import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  IPC_CHANNELS,
  type IpcApi,
  type IpcResult,
} from '../../src/shared/ipc';
import type {
  Connection,
  ConnectionInput,
  ConnectionUpdate,
  ConnectionIdentity,
  Provider,
  AuthMethod,
} from '../../src/shared/schema/connection';

/**
 * IPC-CONN-001..004 — IPC contract for the Connection model + Connections
 * settings view (issue #24).
 *
 * Mirrors `tests/unit/ipc-contract-projects.test.ts`:
 *  - Channel-string contract (runtime equality)
 *  - IpcApi.connections shape (compile-time, via expectTypeOf)
 *  - Discriminated-union drift guard for ConnectionsTestRequest
 *  - Regression that prior channels (PING / claude / projects / runs / jira)
 *    have not drifted.
 */

// Shared aliases imported from `shared/ipc` — these are declared by Agent B.
// Importing them by name verifies they exist on the module surface; if the
// module hasn't shipped these types yet the file fails to type-check.
type ConnectionsGetRequest = import('../../src/shared/ipc').ConnectionsGetRequest;
type ConnectionsCreateRequest = import('../../src/shared/ipc').ConnectionsCreateRequest;
type ConnectionsUpdateRequest = import('../../src/shared/ipc').ConnectionsUpdateRequest;
type ConnectionsDeleteRequest = import('../../src/shared/ipc').ConnectionsDeleteRequest;
type ConnectionsTestRequest = import('../../src/shared/ipc').ConnectionsTestRequest;
type ConnectionsTestResponse = import('../../src/shared/ipc').ConnectionsTestResponse;

describe('src/shared/ipc.ts — Connection model + Connections settings extension', () => {
  // -----------------------------------------------------------------
  // IPC-CONN-001 — channel-string contract
  // -----------------------------------------------------------------
  describe('IPC-CONN-001 channel strings', () => {
    it('CONNECTIONS_LIST === "connections:list"', () => {
      expect(IPC_CHANNELS.CONNECTIONS_LIST).toBe('connections:list');
    });
    it('CONNECTIONS_GET === "connections:get"', () => {
      expect(IPC_CHANNELS.CONNECTIONS_GET).toBe('connections:get');
    });
    it('CONNECTIONS_CREATE === "connections:create"', () => {
      expect(IPC_CHANNELS.CONNECTIONS_CREATE).toBe('connections:create');
    });
    it('CONNECTIONS_UPDATE === "connections:update"', () => {
      expect(IPC_CHANNELS.CONNECTIONS_UPDATE).toBe('connections:update');
    });
    it('CONNECTIONS_DELETE === "connections:delete"', () => {
      expect(IPC_CHANNELS.CONNECTIONS_DELETE).toBe('connections:delete');
    });
    it('CONNECTIONS_TEST === "connections:test"', () => {
      expect(IPC_CHANNELS.CONNECTIONS_TEST).toBe('connections:test');
    });

    it('all 6 CONNECTIONS_* channel keys are present on IPC_CHANNELS', () => {
      const required = [
        'CONNECTIONS_LIST',
        'CONNECTIONS_GET',
        'CONNECTIONS_CREATE',
        'CONNECTIONS_UPDATE',
        'CONNECTIONS_DELETE',
        'CONNECTIONS_TEST',
      ];
      for (const k of required) {
        expect(Object.keys(IPC_CHANNELS)).toContain(k);
      }
    });

    it('CONNECTIONS_* values keep their literal-string types (compile-time)', () => {
      expectTypeOf(IPC_CHANNELS.CONNECTIONS_LIST).toEqualTypeOf<'connections:list'>();
      expectTypeOf(IPC_CHANNELS.CONNECTIONS_GET).toEqualTypeOf<'connections:get'>();
      expectTypeOf(IPC_CHANNELS.CONNECTIONS_CREATE).toEqualTypeOf<'connections:create'>();
      expectTypeOf(IPC_CHANNELS.CONNECTIONS_UPDATE).toEqualTypeOf<'connections:update'>();
      expectTypeOf(IPC_CHANNELS.CONNECTIONS_DELETE).toEqualTypeOf<'connections:delete'>();
      expectTypeOf(IPC_CHANNELS.CONNECTIONS_TEST).toEqualTypeOf<'connections:test'>();
    });
  });

  // -----------------------------------------------------------------
  // IPC-CONN-002 — IpcApi.connections shape
  // -----------------------------------------------------------------
  describe('IPC-CONN-002 IpcApi.connections shape', () => {
    it('IpcApi has a connections namespace with the 6 expected methods', () => {
      expectTypeOf<IpcApi>().toHaveProperty('connections');
      expectTypeOf<IpcApi['connections']>().toHaveProperty('list');
      expectTypeOf<IpcApi['connections']>().toHaveProperty('get');
      expectTypeOf<IpcApi['connections']>().toHaveProperty('create');
      expectTypeOf<IpcApi['connections']>().toHaveProperty('update');
      expectTypeOf<IpcApi['connections']>().toHaveProperty('delete');
      expectTypeOf<IpcApi['connections']>().toHaveProperty('test');
    });

    it('IpcApi.connections.list signature', () => {
      expectTypeOf<IpcApi['connections']['list']>().toEqualTypeOf<
        () => Promise<IpcResult<Connection[]>>
      >();
    });

    it('IpcApi.connections.get signature', () => {
      expectTypeOf<IpcApi['connections']['get']>().toEqualTypeOf<
        (req: ConnectionsGetRequest) => Promise<IpcResult<Connection>>
      >();
    });

    it('IpcApi.connections.create signature', () => {
      expectTypeOf<IpcApi['connections']['create']>().toEqualTypeOf<
        (req: ConnectionsCreateRequest) => Promise<IpcResult<Connection>>
      >();
    });

    it('IpcApi.connections.update signature', () => {
      expectTypeOf<IpcApi['connections']['update']>().toEqualTypeOf<
        (req: ConnectionsUpdateRequest) => Promise<IpcResult<Connection>>
      >();
    });

    it('IpcApi.connections.delete signature', () => {
      expectTypeOf<IpcApi['connections']['delete']>().toEqualTypeOf<
        (req: ConnectionsDeleteRequest) => Promise<IpcResult<{ id: string }>>
      >();
    });

    it('IpcApi.connections.test signature', () => {
      expectTypeOf<IpcApi['connections']['test']>().toEqualTypeOf<
        (req: ConnectionsTestRequest) => Promise<IpcResult<ConnectionsTestResponse>>
      >();
    });

    it('Request payload shapes have contractual fields', () => {
      expectTypeOf<ConnectionsGetRequest>().toHaveProperty('id');
      expectTypeOf<ConnectionsGetRequest['id']>().toEqualTypeOf<string>();

      expectTypeOf<ConnectionsCreateRequest>().toHaveProperty('input');
      expectTypeOf<ConnectionsCreateRequest['input']>().toEqualTypeOf<ConnectionInput>();

      expectTypeOf<ConnectionsUpdateRequest>().toHaveProperty('id');
      expectTypeOf<ConnectionsUpdateRequest>().toHaveProperty('input');
      expectTypeOf<ConnectionsUpdateRequest['input']>().toEqualTypeOf<ConnectionUpdate>();

      expectTypeOf<ConnectionsDeleteRequest>().toHaveProperty('id');
      expectTypeOf<ConnectionsDeleteRequest['id']>().toEqualTypeOf<string>();

      expectTypeOf<ConnectionsTestResponse>().toHaveProperty('identity');
      expectTypeOf<ConnectionsTestResponse['identity']>().toEqualTypeOf<ConnectionIdentity>();
      expectTypeOf<ConnectionsTestResponse>().toHaveProperty('verifiedAt');
      expectTypeOf<ConnectionsTestResponse['verifiedAt']>().toEqualTypeOf<number>();
    });
  });

  // -----------------------------------------------------------------
  // IPC-CONN-003 — discriminated-union drift guard
  // -----------------------------------------------------------------
  describe('IPC-CONN-003 ConnectionsTestRequest discriminated union', () => {
    it('IPC-CONN-003: existing-mode request type-checks', () => {
      const existing = { mode: 'existing', id: 'conn-1' } satisfies ConnectionsTestRequest;
      expect(existing.mode).toBe('existing');
    });

    it('IPC-CONN-003: preview-mode request (github) type-checks', () => {
      const preview = {
        mode: 'preview',
        provider: 'github',
        host: 'https://api.github.com',
        authMethod: 'pat',
        plaintextToken: 'ghp_abc',
      } satisfies ConnectionsTestRequest;
      expect(preview.mode).toBe('preview');
    });

    it('IPC-CONN-003: preview-mode request (jira with email) type-checks', () => {
      const preview = {
        mode: 'preview',
        provider: 'jira',
        host: 'https://acme.atlassian.net',
        authMethod: 'api-token',
        plaintextToken: 'jira-tok',
        email: 'me@acme.com',
      } satisfies ConnectionsTestRequest;
      expect(preview.email).toBe('me@acme.com');
    });

    it('IPC-CONN-003: Provider and AuthMethod are string literal unions', () => {
      type ExpectedProviders = 'github' | 'bitbucket' | 'jira';
      expectTypeOf<Provider>().toEqualTypeOf<ExpectedProviders>();

      type ExpectedAuth = 'pat' | 'app-password' | 'api-token';
      expectTypeOf<AuthMethod>().toEqualTypeOf<ExpectedAuth>();
    });
  });

  // -----------------------------------------------------------------
  // IPC-CONN-004 — regression: prior channels unchanged
  // -----------------------------------------------------------------
  describe('IPC-CONN-004 regression: prior channel strings unchanged', () => {
    it('IPC-CONN-004: PING channel unchanged', () => {
      expect(IPC_CHANNELS.PING).toBe('app:ping');
    });

    it('IPC-CONN-004: CLAUDE_* channel values unchanged', () => {
      expect(IPC_CHANNELS.CLAUDE_RUN).toBe('claude:run');
      expect(IPC_CHANNELS.CLAUDE_CANCEL).toBe('claude:cancel');
      expect(IPC_CHANNELS.CLAUDE_WRITE).toBe('claude:write');
      expect(IPC_CHANNELS.CLAUDE_STATUS).toBe('claude:status');
      expect(IPC_CHANNELS.CLAUDE_OUTPUT).toBe('claude:output');
      expect(IPC_CHANNELS.CLAUDE_EXIT).toBe('claude:exit');
    });

    it('IPC-CONN-004: PROJECTS_* channel values unchanged', () => {
      expect(IPC_CHANNELS.PROJECTS_LIST).toBe('projects:list');
      expect(IPC_CHANNELS.PROJECTS_GET).toBe('projects:get');
      expect(IPC_CHANNELS.PROJECTS_CREATE).toBe('projects:create');
      expect(IPC_CHANNELS.PROJECTS_UPDATE).toBe('projects:update');
      expect(IPC_CHANNELS.PROJECTS_DELETE).toBe('projects:delete');
    });

    it('IPC-CONN-004: SECRETS_* channel values unchanged', () => {
      expect(IPC_CHANNELS.SECRETS_SET).toBe('secrets:set');
      expect(IPC_CHANNELS.SECRETS_GET).toBe('secrets:get');
      expect(IPC_CHANNELS.SECRETS_DELETE).toBe('secrets:delete');
      expect(IPC_CHANNELS.SECRETS_LIST).toBe('secrets:list');
    });

    it('IPC-CONN-004: JIRA_* channel values unchanged', () => {
      expect(IPC_CHANNELS.JIRA_LIST).toBe('jira:list');
      expect(IPC_CHANNELS.JIRA_REFRESH).toBe('jira:refresh');
      expect(IPC_CHANNELS.JIRA_TEST_CONNECTION).toBe('jira:test-connection');
      expect(IPC_CHANNELS.JIRA_REFRESH_POLLERS).toBe('jira:refresh-pollers');
      expect(IPC_CHANNELS.JIRA_TICKETS_CHANGED).toBe('jira:tickets-changed');
      expect(IPC_CHANNELS.JIRA_ERROR).toBe('jira:error');
    });

    it('IPC-CONN-004: RUNS_* channel values unchanged', () => {
      expect(IPC_CHANNELS.RUNS_START).toBe('runs:start');
      expect(IPC_CHANNELS.RUNS_CANCEL).toBe('runs:cancel');
      expect(IPC_CHANNELS.RUNS_APPROVE).toBe('runs:approve');
      expect(IPC_CHANNELS.RUNS_REJECT).toBe('runs:reject');
      expect(IPC_CHANNELS.RUNS_MODIFY).toBe('runs:modify');
      expect(IPC_CHANNELS.RUNS_CURRENT).toBe('runs:current');
      expect(IPC_CHANNELS.RUNS_LIST_HISTORY).toBe('runs:list-history');
      expect(IPC_CHANNELS.RUNS_READ_LOG).toBe('runs:read-log');
      expect(IPC_CHANNELS.RUNS_CURRENT_CHANGED).toBe('runs:current-changed');
      expect(IPC_CHANNELS.RUNS_STATE_CHANGED).toBe('runs:state-changed');
    });

    it('IPC-CONN-004: pre-existing IpcApi namespaces still present', () => {
      expectTypeOf<IpcApi>().toHaveProperty('ping');
      expectTypeOf<IpcApi>().toHaveProperty('claude');
      expectTypeOf<IpcApi>().toHaveProperty('projects');
      expectTypeOf<IpcApi>().toHaveProperty('secrets');
      expectTypeOf<IpcApi>().toHaveProperty('jira');
      expectTypeOf<IpcApi>().toHaveProperty('runs');
    });
  });
});
