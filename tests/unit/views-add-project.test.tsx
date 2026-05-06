// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { AddProject } from '../../src/renderer/views/AddProject';
import type {
  IpcApi,
  IpcResult,
  ProjectInstanceDto,
  ProjectsCreateRequest,
} from '../../src/shared/ipc';

/**
 * ADD-001..012 — <AddProject> view.
 *
 * Stubs `window.api.{secrets,projects,jira}` per-test. The view receives
 * `onClose` and `onCreated` props (per spec App.tsx wiring).
 *
 * For ADD-006 we use `vi.fn().mock.invocationCallOrder` to assert that
 * `secrets.set` was called BEFORE `projects.create`. invocationCallOrder
 * is a global per-test counter Vitest exposes; comparing two values from
 * the same test is reliable.
 */

declare global {
  interface Window {
    api?: IpcApi;
  }
}

interface ApiStub {
  api: IpcApi;
  secretsSet: ReturnType<typeof vi.fn>;
  projectsCreate: ReturnType<typeof vi.fn>;
  jiraTestConnection: ReturnType<typeof vi.fn>;
}

function makeProject(id: string, name: string): ProjectInstanceDto {
  return {
    id,
    name,
    repo: { type: 'github', localPath: '/tmp/' + id, baseBranch: 'main' },
    tickets: { source: 'jira', query: 'project = ABC' },
    workflow: { mode: 'interactive', branchFormat: 'feature/{ticketKey}-{slug}' },
    createdAt: 0,
    updatedAt: 0,
  };
}

