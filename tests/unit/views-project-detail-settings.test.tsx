// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { IpcApi, IpcResult, ProjectInstanceDto, Run } from '../../src/shared/ipc';
import { ProjectSettingsTab } from '../../src/renderer/views/ProjectSettingsTab';
import {
  __resetNotificationsForTests,
  getToasts,
} from '../../src/renderer/state/notifications';

/**
 * SETTINGS-001..010 — <ProjectSettingsTab> view (GH-68).
 *
 * The tab embeds <AddProject editing={project}> for the form body and
 * layers a Destructive Zone (delete button + confirm dialog) below it.
 * These tests focus on the destructive-zone affordance, the active-run
 * guard, and the prop-wiring between the embedded form and the parent —
 * AddProject's own internals are exercised by views-add-project.test.tsx,
 * so we mock the AddProject module here to keep this test surface narrow.
 */

declare global {
  interface Window {
    api?: IpcApi;
  }
}

interface MockedAddProjectProps {
  onClose: () => void;
  onCreated: () => Promise<void> | void;
  editing?: ProjectInstanceDto;
}

vi.mock('../../src/renderer/views/AddProject', () => ({
  AddProject: (props: MockedAddProjectProps) => {
    // Stand-in form: surfaces the editing project's id and exposes two
    // testid buttons so SETTINGS-* tests can drive the prop callbacks
    // without going through the real connection-picker stack.
    return (
      <div data-testid="mock-add-project">
        <span data-testid="mock-add-project-editing-id">
          {props.editing?.id ?? '(none)'}
        </span>
        <button
          type="button"
          data-testid="mock-add-project-save"
          onClick={() => {
            void props.onCreated();
          }}
        >
          Save (mock)
        </button>
        <button
          type="button"
          data-testid="mock-add-project-discard"
          onClick={() => {
            props.onClose();
          }}
        >
          Discard (mock)
        </button>
      </div>
    );
  },
}));

function makeProject(id: string, name: string): ProjectInstanceDto {
  return {
    id,
    name,
    repo: {
      type: 'github',
      localPath: '/abs/' + id,
      baseBranch: 'main',
      connectionId: 'conn-gh-1',
      slug: 'gazhang/frontend-app',
    },
    tickets: {
      source: 'jira',
      connectionId: 'conn-jr-1',
      projectKey: 'PROJ',
    },
    workflow: { mode: 'interactive', branchFormat: 'feature/{ticketKey}-{slug}' },
    createdAt: 0,
    updatedAt: 0,
  };
}

function makeRun(projectId: string, overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    projectId,
    ticketKey: 'PROJ-1',
    ticketSummary: 'Demo ticket',
    branchName: 'feature/PROJ-1',
    state: 'running',
    status: 'running',
    startedAt: 0,
    finishedAt: undefined,
    pendingApproval: null,
    prUrl: null,
    error: null,
    ...overrides,
  } as Run;
}

interface ApiStub {
  api: IpcApi;
  projectsDelete: ReturnType<typeof vi.fn>;
}

