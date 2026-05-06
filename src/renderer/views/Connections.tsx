import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Connection, Provider } from '@shared/ipc';
import { AddConnectionDialog } from '../components/AddConnectionDialog';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { DataTable, type DataTableColumn } from '../components/DataTable';
import { Dialog } from '../components/Dialog';
import { EmptyState } from '../components/EmptyState';
import {
  IconBitbucket,
  IconCheck,
  IconClose,
  IconGitHub,
  IconJira,
  IconKey,
  IconPlus,
  IconRefresh,
} from '../components/icons';
import { formatRelative } from '../lib/time';
import { useConnections } from '../state/connections';
import styles from './Connections.module.css';

export interface ConnectionsProps {
  /** When set, opens the Add dialog after first paint (e.g. linked from empty state). */
  initialAdd?: boolean;
}

interface RowTestState {
  kind: 'success';
  summary: string;
}

interface RowErrorState {
  kind: 'error';
  code: string;
  message: string;
}

type RowFeedback = RowTestState | RowErrorState | undefined;

function providerIconFor(provider: Provider): JSX.Element {
  switch (provider) {
    case 'github':
      return <IconGitHub />;
    case 'jira':
      return <IconJira />;
    case 'bitbucket':
      return <IconBitbucket />;
  }
}

function providerLabelFor(provider: Provider): string {
  switch (provider) {
    case 'github':
      return 'GitHub';
    case 'jira':
      return 'Jira';
    case 'bitbucket':
      return 'Bitbucket';
  }
}

function identityDisplay(c: Connection): string {
  const id = c.accountIdentity;
  if (!id) return 'Not verified';
  if (id.kind === 'github') return id.name ? `${id.name} (@${id.login})` : `@${id.login}`;
  if (id.kind === 'jira') {
    if (id.displayName && id.emailAddress) {
      return `${id.displayName} <${id.emailAddress}>`;
    }
    return id.displayName ?? id.accountId;
  }
  return id.displayName ?? id.username;
}

function lastVerifiedDisplay(epochMs: number | undefined): string {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) return '—';
  return formatRelative(new Date(epochMs).toISOString());
}

