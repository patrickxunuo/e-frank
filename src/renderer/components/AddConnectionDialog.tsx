import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type {
  AuthMethod,
  Connection,
  ConnectionInput,
  ConnectionUpdate,
  Provider,
} from '@shared/ipc';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { FormSection } from './FormSection';
import { Input } from './Input';
import { Select } from './Select';
import { IconAlert, IconCheck, IconClose, IconRefresh } from './icons';
import styles from './AddConnectionDialog.module.css';

export interface AddConnectionDialogProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  /** When set, dialog opens in Edit mode. */
  editing?: Connection;
}

interface FormState {
  provider: Provider;
  label: string;
  host: string;
  email: string;
  token: string;
}

type TestState =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'success'; summary: string }
  | { state: 'error'; code: string; message: string };

const PROVIDER_HOSTS: Record<Provider, string> = {
  github: 'https://api.github.com',
  jira: 'https://your-workspace.atlassian.net',
  bitbucket: 'https://api.bitbucket.org/2.0',
};

function defaultAuthMethod(provider: Provider): AuthMethod {
  switch (provider) {
    case 'github':
      return 'pat';
    case 'jira':
      return 'api-token';
    case 'bitbucket':
      return 'app-password';
  }
}

function emptyForm(): FormState {
  return {
    provider: 'github',
    label: '',
    host: PROVIDER_HOSTS.github,
    email: '',
    token: '',
  };
}

function formFromConnection(c: Connection): FormState {
  return {
    provider: c.provider,
    label: c.label,
    host: c.host,
    // Email lives in the secret value (`email\ntoken`); the dialog can't
    // recover it without an extra IPC call. Kept blank in edit-mode for
    // Jira; user typing a new email is treated as an update.
    email: '',
    token: '',
  };
}

function summarizeIdentity(
  provider: Provider,
  payload: { login?: string; name?: string; displayName?: string; emailAddress?: string },
): string {
  if (provider === 'github') {
    return payload.login ? `@${payload.login}` : 'connected';
  }
  if (provider === 'jira') {
    if (payload.displayName && payload.emailAddress) {
      return `${payload.displayName} <${payload.emailAddress}>`;
    }
    return payload.displayName ?? 'connected';
  }
  return 'connected';
}