function installApi(opts?: {
  secretsSetResult?: IpcResult<{ ref: string }>;
  projectsCreateResult?: IpcResult<ProjectInstanceDto>;
  jiraTestConnectionResult?: IpcResult<{
    accountId: string;
    displayName: string;
    emailAddress: string;
  }>;
}): ApiStub {
  const unusedErr = (): IpcResult<never> => ({
    ok: false,
    error: { code: 'NOT_USED_IN_FE_TESTS', message: '' },
  });

  const secretsSet = vi
    .fn()
    .mockResolvedValue(
      opts?.secretsSetResult ?? { ok: true, data: { ref: 'r' } },
    );
  const projectsCreate = vi
    .fn()
    .mockResolvedValue(
      opts?.projectsCreateResult ?? {
        ok: true,
        data: makeProject('new-id', 'Created'),
      },
    );
  const jiraTestConnection = vi
    .fn()
    .mockResolvedValue(
      opts?.jiraTestConnectionResult ?? {
        ok: true,
        data: {
          accountId: 'acc-1',
          displayName: 'Test User',
          emailAddress: 'test@example.com',
        },
      },
    );

  const api: IpcApi = {
    ping: vi.fn<IpcApi['ping']>().mockResolvedValue({ reply: 'pong', receivedAt: 0 }),
    claude: {
      run: vi.fn<IpcApi['claude']['run']>().mockResolvedValue(unusedErr()),
      cancel: vi.fn<IpcApi['claude']['cancel']>().mockResolvedValue(unusedErr()),
      write: vi.fn<IpcApi['claude']['write']>().mockResolvedValue(unusedErr()),
      status: vi
        .fn<IpcApi['claude']['status']>()
        .mockResolvedValue({ ok: true, data: { active: null } }),
      onOutput: vi.fn<IpcApi['claude']['onOutput']>(() => () => {}),
      onExit: vi.fn<IpcApi['claude']['onExit']>(() => () => {}),
    },
    projects: {
      list: vi
        .fn<IpcApi['projects']['list']>()
        .mockResolvedValue({ ok: true, data: [] }),
      get: vi.fn<IpcApi['projects']['get']>().mockResolvedValue(unusedErr()),
      create: projectsCreate as unknown as IpcApi['projects']['create'],
      update: vi.fn<IpcApi['projects']['update']>().mockResolvedValue(unusedErr()),
      delete: vi.fn<IpcApi['projects']['delete']>().mockResolvedValue(unusedErr()),
    },
    secrets: {
      set: secretsSet as unknown as IpcApi['secrets']['set'],
      get: vi.fn<IpcApi['secrets']['get']>().mockResolvedValue(unusedErr()),
      delete: vi.fn<IpcApi['secrets']['delete']>().mockResolvedValue(unusedErr()),
      list: vi.fn<IpcApi['secrets']['list']>().mockResolvedValue(unusedErr()),
    },
    jira: {
      list: vi.fn<IpcApi['jira']['list']>().mockResolvedValue(unusedErr()),
      refresh: vi.fn<IpcApi['jira']['refresh']>().mockResolvedValue(unusedErr()),
      testConnection:
        jiraTestConnection as unknown as IpcApi['jira']['testConnection'],
      refreshPollers: vi
        .fn<IpcApi['jira']['refreshPollers']>()
        .mockResolvedValue(unusedErr()),
      onTicketsChanged: vi.fn<IpcApi['jira']['onTicketsChanged']>(() => () => {}),
      onError: vi.fn<IpcApi['jira']['onError']>(() => () => {}),
    },
    connections: {
      list: vi.fn() as unknown as IpcApi['connections']['list'],
      get: vi.fn() as unknown as IpcApi['connections']['get'],
      create: vi.fn() as unknown as IpcApi['connections']['create'],
      update: vi.fn() as unknown as IpcApi['connections']['update'],
      delete: vi.fn() as unknown as IpcApi['connections']['delete'],
      test: vi.fn() as unknown as IpcApi['connections']['test'],
    },
    runs: {
      start: vi.fn<IpcApi['runs']['start']>().mockResolvedValue(unusedErr()),
      cancel: vi.fn<IpcApi['runs']['cancel']>().mockResolvedValue(unusedErr()),
      approve: vi.fn<IpcApi['runs']['approve']>().mockResolvedValue(unusedErr()),
      reject: vi.fn<IpcApi['runs']['reject']>().mockResolvedValue(unusedErr()),
      modify: vi.fn<IpcApi['runs']['modify']>().mockResolvedValue(unusedErr()),
      current: vi
        .fn<IpcApi['runs']['current']>()
        .mockResolvedValue({ ok: true, data: { run: null } }),
      listHistory: vi
        .fn<IpcApi['runs']['listHistory']>()
        .mockResolvedValue(unusedErr()),
      onCurrentChanged: vi.fn<IpcApi['runs']['onCurrentChanged']>(() => () => {}),
      onStateChanged: vi.fn<IpcApi['runs']['onStateChanged']>(() => () => {}),
      // #8: extend with readLog so AddProject (and any code that imports the
      // full IpcApi via tree-shaken renderer modules) sees a complete bridge.
      readLog: vi.fn().mockResolvedValue({ ok: true, data: { entries: [] } }),
    } as unknown as IpcApi['runs'],
  };

  (window as { api?: IpcApi }).api = api;
  return { api, secretsSet, projectsCreate, jiraTestConnection };
}

/**
 * Convenience: fills every input that has a data-testid we expect on the
 * AddProject form with a valid value. Test IDs follow the convention
 * `add-project-<field>` per the spec's "all interactive elements MUST have
 * data-testid" rule. Specific field test IDs are inferred from the spec's
 * named inputs.
 */
function fillValidForm() {
  fireEvent.change(screen.getByTestId('field-name'), {
    target: { value: 'My Project' },
  });
  // Repository
  // Repository Type select defaults to github; setting explicitly is fine.
  fireEvent.change(screen.getByTestId('field-repo-type'), {
    target: { value: 'github' },
  });
  fireEvent.change(screen.getByTestId('field-repo-local-path'), {
    target: { value: '/abs/path/repo' },
  });
  fireEvent.change(screen.getByTestId('field-repo-base-branch'), {
    target: { value: 'main' },
  });
  fireEvent.change(screen.getByTestId('field-repo-token'), {
    target: { value: 'gh_token_123' },
  });
  // Ticket source
  fireEvent.change(screen.getByTestId('field-ticket-source'), {
    target: { value: 'jira' },
  });
  fireEvent.change(screen.getByTestId('field-ticket-query'), {
    target: { value: 'project = ABC AND status = "Ready for AI"' },
  });
  fireEvent.change(screen.getByTestId('field-jira-host'), {
    target: { value: 'https://example.atlassian.net' },
  });
  fireEvent.change(screen.getByTestId('field-jira-email'), {
    target: { value: 'me@example.com' },
  });
  fireEvent.change(screen.getByTestId('field-jira-token'), {
    target: { value: 'jira_token_456' },
  });
  // Workflow
  fireEvent.change(screen.getByTestId('field-branch-format'), {
    target: { value: 'feature/{ticketKey}-{slug}' },
  });
}

