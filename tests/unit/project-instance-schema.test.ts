import { describe, it, expect } from 'vitest';
import {
  validateProjectInstance,
  validateProjectInstanceInput,
  REPO_TYPES,
  TICKET_SOURCES,
  WORKFLOW_MODES,
  type ProjectInstance,
  type ProjectInstanceInput,
  type ValidationError,
} from '../../src/shared/schema/project-instance';

/**
 * Validator acceptance tests (VAL-001..VAL-017 + PROJ-SCH-001..010).
 *
 * Issue #25 schema break: `RepoConfig.host`/`tokenRef` and
 * `TicketsConfig.host`/`email`/`tokenRef` are GONE. New fields:
 *   - `RepoConfig.connectionId`, `RepoConfig.slug`
 *   - `TicketsConfig.connectionId`, `TicketsConfig.projectKey`
 *   - `TicketsConfig.query` becomes OPTIONAL
 *
 * The drift guard (PROJ-SCH-002..004) asserts the validator REJECTS old
 * credential fields. Pre-MVP, no migration shim — bad records get rejected
 * outright.
 *
 * The validator emits ALL field errors at once (no first-error-and-stop)
 * so the form can render every problem inline. Each test asserts on the
 * discriminated `ValidationResult` union — narrow with the `ok` field
 * before reading `.value` or `.errors`.
 */

// ---------------------------------------------------------------------------
// Fixture helpers — make valid baselines so each test only deviates by one
// field. Using fresh objects per test avoids cross-test mutation traps.
// ---------------------------------------------------------------------------

function validInput(): ProjectInstanceInput {
  return {
    name: 'My Project',
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
      query: 'project = ABC AND status = "Ready for AI"',
    },
    workflow: {
      mode: 'interactive',
      branchFormat: 'feat/{ticketKey}-{slug}',
    },
  };
}

function validFullProject(): ProjectInstance {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    name: 'My Project',
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
    workflow: {
      mode: 'interactive',
      branchFormat: 'feat/{ticketKey}',
    },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
}

function findError(
  errors: ReadonlyArray<ValidationError>,
  path: string,
): ValidationError | undefined {
  return errors.find((e) => e.path === path);
}