export function AddConnectionDialog({
  open,
  onClose,
  onSaved,
  editing,
}: AddConnectionDialogProps): JSX.Element {
  const [form, setForm] = useState<FormState>(() =>
    editing ? formFromConnection(editing) : emptyForm(),
  );
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [testState, setTestState] = useState<TestState>({ state: 'idle' });
  const [labelError, setLabelError] = useState<string | undefined>(undefined);
  const [banner, setBanner] = useState<{ title: string; detail?: string } | null>(null);

  // Reset form whenever the dialog opens or `editing` changes.
  useEffect(() => {
    if (!open) return;
    setForm(editing ? formFromConnection(editing) : emptyForm());
    setTestState({ state: 'idle' });
    setLabelError(undefined);
    setBanner(null);
  }, [open, editing]);

  const isEdit = editing !== undefined;
  const isJira = form.provider === 'jira';
  const isBitbucket = form.provider === 'bitbucket';

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const onProviderChange = (next: Provider): void => {
    setForm((prev) => ({
      ...prev,
      provider: next,
      // Auto-fill the placeholder host when the user hasn't customized it.
      host: prev.host === '' || prev.host === PROVIDER_HOSTS[prev.provider] ? PROVIDER_HOSTS[next] : prev.host,
    }));
    setTestState({ state: 'idle' });
  };

  // Save is enabled when the required fields are filled. We don't gate on
  // Test Connection — UX safeguard, not a hard gate.
  const requiredFilled = useMemo(() => {
    if (form.label.trim() === '') return false;
    if (form.host.trim() === '') return false;
    if (!isEdit && form.token.trim() === '') return false;
    if (isJira && form.email.trim() === '') return false;
    return true;
  }, [form, isEdit, isJira]);

  const handleTest = async (): Promise<void> => {
    if (typeof window === 'undefined' || !window.api) {
      setTestState({
        state: 'error',
        code: 'BRIDGE',
        message: 'IPC bridge unavailable',
      });
      return;
    }
    if (isBitbucket) {
      setTestState({
        state: 'error',
        code: 'NOT_IMPLEMENTED',
        message: 'Bitbucket connections are not yet supported',
      });
      return;
    }
    setTestState({ state: 'loading' });
    try {
      const result = await window.api.connections.test({
        mode: 'preview',
        provider: form.provider,
        host: form.host.trim(),
        authMethod: defaultAuthMethod(form.provider),
        plaintextToken: form.token,
        ...(isJira ? { email: form.email.trim() } : {}),
      });
      if (result.ok) {
        const id = result.data.identity;
        const payload =
          id.kind === 'github'
            ? { login: id.login, name: id.name }
            : id.kind === 'jira'
              ? { displayName: id.displayName, emailAddress: id.emailAddress }
              : { name: id.username };
        setTestState({
          state: 'success',
          summary: summarizeIdentity(form.provider, payload),
        });
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
    setLabelError(undefined);

    if (typeof window === 'undefined' || !window.api) {
      setBanner({
        title: 'IPC bridge unavailable',
        detail: 'Cannot save the connection from this context.',
      });
      return;
    }

    setSubmitting(true);
    try {
      if (isEdit && editing) {
        const update: ConnectionUpdate = {
          label: form.label,
          host: form.host.trim(),
        };
        if (form.token.trim() !== '') {
          update.plaintextToken = form.token;
        }
        if (isJira && form.email.trim() !== '') {
          update.email = form.email.trim();
        }
        const result = await window.api.connections.update({
          id: editing.id,
          input: update,
        });
        if (!result.ok) {
          if (result.error.code === 'LABEL_NOT_UNIQUE') {
            setLabelError(result.error.message);
          } else {
            setBanner({
              title: 'Failed to update connection',
              detail: `${result.error.message} (${result.error.code})`,
            });
          }
          return;
        }
      } else {
        const input: ConnectionInput = {
          provider: form.provider,
          label: form.label,
          host: form.host.trim(),
          authMethod: defaultAuthMethod(form.provider),
          plaintextToken: form.token,
          ...(isJira ? { email: form.email.trim() } : {}),
        };
        const result = await window.api.connections.create({ input });
        if (!result.ok) {
          if (result.error.code === 'LABEL_NOT_UNIQUE') {
            setLabelError(result.error.message);
          } else {
            setBanner({
              title: 'Failed to create connection',
              detail: `${result.error.message} (${result.error.code})`,
            });
          }
          return;
        }
      }
      onSaved();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setBanner({ title: 'Unexpected error', detail: message });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title={isEdit ? 'Edit Connection' : 'Add Connection'}
      subtitle={
        isEdit
          ? 'Rotate the token, rename, or change the host.'
          : 'Connect a GitHub, Jira, or Bitbucket account.'
      }
      data-testid="add-connection-dialog"
    >
      <form className={styles.form} onSubmit={handleSubmit} noValidate>
        {banner && (
          <div className={styles.banner} role="alert" data-testid="add-connection-banner">
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
          title="Provider"
          description="Pick the service this connection authenticates against."
          data-testid="add-connection-section-1"
        >
          <Select
            label="Provider"
            required
            value={form.provider}
            onChange={(e) => onProviderChange(e.target.value as Provider)}
            disabled={isEdit}
            data-testid="connection-provider-select"
            name="provider"
          >
            <option value="github">GitHub</option>
            <option value="jira">Jira</option>
            <option value="bitbucket" disabled>
              Bitbucket (coming soon)
            </option>
          </Select>
        </FormSection>

        <FormSection
          index={2}
          title="Details"
          description="Label, host, and (for Jira) the email used in Basic auth."
          data-testid="add-connection-section-2"
        >
          <Input
            label="Label"
            required
            value={form.label}
            onChange={(e) => set('label', e.target.value)}
            placeholder="Personal"
            hint="Unique within the provider."
            error={labelError}
            data-testid="connection-label-input"
            name="label"
          />
          <Input
            label="Host"
            required
            value={form.host}
            onChange={(e) => set('host', e.target.value)}
            placeholder={PROVIDER_HOSTS[form.provider]}
            mono
            data-testid="connection-host-input"
            name="host"
          />
          {isJira && (
            <Input
              label="Email"
              type="email"
              required
              value={form.email}
              onChange={(e) => set('email', e.target.value)}
              placeholder="you@company.com"
              data-testid="connection-email-input"
              name="email"
            />
          )}
        </FormSection>

        <FormSection
          index={3}
          title="Token"
          description={
            isEdit
              ? 'Leave empty to keep the existing token.'
              : isBitbucket
                ? 'App password (Bitbucket connections cannot yet be tested).'
                : 'Personal Access Token. Stored encrypted in the OS keychain.'
          }
          data-testid="add-connection-section-3"
        >
          <Input
            label={isEdit ? 'New Token' : 'Token'}
            type="password"
            required={!isEdit}
            value={form.token}
            onChange={(e) => set('token', e.target.value)}
            placeholder={isEdit ? 'Leave empty to keep current' : '••••••••••••'}
            data-testid="connection-token-input"
            name="token"
          />
          <div className={styles.testRow}>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              leadingIcon={
                testState.state === 'loading' ? <IconRefresh /> : <IconCheck />
              }
              onClick={() => {
                void handleTest();
              }}
              disabled={testState.state === 'loading' || isBitbucket}
              data-testid="connection-test-button"
            >
              {testState.state === 'loading' ? 'Testing…' : 'Test connection'}
            </Button>
            {testState.state === 'success' && (
              <span
                className={styles.testPill}
                data-state="success"
                data-testid="connection-test-result"
              >
                <IconCheck size={12} />
                Connected as {testState.summary}
              </span>
            )}
            {testState.state === 'error' && (
              <span
                className={styles.testPill}
                data-state="error"
                data-testid="connection-test-result"
              >
                <IconClose size={12} />
                {testState.code}
                {testState.message ? ` — ${testState.message}` : ''}
              </span>
            )}
          </div>
        </FormSection>

        <div className={styles.actions}>
          <Button
            variant="ghost"
            type="button"
            onClick={onClose}
            disabled={submitting}
            data-testid="connection-cancel-button"
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={submitting || !requiredFilled}
            data-testid="connection-save-button"
          >
            {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Add Connection'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
