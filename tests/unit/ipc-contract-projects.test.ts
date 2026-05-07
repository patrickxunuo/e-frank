import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  IPC_CHANNELS,
  type IpcApi,
  type IpcResult,
  type PingRequest,
  type PingResponse,
  type ProjectInstanceDto,
  type ProjectsCreateRequest,
  type ProjectsUpdateRequest,
  type ProjectsDeleteRequest,
  type ProjectsGetRequest,
  type RepoConfig,
  type TicketsConfig,
  type SecretsSetRequest,
  type SecretsGetRequest,
  type SecretsGetResponse,
  type SecretsDeleteRequest,
  type SecretsListResponse,
} from '../../src/shared/ipc';
import { validateProjectInstance } from '../../src/shared/schema/project-instance';

/**
 * IPC contract tests for the Project Instance config + Secrets storage
 * extension (issue #3).
 *
 * Covers:
 *  - IPC-PS-001: runtime channel-string contract for the 9 new channels
 *  - IPC-PS-002: TS type-shape contract for `IpcApi['projects']` and
 *                `IpcApi['secrets']`
 *  - IPC-PS-003: regression — PING and all 6 CLAUDE_* contracts unchanged
 *  - IPC-PS-004: drift guard — `ProjectInstanceDto` is structurally
 *                equivalent to `ProjectInstance` from the schema module
 */

