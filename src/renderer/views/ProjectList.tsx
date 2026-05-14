import type { ProjectInstanceDto, Run } from '@shared/ipc';
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
import { useGlobalActiveRuns } from '../state/global-active-run';
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
 * Live status for a project row. Driven by all in-flight runs from the
 * runner via `useGlobalActiveRuns` (#GH-81 lifted this from singular).
 * Cases:
 *   - zero runs target this project → "Idle"
 *   - one run, awaiting approval → "Awaiting"
 *   - one run, any other state → "Running"
 *   - N>1 runs, ANY awaiting → "Awaiting (N)" (awaiting takes precedence
 *     so the user sees the actionable state count, not generic "Running")
 *   - N>1 runs, none awaiting → "Running (N)"
 */
function statusFor(
  project: ProjectInstanceDto,
  activeRuns: ReadonlyArray<Run>,
): ProjectStatus {
  const mine = activeRuns.filter((r) => r.projectId === project.id);
  if (mine.length === 0) {
    return { variant: 'idle', label: 'Idle' };
  }
  const hasAwaiting = mine.some((r) => r.state === 'awaitingApproval');
  if (mine.length === 1) {
    return {
      variant: 'running',
      label: hasAwaiting ? 'Awaiting' : 'Running',
      pulse: true,
    };
  }
  return {
    variant: 'running',
    label: hasAwaiting ? `Awaiting (${mine.length})` : `Running (${mine.length})`,
    pulse: true,
  };
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
    case 'github-issues':
      // No dedicated GitHub Issues icon yet — fall through to the generic
      // ticket icon (Jira). The label below disambiguates.
      return <IconJira />;
    default:
      return <IconJira />;
  }
}

function ticketLabelFor(source: ProjectInstanceDto['tickets']['source']): string {
  switch (source) {
    case 'jira':
      return 'Jira';
    case 'github-issues':
      return 'GitHub Issues';
    default:
      return source;
  }
}

/**
 * Returns the ticket-source identifier for the row. The polish bundle
 * widens `tickets` to a discriminated union — Jira projects show the
 * `projectKey`, GitHub Issues projects show the `repoSlug`.
 */
function ticketSourceLabel(tickets: ProjectInstanceDto['tickets']): string {
  if (tickets.source === 'jira') {
    return tickets.projectKey || 'Jira';
  }
  return tickets.repoSlug || 'GitHub Issues';
}

function basenameOf(p: string): string {
  if (!p) return '';
  // Take the last segment regardless of separator.
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/**
 * Stable color palette for the project-cell badge tile. Picks one of four
 * token pairs based on a hash of `project.id` so each project gets a
 * visually distinguishable tile that's consistent across sessions — no
 * schema change required (no `iconColor` field). Skips `--danger` so the
 * happy-path list doesn't accidentally signal "broken" via color.
 */
const PROJECT_BADGE_PALETTE: ReadonlyArray<{ bg: string; fg: string }> = [
  { bg: 'var(--accent-soft)', fg: 'var(--accent)' },
  { bg: 'var(--success-soft)', fg: 'var(--success)' },
  { bg: 'var(--warning-soft)', fg: 'var(--warning)' },
  { bg: 'var(--accent-soft-strong)', fg: 'var(--accent)' },
];

function projectBadgeColors(projectId: string): { bg: string; fg: string } {
  // Cheap deterministic hash; modulo into the palette. djb2-ish.
  let h = 0;
  for (let i = 0; i < projectId.length; i++) {
    h = (h * 31 + projectId.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(h) % PROJECT_BADGE_PALETTE.length;
  return PROJECT_BADGE_PALETTE[idx]!;
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
  const activeRuns = useGlobalActiveRuns();

  const columns: DataTableColumn<ProjectInstanceDto>[] = [
    {
      key: 'project',
      header: 'Project',
      render: (row) => {
        const palette = projectBadgeColors(row.id);
        return (
          <div className={styles.cell}>
            <span
              className={styles.projectBadge}
              style={{
                // Per-row colors flow in as custom props so the CSS rule
                // stays static. Deterministic per project id; see
                // `projectBadgeColors` above.
                ['--badge-bg' as string]: palette.bg,
                ['--badge-fg' as string]: palette.fg,
              }}
              aria-hidden="true"
            >
              <IconCode size={16} />
            </span>
            <div className={styles.cellText}>
              <span className={styles.cellPrimary}>{row.name}</span>
              <span className={styles.cellSecondary}>{basenameOf(row.repo.localPath)}</span>
            </div>
          </div>
        );
      },
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
            <span className={styles.cellSecondary}>{ticketSourceLabel(row.tickets)}</span>
          </div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => {
        const status = statusFor(row, activeRuns);
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
          description="Connect a repository, point at a ticket source, and let PaperPlane turn tickets into pull requests."
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