function installApi(opts?: {
  deleteResult?: IpcResult<{ id: string }>;
}): ApiStub {
  const unusedErr = (): IpcResult<never> => ({
    ok: false,
    error: { code: 'NOT_USED_IN_FE_TESTS', message: '' },
  });

  const projectsDelete = vi
    .fn()
    .mockResolvedValue(opts?.deleteResult ?? { ok: true, data: { id: 'p-1' } });

  const api: IpcApi = {
    ping: vi.fn().mockResolvedValue({ reply: 'pong', receivedAt: 0 }),
    claude: {
      run: vi.fn().mockResolvedValue(unusedErr()),
      cancel: vi.fn().mockResolvedValue(unusedErr()),
      write: vi.fn().mockResolvedValue(unusedErr()),
      status: vi.fn().mockResolvedValue({ ok: true, data: { active: null } }),
      onOutput: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
    } as unknown as IpcApi['claude'],
    projects: {
      list: vi.fn().mockResolvedValue({ ok: true, data: [] }),
      get: vi.fn().mockResolvedValue(unusedErr()),
      create: vi.fn().mockResolvedValue(unusedErr()),
      update: vi.fn().mockResolvedValue(unusedErr()),
      delete: projectsDelete,
    } as unknown as IpcApi['projects'],
    secrets: {
      set: vi.fn().mockResolvedValue(unusedErr()),
      get: vi.fn().mockResolvedValue(unusedErr()),
      delete: vi.fn().mockResolvedValue(unusedErr()),
      list: vi.fn().mockResolvedValue(unusedErr()),
    } as unknown as IpcApi['secrets'],
    jira: {
      list: vi.fn().mockResolvedValue(unusedErr()),
      refresh: vi.fn().mockResolvedValue(unusedErr()),
      testConnection: vi.fn().mockResolvedValue(unusedErr()),
      refreshPollers: vi.fn().mockResolvedValue(unusedErr()),
      onTicketsChanged: vi.fn(() => () => {}),
      onError: vi.fn(() => () => {}),
    } as unknown as IpcApi['jira'],
    connections: {
      list: vi.fn().mockResolvedValue({ ok: true, data: [] }),
      get: vi.fn().mockResolvedValue(unusedErr()),
      create: vi.fn().mockResolvedValue(unusedErr()),
      update: vi.fn().mockResolvedValue(unusedErr()),
      delete: vi.fn().mockResolvedValue(unusedErr()),
      test: vi.fn().mockResolvedValue(unusedErr()),
      listRepos: vi.fn().mockResolvedValue(unusedErr()),
      listJiraProjects: vi.fn().mockResolvedValue(unusedErr()),
      listBranches: vi.fn().mockResolvedValue(unusedErr()),
    } as unknown as IpcApi['connections'],
    dialog: {
      selectFolder: vi.fn().mockResolvedValue(unusedErr()),
    } as unknown as IpcApi['dialog'],
    runs: {
      start: vi.fn().mockResolvedValue(unusedErr()),
      cancel: vi.fn().mockResolvedValue(unusedErr()),
      approve: vi.fn().mockResolvedValue(unusedErr()),
      reject: vi.fn().mockResolvedValue(unusedErr()),
      modify: vi.fn().mockResolvedValue(unusedErr()),
      current: vi.fn().mockResolvedValue({ ok: true, data: { run: null } }),
      listHistory: vi.fn().mockResolvedValue(unusedErr()),
      delete: vi.fn().mockResolvedValue(unusedErr()),
      readLog: vi.fn().mockResolvedValue({ ok: true, data: { entries: [] } }),
      onCurrentChanged: vi.fn(() => () => {}),
      onStateChanged: vi.fn(() => () => {}),
    } as unknown as IpcApi['runs'],
    tickets: {
      list: vi.fn().mockResolvedValue(unusedErr()),
    } as unknown as IpcApi['tickets'],
    pulls: {
      list: vi.fn().mockResolvedValue(unusedErr()),
    } as unknown as IpcApi['pulls'],
    chrome: {
      minimize: vi.fn().mockResolvedValue({ ok: true, data: null }),
      maximize: vi.fn().mockResolvedValue({ ok: true, data: null }),
      close: vi.fn().mockResolvedValue({ ok: true, data: null }),
      getState: vi.fn().mockResolvedValue({
        ok: true,
        data: { isMaximized: false, platform: 'win32' },
      }),
      onStateChanged: vi.fn(() => () => {}),
    } as unknown as IpcApi['chrome'],
    skills: {
      list: vi.fn().mockResolvedValue(unusedErr()),
      install: vi.fn().mockResolvedValue(unusedErr()),
      remove: vi.fn().mockResolvedValue(unusedErr()),
      findStart: vi.fn().mockResolvedValue(unusedErr()),
      findCancel: vi.fn().mockResolvedValue(unusedErr()),
      onFindOutput: vi.fn(() => () => {}),
      onFindExit: vi.fn(() => () => {}),
    } as unknown as IpcApi['skills'],
    shell: {
      openPath: vi.fn().mockResolvedValue({ ok: true, data: null }),
      openExternal: vi.fn().mockResolvedValue({ ok: true, data: null }),
    } as unknown as IpcApi['shell'],
    appConfig: {
      get: vi.fn().mockResolvedValue({ ok: false, error: { code: 'NOT_USED_IN_FE_TESTS', message: '' } }),
      set: vi.fn().mockResolvedValue({ ok: false, error: { code: 'NOT_USED_IN_FE_TESTS', message: '' } }),
    },

  };

  (window as { api?: IpcApi }).api = api;
  return { api, projectsDelete };
}