describe('src/shared/schema/project-instance.ts', () => {
  describe('exported constants', () => {
    it('REPO_TYPES contains github and bitbucket', () => {
      expect(REPO_TYPES).toContain('github');
      expect(REPO_TYPES).toContain('bitbucket');
    });

    it('TICKET_SOURCES contains jira', () => {
      expect(TICKET_SOURCES).toContain('jira');
    });

    it('WORKFLOW_MODES contains interactive and yolo', () => {
      expect(WORKFLOW_MODES).toContain('interactive');
      expect(WORKFLOW_MODES).toContain('yolo');
    });
  });

  // -------------------------------------------------------------------------
  // VAL-001: happy path
  // -------------------------------------------------------------------------
  describe('VAL-001 happy path', () => {
    it('VAL-001: fully-valid input → ok:true, returned value matches input', () => {
      const input = validFullProject();
      const result = validateProjectInstance(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toMatchObject({
        id: input.id,
        name: input.name,
        repo: input.repo,
        tickets: input.tickets,
        workflow: input.workflow,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      });
    });
  });

  // -------------------------------------------------------------------------
  // VAL-002 / VAL-003 / VAL-013: name field
  // -------------------------------------------------------------------------
  describe('VAL-002/003/013 name field', () => {
    it('VAL-002: missing name → REQUIRED at path "name"', () => {
      const input: Record<string, unknown> = { ...validFullProject() };
      delete input.name;
      const result = validateProjectInstance(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const err = findError(result.errors, 'name');
      expect(err).toBeDefined();
      expect(err?.code).toBe('REQUIRED');
    });

    it('VAL-003: whitespace-only name → EMPTY at path "name"', () => {
      const input = { ...validFullProject(), name: '   ' };
      const result = validateProjectInstance(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const err = findError(result.errors, 'name');
      expect(err).toBeDefined();
      expect(err?.code).toBe('EMPTY');
    });

    it('VAL-013: number for name → NOT_STRING at path "name"', () => {
      const input = { ...validFullProject(), name: 42 as unknown as string };
      const result = validateProjectInstance(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const err = findError(result.errors, 'name');
      expect(err).toBeDefined();
      expect(err?.code).toBe('NOT_STRING');
    });
  });

  // -------------------------------------------------------------------------
  // VAL-004 / VAL-005 / VAL-006: repo subtree
  // -------------------------------------------------------------------------
  describe('VAL-004/005/006 repo subtree', () => {
    it('VAL-004: invalid repo.type ("gitlab") → INVALID_ENUM with valid values in message', () => {
      const base = validFullProject();
      const input = {
        ...base,
        repo: { ...base.repo, type: 'gitlab' as unknown as 'github' },
      };
      const result = validateProjectInstance(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const err = findError(result.errors, 'repo.type');
      expect(err).toBeDefined();
      expect(err?.code).toBe('INVALID_ENUM');
      // Message should mention the allowed values so the form can show them.
      expect(err?.message).toMatch(/github/);
      expect(err?.message).toMatch(/bitbucket/);
    });

    it('VAL-005: relative repo.localPath ("./foo") → NOT_ABSOLUTE', () => {
      const base = validFullProject();
      const input = {
        ...base,
        repo: { ...base.repo, localPath: './foo' },
      };
      const result = validateProjectInstance(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const err = findError(result.errors, 'repo.localPath');
      expect(err).toBeDefined();
      expect(err?.code).toBe('NOT_ABSOLUTE');
    });

    it('VAL-006: empty repo.baseBranch → EMPTY', () => {
      const base = validFullProject();
      const input = {
        ...base,
        repo: { ...base.repo, baseBranch: '' },
      };
      const result = validateProjectInstance(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const err = findError(result.errors, 'repo.baseBranch');
      expect(err).toBeDefined();
      expect(err?.code).toBe('EMPTY');
    });
  });

  // -------------------------------------------------------------------------
  // VAL-007: tickets subtree
  // -------------------------------------------------------------------------
  describe('VAL-007 tickets subtree', () => {
    it('VAL-007: invalid tickets.source → INVALID_ENUM', () => {
      const base = validFullProject();
      const input = {
        ...base,
        tickets: { ...base.tickets, source: 'linear' as unknown as 'jira' },
      };
      const result = validateProjectInstance(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const err = findError(result.errors, 'tickets.source');
      expect(err).toBeDefined();
      expect(err?.code).toBe('INVALID_ENUM');
    });
  });

  // -------------------------------------------------------------------------
  // VAL-009 / VAL-010 / VAL-014 / VAL-015: workflow subtree
  // -------------------------------------------------------------------------
  describe('VAL-009/010/014/015 workflow subtree', () => {
    it('VAL-009: invalid workflow.mode → INVALID_ENUM', () => {
      const base = validFullProject();
      const input = {
        ...base,
        workflow: {
          ...base.workflow,
          mode: 'turbo' as unknown as 'interactive',
        },
      };
      const result = validateProjectInstance(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const err = findError(result.errors, 'workflow.mode');
      expect(err).toBeDefined();
      expect(err?.code).toBe('INVALID_ENUM');
    });

    it('VAL-010: branchFormat without placeholder ("feat/foo") → INVALID_BRANCH_FORMAT', () => {
      const base = validFullProject();
      const input = {
        ...base,
        workflow: { ...base.workflow, branchFormat: 'feat/foo' },
      };
      const result = validateProjectInstance(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const err = findError(result.errors, 'workflow.branchFormat');
      expect(err).toBeDefined();
      expect(err?.code).toBe('INVALID_BRANCH_FORMAT');
    });

    it('VAL-014: branchFormat with {ticketKey} only → ok:true', () => {
      const base = validFullProject();
      const input = {
        ...base,
        workflow: { ...base.workflow, branchFormat: 'feat/{ticketKey}' },
      };
      const result = validateProjectInstance(input);
      expect(result.ok).toBe(true);
    });

    it('VAL-015: branchFormat with {slug} only → ok:true', () => {
      const base = validFullProject();
      const input = {
        ...base,
        workflow: { ...base.workflow, branchFormat: 'topic/{slug}' },
      };
      const result = validateProjectInstance(input);
      expect(result.ok).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-011: multiple errors at once
  // -------------------------------------------------------------------------
  describe('VAL-011 multiple errors at once', () => {
    it('VAL-011: input with 3+ field violations → errors array contains all expected paths', () => {
      const input = {
        id: '11111111-2222-4333-8444-555555555555',
        name: '   ', // EMPTY
        repo: {
          type: 'gitlab', // INVALID_ENUM
          localPath: './rel', // NOT_ABSOLUTE
          baseBranch: 'main',
          connectionId: 'conn-gh-1',
          slug: 'gazhang/frontend-app',
        },
        tickets: {
          source: 'jira',
          connectionId: 'conn-jr-1',
          projectKey: 'PROJ',
        },
        workflow: {
          mode: 'interactive',
          branchFormat: 'no-placeholder', // INVALID_BRANCH_FORMAT
        },
        createdAt: 1,
        updatedAt: 2,
      };
      const result = validateProjectInstance(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;

      const paths = result.errors.map((e) => e.path);
      expect(paths).toContain('name');
      expect(paths).toContain('repo.type');
      expect(paths).toContain('repo.localPath');
      expect(paths).toContain('workflow.branchFormat');
      // At least 4 errors collected — confirms validator does not stop on first.
      expect(result.errors.length).toBeGreaterThanOrEqual(4);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-012: top-level null
  // -------------------------------------------------------------------------
  describe('VAL-012 top-level null', () => {
    it('VAL-012: null input → ok:false with a non-REQUIRED top-level error', () => {
      const result = validateProjectInstance(null);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors.length).toBeGreaterThan(0);
      const top = result.errors[0];
      expect(top).toBeDefined();
      if (!top) return;
      expect(top.code).not.toBe('REQUIRED');
      expect(['', '$root']).toContain(top.path);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-016: extra fields silently dropped
  // -------------------------------------------------------------------------
  describe('VAL-016 extra fields preserved-on-failure / dropped-on-success', () => {
    it('VAL-016: extra unknown top-level field → ok:true and field NOT in result.value', () => {
      const input = {
        ...validFullProject(),
        extraField: 'i should be dropped',
        anotherExtra: 99,
      } as unknown;
      const result = validateProjectInstance(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect((result.value as unknown as Record<string, unknown>).extraField).toBeUndefined();
      expect((result.value as unknown as Record<string, unknown>).anotherExtra).toBeUndefined();
    });

    it('VAL-016: extra unknown nested field → ok:true and nested extras dropped', () => {
      const base = validFullProject();
      const input = {
        ...base,
        repo: { ...base.repo, sneaky: 'no' },
      } as unknown;
      const result = validateProjectInstance(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(
        (result.value.repo as unknown as Record<string, unknown>).sneaky,
      ).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // VAL-017: validateProjectInstanceInput rejects supplied id
  // -------------------------------------------------------------------------
  describe('VAL-017 validateProjectInstanceInput', () => {
    it('VAL-017: input with `id` field → INVALID_ID at path "id"', () => {
      const input = {
        id: '11111111-2222-4333-8444-555555555555',
        ...validInput(),
      };
      const result = validateProjectInstanceInput(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const err = findError(result.errors, 'id');
      expect(err).toBeDefined();
      expect(err?.code).toBe('INVALID_ID');
    });

    it('VAL-017: input without `id`/`createdAt`/`updatedAt` → ok:true', () => {
      const result = validateProjectInstanceInput(validInput());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toMatchObject({
        name: 'My Project',
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
        workflow: { mode: 'interactive' },
      });
      expect((result.value as unknown as Record<string, unknown>).id).toBeUndefined();
      expect(
        (result.value as unknown as Record<string, unknown>).createdAt,
      ).toBeUndefined();
      expect(
        (result.value as unknown as Record<string, unknown>).updatedAt,
      ).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // PROJ-SCH-001..010 — issue #25 schema break
  // -------------------------------------------------------------------------
  describe('PROJ-SCH-001 happy path with new connection-ref shape', () => {
    it('PROJ-SCH-001: validateProjectInstance accepts repo.connectionId + repo.slug + tickets.connectionId + tickets.projectKey, no host/tokenRef anywhere', () => {
      const input = validFullProject();
      const result = validateProjectInstance(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.repo.connectionId).toBe('conn-gh-1');
      expect(result.value.repo.slug).toBe('gazhang/frontend-app');
      expect(result.value.tickets.connectionId).toBe('conn-jr-1');
      expect(result.value.tickets.projectKey).toBe('PROJ');
      // Old fields must NOT be present on the validated value.
      const repoUnknown = result.value.repo as unknown as Record<string, unknown>;
      const ticketsUnknown = result.value.tickets as unknown as Record<string, unknown>;
      expect(repoUnknown['host']).toBeUndefined();
      expect(repoUnknown['tokenRef']).toBeUndefined();
      expect(ticketsUnknown['host']).toBeUndefined();
      expect(ticketsUnknown['email']).toBeUndefined();
      expect(ticketsUnknown['tokenRef']).toBeUndefined();
    });
  });

  // PROJ-SCH-002 — drift guard: `host` on repo or tickets is REJECTED.
  describe('PROJ-SCH-002 drift guard: host field rejected', () => {
    it('PROJ-SCH-002: host on repo → validation fails', () => {
      const base = validFullProject();
      const input = {
        ...base,
        repo: { ...base.repo, host: 'https://api.github.com' },
      };
      const result = validateProjectInstance(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      // The drift guard must surface a path-anchored error on repo.host.
      const err = findError(result.errors, 'repo.host');
      expect(err).toBeDefined();
    });

    it('PROJ-SCH-002: host on tickets → validation fails', () => {
      const base = validFullProject();
      const input = {
        ...base,
        tickets: { ...base.tickets, host: 'https://acme.atlassian.net' },
      };
      const result = validateProjectInstance(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const err = findError(result.errors, 'tickets.host');
      expect(err).toBeDefined();
    });
  });

  // PROJ-SCH-003 — drift guard: `tokenRef` on repo or tickets is REJECTED.
  describe('PROJ-SCH-003 drift guard: tokenRef field rejected', () => {
    it('PROJ-SCH-003: tokenRef on repo → validation fails', () => {
      const base = validFullProject();
      const input = {
        ...base,
        repo: { ...base.repo, tokenRef: 'github-default' },
      };
      const result = validateProjectInstance(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const err = findError(result.errors, 'repo.tokenRef');
      expect(err).toBeDefined();
    });

    it('PROJ-SCH-003: tokenRef on tickets → validation fails', () => {
      const base = validFullProject();
      const input = {
        ...base,
        tickets: { ...base.tickets, tokenRef: 'jira-default' },
      };
      const result = validateProjectInstance(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const err = findError(result.errors, 'tickets.tokenRef');
      expect(err).toBeDefined();
    });
  });

  // PROJ-SCH-004 — drift guard: `email` on tickets is REJECTED.
  describe('PROJ-SCH-004 drift guard: email field rejected on tickets', () => {
    it('PROJ-SCH-004: email on tickets → validation fails', () => {
      const base = validFullProject();
      const input = {
        ...base,
        tickets: { ...base.tickets, email: 'me@example.com' },
      };
      const result = validateProjectInstance(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const err = findError(result.errors, 'tickets.email');
      expect(err).toBeDefined();
    });
  });

  // PROJ-SCH-005 — Missing `repo.connectionId` → REQUIRED.
  describe('PROJ-SCH-005 missing repo.connectionId', () => {
    it('PROJ-SCH-005: missing repo.connectionId → REQUIRED', () => {
      const base = validFullProject();
      const repoNoConn: Record<string, unknown> = { ...base.repo };
      delete repoNoConn['connectionId'];
      const input = { ...base, repo: repoNoConn };
      const result = validateProjectInstance(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const err = findError(result.errors, 'repo.connectionId');
      expect(err).toBeDefined();
      expect(err?.code).toBe('REQUIRED');
    });
  });

  // PROJ-SCH-006 — Missing `repo.slug` → REQUIRED.
  describe('PROJ-SCH-006 missing repo.slug', () => {
    it('PROJ-SCH-006: missing repo.slug → REQUIRED', () => {
      const base = validFullProject();
      const repoNoSlug: Record<string, unknown> = { ...base.repo };
      delete repoNoSlug['slug'];
      const input = { ...base, repo: repoNoSlug };
      const result = validateProjectInstance(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const err = findError(result.errors, 'repo.slug');
      expect(err).toBeDefined();
      expect(err?.code).toBe('REQUIRED');
    });
  });

  // PROJ-SCH-007 — Missing `tickets.connectionId` → REQUIRED.
  describe('PROJ-SCH-007 missing tickets.connectionId', () => {
    it('PROJ-SCH-007: missing tickets.connectionId → REQUIRED', () => {
      const base = validFullProject();
      const ticketsNoConn: Record<string, unknown> = { ...base.tickets };
      delete ticketsNoConn['connectionId'];
      const input = { ...base, tickets: ticketsNoConn };
      const result = validateProjectInstance(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const err = findError(result.errors, 'tickets.connectionId');
      expect(err).toBeDefined();
      expect(err?.code).toBe('REQUIRED');
    });
  });

  // PROJ-SCH-008 — Missing `tickets.projectKey` → REQUIRED.
  describe('PROJ-SCH-008 missing tickets.projectKey', () => {
    it('PROJ-SCH-008: missing tickets.projectKey → REQUIRED', () => {
      const base = validFullProject();
      const ticketsNoKey: Record<string, unknown> = { ...base.tickets };
      delete ticketsNoKey['projectKey'];
      const input = { ...base, tickets: ticketsNoKey };
      const result = validateProjectInstance(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const err = findError(result.errors, 'tickets.projectKey');
      expect(err).toBeDefined();
      expect(err?.code).toBe('REQUIRED');
    });
  });

  // PROJ-SCH-009 — Empty / absent `tickets.query` is OK (optional now).
  describe('PROJ-SCH-009 tickets.query optional', () => {
    it('PROJ-SCH-009: tickets.query absent → ok:true', () => {
      const base = validFullProject();
      // base already has no `query` — this confirms the optional path.
      expect((base.tickets as unknown as Record<string, unknown>)['query']).toBeUndefined();
      const result = validateProjectInstance(base);
      expect(result.ok).toBe(true);
    });

    it('PROJ-SCH-009: tickets.query undefined → ok:true', () => {
      const base = validFullProject();
      const input = {
        ...base,
        tickets: { ...base.tickets, query: undefined as unknown as string },
      };
      const result = validateProjectInstance(input);
      expect(result.ok).toBe(true);
    });
  });

  // PROJ-SCH-010 — `tickets.query` if PRESENT must be non-empty after trim.
  describe('PROJ-SCH-010 tickets.query non-empty when present', () => {
    it('PROJ-SCH-010: whitespace-only tickets.query → EMPTY', () => {
      const base = validFullProject();
      const input = {
        ...base,
        tickets: { ...base.tickets, query: '   \t  ' },
      };
      const result = validateProjectInstance(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const err = findError(result.errors, 'tickets.query');
      expect(err).toBeDefined();
      expect(err?.code).toBe('EMPTY');
    });

    it('PROJ-SCH-010: non-empty tickets.query → ok:true and round-trips on result.value', () => {
      const base = validFullProject();
      const input = {
        ...base,
        tickets: { ...base.tickets, query: 'project = PROJ AND status = "Ready"' },
      };
      const result = validateProjectInstance(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.tickets.query).toBe('project = PROJ AND status = "Ready"');
    });
  });
});
