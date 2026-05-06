import { useMemo, useState, type FormEvent } from 'react';
import {
  validateProjectInstanceInput,
  type ProjectInstanceInput,
  type ValidationError,
} from '@shared/schema/project-instance.js';
import { Button } from '../components/Button';
import { Dropdown } from '../components/Dropdown';
import { FormSection } from '../components/FormSection';
import { Input } from '../components/Input';
import { Textarea } from '../components/Textarea';
import {
  IconAlert,
  IconCheck,
  IconClose,
  IconFolder,
  IconRefresh,
} from '../components/icons';
import styles from './AddProject.module.css';

export interface AddProjectProps {
  onClose: () => void;
  onCreated: () => Promise<void> | void;
}

type RepoType = 'github' | 'bitbucket';
type WorkflowMode = 'interactive' | 'yolo';

interface FormState {
  name: string;
  repoType: RepoType;
  repoLocalPath: string;
  repoBaseBranch: string;
  repoToken: string;
  ticketSource: 'jira';
  ticketQuery: string;
  jiraHost: string;
  jiraEmail: string;
  jiraToken: string;
  workflowMode: WorkflowMode;
  branchFormat: string;
}

const INITIAL: FormState = {
  name: '',
  repoType: 'github',
  repoLocalPath: '',
  repoBaseBranch: '',
  repoToken: '',
  ticketSource: 'jira',
  ticketQuery: '',
  jiraHost: '',
  jiraEmail: '',
  jiraToken: '',
  workflowMode: 'interactive',
  branchFormat: '',
};

type TestState =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'success'; displayName: string }
  | { state: 'error'; code: string; message: string };

/**
 * Slugify a project name for use as a SecretsManager ref prefix.
 * Lowercase, dashes, ASCII alphanumerics only.
 */
function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function errorsByPath(errors: ValidationError[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of errors) {
    if (!m.has(e.path)) m.set(e.path, e.message);
  }
  return m;
}