beforeEach(() => {
  __resetNotificationsForTests();
});

afterEach(() => {
  cleanup();
  delete (window as { api?: IpcApi }).api;
  __resetNotificationsForTests();
  vi.restoreAllMocks();
});

describe('<ProjectSettingsTab /> — SETTINGS', () => {
  // ---------------------------------------------------------------------------
  // SETTINGS-001 — Tab embeds AddProject in editing mode + Destructive Zone
  // ---------------------------------------------------------------------------
  describe('SETTINGS-001 tab structure', () => {
    it('SETTINGS-001: renders the embedded AddProject form (editing the project) plus the Destructive Zone', () => {
      installApi();
      const project = makeProject('p-1', 'Alpha');
      render(
        <ProjectSettingsTab
          project={project}
          activeRun={null}
          onProjectChanged={() => {}}
          onDeleted={() => {}}
        />,
      );
      expect(screen.getByTestId('project-settings-tab')).toBeInTheDocument();
      expect(screen.getByTestId('mock-add-project')).toBeInTheDocument();
      // Editing is bound to this project
      expect(screen.getByTestId('mock-add-project-editing-id')).toHaveTextContent(
        'p-1',
      );
      expect(screen.getByTestId('settings-danger-zone')).toBeInTheDocument();
      expect(screen.getByTestId('settings-delete-project')).toBeInTheDocument();
      // No active-run banner when no run is active
      expect(
        screen.queryByTestId('settings-delete-blocked-banner'),
      ).not.toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // SETTINGS-002 — Save success: dispatches 'Project updated' toast +
  // calls onProjectChanged
  // ---------------------------------------------------------------------------
  describe('SETTINGS-002 save success', () => {
    it('SETTINGS-002: AddProject onCreated → success toast dispatched + onProjectChanged fired', async () => {
      installApi();
      const project = makeProject('p-1', 'Alpha');
      const onProjectChanged = vi.fn().mockResolvedValue(undefined);
      render(
        <ProjectSettingsTab
          project={project}
          activeRun={null}
          onProjectChanged={onProjectChanged}
          onDeleted={() => {}}
        />,
      );

      fireEvent.click(screen.getByTestId('mock-add-project-save'));

      await waitFor(() => {
        expect(onProjectChanged).toHaveBeenCalled();
      });

      const toasts = getToasts();
      expect(toasts).toHaveLength(1);
      const [first] = toasts;
      expect(first?.type).toBe('success');
      expect(first?.title).toBe('Project updated');
      // Salted dedupeKey so a second save fires a fresh toast + timer
      // instead of dedupe-replacing the first one in place.
      expect(first?.dedupeKey).toMatch(/^project-updated-p-1-\d+$/);
    });
  });

  // ---------------------------------------------------------------------------
  // SETTINGS-003 — Discard remounts AddProject so it re-derives form state
  // ---------------------------------------------------------------------------
  describe('SETTINGS-003 discard remounts form', () => {
    it('SETTINGS-003: clicking Discard remounts AddProject (new instance receives editing prop again)', () => {
      installApi();
      const project = makeProject('p-1', 'Alpha');
      render(
        <ProjectSettingsTab
          project={project}
          activeRun={null}
          onProjectChanged={() => {}}
          onDeleted={() => {}}
        />,
      );
      // The mock AddProject renders the editing id; before discard it's there.
      expect(screen.getByTestId('mock-add-project-editing-id')).toHaveTextContent(
        'p-1',
      );
      // Click discard — bumps the remount-key so AddProject re-mounts with a
      // fresh copy of the project. We can't observe the bumped key directly,
      // but we can confirm the click doesn't throw and the form stays mounted
      // and bound to the same project.
      fireEvent.click(screen.getByTestId('mock-add-project-discard'));
      expect(screen.getByTestId('mock-add-project')).toBeInTheDocument();
      expect(screen.getByTestId('mock-add-project-editing-id')).toHaveTextContent(
        'p-1',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // SETTINGS-004 — Delete button opens the confirm dialog
  // ---------------------------------------------------------------------------
  describe('SETTINGS-004 delete dialog open', () => {
    it('SETTINGS-004: clicking Delete project opens the confirm dialog', () => {
      installApi();
      const project = makeProject('p-1', 'Alpha');
      render(
        <ProjectSettingsTab
          project={project}
          activeRun={null}
          onProjectChanged={() => {}}
          onDeleted={() => {}}
        />,
      );
      expect(screen.queryByTestId('settings-delete-dialog')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('settings-delete-project'));
      expect(screen.getByTestId('settings-delete-dialog')).toBeInTheDocument();
      expect(screen.getByTestId('settings-delete-confirm-input')).toBeInTheDocument();
      // Confirm starts disabled (no typed name)
      const confirm = screen.getByTestId(
        'settings-delete-confirm',
      ) as HTMLButtonElement;
      expect(confirm.disabled).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // SETTINGS-005 — Confirm requires exact project-name match
  // ---------------------------------------------------------------------------
  describe('SETTINGS-005 confirm requires name match', () => {
    it('SETTINGS-005: typed-name mismatch keeps confirm disabled; exact match enables it', () => {
      installApi();
      const project = makeProject('p-1', 'Alpha');
      render(
        <ProjectSettingsTab
          project={project}
          activeRun={null}
          onProjectChanged={() => {}}
          onDeleted={() => {}}
        />,
      );
      fireEvent.click(screen.getByTestId('settings-delete-project'));
      const input = screen.getByTestId(
        'settings-delete-confirm-input',
      ) as HTMLInputElement;
      const confirm = screen.getByTestId(
        'settings-delete-confirm',
      ) as HTMLButtonElement;

      fireEvent.change(input, { target: { value: 'alpha' } });
      expect(confirm.disabled).toBe(true);

      fireEvent.change(input, { target: { value: 'Alpha' } });
      expect(confirm.disabled).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // SETTINGS-006 — Successful delete calls projects.delete + onDeleted
  // ---------------------------------------------------------------------------
  describe('SETTINGS-006 delete success', () => {
    it('SETTINGS-006: confirm → projects.delete called with id, onDeleted fired, success toast dispatched', async () => {
      const stub = installApi();
      const project = makeProject('p-1', 'Alpha');
      const onDeleted = vi.fn();
      render(
        <ProjectSettingsTab
          project={project}
          activeRun={null}
          onProjectChanged={() => {}}
          onDeleted={onDeleted}
        />,
      );

      fireEvent.click(screen.getByTestId('settings-delete-project'));
      fireEvent.change(screen.getByTestId('settings-delete-confirm-input'), {
        target: { value: 'Alpha' },
      });
      fireEvent.click(screen.getByTestId('settings-delete-confirm'));

      await waitFor(() => {
        expect(stub.projectsDelete).toHaveBeenCalledWith({ id: 'p-1' });
      });
      await waitFor(() => {
        expect(onDeleted).toHaveBeenCalledTimes(1);
      });

      const toasts = getToasts();
      expect(toasts.some((t) => t.title === 'Project deleted')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // SETTINGS-007 — Delete failure surfaces error in dialog; onDeleted NOT fired
  // ---------------------------------------------------------------------------
  describe('SETTINGS-007 delete failure', () => {
    it('SETTINGS-007: failure response → error rendered inline in the dialog, onDeleted not called, dialog stays open', async () => {
      installApi({
        deleteResult: {
          ok: false,
          error: { code: 'IO_FAILURE', message: 'disk full' },
        },
      });
      const project = makeProject('p-1', 'Alpha');
      const onDeleted = vi.fn();
      render(
        <ProjectSettingsTab
          project={project}
          activeRun={null}
          onProjectChanged={() => {}}
          onDeleted={onDeleted}
        />,
      );

      fireEvent.click(screen.getByTestId('settings-delete-project'));
      fireEvent.change(screen.getByTestId('settings-delete-confirm-input'), {
        target: { value: 'Alpha' },
      });
      fireEvent.click(screen.getByTestId('settings-delete-confirm'));

      await waitFor(() => {
        expect(
          screen.queryByTestId('settings-delete-confirm-error'),
        ).toBeInTheDocument();
      });
      expect(
        screen.getByTestId('settings-delete-confirm-error'),
      ).toHaveTextContent(/disk full/);
      expect(onDeleted).not.toHaveBeenCalled();
      // Dialog is still open so the user can retry / dismiss.
      expect(screen.getByTestId('settings-delete-dialog')).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // SETTINGS-008 — Active run gating: button disabled + banner visible
  // ---------------------------------------------------------------------------
  describe('SETTINGS-008 active run blocks delete', () => {
    it('SETTINGS-008: activeRun targeting this project disables Delete + shows banner', () => {
      installApi();
      const project = makeProject('p-1', 'Alpha');
      const activeRun = makeRun('p-1');
      render(
        <ProjectSettingsTab
          project={project}
          activeRun={activeRun}
          onProjectChanged={() => {}}
          onDeleted={() => {}}
        />,
      );
      const button = screen.getByTestId(
        'settings-delete-project',
      ) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(
        screen.getByTestId('settings-delete-blocked-banner'),
      ).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // SETTINGS-009 — Active run targeting a DIFFERENT project does NOT block
  // ---------------------------------------------------------------------------
  describe('SETTINGS-009 active run on another project does not block', () => {
    it('SETTINGS-009: activeRun.projectId !== project.id → Delete remains enabled, no banner', () => {
      installApi();
      const project = makeProject('p-1', 'Alpha');
      const otherRun = makeRun('p-other');
      render(
        <ProjectSettingsTab
          project={project}
          activeRun={otherRun}
          onProjectChanged={() => {}}
          onDeleted={() => {}}
        />,
      );
      const button = screen.getByTestId(
        'settings-delete-project',
      ) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      expect(
        screen.queryByTestId('settings-delete-blocked-banner'),
      ).not.toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // SETTINGS-010 — Cancel from the confirm dialog closes it without IPC
  // ---------------------------------------------------------------------------
  describe('SETTINGS-010 cancel from confirm dialog', () => {
    it('SETTINGS-010: clicking Cancel closes the dialog without calling projects.delete', () => {
      const stub = installApi();
      const project = makeProject('p-1', 'Alpha');
      render(
        <ProjectSettingsTab
          project={project}
          activeRun={null}
          onProjectChanged={() => {}}
          onDeleted={() => {}}
        />,
      );

      fireEvent.click(screen.getByTestId('settings-delete-project'));
      fireEvent.change(screen.getByTestId('settings-delete-confirm-input'), {
        target: { value: 'Alpha' },
      });
      fireEvent.click(screen.getByTestId('settings-delete-confirm-cancel'));

      expect(
        screen.queryByTestId('settings-delete-dialog'),
      ).not.toBeInTheDocument();
      expect(stub.projectsDelete).not.toHaveBeenCalled();
    });
  });
});
