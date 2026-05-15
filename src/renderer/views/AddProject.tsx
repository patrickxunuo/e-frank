import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  validateProjectInstanceInput,
  type ProjectInstanceInput,
  type TicketsConfig,
  type ValidationError,
} from '@shared/schema/project-instance.js';
import type { Connection, ProjectInstanceDto } from '@shared/ipc';
import { Button } from '../components/Button';
import { Dropdown, type DropdownOption } from '../components/Dropdown';
import { EmptyState } from '../components/EmptyState';
import { FormSection } from '../components/FormSection';
import { Input } from '../components/Input';
import { Textarea } from '../components/Textarea';
import { AddConnectionDialog } from '../components/AddConnectionDialog';
import { RadioCardGroup } from '../components/RadioCardGroup';
import {
  IconAlert,
  IconCheck,
  IconFolder,
  IconKey,
  IconPlay,
  IconPlus,
  IconRefresh,
} from '../components/icons';
import { useAppConfig } from '../state/app-config';
import { useConnections } from '../state/connections';
import {
  useConnectionRepos,
  useConnectionJiraProjects,
  useConnectionBranches,
} from '../state/connection-resources';
import styles from './AddProject.module.css';

export interface AddProjectProps {
  onClose: () => void;
  onCreated: () => Promise<void> | void;
  /**
   * When set, the form pre-fills from this project. Save dispatches an
   * update instead of a create, and `onCreated` runs on success.
   */
  editing?: ProjectInstanceDto;
}

type WorkflowMode = 'interactive' | 'yolo';
type TicketsSource = 'jira' | 'github-issues';

interface FormState {
  name: string;
  // Source repo
  repoConnectionId: string;
  repoSlug: string;
  repoLocalPath: string;
  repoBaseBranch: string;
  // Tickets
  ticketsSource: TicketsSource;
  ticketsConnectionId: string;
  ticketsProjectKey: string; // jira branch
  ticketsRepoSlug: string; // github-issues branch
  ticketLabels: string; // github-issues branch
  ticketQuery: string; // jira branch (optional JQL)
  // Workflow
  workflowMode: WorkflowMode;
  branchFormat: string;
}

const INITIAL: FormState = {
  name: '',
  repoConnectionId: '',
  repoSlug: '',
  repoLocalPath: '',
  repoBaseBranch: '',
  ticketsSource: 'jira',
  ticketsConnectionId: '',
  ticketsProjectKey: '',
  ticketsRepoSlug: '',
  ticketLabels: '',
  ticketQuery: '',
  workflowMode: 'interactive',
  branchFormat: '',
};

function formFromEditing(editing: ProjectInstanceDto): FormState {
  // The discriminated union forces a per-source pull — Jira projects only
  // populate `ticketsProjectKey/ticketQuery`; GitHub Issues projects only
  // populate `ticketsRepoSlug/ticketLabels`. Other slots stay empty so a
  // mid-edit source switch starts from a clean state.
  const t = editing.tickets;
  const base = {
    name: editing.name,
    repoConnectionId: editing.repo.connectionId,
    repoSlug: editing.repo.slug,
    repoLocalPath: editing.repo.localPath,
    repoBaseBranch: editing.repo.baseBranch,
    ticketsConnectionId: t.connectionId,
    workflowMode: editing.workflow.mode,
    branchFormat: editing.workflow.branchFormat,
  };
  if (t.source === 'jira') {
    return {
      ...base,
      ticketsSource: 'jira',
      ticketsProjectKey: t.projectKey,
      ticketsRepoSlug: '',
      ticketLabels: '',
      ticketQuery: t.query ?? '',
    };
  }
  return {
    ...base,
    ticketsSource: 'github-issues',
    ticketsProjectKey: '',
    ticketsRepoSlug: t.repoSlug,
    ticketLabels: t.labels ?? '',
    ticketQuery: '',
  };
}

function errorsByPath(errors: ValidationError[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of errors) {
    if (!m.has(e.path)) m.set(e.path, e.message);
  }
  return m;
}

function connectionLabel(c: Connection): string {
  return c.label;
}