export function AddProject({ onClose, onCreated }: AddProjectProps): JSX.Element {
  const [form, setForm] = useState<FormState>(INITIAL);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [validationErrors, setValidationErrors] = useState<ValidationError[]>([]);
  const [banner, setBanner] = useState<{ title: string; detail?: string } | null>(null);
  const [testState, setTestState] = useState<TestState>({ state: 'idle' });

  const fieldErrors = useMemo(() => errorsByPath(validationErrors), [validationErrors]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const buildInput = (): { input: ProjectInstanceInput; slug: string } => {
    const slug = slugify(form.name) || 'project';
    const repoTokenRef = form.repoToken.trim() ? `${slug}-repo` : undefined;
    const jiraTokenRef = form.jiraToken.trim() ? `${slug}-jira` : undefined;

    const input: ProjectInstanceInput = {
      name: form.name,
      repo: {
        type: form.repoType,
        localPath: form.repoLocalPath,
        baseBranch: form.repoBaseBranch,
        ...(repoTokenRef ? { tokenRef: repoTokenRef } : {}),
      },
      tickets: {
        source: form.ticketSource,
        query: form.ticketQuery,
        ...(jiraTokenRef ? { tokenRef: jiraTokenRef } : {}),
        ...(form.jiraEmail.trim() ? { email: form.jiraEmail } : {}),
        ...(form.jiraHost.trim() ? { host: form.jiraHost } : {}),
      },
      workflow: {
        mode: form.workflowMode,
        branchFormat: form.branchFormat,
      },
    };
    return { input, slug };
  };

  const handleTestConnection = async (): Promise<void> => {
    if (typeof window === 'undefined' || !window.api) {
      setTestState({
        state: 'error',
        code: 'BRIDGE',
        message: 'IPC bridge unavailable',
      });
      return;
    }
    setTestState({ state: 'loading' });
    try {
      const result = await window.api.jira.testConnection({
        host: form.jiraHost.trim(),
        email: form.jiraEmail.trim(),
        apiToken: form.jiraToken,
      });
      if (result.ok) {
        setTestState({ state: 'success', displayName: result.data.displayName });
      } else {
        setTestState({
          state: 'error',
          code: result.error.code,
          message: result.error.message,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setTestState({ state: 'error', code: 'UNKNOWN', message });
    }
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (submitting) return;

    setBanner(null);
    const { input, slug } = buildInput();

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
        detail: 'Cannot create the project from this context.',
      });
      return;
    }

    setSubmitting(true);

    try {
      // 2. Repo token (skip if empty — rule 8).
      if (form.repoToken.trim()) {
        const ref = `${slug}-repo`;
        const repoSecret = await window.api.secrets.set({
          ref,
          plaintext: form.repoToken,
        });
        if (!repoSecret.ok) {
          setBanner({
            title: 'Failed to save repo token',
            detail: `${repoSecret.error.message} (${repoSecret.error.code})`,
          });
          return;
        }
      }

      // 3. Jira token (skip if empty).
      if (form.jiraToken.trim()) {
        const ref = `${slug}-jira`;
        const jiraSecret = await window.api.secrets.set({
          ref,
          plaintext: form.jiraToken,
        });
        if (!jiraSecret.ok) {
          setBanner({
            title: 'Failed to save Jira token',
            detail: `${jiraSecret.error.message} (${jiraSecret.error.code})`,
          });
          return;
        }
      }

      // 4. Create the project. tokenRefs are already encoded in the input.
      const created = await window.api.projects.create({ input: validation.value });
      if (!created.ok) {
        setBanner({
          title: 'Failed to create project',
          detail: `${created.error.message} (${created.error.code})`,
        });
        return;
      }

      await onCreated();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setBanner({ title: 'Unexpected error', detail: message });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={handleSubmit} noValidate data-testid="add-project-form">
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
        title="Repository Configuration"
        description="Where the code lives. The local path must be absolute on this machine."
        data-testid="add-project-section-2"
      >
        <div className={styles.grid2}>
          <Dropdown
            label="Repository Type"
            required
            value={form.repoType}
            onChange={(value) => set('repoType', value as RepoType)}
            options={[
              { value: 'github', label: 'GitHub' },
              { value: 'bitbucket', label: 'Bitbucket' },
            ]}
            error={fieldErrors.get('repo.type')}
            data-testid="field-repo-type"
            name="repoType"
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
          label="Personal Access Token"
          type="password"
          value={form.repoToken}
          onChange={(e) => set('repoToken', e.target.value)}
          placeholder="••••••••••••"
          hint="Optional — stored encrypted in the OS keychain."
          data-testid="field-repo-token"
          name="repoToken"
        />
      </FormSection>

      <FormSection
        index={3}
        title="Ticket Source"
        description="The query and credentials used to pull tickets."
        data-testid="add-project-section-3"
      >
        <div className={styles.grid2}>
          <Dropdown
            label="Ticket Source Type"
            required
            value={form.ticketSource}
            onChange={(value) => set('ticketSource', value as 'jira')}
            options={[{ value: 'jira', label: 'Jira' }]}
            error={fieldErrors.get('tickets.source')}
            data-testid="field-ticket-source"
            name="ticketSource"
          />
          <Input
            label="Jira Host"
            value={form.jiraHost}
            onChange={(e) => set('jiraHost', e.target.value)}
            placeholder="https://your-team.atlassian.net"
            mono
            error={fieldErrors.get('tickets.host')}
            data-testid="field-jira-host"
            name="jiraHost"
          />
        </div>
        <Textarea
          label="Ticket Query"
          required
          value={form.ticketQuery}
          onChange={(e) => set('ticketQuery', e.target.value)}
          placeholder='project = "AI-TEAM" AND status = "Ready for AI"'
          mono
          hint='JQL — filter for tickets ready for the AI agent (e.g. status = "Ready for AI").'
          error={fieldErrors.get('tickets.query')}
          data-testid="field-ticket-query"
          name="ticketQuery"
        />
        <div className={styles.grid2}>
          <Input
            label="Jira Email"
            type="email"
            value={form.jiraEmail}
            onChange={(e) => set('jiraEmail', e.target.value)}
            placeholder="you@company.com"
            error={fieldErrors.get('tickets.email')}
            data-testid="field-jira-email"
            name="jiraEmail"
          />
          <Input
            label="Jira API Token"
            type="password"
            value={form.jiraToken}
            onChange={(e) => set('jiraToken', e.target.value)}
            placeholder="••••••••••••"
            data-testid="field-jira-token"
            name="jiraToken"
          />
        </div>
        <div className={styles.testRow}>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            leadingIcon={
              testState.state === 'loading' ? <IconRefresh /> : <IconCheck />
            }
            onClick={() => {
              void handleTestConnection();
            }}
            disabled={testState.state === 'loading'}
            data-testid="test-connection-button"
          >
            {testState.state === 'loading' ? 'Testing…' : 'Test connection'}
          </Button>
          {testState.state === 'success' && (
            <span
              className={styles.testPill}
              data-state="success"
              data-testid="test-connection-result"
            >
              <IconCheck size={12} />
              Connected as {testState.displayName}
            </span>
          )}
          {testState.state === 'error' && (
            <span
              className={styles.testPill}
              data-state="error"
              data-testid="test-connection-result"
            >
              <IconClose size={12} />
              {testState.code}
              {testState.message ? ` — ${testState.message}` : ''}
            </span>
          )}
        </div>
      </FormSection>

      <FormSection
        index={4}
        title="Workflow Settings"
        description="How the agent should behave once a ticket is picked up."
        data-testid="add-project-section-4"
      >
        <div>
          <span
            style={{
              display: 'block',
              fontFamily: 'var(--font-display)',
              fontSize: 12,
              fontWeight: 500,
              color: 'var(--text-secondary)',
              marginBottom: 'var(--space-2)',
            }}
          >
            Mode
          </span>
          <div className={styles.modePicker}>
            <button
              type="button"
              className={styles.modeCard}
              data-selected={form.workflowMode === 'interactive'}
              onClick={() => set('workflowMode', 'interactive')}
              data-testid="mode-interactive"
              aria-pressed={form.workflowMode === 'interactive'}
            >
              <span className={styles.modeName}>
                Interactive
                <span className={styles.modeBadge}>Default</span>
              </span>
              <span className={styles.modeDescription}>
                The agent pauses at every checkpoint so you can approve, reject, or modify before it
                moves on.
              </span>
            </button>
            <button
              type="button"
              className={styles.modeCard}
              data-selected={form.workflowMode === 'yolo'}
              onClick={() => set('workflowMode', 'yolo')}
              data-testid="mode-yolo"
              aria-pressed={form.workflowMode === 'yolo'}
            >
              <span className={styles.modeName}>
                YOLO
                <span className={styles.modeBadge} style={{ color: 'var(--warning)', background: 'var(--warning-soft)', borderColor: 'rgba(240,185,92,0.3)' }}>
                  Auto-approve
                </span>
              </span>
              <span className={styles.modeDescription}>
                The agent auto-approves every checkpoint and runs straight through to PR. Faster, but
                you cede control mid-run.
              </span>
            </button>
          </div>
        </div>
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
          disabled={submitting}
          data-testid="add-project-submit"
        >
          {submitting ? 'Creating…' : 'Create Project'}
        </Button>
      </div>
    </form>
  );
}