export function Connections({ initialAdd = false }: ConnectionsProps): JSX.Element {
  const { connections, loading, error, refresh } = useConnections();
  const [addOpen, setAddOpen] = useState<boolean>(initialAdd);
  const [editing, setEditing] = useState<Connection | undefined>(undefined);
  const [confirmDelete, setConfirmDelete] = useState<Connection | undefined>(undefined);
  const [deleteError, setDeleteError] = useState<{ message: string; referencedBy?: string[] } | undefined>(
    undefined,
  );
  const [rowFeedback, setRowFeedback] = useState<Record<string, RowFeedback>>({});

  useEffect(() => {
    if (initialAdd) {
      setAddOpen(true);
    }
  }, [initialAdd]);

  const handleTest = useCallback(
    async (c: Connection): Promise<void> => {
      if (typeof window === 'undefined' || !window.api) return;
      setRowFeedback((prev) => ({ ...prev, [c.id]: undefined }));
      const result = await window.api.connections.test({ mode: 'existing', id: c.id });
      if (result.ok) {
        const id = result.data.identity;
        const summary =
          id.kind === 'github'
            ? `@${id.login}`
            : id.kind === 'jira'
              ? id.displayName
              : id.username;
        setRowFeedback((prev) => ({ ...prev, [c.id]: { kind: 'success', summary } }));
        await refresh();
      } else {
        setRowFeedback((prev) => ({
          ...prev,
          [c.id]: { kind: 'error', code: result.error.code, message: result.error.message },
        }));
      }
    },
    [refresh],
  );

  const handleDeleteConfirm = async (): Promise<void> => {
    if (!confirmDelete) return;
    if (typeof window === 'undefined' || !window.api) return;
    setDeleteError(undefined);
    const result = await window.api.connections.delete({ id: confirmDelete.id });
    if (!result.ok) {
      // The Connection store enriches IN_USE errors with `details.referencedBy`.
      // The IPC `IpcResult` type doesn't formally model that field, so we read
      // it via a structural narrowing rather than extending the contract.
      const err = result.error as {
        code: string;
        message: string;
        details?: { referencedBy?: unknown };
      };
      const referencedBy =
        err.code === 'IN_USE' &&
        err.details &&
        Array.isArray(err.details.referencedBy)
          ? err.details.referencedBy.filter(
              (v): v is string => typeof v === 'string',
            )
          : undefined;
      setDeleteError({
        message: `${err.message} (${err.code})`,
        ...(referencedBy !== undefined ? { referencedBy } : {}),
      });
      return;
    }
    setConfirmDelete(undefined);
    await refresh();
  };

  const columns: DataTableColumn<Connection>[] = useMemo(
    () => [
      {
        key: 'provider',
        header: 'Provider',
        render: (row) => (
          <div className={styles.providerCell}>
            <span className={styles.providerBadge}>{providerIconFor(row.provider)}</span>
            <Badge variant="neutral">{providerLabelFor(row.provider)}</Badge>
          </div>
        ),
      },
      {
        key: 'label',
        header: 'Label',
        render: (row) => <span className={styles.cellPrimary}>{row.label}</span>,
      },
      {
        key: 'host',
        header: 'Host',
        render: (row) => <span className={styles.cellMono}>{row.host}</span>,
      },
      {
        key: 'identity',
        header: 'Identity',
        render: (row) => {
          const fb = rowFeedback[row.id];
          if (fb?.kind === 'error') {
            return (
              <span className={styles.testPill} data-state="error">
                <IconClose size={12} />
                {fb.code}
              </span>
            );
          }
          if (fb?.kind === 'success') {
            return (
              <span className={styles.testPill} data-state="success">
                <IconCheck size={12} />
                {fb.summary}
              </span>
            );
          }
          const display = identityDisplay(row);
          return (
            <span
              className={
                row.accountIdentity ? styles.cellPrimary : styles.cellTertiary
              }
            >
              {display}
            </span>
          );
        },
      },
      {
        key: 'lastVerifiedAt',
        header: 'Last Verified',
        render: (row) => (
          <span className={styles.cellMono}>{lastVerifiedDisplay(row.lastVerifiedAt)}</span>
        ),
      },
      {
        key: 'actions',
        header: '',
        align: 'right',
        width: '260px',
        render: (row) => (
          <div className={styles.actionsCell}>
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                void handleTest(row);
              }}
              data-testid={`connection-test-${row.id}`}
            >
              Test
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                setEditing(row);
                setAddOpen(true);
              }}
              data-testid={`connection-edit-${row.id}`}
            >
              Edit
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                setConfirmDelete(row);
                setDeleteError(undefined);
              }}
              data-testid={`connection-delete-${row.id}`}
            >
              Delete
            </Button>
          </div>
        ),
      },
    ],
    [rowFeedback, handleTest],
  );

  const showSkeleton = loading && connections.length === 0;
  const showEmpty = !loading && !error && connections.length === 0;
  const showTable = !loading && !error && connections.length > 0;

  return (
    <div className={styles.page} data-testid="connections-page">
      <header className={styles.head}>
        <div className={styles.titleBlock}>
          <span className={styles.eyebrow}>Workspace · Connections</span>
          <h1 className={styles.title} data-testid="connections-title">
            Connections
          </h1>
          <p className={styles.subtitle}>
            Manage your GitHub, Bitbucket, and Jira connections.
          </p>
        </div>
        <div className={styles.headActions}>
          <Button
            variant="primary"
            leadingIcon={<IconPlus />}
            onClick={() => {
              setEditing(undefined);
              setAddOpen(true);
            }}
            data-testid="connections-add-button"
          >
            Add Connection
          </Button>
        </div>
      </header>

      {error && (
        <div className={styles.errorBanner} role="alert" data-testid="connections-error">
          <span>
            <strong>Couldn't load connections.</strong> {error}
          </span>
          <Button
            variant="ghost"
            size="sm"
            leadingIcon={<IconRefresh />}
            onClick={() => {
              void refresh();
            }}
            data-testid="connections-retry"
          >
            Retry
          </Button>
        </div>
      )}

      {showSkeleton && (
        <div className={styles.skeleton} data-testid="connections-loading">
          <div className={styles.skeletonRow} style={{ width: '36%' }} />
          <div className={styles.skeletonRow} style={{ width: '92%' }} />
          <div className={styles.skeletonRow} style={{ width: '78%' }} />
        </div>
      )}

      {showEmpty && (
        <EmptyState
          icon={<IconKey size={26} />}
          title="No connections yet"
          description="Connect a GitHub, Jira, or Bitbucket account to use across your projects."
          action={
            <Button
              variant="primary"
              leadingIcon={<IconPlus />}
              onClick={() => {
                setEditing(undefined);
                setAddOpen(true);
              }}
              data-testid="connections-empty-cta"
            >
              Add your first connection
            </Button>
          }
          data-testid="connections-empty"
        />
      )}

      {showTable && (
        <DataTable
          columns={columns}
          rows={connections}
          rowKey={(row) => row.id}
          rowTestId={(row) => `connections-row-${row.id}`}
          data-testid="connections-table"
        />
      )}

      <AddConnectionDialog
        open={addOpen}
        onClose={() => {
          setAddOpen(false);
          setEditing(undefined);
        }}
        onSaved={() => {
          setAddOpen(false);
          setEditing(undefined);
          void refresh();
        }}
        editing={editing}
      />

      <Dialog
        open={confirmDelete !== undefined}
        onClose={() => {
          setConfirmDelete(undefined);
          setDeleteError(undefined);
        }}
        size="md"
        title="Delete connection?"
        subtitle={
          confirmDelete
            ? `This will remove "${confirmDelete.label}" and its stored token.`
            : undefined
        }
        data-testid="connection-delete-dialog"
        footer={
          <div className={styles.actions}>
            <Button
              variant="ghost"
              onClick={() => {
                setConfirmDelete(undefined);
                setDeleteError(undefined);
              }}
              data-testid="connection-delete-cancel"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                void handleDeleteConfirm();
              }}
              data-testid="connection-delete-confirm"
            >
              Delete
            </Button>
          </div>
        }
      >
        {deleteError && (
          <div className={styles.errorBanner} role="alert" data-testid="connection-delete-error">
            <span>
              <strong>Couldn't delete.</strong> {deleteError.message}
            </span>
          </div>
        )}
        {deleteError?.referencedBy && deleteError.referencedBy.length > 0 && (
          <ul className={styles.referencedList} data-testid="connection-delete-referenced">
            {deleteError.referencedBy.map((id) => (
              <li key={id}>{id}</li>
            ))}
          </ul>
        )}
      </Dialog>
    </div>
  );
}