describe('src/shared/ipc.ts — Project Instance + Secrets extension', () => {
  // -------------------------------------------------------------
  // IPC-PS-001 — new channel strings
  // -------------------------------------------------------------
  describe('IPC-PS-001 new channel strings', () => {
    it('PROJECTS_LIST === "projects:list"', () => {
      expect(IPC_CHANNELS.PROJECTS_LIST).toBe('projects:list');
    });
    it('PROJECTS_GET === "projects:get"', () => {
      expect(IPC_CHANNELS.PROJECTS_GET).toBe('projects:get');
    });
    it('PROJECTS_CREATE === "projects:create"', () => {
      expect(IPC_CHANNELS.PROJECTS_CREATE).toBe('projects:create');
    });
    it('PROJECTS_UPDATE === "projects:update"', () => {
      expect(IPC_CHANNELS.PROJECTS_UPDATE).toBe('projects:update');
    });
    it('PROJECTS_DELETE === "projects:delete"', () => {
      expect(IPC_CHANNELS.PROJECTS_DELETE).toBe('projects:delete');
    });
    it('SECRETS_SET === "secrets:set"', () => {
      expect(IPC_CHANNELS.SECRETS_SET).toBe('secrets:set');
    });
    it('SECRETS_GET === "secrets:get"', () => {
      expect(IPC_CHANNELS.SECRETS_GET).toBe('secrets:get');
    });
    it('SECRETS_DELETE === "secrets:delete"', () => {
      expect(IPC_CHANNELS.SECRETS_DELETE).toBe('secrets:delete');
    });
    it('SECRETS_LIST === "secrets:list"', () => {
      expect(IPC_CHANNELS.SECRETS_LIST).toBe('secrets:list');
    });

    it('all 9 new channel keys present on IPC_CHANNELS', () => {
      const required = [
        'PROJECTS_LIST',
        'PROJECTS_GET',
        'PROJECTS_CREATE',
        'PROJECTS_UPDATE',
        'PROJECTS_DELETE',
        'SECRETS_SET',
        'SECRETS_GET',
        'SECRETS_DELETE',
        'SECRETS_LIST',
      ];
      for (const k of required) {
        expect(Object.keys(IPC_CHANNELS)).toContain(k);
      }
    });

    it('IPC_CHANNELS values are typed as their string literals (compile-time)', () => {
      expectTypeOf(IPC_CHANNELS.PROJECTS_LIST).toEqualTypeOf<'projects:list'>();
      expectTypeOf(IPC_CHANNELS.PROJECTS_GET).toEqualTypeOf<'projects:get'>();
      expectTypeOf(IPC_CHANNELS.PROJECTS_CREATE).toEqualTypeOf<'projects:create'>();
      expectTypeOf(IPC_CHANNELS.PROJECTS_UPDATE).toEqualTypeOf<'projects:update'>();
      expectTypeOf(IPC_CHANNELS.PROJECTS_DELETE).toEqualTypeOf<'projects:delete'>();
      expectTypeOf(IPC_CHANNELS.SECRETS_SET).toEqualTypeOf<'secrets:set'>();
      expectTypeOf(IPC_CHANNELS.SECRETS_GET).toEqualTypeOf<'secrets:get'>();
      expectTypeOf(IPC_CHANNELS.SECRETS_DELETE).toEqualTypeOf<'secrets:delete'>();
      expectTypeOf(IPC_CHANNELS.SECRETS_LIST).toEqualTypeOf<'secrets:list'>();
    });
  });

  // -------------------------------------------------------------
  // IPC-PS-002 — IpcApi.projects and IpcApi.secrets type contract
  // -------------------------------------------------------------
  describe('IPC-PS-002 IpcApi.projects + IpcApi.secrets type contract', () => {
    it('IpcApi has `projects` and `secrets` namespaces with the expected methods', () => {
      expectTypeOf<IpcApi>().toHaveProperty('projects');
      expectTypeOf<IpcApi>().toHaveProperty('secrets');

      expectTypeOf<IpcApi['projects']>().toHaveProperty('list');
      expectTypeOf<IpcApi['projects']>().toHaveProperty('get');
      expectTypeOf<IpcApi['projects']>().toHaveProperty('create');
      expectTypeOf<IpcApi['projects']>().toHaveProperty('update');
      expectTypeOf<IpcApi['projects']>().toHaveProperty('delete');

      expectTypeOf<IpcApi['secrets']>().toHaveProperty('set');
      expectTypeOf<IpcApi['secrets']>().toHaveProperty('get');
      expectTypeOf<IpcApi['secrets']>().toHaveProperty('delete');
      expectTypeOf<IpcApi['secrets']>().toHaveProperty('list');
    });

    // ---- projects.* signatures -------------------------------------------
    it('IpcApi.projects.list signature', () => {
      expectTypeOf<IpcApi['projects']['list']>().toEqualTypeOf<
        () => Promise<IpcResult<ProjectInstanceDto[]>>
      >();
    });

    it('IpcApi.projects.get signature', () => {
      expectTypeOf<IpcApi['projects']['get']>().toEqualTypeOf<
        (req: ProjectsGetRequest) => Promise<IpcResult<ProjectInstanceDto>>
      >();
    });

    it('IpcApi.projects.create signature', () => {
      expectTypeOf<IpcApi['projects']['create']>().toEqualTypeOf<
        (req: ProjectsCreateRequest) => Promise<IpcResult<ProjectInstanceDto>>
      >();
    });

    it('IpcApi.projects.update signature', () => {
      expectTypeOf<IpcApi['projects']['update']>().toEqualTypeOf<
        (req: ProjectsUpdateRequest) => Promise<IpcResult<ProjectInstanceDto>>
      >();
    });

    it('IpcApi.projects.delete signature', () => {
      expectTypeOf<IpcApi['projects']['delete']>().toEqualTypeOf<
        (req: ProjectsDeleteRequest) => Promise<IpcResult<{ id: string }>>
      >();
    });

    // ---- secrets.* signatures -------------------------------------------
    it('IpcApi.secrets.set signature', () => {
      expectTypeOf<IpcApi['secrets']['set']>().toEqualTypeOf<
        (req: SecretsSetRequest) => Promise<IpcResult<{ ref: string }>>
      >();
    });

    it('IpcApi.secrets.get signature', () => {
      expectTypeOf<IpcApi['secrets']['get']>().toEqualTypeOf<
        (req: SecretsGetRequest) => Promise<IpcResult<SecretsGetResponse>>
      >();
    });

    it('IpcApi.secrets.delete signature', () => {
      expectTypeOf<IpcApi['secrets']['delete']>().toEqualTypeOf<
        (req: SecretsDeleteRequest) => Promise<IpcResult<{ ref: string }>>
      >();
    });

    it('IpcApi.secrets.list signature', () => {
      expectTypeOf<IpcApi['secrets']['list']>().toEqualTypeOf<
        () => Promise<IpcResult<SecretsListResponse>>
      >();
    });

    // ---- payload type sanity --------------------------------------------
    it('payload types have the contractual fields', () => {
      // ProjectsGetRequest / ProjectsDeleteRequest
      expectTypeOf<ProjectsGetRequest>().toHaveProperty('id');
      expectTypeOf<ProjectsGetRequest['id']>().toEqualTypeOf<string>();
      expectTypeOf<ProjectsDeleteRequest>().toHaveProperty('id');
      expectTypeOf<ProjectsDeleteRequest['id']>().toEqualTypeOf<string>();

      // ProjectsCreateRequest / ProjectsUpdateRequest carry the input shape
      expectTypeOf<ProjectsCreateRequest>().toHaveProperty('input');
      expectTypeOf<ProjectsUpdateRequest>().toHaveProperty('id');
      expectTypeOf<ProjectsUpdateRequest>().toHaveProperty('input');
      expectTypeOf<ProjectsUpdateRequest['id']>().toEqualTypeOf<string>();

      // SecretsSetRequest
      expectTypeOf<SecretsSetRequest>().toHaveProperty('ref');
      expectTypeOf<SecretsSetRequest['ref']>().toEqualTypeOf<string>();
      expectTypeOf<SecretsSetRequest>().toHaveProperty('plaintext');
      expectTypeOf<SecretsSetRequest['plaintext']>().toEqualTypeOf<string>();

      // SecretsGetRequest / SecretsGetResponse
      expectTypeOf<SecretsGetRequest>().toHaveProperty('ref');
      expectTypeOf<SecretsGetRequest['ref']>().toEqualTypeOf<string>();
      expectTypeOf<SecretsGetResponse>().toHaveProperty('plaintext');
      expectTypeOf<SecretsGetResponse['plaintext']>().toEqualTypeOf<string>();

      // SecretsDeleteRequest
      expectTypeOf<SecretsDeleteRequest>().toHaveProperty('ref');
      expectTypeOf<SecretsDeleteRequest['ref']>().toEqualTypeOf<string>();

      // SecretsListResponse
      expectTypeOf<SecretsListResponse>().toHaveProperty('refs');
      expectTypeOf<SecretsListResponse['refs']>().toEqualTypeOf<string[]>();
    });
  });

  // -------------------------------------------------------------
  // IPC-PS-003 — regression: PING + CLAUDE_* contracts from #1/#2
  // -------------------------------------------------------------
  describe('IPC-PS-003 regression: PING + CLAUDE_* unchanged', () => {
    it('IPC_CHANNELS.PING is still "app:ping"', () => {
      expect(IPC_CHANNELS.PING).toBe('app:ping');
    });

    it('all 6 CLAUDE_* channels are still present and correct', () => {
      expect(IPC_CHANNELS.CLAUDE_RUN).toBe('claude:run');
      expect(IPC_CHANNELS.CLAUDE_CANCEL).toBe('claude:cancel');
      expect(IPC_CHANNELS.CLAUDE_WRITE).toBe('claude:write');
      expect(IPC_CHANNELS.CLAUDE_STATUS).toBe('claude:status');
      expect(IPC_CHANNELS.CLAUDE_OUTPUT).toBe('claude:output');
      expect(IPC_CHANNELS.CLAUDE_EXIT).toBe('claude:exit');
    });

    it('CLAUDE_* channel values keep their literal-string types', () => {
      expectTypeOf(IPC_CHANNELS.CLAUDE_RUN).toEqualTypeOf<'claude:run'>();
      expectTypeOf(IPC_CHANNELS.CLAUDE_CANCEL).toEqualTypeOf<'claude:cancel'>();
      expectTypeOf(IPC_CHANNELS.CLAUDE_WRITE).toEqualTypeOf<'claude:write'>();
      expectTypeOf(IPC_CHANNELS.CLAUDE_STATUS).toEqualTypeOf<'claude:status'>();
      expectTypeOf(IPC_CHANNELS.CLAUDE_OUTPUT).toEqualTypeOf<'claude:output'>();
      expectTypeOf(IPC_CHANNELS.CLAUDE_EXIT).toEqualTypeOf<'claude:exit'>();
    });

    it('IpcApi.ping retains its original signature', () => {
      expectTypeOf<IpcApi['ping']>().toEqualTypeOf<
        (req: PingRequest) => Promise<PingResponse>
      >();
    });

    it('IpcApi.claude namespace is still present with expected methods', () => {
      expectTypeOf<IpcApi>().toHaveProperty('claude');
      expectTypeOf<IpcApi['claude']>().toHaveProperty('run');
      expectTypeOf<IpcApi['claude']>().toHaveProperty('cancel');
      expectTypeOf<IpcApi['claude']>().toHaveProperty('write');
      expectTypeOf<IpcApi['claude']>().toHaveProperty('status');
      expectTypeOf<IpcApi['claude']>().toHaveProperty('onOutput');
      expectTypeOf<IpcApi['claude']>().toHaveProperty('onExit');
    });
  });

  // -------------------------------------------------------------
  // IPC-PS-004 — drift guard: ProjectInstanceDto vs schema's ProjectInstance
  // -------------------------------------------------------------
  // The shared/ipc module re-exports the schema type as `ProjectInstanceDto`
  // for renderer convenience. These compile-time assertions guard against
  // accidental drift between the two definitions. We use a `import type`
  // here (rather than the `typeof import(...)` form used in
  // `ipc-contract-claude.test.ts`) because `ProjectInstance` /
  // `ProjectInstanceInput` are interfaces — type-only exports that don't
  // appear in `typeof import(...)`'s value-space module shape.
  describe('IPC-PS-004 drift guard: ProjectInstanceDto ↔ schema.ProjectInstance', () => {
    it('ProjectInstanceDto is structurally equivalent to schema.ProjectInstance', () => {
      type SchemaProjectInstance = import('../../src/shared/schema/project-instance').ProjectInstance;
      expectTypeOf<ProjectInstanceDto>().toEqualTypeOf<SchemaProjectInstance>();
    });

    it('ProjectInstanceDto has all the contractual top-level fields', () => {
      expectTypeOf<ProjectInstanceDto>().toHaveProperty('id');
      expectTypeOf<ProjectInstanceDto['id']>().toEqualTypeOf<string>();
      expectTypeOf<ProjectInstanceDto>().toHaveProperty('name');
      expectTypeOf<ProjectInstanceDto['name']>().toEqualTypeOf<string>();
      expectTypeOf<ProjectInstanceDto>().toHaveProperty('repo');
      expectTypeOf<ProjectInstanceDto>().toHaveProperty('tickets');
      expectTypeOf<ProjectInstanceDto>().toHaveProperty('workflow');
      expectTypeOf<ProjectInstanceDto>().toHaveProperty('createdAt');
      expectTypeOf<ProjectInstanceDto['createdAt']>().toEqualTypeOf<number>();
      expectTypeOf<ProjectInstanceDto>().toHaveProperty('updatedAt');
      expectTypeOf<ProjectInstanceDto['updatedAt']>().toEqualTypeOf<number>();
    });

    it('ProjectsCreateRequest.input matches schema.ProjectInstanceInput', () => {
      type SchemaInput = import('../../src/shared/schema/project-instance').ProjectInstanceInput;
      type DtoInput = ProjectsCreateRequest['input'];
      expectTypeOf<DtoInput>().toEqualTypeOf<SchemaInput>();
    });

    it('ProjectsUpdateRequest.input matches schema.ProjectInstanceInput', () => {
      type SchemaInput = import('../../src/shared/schema/project-instance').ProjectInstanceInput;
      type DtoInput = ProjectsUpdateRequest['input'];
      expectTypeOf<DtoInput>().toEqualTypeOf<SchemaInput>();
    });
  });

  // -------------------------------------------------------------
  // IPC-PROJ-DRIFT — issue #25 schema break
  //
  // Compile-time: RepoConfig + TicketsConfig carry the new connectionId/slug/
  // projectKey fields; old credential fields (host/email/tokenRef) are gone.
  // Runtime: validateProjectInstance rejects records that still carry the
  // old fields (drift guard).
  // -------------------------------------------------------------
  describe('IPC-PROJ-DRIFT schema break — new connection-ref shape', () => {
    it('IPC-PROJ-DRIFT: RepoConfig type carries connectionId + slug (compile-time)', () => {
      expectTypeOf<RepoConfig>().toHaveProperty('connectionId');
      expectTypeOf<RepoConfig['connectionId']>().toEqualTypeOf<string>();
      expectTypeOf<RepoConfig>().toHaveProperty('slug');
      expectTypeOf<RepoConfig['slug']>().toEqualTypeOf<string>();
      expectTypeOf<RepoConfig>().toHaveProperty('type');
      expectTypeOf<RepoConfig>().toHaveProperty('localPath');
      expectTypeOf<RepoConfig>().toHaveProperty('baseBranch');
    });

    it('IPC-PROJ-DRIFT: TicketsConfig (jira branch) carries connectionId + projectKey (compile-time)', () => {
      // TicketsConfig is now a discriminated union (TicketsJiraConfig | TicketsGithubIssuesConfig).
      // Both branches share `source` + `connectionId`; `projectKey` is jira-only.
      expectTypeOf<TicketsConfig>().toHaveProperty('connectionId');
      expectTypeOf<TicketsConfig>().toHaveProperty('source');
      type JiraOnly = Extract<TicketsConfig, { source: 'jira' }>;
      expectTypeOf<JiraOnly>().toHaveProperty('projectKey');
      expectTypeOf<JiraOnly['projectKey']>().toEqualTypeOf<string>();
    });

    it('IPC-PROJ-DRIFT: validator REJECTS a project record with repo.host', () => {
      const record = {
        id: '11111111-2222-4333-8444-555555555555',
        name: 'X',
        repo: {
          type: 'github',
          localPath: '/abs/repo',
          baseBranch: 'main',
          connectionId: 'conn-gh-1',
          slug: 'gazhang/frontend-app',
          host: 'https://api.github.com', // drift!
        },
        tickets: {
          source: 'jira',
          connectionId: 'conn-jr-1',
          projectKey: 'PROJ',
        },
        workflow: { mode: 'interactive', branchFormat: 'feat/{ticketKey}' },
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      };
      const result = validateProjectInstance(record);
      expect(result.ok).toBe(false);
    });

    it('IPC-PROJ-DRIFT: validator REJECTS a project record with repo.tokenRef', () => {
      const record = {
        id: '11111111-2222-4333-8444-555555555555',
        name: 'X',
        repo: {
          type: 'github',
          localPath: '/abs/repo',
          baseBranch: 'main',
          connectionId: 'conn-gh-1',
          slug: 'gazhang/frontend-app',
          tokenRef: 'github-default', // drift!
        },
        tickets: {
          source: 'jira',
          connectionId: 'conn-jr-1',
          projectKey: 'PROJ',
        },
        workflow: { mode: 'interactive', branchFormat: 'feat/{ticketKey}' },
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      };
      const result = validateProjectInstance(record);
      expect(result.ok).toBe(false);
    });

    it('IPC-PROJ-DRIFT: validator REJECTS a project record with tickets.host', () => {
      const record = {
        id: '11111111-2222-4333-8444-555555555555',
        name: 'X',
        repo: {
          type: 'github',
          localPath: '/abs/repo',
          baseBranch: 'main',
          connectionId: 'conn-gh-1',
          slug: 'gazhang/frontend-app',
        },
        tickets: {
          source: 'jira',
          connectionId: 'conn-jr-1',
          projectKey: 'PROJ',
          host: 'https://acme.atlassian.net', // drift!
        },
        workflow: { mode: 'interactive', branchFormat: 'feat/{ticketKey}' },
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      };
      const result = validateProjectInstance(record);
      expect(result.ok).toBe(false);
    });

    it('IPC-PROJ-DRIFT: validator REJECTS a project record with tickets.email', () => {
      const record = {
        id: '11111111-2222-4333-8444-555555555555',
        name: 'X',
        repo: {
          type: 'github',
          localPath: '/abs/repo',
          baseBranch: 'main',
          connectionId: 'conn-gh-1',
          slug: 'gazhang/frontend-app',
        },
        tickets: {
          source: 'jira',
          connectionId: 'conn-jr-1',
          projectKey: 'PROJ',
          email: 'me@example.com', // drift!
        },
        workflow: { mode: 'interactive', branchFormat: 'feat/{ticketKey}' },
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      };
      const result = validateProjectInstance(record);
      expect(result.ok).toBe(false);
    });

    it('IPC-PROJ-DRIFT: validator REJECTS a project record with tickets.tokenRef', () => {
      const record = {
        id: '11111111-2222-4333-8444-555555555555',
        name: 'X',
        repo: {
          type: 'github',
          localPath: '/abs/repo',
          baseBranch: 'main',
          connectionId: 'conn-gh-1',
          slug: 'gazhang/frontend-app',
        },
        tickets: {
          source: 'jira',
          connectionId: 'conn-jr-1',
          projectKey: 'PROJ',
          tokenRef: 'jira-default', // drift!
        },
        workflow: { mode: 'interactive', branchFormat: 'feat/{ticketKey}' },
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      };
      const result = validateProjectInstance(record);
      expect(result.ok).toBe(false);
    });

    it('IPC-PROJ-DRIFT: validator ACCEPTS a clean record on the new shape (regression)', () => {
      const record = {
        id: '11111111-2222-4333-8444-555555555555',
        name: 'X',
        repo: {
          type: 'github',
          localPath: '/abs/repo',
          baseBranch: 'main',
          connectionId: 'conn-gh-1',
          slug: 'gazhang/frontend-app',
        },
        tickets: {
          source: 'jira',
          connectionId: 'conn-jr-1',
          projectKey: 'PROJ',
        },
        workflow: { mode: 'interactive', branchFormat: 'feat/{ticketKey}' },
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      };
      const result = validateProjectInstance(record);
      expect(result.ok).toBe(true);
    });
  });

  // -------------------------------------------------------------
  // IPC-PROJ-DRIFT-GH — issue #25 polish: github-issues branch of
  // TicketsConfig is accepted by validateProjectInstance, while jira
  // branch keeps its existing rules.
  // -------------------------------------------------------------
  describe('IPC-PROJ-DRIFT-GH github-issues TicketsConfig branch accepted', () => {
    it('IPC-PROJ-DRIFT-GH: validator ACCEPTS tickets.source === "github-issues" with connectionId + repoSlug', () => {
      const record = {
        id: '11111111-2222-4333-8444-555555555555',
        name: 'X',
        repo: {
          type: 'github',
          localPath: '/abs/repo',
          baseBranch: 'main',
          connectionId: 'conn-gh-1',
          slug: 'gazhang/foo',
        },
        tickets: {
          source: 'github-issues',
          connectionId: 'conn-gh-1',
          repoSlug: 'gazhang/foo',
        },
        workflow: { mode: 'interactive', branchFormat: 'feat/{ticketKey}' },
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      };
      const result = validateProjectInstance(record);
      expect(result.ok).toBe(true);
    });

    it('IPC-PROJ-DRIFT-GH: validator ACCEPTS github-issues with optional `labels`', () => {
      const record = {
        id: '11111111-2222-4333-8444-555555555555',
        name: 'X',
        repo: {
          type: 'github',
          localPath: '/abs/repo',
          baseBranch: 'main',
          connectionId: 'conn-gh-1',
          slug: 'gazhang/foo',
        },
        tickets: {
          source: 'github-issues',
          connectionId: 'conn-gh-1',
          repoSlug: 'gazhang/foo',
          labels: 'bug,priority/high',
        },
        workflow: { mode: 'interactive', branchFormat: 'feat/{ticketKey}' },
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      };
      const result = validateProjectInstance(record);
      expect(result.ok).toBe(true);
    });

    it('IPC-PROJ-DRIFT-GH: jira branch still rejects `host` (drift guard preserved)', () => {
      const record = {
        id: '11111111-2222-4333-8444-555555555555',
        name: 'X',
        repo: {
          type: 'github',
          localPath: '/abs/repo',
          baseBranch: 'main',
          connectionId: 'conn-gh-1',
          slug: 'gazhang/frontend-app',
        },
        tickets: {
          source: 'jira',
          connectionId: 'conn-jr-1',
          projectKey: 'PROJ',
          host: 'https://acme.atlassian.net', // drift!
        },
        workflow: { mode: 'interactive', branchFormat: 'feat/{ticketKey}' },
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      };
      const result = validateProjectInstance(record);
      expect(result.ok).toBe(false);
    });

    it('IPC-PROJ-DRIFT-GH: github-issues branch rejects missing `repoSlug`', () => {
      const record = {
        id: '11111111-2222-4333-8444-555555555555',
        name: 'X',
        repo: {
          type: 'github',
          localPath: '/abs/repo',
          baseBranch: 'main',
          connectionId: 'conn-gh-1',
          slug: 'gazhang/foo',
        },
        tickets: {
          source: 'github-issues',
          connectionId: 'conn-gh-1',
          // repoSlug intentionally missing
        },
        workflow: { mode: 'interactive', branchFormat: 'feat/{ticketKey}' },
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      };
      const result = validateProjectInstance(record);
      expect(result.ok).toBe(false);
    });
  });
});