afterEach(() => {
  cleanup();
  delete (window as { api?: IpcApi }).api;
  vi.restoreAllMocks();
});

describe('<AddProject /> — ADD', () => {
  describe('ADD-001 layout', () => {
    beforeEach(() => {
      installApi();
    });

    it('ADD-001: renders 4 numbered FormSection cards in order', () => {
      render(<AddProject onClose={() => {}} onCreated={async () => {}} />);
      // Each FormSection should be findable by data-testid
      expect(screen.getByTestId('add-project-section-1')).toBeInTheDocument();
      expect(screen.getByTestId('add-project-section-2')).toBeInTheDocument();
      expect(screen.getByTestId('add-project-section-3')).toBeInTheDocument();
      expect(screen.getByTestId('add-project-section-4')).toBeInTheDocument();

      // Order check via DOM position
      const all = [
        screen.getByTestId('add-project-section-1'),
        screen.getByTestId('add-project-section-2'),
        screen.getByTestId('add-project-section-3'),
        screen.getByTestId('add-project-section-4'),
      ];
      for (let i = 1; i < all.length; i++) {
        const prev = all[i - 1] as HTMLElement;
        const cur = all[i] as HTMLElement;
        // DOCUMENT_POSITION_FOLLOWING = 4
         
        expect(prev.compareDocumentPosition(cur) & 4).toBeTruthy();
      }
    });
  });

  describe('ADD-002 empty submit', () => {
    let stub: ApiStub;
    beforeEach(() => {
      stub = installApi();
    });

    it('ADD-002: empty submit shows >=4 inline errors and does not call IPC', async () => {
      render(<AddProject onClose={() => {}} onCreated={async () => {}} />);

      const submit = screen.getByTestId('add-project-submit');
      fireEvent.click(submit);

      // The validator collects all errors. We expect at least 4 inline
      // messages whose text matches one of the validator codes' english
      // wording: "required" / "empty" / "absolute" / "invalid".
      await waitFor(() => {
        const errors = screen.getAllByText(/required|empty|absolute|invalid/i);
        expect(errors.length).toBeGreaterThanOrEqual(4);
      });

      expect(stub.secretsSet).not.toHaveBeenCalled();
      expect(stub.projectsCreate).not.toHaveBeenCalled();
    });
  });

  describe('ADD-003 relative repo path', () => {
    let stub: ApiStub;
    beforeEach(() => {
      stub = installApi();
    });

    it('ADD-003: repo path "relative/path" → NOT_ABSOLUTE error inline; submit blocked', async () => {
      render(<AddProject onClose={() => {}} onCreated={async () => {}} />);
      fillValidForm();
      // Override repo path with a relative path
      fireEvent.change(screen.getByTestId('field-repo-local-path'), {
        target: { value: 'relative/path' },
      });

      fireEvent.click(screen.getByTestId('add-project-submit'));

      await waitFor(() => {
        // The validator emits "must be an absolute path" — section 2 also
        // has a static description containing "absolute", so we assert at
        // least 2 matches (description + the inline error).
        const section2 = screen.getByTestId('add-project-section-2');
        const matches = within(section2).getAllByText(/absolute/i);
        expect(matches.length).toBeGreaterThanOrEqual(2);
      });

      // Submit was blocked
      expect(stub.projectsCreate).not.toHaveBeenCalled();
    });
  });

  describe('ADD-004 invalid branch format', () => {
    beforeEach(() => {
      installApi();
    });

    it('ADD-004: branch format without {ticketKey}/{slug} → INVALID_BRANCH_FORMAT inline', async () => {
      render(<AddProject onClose={() => {}} onCreated={async () => {}} />);
      fillValidForm();
      // Override branch format to a string without placeholders
      fireEvent.change(screen.getByTestId('field-branch-format'), {
        target: { value: 'feature/no-placeholders' },
      });

      fireEvent.click(screen.getByTestId('add-project-submit'));

      await waitFor(() => {
        const section4 = screen.getByTestId('add-project-section-4');
        // Validator message mentions {ticketKey} / {slug} placeholders.
        // When the error renders it REPLACES the hint (Input.tsx renders
        // one or the other), so we expect >= 1 match — the inline error.
        const matches = within(section4).getAllByText(/ticketKey|slug/i);
        expect(matches.length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  describe('ADD-005 default mode picker', () => {
    beforeEach(() => {
      installApi();
    });

    it('ADD-005: Interactive selected by default in mode picker', () => {
      render(<AddProject onClose={() => {}} onCreated={async () => {}} />);
      const interactive = screen.getByTestId('mode-interactive');
      // Either aria-selected="true" or a data-selected attribute, or a
      // class containing "selected". We check all three permissively.
      const selectedAttr =
        interactive.getAttribute('aria-selected') === 'true' ||
        interactive.getAttribute('data-selected') === 'true' ||
        /selected/i.test(interactive.className);
      expect(selectedAttr).toBe(true);
    });
  });

  describe('ADD-006 invocation order', () => {
    let stub: ApiStub;
    beforeEach(() => {
      stub = installApi();
    });

    it('ADD-006: secrets.set called BEFORE projects.create on valid submit', async () => {
      render(<AddProject onClose={() => {}} onCreated={async () => {}} />);
      fillValidForm();
      fireEvent.click(screen.getByTestId('add-project-submit'));

      await waitFor(() => {
        expect(stub.secretsSet).toHaveBeenCalled();
        expect(stub.projectsCreate).toHaveBeenCalled();
      });

      // Vitest exposes invocationCallOrder per fn — global counter, so
      // comparing across two mocks within a single test is valid.
      const secretsCalls = stub.secretsSet.mock.invocationCallOrder;
      const createCalls = stub.projectsCreate.mock.invocationCallOrder;
      expect(secretsCalls.length).toBeGreaterThan(0);
      expect(createCalls.length).toBeGreaterThan(0);
      const firstSecret = secretsCalls[0];
      const firstCreate = createCalls[0];
      expect(firstSecret).toBeDefined();
      expect(firstCreate).toBeDefined();
      expect(firstSecret as number).toBeLessThan(firstCreate as number);
    });
  });

  describe('ADD-007 secrets.set fails', () => {
    let stub: ApiStub;
    beforeEach(() => {
      stub = installApi({
        secretsSetResult: {
          ok: false,
          error: { code: 'KEYTAR_FAIL', message: 'keychain unavailable' },
        },
      });
    });

    it('ADD-007: secrets.set fails → no projects.create call, banner shown', async () => {
      render(<AddProject onClose={() => {}} onCreated={async () => {}} />);
      fillValidForm();
      fireEvent.click(screen.getByTestId('add-project-submit'));

      await waitFor(() => {
        expect(screen.getByTestId('add-project-banner')).toBeInTheDocument();
      });

      // Banner mentions repo or jira token failure
      expect(screen.getByTestId('add-project-banner').textContent).toMatch(
        /(token|secrets|repo|jira|fail)/i,
      );
      expect(stub.projectsCreate).not.toHaveBeenCalled();
    });
  });

  describe('ADD-008 projects.create fails', () => {
    let stub: ApiStub;
    let onCreated: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      stub = installApi({
        projectsCreateResult: {
          ok: false,
          error: { code: 'WRITE_FAIL', message: 'disk full' },
        },
      });
      onCreated = vi.fn().mockResolvedValue(undefined);
    });

    it('ADD-008: secrets.set ok then projects.create fails → banner shown, dialog stays open, values preserved', async () => {
      render(<AddProject onClose={() => {}} onCreated={onCreated} />);
      fillValidForm();
      fireEvent.click(screen.getByTestId('add-project-submit'));

      await waitFor(() => {
        expect(screen.getByTestId('add-project-banner')).toBeInTheDocument();
      });

      // onCreated NOT called → dialog remains open
      expect(onCreated).not.toHaveBeenCalled();
      // Form values preserved — Project Name still "My Project"
      const nameInput = screen.getByTestId('field-name') as HTMLInputElement;
      expect(nameInput.value).toBe('My Project');
      // secretsSet was called, projectsCreate was attempted
      expect(stub.secretsSet).toHaveBeenCalled();
      expect(stub.projectsCreate).toHaveBeenCalled();
    });
  });

  describe('ADD-009 success', () => {
    let onCreated: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      installApi();
      onCreated = vi.fn().mockResolvedValue(undefined);
    });

    it('ADD-009: all succeed → onCreated callback fires', async () => {
      render(<AddProject onClose={() => {}} onCreated={onCreated} />);
      fillValidForm();
      fireEvent.click(screen.getByTestId('add-project-submit'));

      await waitFor(() => {
        expect(onCreated).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('ADD-010/011 Test Connection pill', () => {
    it('ADD-010: success pill shows "Connected as {displayName}"', async () => {
      installApi({
        jiraTestConnectionResult: {
          ok: true,
          data: {
            accountId: 'acc',
            displayName: 'Ada Lovelace',
            emailAddress: 'ada@example.com',
          },
        },
      });

      render(<AddProject onClose={() => {}} onCreated={async () => {}} />);
      // Fill the Jira fields so test-connection has values to use
      fireEvent.change(screen.getByTestId('field-jira-host'), {
        target: { value: 'https://example.atlassian.net' },
      });
      fireEvent.change(screen.getByTestId('field-jira-email'), {
        target: { value: 'ada@example.com' },
      });
      fireEvent.change(screen.getByTestId('field-jira-token'), {
        target: { value: 'token' },
      });

      fireEvent.click(screen.getByTestId('test-connection-button'));

      await waitFor(() => {
        const pill = screen.getByTestId('test-connection-result');
        expect(pill).toBeInTheDocument();
        expect(pill.textContent).toMatch(/ada lovelace/i);
      });
    });

    it('ADD-011: error pill shows error code', async () => {
      installApi({
        jiraTestConnectionResult: {
          ok: false,
          error: { code: 'AUTH', message: 'unauthorized' },
        },
      });

      render(<AddProject onClose={() => {}} onCreated={async () => {}} />);
      fireEvent.change(screen.getByTestId('field-jira-host'), {
        target: { value: 'https://example.atlassian.net' },
      });
      fireEvent.change(screen.getByTestId('field-jira-email'), {
        target: { value: 'me@example.com' },
      });
      fireEvent.change(screen.getByTestId('field-jira-token'), {
        target: { value: 'badtoken' },
      });

      fireEvent.click(screen.getByTestId('test-connection-button'));

      await waitFor(() => {
        const pill = screen.getByTestId('test-connection-result');
        expect(pill).toBeInTheDocument();
        // Error code or message should be visible. Match either.
        expect(pill.textContent).toMatch(/AUTH|unauthorized/i);
      });
    });
  });

  describe('ADD-012 YOLO mode', () => {
    let stub: ApiStub;
    beforeEach(() => {
      stub = installApi();
    });

    it('ADD-012: YOLO mode selected → projects.create called with workflow.mode === "yolo"', async () => {
      render(<AddProject onClose={() => {}} onCreated={async () => {}} />);
      fillValidForm();

      // Switch from Interactive (default) to YOLO
      fireEvent.click(screen.getByTestId('mode-yolo'));

      fireEvent.click(screen.getByTestId('add-project-submit'));

      await waitFor(() => {
        expect(stub.projectsCreate).toHaveBeenCalled();
      });

      // Inspect the request payload
      const callArgs = stub.projectsCreate.mock.calls[0];
      expect(callArgs).toBeDefined();
      const req = (callArgs as unknown[])[0] as ProjectsCreateRequest;
      expect(req.input.workflow.mode).toBe('yolo');
    });
  });
});
