import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { Connection, ConnectionIdentity, Provider } from '@shared/ipc';
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

function identitySummary(id: ConnectionIdentity): string {
  if (id.kind === 'github') return `@${id.login}`;
  if (id.kind === 'jira') return id.displayName || id.accountId;
  return id.displayName ?? id.username;
}

function lastVerifiedDisplay(epochMs: number | undefined): string {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) return '—';
  return formatRelative(new Date(epochMs).toISOString());
}

/**
 * Test in-flight state. We use a Context (rather than threading the id
 * through every cell render via the columns memo) so the columns array
 * reference is stable across test clicks — DataTable doesn't re-render
 * unrelated rows. Only the ActionsCell subscribes to this context, so
 * only ActionsCells re-render when a test starts/finishes.
 */
const TestingIdContext = createContext<string | null>(null);

interface ActionsCellProps {
  row: Connection;
  onTest: (c: Connection) => void;
  onEdit: (c: Connection) => void;
  onDelete: (c: Connection) => void;
}

const ActionsCell = memo(function ActionsCell({
  row,
  onTest,
  onEdit,
  onDelete,
}: ActionsCellProps): JSX.Element {
  const testingId = useContext(TestingIdContext);
  const isTesting = testingId === row.id;
  const otherTesting = testingId !== null && testingId !== row.id;
  return (
    <div className={styles.actionsCell}>
      <Button
        variant="ghost"
        size="sm"
        disabled={isTesting || otherTesting}
        onClick={(e) => {
          e.stopPropagation();
          onTest(row);
        }}
        data-testid={`connection-test-${row.id}`}
      >
        {isTesting ? 'Testing…' : 'Test'}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={(e) => {
          e.stopPropagation();
          onEdit(row);
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
          onDelete(row);
        }}
        data-testid={`connection-delete-${row.id}`}
      >
        Delete
      </Button>
    </div>
  );
});

/**
 * Identity cell — pure derivation from row data. Memoized so a row update
 * elsewhere in the table doesn't force this cell to re-render. The pill is
 * persistent across navigations because `verificationStatus` lives on the
 * server-side connection record (see ConnectionStore.recordVerification /
 * markVerificationFailed).
 */
const IdentityCell = memo(function IdentityCell({ row }: { row: Connection }): JSX.Element {
  if (row.verificationStatus === 'auth-failed') {
    return (
      <span className={styles.testPill} data-state="error">
        <IconClose size={12} />
        Auth expired — re-test
      </span>
    );
  }
  if (row.verificationStatus === 'verified' && row.accountIdentity) {
    return (
      <span className={styles.testPill} data-state="success">
        <IconCheck size={12} />
        {identitySummary(row.accountIdentity)}
      </span>
    );
  }
  return <span className={styles.cellTertiary}>Not verified</span>;
});

export function Connections({ initialAdd = false }: ConnectionsProps): JSX.Element {
  const { connections, loading, error, refresh } = useConnections();
  const [addOpen, setAddOpen] = useState<boolean>(initialAdd);
  const [editing, setEditing] = useState<Connection | undefined>(undefined);
  const [confirmDelete, setConfirmDelete] = useState<Connection | undefined>(undefined);
  const [deleteError, setDeleteError] = useState<{ message: string; referencedBy?: string[] } | undefined>(
    undefined,
  );
  /** Single in-flight test at a time — disables the corresponding Test button. */
  const [testingId, setTestingId] = useState<string | null>(null);

  useEffect(() => {
    if (initialAdd) {
      setAddOpen(true);
    }
  }, [initialAdd]);

  const handleTestRow = useCallback(
    (c: Connection): void => {
      if (typeof window === 'undefined' || !window.api) return;
      const api = window.api;
      void (async () => {
        // Reads testingId via the setState updater — no need to add it to
        // deps and break the stable callback identity.
        let alreadyTesting = false;
        setTestingId((prev) => {
          if (prev !== null) {
            alreadyTesting = true;
            return prev;
          }
          return c.id;
        });
        if (alreadyTesting) return;
        try {
          // Pill state lives on the server-side connection record. After
          // the test the main process has already called recordVerification
          // (success) or markVerificationFailed (HTTP 401), so refresh()
          // surfaces the new state with no transient local feedback needed.
          await api.connections.test({ mode: 'existing', id: c.id });
          await refresh();
        } finally {
          setTestingId(null);
        }
      })();
    },
    [refresh],
  );

  const handleEditRow = useCallback((c: Connection): void => {
    setEditing(c);
    setAddOpen(true);
  }, []);

  const handleDeleteRow = useCallback((c: Connection): void => {
    setConfirmDelete(c);
    setDeleteError(undefined);
  }, []);

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
        key: 'identity',
        header: 'Identity',
        render: (row) => <IdentityCell row={row} />,
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
          <ActionsCell
            row={row}
            onTest={handleTestRow}
            onEdit={handleEditRow}
            onDelete={handleDeleteRow}
          />
        ),
      },
    ],
    [handleTestRow, handleEditRow, handleDeleteRow],
  );

  const showSkeleton = loading && connections.length === 0;
  const showEmpty = !loading && !error && connections.length === 0;
  // Keep the table mounted any time we have data — `loading` flips true
  // briefly during refresh() (e.g. after Test Connection), and unmounting
  // here would re-fire the row-enter animations on every refetch.
  const showTable = connections.length > 0;

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
          description="Connections store the credentials Paperplane uses to fetch tickets and open PRs (Jira API tokens, GitHub PATs, etc.)."
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
              Add connection
            </Button>
          }
          data-testid="connections-empty"
        />
      )}

      {showTable && (
        <TestingIdContext.Provider value={testingId}>
          <DataTable
            columns={columns}
            rows={connections}
            rowKey={(row) => row.id}
            rowTestId={(row) => `connections-row-${row.id}`}
            data-testid="connections-table"
          />
        </TestingIdContext.Provider>
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