export function AddProject({ onClose, onCreated, editing }: AddProjectProps): JSX.Element {
  const [form, setForm] = useState<FormState>(() =>
    editing ? formFromEditing(editing) : INITIAL,
  );
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>([]);
  const [banner, setBanner] = useState<{ title: string; detail?: string } | null>(null);
  // The "Add Connection" dialog opens for either provider depending on which
  // empty-state CTA was clicked. `null` means closed.
  const [addConnectionFor, setAddConnectionFor] = useState<
    'github' | 'jira' | null
  >(null);

  // #GH-86: in creation mode, pre-select the workflow-mode card from
  // `appConfig.defaultWorkflowMode` once the config has loaded — instead of
  // staying on the hardcoded INITIAL.workflowMode = 'interactive'. We only
  // seed once, and only if the user hasn't already touched the field, so a
  // click that lands during the initial load isn't clobbered. Editing mode
  // is exempt because `formFromEditing` already pins `workflowMode` to
  // `editing.workflow.mode`.
  const appConfig = useAppConfig();
  const workflowModeTouchedRef = useRef<boolean>(false);
  useEffect(() => {
    if (editing !== undefined) return;
    if (workflowModeTouchedRef.current) return;
    const next = appConfig.config?.defaultWorkflowMode;
    if (next === undefined) return;
    setForm((prev) =>
      prev.workflowMode === next ? prev : { ...prev, workflowMode: next },
    );
  }, [appConfig.config?.defaultWorkflowMode, editing]);

  const fieldErrors = useMemo(() => errorsByPath(validationErrors), [validationErrors]);

  const connectionsState = useConnections();
  const repoConnectionId = form.repoConnectionId === '' ? null : form.repoConnectionId;
  const ticketsConnectionId =
    form.ticketsConnectionId === '' ? null : form.ticketsConnectionId;
  const repoSlug = form.repoSlug === '' ? null : form.repoSlug;
  const repoResources = useConnectionRepos(repoConnectionId);
  const branchResources = useConnectionBranches(repoConnectionId, repoSlug);
  const jiraResources = useConnectionJiraProjects(
    form.ticketsSource === 'jira' ? ticketsConnectionId : null,
  );

  const githubConnections = useMemo(
    () => connectionsState.connections.filter((c) => c.provider === 'github'),
    [connectionsState.connections],
  );
  const jiraConnections = useMemo(
    () => connectionsState.connections.filter((c) => c.provider === 'jira'),
    [connectionsState.connections],
  );

  const pickedRepoConnection = useMemo<Connection | null>(() => {
    if (form.repoConnectionId === '') return null;
    return (
      connectionsState.connections.find((c) => c.id === form.repoConnectionId) ?? null
    );
  }, [connectionsState.connections, form.repoConnectionId]);

  const pickedTicketsConnection = useMemo<Connection | null>(() => {
    if (form.ticketsConnectionId === '') return null;
    return (
      connectionsState.connections.find((c) => c.id === form.ticketsConnectionId) ??
      null
    );
  }, [connectionsState.connections, form.ticketsConnectionId]);

  // Edit-mode broken-connection detection: only fire after the connections
  // list has loaded, so we don't flash the banner during the initial load.
  const repoConnectionMissing =
    editing !== undefined &&
    !connectionsState.loading &&
    form.repoConnectionId !== '' &&
    pickedRepoConnection === null;
  const ticketsConnectionMissing =
    editing !== undefined &&
    !connectionsState.loading &&
    form.ticketsConnectionId !== '' &&
    pickedTicketsConnection === null;

  const brokenConnections =
    repoConnectionMissing || ticketsConnectionMissing;

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleRepoConnectionChange = (next: string): void => {
    setForm((prev) => ({
      ...prev,
      repoConnectionId: next,
      repoSlug: '',
      // Drop the base branch when the repo connection changes — the new
      // connection's repos won't have any branches in scope yet.
      repoBaseBranch: '',
    }));
  };

  // The provider-aware tickets-connection change resets the per-source
  // resource fields so stale values can't leak across provider switches.
  const handleTicketsConnectionChange = (next: string): void => {
    setForm((prev) => ({
      ...prev,
      ticketsConnectionId: next,
      ticketsProjectKey: '',
      // Don't clobber `ticketsRepoSlug` here. For the github-issues source
      // it gets prefilled to `repoSlug` by handleTicketsSourceChange, and
      // resetting on every connection change would wipe that prefill the
      // moment the user picks a connection. If the new connection doesn't
      // have access to the prefilled slug, the picker / validator surface
      // the issue.
    }));
  };

  // When the user picks a different repo for the SOURCE side, default
  // `repoBaseBranch` to that repo's `defaultBranch` (read from the cached
  // listRepos response). The branches dropdown still shows the full branch
  // list; this just seeds the initial selection so the user doesn't have
  // to interact for the common case.
  useEffect(() => {
    if (form.repoSlug === '') return;
    const repo = repoResources.data.find((r) => r.slug === form.repoSlug);
    if (repo === undefined) return;
    // Only seed when empty OR when the current value isn't a real branch
    // for this repo (post-switch). We avoid clobbering a manual user pick
    // by only writing on transitions where repoBaseBranch is empty.
    if (form.repoBaseBranch === '') {
      setForm((prev) =>
        prev.repoSlug === form.repoSlug && prev.repoBaseBranch === ''
          ? { ...prev, repoBaseBranch: repo.defaultBranch }
          : prev,
      );
    }
    // We intentionally only react to repoSlug + repoResources.data here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.repoSlug, repoResources.data]);

  // For source='github-issues', the tickets ARE the source repo's issues —
  // mirror repoConnectionId / repoSlug onto the tickets fields whenever the
  // source side changes. The user doesn't pick a separate connection or
  // repo for github-issues; that would just be the same selection twice.
  // (For separate-issues-repo cases, the project schema still allows
  // distinct values; we just don't expose the picker.)
  useEffect(() => {
    if (form.ticketsSource !== 'github-issues') return;
    if (
      form.ticketsConnectionId === form.repoConnectionId &&
      form.ticketsRepoSlug === form.repoSlug
    ) {
      return;
    }
    setForm((prev) =>
      prev.ticketsSource === 'github-issues'
        ? {
            ...prev,
            ticketsConnectionId: prev.repoConnectionId,
            ticketsRepoSlug: prev.repoSlug,
          }
        : prev,
    );
  }, [
    form.ticketsSource,
    form.repoConnectionId,
    form.repoSlug,
    form.ticketsConnectionId,
    form.ticketsRepoSlug,
  ]);

  const handleTicketsSourceChange = (next: string): void => {
    if (next !== 'jira' && next !== 'github-issues') return;
    setForm((prev) => {
      const fresh: FormState = {
        ...prev,
        ticketsSource: next as TicketsSource,
        ticketsProjectKey: '',
        ticketLabels: '',
        ticketQuery: '',
        // For github-issues, the tickets connection + repo are the SAME as
        // the source's — no separate picker. For jira, reset both since the
        // jira connection picker is separate.
        ticketsConnectionId:
          next === 'github-issues' ? prev.repoConnectionId : '',
        ticketsRepoSlug: next === 'github-issues' ? prev.repoSlug : '',
      };
      return fresh;
    });
  };

  const handleBrowseRepoFolder = async (): Promise<void> => {
    if (typeof window === 'undefined' || !window.api) return;
    try {
      const result = await window.api.dialog.selectFolder({
        title: 'Select repository folder',
      });
      if (!result.ok) {
        // Soft failure — surface in the page banner so the user understands
        // why nothing happened. IO_FAILURE is rare (permission denied etc).
        setBanner({
          title: 'Could not open folder picker',
          detail: `${result.error.message} (${result.error.code})`,
        });
        return;
      }
      const path = result.data.path;
      if (path !== null) {
        set('repoLocalPath', path);
      }
      // Cancel: do nothing. The renderer keeps the existing path.
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setBanner({ title: 'Folder picker failed', detail: message });
    }
  };

  const buildInput = (): ProjectInstanceInput | null => {
    if (pickedRepoConnection === null) return null;
    const repoType =
      pickedRepoConnection.provider === 'bitbucket' ? 'bitbucket' : 'github';

    let tickets: TicketsConfig;
    if (form.ticketsSource === 'jira') {
      tickets = {
        source: 'jira',
        connectionId: form.ticketsConnectionId,
        projectKey: form.ticketsProjectKey,
        ...(form.ticketQuery.trim() ? { query: form.ticketQuery } : {}),
      };
    } else {
      tickets = {
        source: 'github-issues',
        connectionId: form.ticketsConnectionId,
        repoSlug: form.ticketsRepoSlug,
        ...(form.ticketLabels.trim() ? { labels: form.ticketLabels } : {}),
      };
    }

    const input: ProjectInstanceInput = {
      name: form.name,
      repo: {
        type: repoType,
        localPath: form.repoLocalPath,
        baseBranch: form.repoBaseBranch,
        connectionId: form.repoConnectionId,
        slug: form.repoSlug,
      },
      tickets,
      workflow: {
        mode: form.workflowMode,
        branchFormat: form.branchFormat,
      },
    };
    return input;
  };

  const handleAddConnectionSaved = async (
    provider: 'github' | 'jira',
  ): Promise<void> => {
    setAddConnectionFor(null);
    await connectionsState.refresh();
    void provider;
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (submitting) return;
    if (brokenConnections) return;

    setBanner(null);
    const input = buildInput();
    if (input === null) {
      setBanner({
        title: 'Pick a source connection',
        detail: 'A GitHub connection is required for the source repo.',
      });
      return;
    }

    // 1. Synchronous renderer-side validation. Surface every error inline.
    const validation = validateProjectInstanceInput(input);
    if (!validation.ok) {
      setValidationErrors(validation.errors);
      return;
    }
    setValidationErrors([]);

    if (typeof window === 'undefined' || !window.api) {
      setBanner({
        title: 'IPC bridge unavailable',
        detail: 'Cannot save the project from this context.',
      });
      return;
    }

    setSubmitting(true);
    try {
      if (editing !== undefined) {
        const updated = await window.api.projects.update({
          id: editing.id,
          input: validation.value,
        });
        if (!updated.ok) {
          setBanner({
            title: 'Failed to update project',
            detail: `${updated.error.message} (${updated.error.code})`,
          });
          return;
        }
      } else {
        const created = await window.api.projects.create({
          input: validation.value,
        });
        if (!created.ok) {
          setBanner({
            title: 'Failed to create project',
            detail: `${created.error.message} (${created.error.code})`,
          });
          return;
        }
      }
      await onCreated();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setBanner({ title: 'Unexpected error', detail: message });
    } finally {
      setSubmitting(false);
    }
  };

  // Repo dropdown options derive from the picked GitHub connection's
  // listRepos response.
  // The hidden <select> inside Dropdown falls back to '' if `value` isn't
  // in the rendered options — so when an IPC list is still in flight, the
  // current form value goes blank. Synthetic-prepend the current value to
  // each dropdown's options so the value sticks regardless of load state.
  const repoDropdownOptions: DropdownOption[] = useMemo(() => {
    const opts: DropdownOption[] = repoResources.data.map((r) => ({
      value: r.slug,
      label: r.slug,
    }));
    if (form.repoSlug !== '' && !opts.some((o) => o.value === form.repoSlug)) {
      opts.unshift({ value: form.repoSlug, label: form.repoSlug });
    }
    return opts;
  }, [repoResources.data, form.repoSlug]);

  const branchDropdownOptions: DropdownOption[] = useMemo(() => {
    const opts: DropdownOption[] = branchResources.data.map((b) => ({
      value: b.name,
      label: b.protected ? `${b.name} (protected)` : b.name,
    }));
    if (
      form.repoBaseBranch !== '' &&
      !opts.some((o) => o.value === form.repoBaseBranch)
    ) {
      opts.unshift({ value: form.repoBaseBranch, label: form.repoBaseBranch });
    }
    return opts;
  }, [branchResources.data, form.repoBaseBranch]);

  const jiraDropdownOptions: DropdownOption[] = useMemo(() => {
    const opts: DropdownOption[] = jiraResources.data.map((p) => ({
      value: p.key,
      label: `${p.key} — ${p.name}`,
    }));
    if (
      form.ticketsProjectKey !== '' &&
      !opts.some((o) => o.value === form.ticketsProjectKey)
    ) {
      opts.unshift({ value: form.ticketsProjectKey, label: form.ticketsProjectKey });
    }
    return opts;
  }, [jiraResources.data, form.ticketsProjectKey]);

  // Pre-fill on `editing` change (rare, but keeps the form coherent if a
  // parent ever swaps which project is being edited without unmounting).
  useEffect(() => {
    if (editing) {
      setForm(formFromEditing(editing));
    }
  }, [editing]);

  const isEdit = editing !== undefined;
  // Tickets section uses different connection lists per source. github-issues
  // borrows the same list as the source repo (provider === 'github'); jira
  // uses provider === 'jira'.
  const ticketsConnectionList =
    form.ticketsSource === 'github-issues' ? githubConnections : jiraConnections;

  return (
    <>
      <form
        className={styles.form}
        onSubmit={handleSubmit}
        noValidate
        data-testid="add-project-form"
      >
        {banner && (
          <div className={styles.banner} role="alert" data-testid="add-project-banner">
            <span className={styles.bannerIcon}>
              <IconAlert size={18} />
            </span>
            <div className={styles.bannerBody}>
              <strong>{banner.title}</strong>
              {banner.detail && <span>{banner.detail}</span>}
            </div>
          </div>
        )}

        {brokenConnections && (
          <div
            className={styles.warningBanner}
            role="alert"
            data-testid="add-project-broken-connection-banner"
          >
            <span className={styles.bannerIcon}>
              <IconAlert size={18} />
            </span>
            <div className={styles.bannerBody}>
              <strong>A connection used by this project is gone</strong>
              <span>
                {repoConnectionMissing && ticketsConnectionMissing
                  ? 'The source and tickets connections were both removed. Please pick replacements.'
                  : repoConnectionMissing
                    ? 'The connection used for the source repo was removed. Please pick a new one.'
                    : 'The connection used for tickets was removed. Please pick a new one.'}
              </span>
            </div>
          </div>
        )}

        <FormSection
          index={1}
          title="Basic Info"
          description="Give the project a clear, human-readable name."
          data-testid="add-project-section-1"
        >
          <Input
            label="Project Name"
            required
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="Frontend App"
            error={fieldErrors.get('name')}
            data-testid="field-name"
            name="name"
          />
        </FormSection>

        <FormSection
          index={2}
          title="Source"
          description="Pick a GitHub connection and the repository this project tracks."
          data-testid="add-project-section-2"
        >
          {githubConnections.length === 0 ? (
            <EmptyState
              icon={<IconKey size={18} />}
              title="No GitHub connections yet"
              description="Add a GitHub connection to pick a repository."
              action={
                <Button
                  variant="primary"
                  size="sm"
                  type="button"
                  leadingIcon={<IconPlus size={14} />}
                  onClick={() => setAddConnectionFor('github')}
                  data-testid="add-project-source-empty-cta"
                >
                  Add GitHub Connection
                </Button>
              }
              data-testid="add-project-source-empty"
            />
          ) : (
            <>
              <Dropdown
                label="GitHub Connection"
                required
                value={form.repoConnectionId}
                onChange={handleRepoConnectionChange}
                options={githubConnections.map((c) => ({
                  value: c.id,
                  label: connectionLabel(c),
                }))}
                placeholder="Pick a connection…"
                error={fieldErrors.get('repo.connectionId')}
                data-testid="field-repo-connection"
                name="repoConnectionId"
              />
              <div className={styles.fieldHeaderRow}>
                <span className={styles.miniLabel}>Repository</span>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  leadingIcon={<IconRefresh size={12} />}
                  onClick={() => {
                    void repoResources.refresh();
                  }}
                  disabled={
                    form.repoConnectionId === '' || repoResources.loading
                  }
                  data-testid="add-project-repo-refresh"
                >
                  Refresh
                </Button>
              </div>
              <Dropdown
                value={form.repoSlug}
                onChange={(value) =>
                  setForm((prev) => ({
                    ...prev,
                    repoSlug: value,
                    // Switching repos invalidates the branch — reset it so
                    // the seeding effect can pick the new repo's default.
                    repoBaseBranch: prev.repoSlug === value ? prev.repoBaseBranch : '',
                  }))
                }
                options={repoDropdownOptions}
                searchable
                disabled={form.repoConnectionId === ''}
                placeholder={
                  form.repoConnectionId === ''
                    ? 'Pick a connection first'
                    : repoResources.loading
                      ? 'Loading repositories…'
                      : repoResources.data.length === 0
                        ? 'No repositories visible to this token'
                        : 'Pick a repository…'
                }
                error={
                  fieldErrors.get('repo.slug') ??
                  (repoResources.error ?? undefined)
                }
                data-testid="field-repo-slug"
                name="repoSlug"
              />
              <div className={styles.grid2}>
                <Input
                  label="Repository Path"
                  required
                  value={form.repoLocalPath}
                  onChange={(e) => set('repoLocalPath', e.target.value)}
                  placeholder="C:\\Users\\you\\code\\frontend-app"
                  mono
                  leadingIcon={<IconFolder />}
                  hint="Absolute path to the local clone."
                  error={fieldErrors.get('repo.localPath')}
                  data-testid="field-repo-local-path"
                  name="repoLocalPath"
                  trailing={
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      onClick={() => {
                        void handleBrowseRepoFolder();
                      }}
                      data-testid="field-repo-local-path-browse"
                    >
                      Browse…
                    </Button>
                  }
                />
                <div>
                  <div className={styles.fieldHeaderRow}>
                    <span className={styles.miniLabel}>Base Branch</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      leadingIcon={<IconRefresh size={12} />}
                      onClick={() => {
                        void branchResources.refresh();
                      }}
                      disabled={
                        form.repoSlug === '' || branchResources.loading
                      }
                      data-testid="add-project-branch-refresh"
                    >
                      Refresh
                    </Button>
                  </div>
                  <Dropdown
                    value={form.repoBaseBranch}
                    onChange={(value) => set('repoBaseBranch', value)}
                    options={branchDropdownOptions}
                    searchable
                    disabled={form.repoSlug === ''}
                    placeholder={
                      form.repoSlug === ''
                        ? 'Pick a repository first'
                        : branchResources.loading
                          ? 'Loading branches…'
                          : branchResources.data.length === 0
                            ? 'No branches found'
                            : 'Pick a branch…'
                    }
                    error={
                      fieldErrors.get('repo.baseBranch') ??
                      (branchResources.error ?? undefined)
                    }
                    data-testid="field-repo-base-branch"
                    name="repoBaseBranch"
                  />
                </div>
              </div>
            </>
          )}
        </FormSection>

        <FormSection
          index={3}
          title="Tickets"
          description="Choose where tickets come from — Jira or GitHub Issues."
          data-testid="add-project-section-3"
        >
          <Dropdown
            label="Source"
            required
            value={form.ticketsSource}
            onChange={handleTicketsSourceChange}
            options={[
              { value: 'jira', label: 'Jira' },
              { value: 'github-issues', label: 'GitHub Issues' },
            ]}
            data-testid="field-tickets-source"
            name="ticketsSource"
          />

          {form.ticketsSource === 'jira' && ticketsConnectionList.length === 0 ? (
            <EmptyState
              icon={<IconKey size={18} />}
              title="No Jira connections yet"
              description="Add a Jira connection to pick a project."
              action={
                <Button
                  variant="primary"
                  size="sm"
                  type="button"
                  leadingIcon={<IconPlus size={14} />}
                  onClick={() => setAddConnectionFor('jira')}
                  data-testid="add-project-tickets-empty-cta"
                >
                  Add Jira Connection
                </Button>
              }
              data-testid="add-project-tickets-empty"
            />
          ) : form.ticketsSource === 'jira' ? (
            <>
              <Dropdown
                label="Jira Connection"
                required
                value={form.ticketsConnectionId}
                onChange={handleTicketsConnectionChange}
                options={ticketsConnectionList.map((c) => ({
                  value: c.id,
                  label: connectionLabel(c),
                }))}
                placeholder="Pick a connection…"
                error={fieldErrors.get('tickets.connectionId')}
                data-testid="field-tickets-connection"
                name="ticketsConnectionId"
              />

              {form.ticketsSource === 'jira' ? (
                <>
                  <div className={styles.fieldHeaderRow}>
                    <span className={styles.miniLabel}>Jira Project</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      leadingIcon={<IconRefresh size={12} />}
                      onClick={() => {
                        void jiraResources.refresh();
                      }}
                      disabled={
                        form.ticketsConnectionId === '' || jiraResources.loading
                      }
                      data-testid="add-project-jira-projects-refresh"
                    >
                      Refresh
                    </Button>
                  </div>
                  <Dropdown
                    value={form.ticketsProjectKey}
                    onChange={(value) => set('ticketsProjectKey', value)}
                    options={jiraDropdownOptions}
                    searchable
                    disabled={form.ticketsConnectionId === ''}
                    placeholder={
                      form.ticketsConnectionId === ''
                        ? 'Pick a connection first'
                        : jiraResources.loading
                          ? 'Loading projects…'
                          : jiraResources.data.length === 0
                            ? 'No projects visible to this token'
                            : 'Pick a project…'
                    }
                    error={
                      fieldErrors.get('tickets.projectKey') ??
                      (jiraResources.error ?? undefined)
                    }
                    data-testid="field-tickets-project-key"
                    name="ticketsProjectKey"
                  />
                  <Textarea
                    label="JQL Override"
                    value={form.ticketQuery}
                    onChange={(e) => set('ticketQuery', e.target.value)}
                    placeholder={
                      form.ticketsProjectKey
                        ? `(defaults to project = "${form.ticketsProjectKey}" if empty)`
                        : '(defaults to project = "{key}" if empty)'
                    }
                    mono
                    hint="Optional — only set this if you need a narrower JQL than the project default."
                    error={fieldErrors.get('tickets.query')}
                    data-testid="field-ticket-query"
                    name="ticketQuery"
                  />
                </>
              ) : null}
            </>
          ) : (
            // GitHub Issues — connection + repo are inherited from the
            // project's source repo. No separate pickers; just an info
            // note + an optional label filter.
            <div
              className={styles.inheritNote}
              data-testid="tickets-inherit-note"
            >
              {form.repoSlug === '' ? (
                <span className={styles.cellTertiary}>
                  Pick a source repository above first — issues are pulled from
                  it.
                </span>
              ) : (
                <>
                  <span className={styles.cellPrimary}>
                    Issues will be pulled from{' '}
                    <strong className={styles.repoSlugInline}>
                      {form.repoSlug}
                    </strong>
                  </span>
                  <Input
                    label="Labels"
                    value={form.ticketLabels}
                    onChange={(e) => set('ticketLabels', e.target.value)}
                    placeholder="bug,help wanted"
                    mono
                    hint="Optional comma-separated list of GitHub labels to filter by."
                    error={fieldErrors.get('tickets.labels')}
                    data-testid="field-ticket-labels"
                    name="ticketLabels"
                  />
                </>
              )}
            </div>
          )}
        </FormSection>

        <FormSection
          index={4}
          title="Workflow"
          description="How the agent should behave once a ticket is picked up."
          data-testid="add-project-section-4"
        >
          <RadioCardGroup<WorkflowMode>
            label="Workflow Mode"
            required
            value={form.workflowMode}
            onChange={(value) => {
              workflowModeTouchedRef.current = true;
              set('workflowMode', value);
            }}
            options={[
              {
                value: 'interactive',
                title: 'Interactive',
                description: 'Pause at every checkpoint for human approval.',
                icon: <IconCheck size={14} />,
              },
              {
                value: 'yolo',
                title: 'YOLO (Auto-approve)',
                description: 'Auto-approve every checkpoint and run straight through.',
                icon: <IconPlay size={14} />,
              },
            ]}
            name="workflowMode"
            data-testid="field-workflow-mode"
          />
          <Input
            label="Branch Naming Format"
            required
            value={form.branchFormat}
            onChange={(e) => set('branchFormat', e.target.value)}
            placeholder="ai/{ticketKey}-{slug}"
            mono
            hint={'Available tokens: {ticketKey}, {slug}'}
            error={fieldErrors.get('workflow.branchFormat')}
            data-testid="field-branch-format"
            name="branchFormat"
          />
        </FormSection>

        <div className={styles.actions}>
          <Button
            variant="ghost"
            type="button"
            onClick={onClose}
            disabled={submitting}
            data-testid="add-project-cancel"
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={submitting || brokenConnections}
            data-testid="add-project-submit"
          >
            {submitting ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Project'}
          </Button>
        </div>
      </form>

      <AddConnectionDialog
        open={addConnectionFor !== null}
        onClose={() => setAddConnectionFor(null)}
        onSaved={() => {
          if (addConnectionFor !== null) {
            void handleAddConnectionSaved(addConnectionFor);
          }
        }}
      />
    </>
  );
}
