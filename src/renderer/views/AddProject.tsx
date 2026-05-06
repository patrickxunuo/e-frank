import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  validateProjectInstanceInput,
  type ProjectInstanceInput,
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
import {
  IconAlert,
  IconFolder,
  IconKey,
  IconPlus,
  IconRefresh,
} from '../components/icons';
import { useConnections } from '../state/connections';
import {
  useConnectionRepos,
  useConnectionJiraProjects,
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

interface FormState {
  name: string;
  repoConnectionId: string;
  repoSlug: string;
  repoLocalPath: string;
  repoBaseBranch: string;
  ticketsConnectionId: string;
  ticketsProjectKey: string;
  ticketQuery: string;
  workflowMode: WorkflowMode;
  branchFormat: string;
}

const INITIAL: FormState = {
  name: '',
  repoConnectionId: '',
  repoSlug: '',
  repoLocalPath: '',
  repoBaseBranch: '',
  ticketsConnectionId: '',
  ticketsProjectKey: '',
  ticketQuery: '',
  workflowMode: 'interactive',
  branchFormat: '',
};

function formFromEditing(editing: ProjectInstanceDto): FormState {
  return {
    name: editing.name,
    repoConnectionId: editing.repo.connectionId,
    repoSlug: editing.repo.slug,
    repoLocalPath: editing.repo.localPath,
    repoBaseBranch: editing.repo.baseBranch,
    ticketsConnectionId: editing.tickets.connectionId,
    ticketsProjectKey: editing.tickets.projectKey,
    ticketQuery: editing.tickets.query ?? '',
    workflowMode: editing.workflow.mode,
    branchFormat: editing.workflow.branchFormat,
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
  const [addConnectionFor, setAddConnectionFor] = useState<
    'github' | 'jira' | null
  >(null);

  const fieldErrors = useMemo(() => errorsByPath(validationErrors), [validationErrors]);

  const connectionsState = useConnections();
  const repoConnectionId = form.repoConnectionId === '' ? null : form.repoConnectionId;
  const ticketsConnectionId =
    form.ticketsConnectionId === '' ? null : form.ticketsConnectionId;

  const repoResources = useConnectionRepos(repoConnectionId);
  const jiraResources = useConnectionJiraProjects(ticketsConnectionId);

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

  // When the form's connection ids drift away from valid options (because
  // the picker was reset, or the connection was deleted while editing),
  // surface a banner and hold Save until the user re-picks.
  const brokenConnections =
    repoConnectionMissing || ticketsConnectionMissing;

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleRepoConnectionChange = (next: string): void => {
    setForm((prev) => ({ ...prev, repoConnectionId: next, repoSlug: '' }));
  };

  const handleTicketsConnectionChange = (next: string): void => {
    setForm((prev) => ({
      ...prev,
      ticketsConnectionId: next,
      ticketsProjectKey: '',
    }));
  };

  const buildInput = (): ProjectInstanceInput | null => {
    if (pickedRepoConnection === null) return null;
    const repoType =
      pickedRepoConnection.provider === 'bitbucket' ? 'bitbucket' : 'github';

    const input: ProjectInstanceInput = {
      name: form.name,
      repo: {
        type: repoType,
        localPath: form.repoLocalPath,
        baseBranch: form.repoBaseBranch,
        connectionId: form.repoConnectionId,
        slug: form.repoSlug,
      },
      tickets: {
        source: 'jira',
        connectionId: form.ticketsConnectionId,
        projectKey: form.ticketsProjectKey,
        ...(form.ticketQuery.trim() ? { query: form.ticketQuery } : {}),
      },
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
    // The newly-saved connection lives at the end of the list; capture it
    // by snapshotting the list AFTER refresh, in `useEffect` — but we don't
    // have the new id directly. The simplest UX is to leave the picker
    // empty and let the user click the new option (now visible). We don't
    // attempt to auto-select.
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
  const repoDropdownOptions: DropdownOption[] = useMemo(
    () =>
      repoResources.data.map((r) => ({
        value: r.slug,
        label: r.slug,
      })),
    [repoResources.data],
  );

  const jiraDropdownOptions: DropdownOption[] = useMemo(
    () =>
      jiraResources.data.map((p) => ({
        value: p.key,
        label: `${p.key} — ${p.name}`,
      })),
    [jiraResources.data],
  );

  // Pre-fill on `editing` change (rare, but keeps the form coherent if a
  // parent ever swaps which project is being edited without unmounting).
  useEffect(() => {
    if (editing) {
      setForm(formFromEditing(editing));
    }
  }, [editing]);

  const isEdit = editing !== undefined;

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
                onChange={(value) => set('repoSlug', value)}
                options={repoDropdownOptions}
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
                />
                <Input
                  label="Base Branch"
                  required
                  value={form.repoBaseBranch}
                  onChange={(e) => set('repoBaseBranch', e.target.value)}
                  placeholder="main"
                  mono
                  hint="Branch the agent will branch off from."
                  error={fieldErrors.get('repo.baseBranch')}
                  data-testid="field-repo-base-branch"
                  name="repoBaseBranch"
                />
              </div>
            </>
          )}
        </FormSection>

        <FormSection
          index={3}
          title="Tickets"
          description="Pick a Jira connection and the project tickets are pulled from."
          data-testid="add-project-section-3"
        >
          {jiraConnections.length === 0 ? (
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
          ) : (
            <>
              <Dropdown
                label="Jira Connection"
                required
                value={form.ticketsConnectionId}
                onChange={handleTicketsConnectionChange}
                options={jiraConnections.map((c) => ({
                  value: c.id,
                  label: connectionLabel(c),
                }))}
                placeholder="Pick a connection…"
                error={fieldErrors.get('tickets.connectionId')}
                data-testid="field-tickets-connection"
                name="ticketsConnectionId"
              />
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
          )}
        </FormSection>

        <FormSection
          index={4}
          title="Workflow"
          description="How the agent should behave once a ticket is picked up."
          data-testid="add-project-section-4"
        >
          <Dropdown
            label="Workflow Mode"
            required
            value={form.workflowMode}
            onChange={(value) => set('workflowMode', value as WorkflowMode)}
            options={[
              { value: 'interactive', label: 'Interactive — pause at every checkpoint' },
              { value: 'yolo', label: 'YOLO — auto-approve every checkpoint' },
            ]}
            hint="Interactive lets you approve / reject / modify each step. YOLO runs straight through."
            data-testid="field-workflow-mode"
            name="workflowMode"
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
