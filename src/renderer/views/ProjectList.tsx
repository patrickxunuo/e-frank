import type { ProjectInstanceDto } from '@shared/ipc';
import { Badge, type BadgeVariant } from '../components/Badge';
import { Button } from '../components/Button';
import { DataTable, type DataTableColumn } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { Toggle } from '../components/Toggle';
import {
  IconArrowRight,
  IconBitbucket,
  IconCode,
  IconGitHub,
  IconJira,
  IconPlus,
  IconProjects,
  IconRefresh,
} from '../components/icons';
import { useAutoMode } from '../state/auto-mode';
import styles from './ProjectList.module.css';

export interface ProjectListProps {
  projects: ProjectInstanceDto[];
  loading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
  onAdd: () => void;
  onOpen: (id: string) => void;
}

interface ProjectStatus {
  variant: BadgeVariant;
  label: string;
  pulse?: boolean;
}

/**
 * MVP status: persisted projects don't carry execution state yet, so every
 * row reads as `idle`. The hook into the live poller arrives in #6 and will
 * map to the other variants without changing this view's contract.
 */
function statusFor(_project: ProjectInstanceDto): ProjectStatus {
  return { variant: 'idle', label: 'Idle' };
}

function repoIconFor(type: ProjectInstanceDto['repo']['type']): JSX.Element {
  switch (type) {
    case 'github':
      return <IconGitHub />;
    case 'bitbucket':
      return <IconBitbucket />;
    default:
      return <IconCode />;
  }
}

function repoLabelFor(type: ProjectInstanceDto['repo']['type']): string {
  switch (type) {
    case 'github':
      return 'GitHub';
    case 'bitbucket':
      return 'Bitbucket';
    default:
      return type;
  }
}

function ticketIconFor(source: ProjectInstanceDto['tickets']['source']): JSX.Element {
  switch (source) {
    case 'jira':
      return <IconJira />;
    default:
      return <IconJira />;
  }
}

function ticketLabelFor(source: ProjectInstanceDto['tickets']['source']): string {
  switch (source) {
    case 'jira':
      return 'Jira';
    default:
      return source;
  }
}

/**
 * Returns the ticket-source identifier for the row. As of #25, this is
 * `tickets.projectKey` directly; pre-#25 records are migrated by the
 * schema break in the same PR so we never see a `query`-only record.
 */
function ticketSourceLabel(projectKey: string): string {
  return projectKey || 'Jira';
}

function basenameOf(p: string): string {
  if (!p) return '';
  // Take the last segment regardless of separator.
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function ProjectList({
  projects,
  loading,
  error,
  onRefresh,
  onAdd,
  onOpen,
}: ProjectListProps): JSX.Element {
  const [autoMode, setAutoMode] = useAutoMode();

  const columns: DataTableColumn<ProjectInstanceDto>[] = [
    {
      key: 'project',
      header: 'Project',
      render: (row) => (
        <div className={styles.cell}>
          <span className={styles.cellIcon}>
            <IconCode />
          </span>
          <div className={styles.cellText}>
            <span className={styles.cellPrimary}>{row.name}</span>
            <span className={styles.cellSecondary}>{basenameOf(row.repo.localPath)}</span>
          </div>
        </div>
      ),
    },
    {
      key: 'repository',
      header: 'Repository',
      render: (row) => (
        <div className={styles.providerCell}>
          <span className={styles.providerBadge}>{repoIconFor(row.repo.type)}</span>
          <div className={styles.cellText}>
            <span className={styles.cellPrimary}>{repoLabelFor(row.repo.type)}</span>
            <span className={styles.cellSecondary}>{row.repo.baseBranch}</span>
          </div>
        </div>
      ),
    },
    {
      key: 'ticketSource',
      header: 'Ticket Source',
      render: (row) => (
        <div className={styles.providerCell}>
          <span className={styles.providerBadge}>{ticketIconFor(row.tickets.source)}</span>
          <div className={styles.cellText}>
            <span className={styles.cellPrimary}>{ticketLabelFor(row.tickets.source)}</span>
            <span className={styles.cellSecondary}>{ticketSourceLabel(row.tickets.projectKey)}</span>
          </div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => {
        const status = statusFor(row);
        return (
          <Badge
            variant={status.variant}
            pulse={status.pulse}
            data-testid={`project-status-${row.id}`}
          >
            {status.label}
          </Badge>
        );
      },
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      width: '120px',
      render: (row) => (
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation();
            onOpen(row.id);
          }}
          trailingIcon={<IconArrowRight />}
          data-testid={`project-open-${row.id}`}
        >
          Open
        </Button>
      ),
    },
  ];

  const showSkeleton = loading && projects.length === 0;
  const showEmpty = !loading && !error && projects.length === 0;
  const showTable = !loading && !error && projects.length > 0;

  return (
    <div className={styles.page} data-testid="project-list-page">
      <header className={styles.head}>
        <div className={styles.titleBlock}>
          <span className={styles.eyebrow}>Workspace · Projects</span>
          <h1 className={styles.title} data-testid="page-title">
            Projects
          </h1>
          <p className={styles.subtitle}>
            Manage and run your AI-powered development projects.
          </p>
        </div>
        <div className={styles.headActions}>
          <Toggle
            checked={autoMode}
            onChange={setAutoMode}
            label="Auto Mode"
            data-testid="auto-mode-toggle"
          />
          <Button
            variant="primary"
            leadingIcon={<IconPlus />}
            onClick={onAdd}
            data-testid="new-project-button"
          >
            New Project
          </Button>
        </div>
      </header>

      {error && (
        <div className={styles.errorBanner} role="alert" data-testid="project-list-error">
          <span>
            <strong>Couldn't load projects.</strong> {error}
          </span>
          <Button
            variant="ghost"
            size="sm"
            leadingIcon={<IconRefresh />}
            onClick={() => {
              void onRefresh();
            }}
            data-testid="project-list-retry"
          >
            Retry
          </Button>
        </div>
      )}

      {showSkeleton && (
        <div className={styles.skeleton} data-testid="project-list-loading">
          <div className={styles.skeletonRow} style={{ width: '36%' }} />
          <div className={styles.skeletonRow} style={{ width: '92%' }} />
          <div className={styles.skeletonRow} style={{ width: '78%' }} />
          <div className={styles.skeletonRow} style={{ width: '85%' }} />
        </div>
      )}

      {showEmpty && (
        <EmptyState
          icon={<IconProjects size={26} />}
          title="No projects yet"
          description="Connect a repository, point at a ticket source, and let e-frank turn tickets into pull requests."
          action={
            <Button
              variant="primary"
              leadingIcon={<IconPlus />}
              onClick={onAdd}
              data-testid="empty-state-cta"
            >
              Create your first project
            </Button>
          }
          data-testid="project-list-empty"
        />
      )}

      {showTable && (
        <DataTable
          columns={columns}
          rows={projects}
          rowKey={(row) => row.id}
          rowTestId={(row) => `project-row-${row.id}`}
          onRowClick={(row) => onOpen(row.id)}
          data-testid="project-list-table"
        />
      )}
    </div>
  );
}
