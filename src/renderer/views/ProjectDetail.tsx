import { useEffect, useMemo, useState } from 'react';
import type { ProjectInstanceDto, Run, RunState, TicketDto } from '@shared/ipc';
import { Badge, type BadgeVariant } from '../components/Badge';
import { Button } from '../components/Button';
import { Checkbox } from '../components/Checkbox';
import { DataTable, type DataTableColumn } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { Input } from '../components/Input';
import { LogPreview } from '../components/LogPreview';
import { ProgressBar } from '../components/ProgressBar';
import { Tabs, type TabItem } from '../components/Tabs';
import { Toggle } from '../components/Toggle';
import {
  IconArrowLeft,
  IconBitbucket,
  IconBranch,
  IconClose,
  IconCode,
  IconGitHub,
  IconJira,
  IconPlay,
  IconPullRequest,
  IconRefresh,
  IconRuns,
  IconSearch,
  IconSettings,
} from '../components/icons';
import { normalizePriority, type PriorityBucket } from '../lib/priority';
import { formatRelative } from '../lib/time';
import { useActiveRun } from '../state/active-run';
import { useAutoMode } from '../state/auto-mode';
import { useTickets } from '../state/tickets';
import styles from './ProjectDetail.module.css';

export interface ProjectDetailProps {
  projectId: string;
  onBack: () => void;
  /** Open the full Execution View for an active run (#8). Optional so legacy
   *  tests that don't exercise the Active Execution panel can omit it. */
  onOpenExecution?: (runId: string) => void;
}

/**
 * Friendly label for a `RunState` — surfaced as the progress-bar caption.
 * Matches the backend's USER_VISIBLE_LABELS table (kept in sync manually
 * to avoid pulling main-process types into the renderer).
 */
const RUN_STATE_LABELS: Record<RunState, string> = {
  idle: 'Idle',
  locking: 'Locking ticket',
  preparing: 'Preparing repo',
  branching: 'Creating branch',
  running: 'Implementing feature',
  awaitingApproval: 'Awaiting approval',
  committing: 'Committing changes',
  pushing: 'Pushing branch',
  creatingPr: 'Creating pull request',
  updatingTicket: 'Updating ticket',
  unlocking: 'Unlocking ticket',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/**
 * Linear progress 0..1 derived from the run's current state. The pipeline
 * has 10 ordered states from `locking` through `done`; we map each to its
 * position so the bar advances monotonically. `awaitingApproval` is a side
 * trip from `running`, so we collapse it to running's slot.
 */
const STATE_PROGRESS_ORDER: RunState[] = [
  'locking',
  'preparing',
  'branching',
  'running',
  'committing',
  'pushing',
  'creatingPr',
  'updatingTicket',
  'unlocking',
  'done',
];

function progressForRun(run: Run): { progress: number; index: number; total: number } {
  const total = STATE_PROGRESS_ORDER.length;
  const effective: RunState = run.state === 'awaitingApproval' ? 'running' : run.state;
  const idx = STATE_PROGRESS_ORDER.indexOf(effective);
  if (idx === -1) {
    // failed / cancelled / idle land here — show full bar so the panel
    // doesn't visually regress on terminal states.
    return { progress: run.status === 'done' ? 1 : 0, index: 0, total };
  }
  return { progress: (idx + 1) / total, index: idx, total };
}

type ProjectState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'not-found' }
  | { kind: 'ready'; project: ProjectInstanceDto };

type TabId = 'tickets' | 'runs' | 'prs' | 'settings';

function repoIconFor(type: ProjectInstanceDto['repo']['type']): JSX.Element {
  switch (type) {
    case 'github':
      return <IconGitHub size={14} />;
    case 'bitbucket':
      return <IconBitbucket size={14} />;
    default:
      return <IconCode size={14} />;
  }
}

function basenameOf(p: string): string {
  if (!p) return '';
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/**
 * Returns the human-facing ticket-source identifier. The polish bundle
 * widens `tickets` to a discriminated union; this helper does the per-
 * source narrowing in one place so the JSX stays readable.
 */
function ticketProjectLabel(tickets: ProjectInstanceDto['tickets']): string {
  if (tickets.source === 'jira') {
    return tickets.projectKey || 'Jira';
  }
  return tickets.repoSlug || 'GitHub Issues';
}

function priorityVariant(p: PriorityBucket): BadgeVariant {
  switch (p) {
    case 'high':
      return 'danger';
    case 'medium':
      return 'warning';
    case 'low':
      return 'success';
    default:
      return 'neutral';
  }
}

function priorityLabel(raw: string): string {
  if (!raw) return 'Unset';
  // Title-case the first letter so "high" -> "High".
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}

export function ProjectDetail({
  projectId,
  onBack,
  onOpenExecution,
}: ProjectDetailProps): JSX.Element {
  const [state, setState] = useState<ProjectState>({ kind: 'loading' });
  const [tab, setTab] = useState<TabId>('tickets');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [ticketSearchQuery, setTicketSearchQuery] = useState<string>('');
  const [runHistory, setRunHistory] = useState<{
    runs: Run[];
    loading: boolean;
    error: string | null;
  }>({ runs: [], loading: false, error: null });
  const [runBanner, setRunBanner] = useState<
    | { kind: 'error'; message: string }
    | { kind: 'queued'; firstKey: string; remaining: number }
    | null
  >(null);

  const tickets = useTickets(projectId);
  const activeRun = useActiveRun(projectId);
  const [autoMode, setAutoMode] = useAutoMode(projectId);

  /**
   * Start a run for `key`. On error, surface an inline banner. We don't
   * await the IPC round-trip from the click handler — the runner emits
   * `current-changed` events that the active panel subscribes to.
   */
  const startRun = (key: string): void => {
    if (typeof window === 'undefined' || !window.api) {
      setRunBanner({ kind: 'error', message: 'IPC bridge unavailable' });
      return;
    }
    setRunBanner(null);
    const api = window.api;
    void (async () => {
      try {
        const result = await api.runs.start({ projectId, ticketKey: key });
        if (!result.ok) {
          setRunBanner({
            kind: 'error',
            message:
              result.error.message ||
              result.error.code ||
              'Failed to start run',
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setRunBanner({ kind: 'error', message });
      }
    })();
  };

  const handleRunSelected = (keys: string[]): void => {
    if (keys.length === 0) return;
    const [first, ...rest] = keys;
    if (first === undefined) return;
    startRun(first);
    if (rest.length > 0) {
      // Sequential queue is a future enhancement — for #7 we start the first
      // ticket and let the user click Run on the rest after the active run
      // completes. The banner makes the queueing semantics explicit.
      setRunBanner({ kind: 'queued', firstKey: first, remaining: rest.length });
    }
  };

  const handleCancelActive = (): void => {
    if (activeRun === null) return;
    if (typeof window === 'undefined' || !window.api) return;
    const api = window.api;
    void api.runs.cancel({ runId: activeRun.id }).then((res) => {
      if (!res.ok) {
        setRunBanner({
          kind: 'error',
          message: res.error.message || res.error.code || 'Failed to cancel run',
        });
      }
    });
  };

  // -- Fetch the project on mount --
  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });

    if (typeof window === 'undefined' || !window.api) {
      setState({ kind: 'error', message: 'IPC bridge unavailable' });
      return;
    }

    const api = window.api;
    void (async () => {
      try {
        const result = await api.projects.get({ id: projectId });
        if (cancelled) return;
        if (result.ok) {
          setState({ kind: 'ready', project: result.data });
        } else if (result.error.code === 'NOT_FOUND') {
          setState({ kind: 'not-found' });
        } else {
          setState({
            kind: 'error',
            message: result.error.message || result.error.code || 'Failed to load project',
          });
        }
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ kind: 'error', message });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // -- Reset selection whenever the ticket list changes (rule from spec) --
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(tickets.tickets.map((t) => t.key));
      const next = new Set<string>();
      for (const key of prev) {
        if (visible.has(key)) next.add(key);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [tickets.tickets]);

  const orderedSelectedKeys = useMemo<string[]>(() => {
    return tickets.tickets.filter((t) => selected.has(t.key)).map((t) => t.key);
  }, [tickets.tickets, selected]);

  // Fetch run history for the Runs tab. Refetches whenever the user
  // switches to the Runs tab so a freshly-completed run shows up without
  // a manual refresh. The poller / WorkflowRunner doesn't push completed
  // runs over the IPC bus today; this lazy fetch is the lightest path
  // to fix #33.
  useEffect(() => {
    if (tab !== 'runs') return;
    if (state.kind !== 'ready') return;
    if (typeof window === 'undefined' || !window.api) return;
    const api = window.api;
    const projectId = state.project.id;
    let cancelled = false;
    setRunHistory((prev) => ({ ...prev, loading: true, error: null }));
    void (async () => {
      try {
        const result = await api.runs.listHistory({
          projectId,
          limit: 50,
        });
        if (cancelled) return;
        if (result.ok) {
          setRunHistory({ runs: result.data.runs, loading: false, error: null });
        } else {
          setRunHistory({
            runs: [],
            loading: false,
            error: result.error.message || result.error.code,
          });
        }
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setRunHistory({ runs: [], loading: false, error: message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, state]);

  const allSelected =
    tickets.tickets.length > 0 && selected.size === tickets.tickets.length;
  const someSelected = selected.size > 0 && !allSelected;

  const toggleAll = (next: boolean): void => {
    if (next) {
      setSelected(new Set(tickets.tickets.map((t) => t.key)));
    } else {
      setSelected(new Set());
    }
  };

  const toggleOne = (key: string, next: boolean): void => {
    setSelected((prev) => {
      const out = new Set(prev);
      if (next) {
        out.add(key);
      } else {
        out.delete(key);
      }
      return out;
    });
  };

  // -- Loading + error + not-found shells (no header / tabs in these states) --
  if (state.kind === 'loading') {
    return (
      <div className={styles.page} data-testid="project-detail-loading">
        <div className={styles.crumbs}>
          <button
            type="button"
            className={styles.crumbBack}
            onClick={onBack}
            data-testid="detail-back"
          >
            <IconArrowLeft size={12} />
            Projects
          </button>
        </div>
        <div className={styles.statePanel}>
          <span className={styles.stateBody}>Loading project…</span>
        </div>
      </div>
    );
  }

  if (state.kind === 'not-found' || state.kind === 'error') {
    const isNotFound = state.kind === 'not-found';
    return (
      <div className={styles.page} data-testid="project-detail-error">
        <div className={styles.crumbs}>
          <button
            type="button"
            className={styles.crumbBack}
            onClick={onBack}
            data-testid="detail-back"
          >
            <IconArrowLeft size={12} />
            Projects
          </button>
        </div>
        <div
          className={styles.banner}
          role="alert"
          data-testid={isNotFound ? 'project-not-found' : 'project-load-error'}
        >
          <span>
            <strong>
              {isNotFound ? "Couldn't find that project." : "Couldn't load project."}
            </strong>{' '}
            {isNotFound
              ? 'It may have been deleted. Head back and pick another one.'
              : state.kind === 'error'
                ? state.message
                : ''}
          </span>
          <Button variant="ghost" size="sm" onClick={onBack}>
            Back to projects
          </Button>
        </div>
      </div>
    );
  }

  // -- Ready --
  const project = state.project;

  const tabItems: TabItem[] = [
    {
      id: 'tickets',
      label: 'Tickets',
      badge: tickets.tickets.length > 0 ? tickets.tickets.length : undefined,
    },
    { id: 'runs', label: 'Runs' },
    { id: 'prs', label: 'Pull Requests' },
    { id: 'settings', label: 'Settings' },
  ];

  const ticketColumns: DataTableColumn<TicketDto>[] = [
    {
      key: 'select',
      width: '36px',
      header: (
        <Checkbox
          checked={allSelected}
          indeterminate={someSelected}
          onChange={(next) => toggleAll(next)}
          aria-label="Select all visible tickets"
          data-testid="ticket-master-checkbox"
        />
      ),
      render: (row) => (
        <Checkbox
          checked={selected.has(row.key)}
          onChange={(next) => toggleOne(row.key, next)}
          aria-label={`Select ${row.key}`}
          data-testid={`ticket-checkbox-${row.key}`}
        />
      ),
    },
    {
      key: 'id',
      header: 'ID',
      width: '120px',
      render: (row) => <span className={styles.idCell}>{row.key}</span>,
    },
    {
      key: 'title',
      header: 'Title',
      render: (row) => (
        <span className={styles.titleCell} title={row.summary}>
          {row.summary}
        </span>
      ),
    },
    {
      key: 'priority',
      header: 'Priority',
      width: '120px',
      render: (row) => {
        const bucket = normalizePriority(row.priority);
        return (
          <span data-priority={bucket}>
            <Badge
              variant={priorityVariant(bucket)}
              data-testid={`ticket-priority-${row.key}`}
            >
              {priorityLabel(row.priority || bucket)}
            </Badge>
          </span>
        );
      },
    },
    {
      key: 'source',
      header: 'Source',
      width: '110px',
      render: () => (
        <span className={styles.sourceCell}>
          <span className={styles.sourceIcon}>
            <IconJira size={14} />
          </span>
          Jira
        </span>
      ),
    },
    {
      key: 'updated',
      header: 'Last Updated',
      width: '140px',
      render: (row) => (
        <span className={styles.timeCell}>{formatRelative(row.updatedAt)}</span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      width: '110px',
      render: (row) => (
        <Button
          variant="ghost"
          size="sm"
          leadingIcon={<IconPlay size={12} />}
          onClick={(e) => {
            e.stopPropagation();
            startRun(row.key);
          }}
          data-testid={`ticket-run-button-${row.key}`}
        >
          Run
        </Button>
      ),
    },
  ];

  // Run-row helpers (used by the Runs tab — #33).
  const runStatusBadge = (run: Run): JSX.Element => {
    let variant: BadgeVariant = 'neutral';
    let label: string = run.status;
    switch (run.status) {
      case 'pending':
      case 'running':
        variant = 'running';
        label = run.state === 'awaitingApproval' ? 'Awaiting' : 'Running';
        break;
      case 'done':
        variant = 'success';
        label = 'Done';
        break;
      case 'failed':
        variant = 'danger';
        label = 'Failed';
        break;
      case 'cancelled':
        variant = 'warning';
        label = 'Cancelled';
        break;
    }
    return (
      <Badge variant={variant} pulse={run.status === 'running'}>
        {label}
      </Badge>
    );
  };

  const formatDuration = (start: number, end: number | undefined): string => {
    if (typeof end !== 'number') return '—';
    const ms = Math.max(0, end - start);
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const remS = s % 60;
    if (m < 60) return remS === 0 ? `${m}m` : `${m}m ${remS}s`;
    const h = Math.floor(m / 60);
    const remM = m % 60;
    return remM === 0 ? `${h}h` : `${h}h ${remM}m`;
  };

  const runColumns: DataTableColumn<Run>[] = [
      {
        key: 'status',
        header: 'Status',
        render: (row) => runStatusBadge(row),
      },
      {
        key: 'ticketKey',
        header: 'Ticket',
        render: (row) => (
          <span className={styles.runTicketKey}>{row.ticketKey}</span>
        ),
      },
      {
        key: 'branch',
        header: 'Branch',
        render: (row) => (
          <span className={styles.runBranch}>{row.branchName}</span>
        ),
      },
      {
        key: 'started',
        header: 'Started',
        render: (row) => (
          <span className={styles.runStartedAt}>
            {formatRelative(new Date(row.startedAt).toISOString())}
          </span>
        ),
      },
      {
        key: 'duration',
        header: 'Duration',
        render: (row) => (
          <span className={styles.runDuration}>
            {formatDuration(row.startedAt, row.finishedAt)}
          </span>
        ),
      },
      {
        key: 'pr',
        header: 'PR',
        render: (row) =>
          row.prUrl ? (
            <a
              href={row.prUrl}
              target="_blank"
              rel="noreferrer"
              className={styles.runPrLink}
              onClick={(e) => e.stopPropagation()}
              data-testid={`run-pr-${row.id}`}
            >
              View
            </a>
          ) : (
            <span className={styles.runPrEmpty}>—</span>
          ),
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
              onOpenExecution?.(row.id);
            }}
            data-testid={`run-view-${row.id}`}
          >
            View
          </Button>
        ),
      },
    ];

  const runsBody = ((): JSX.Element => {
    if (runHistory.loading && runHistory.runs.length === 0) {
      return (
        <div className={styles.tableSkeleton} data-testid="runs-loading">
          <div className={styles.skeletonRow} style={{ width: '40%' }} />
          <div className={styles.skeletonRow} style={{ width: '88%' }} />
          <div className={styles.skeletonRow} style={{ width: '72%' }} />
        </div>
      );
    }
    if (runHistory.error !== null) {
      return (
        <EmptyState
          icon={<IconRuns size={26} />}
          title="Couldn't load run history"
          description={runHistory.error}
          data-testid="runs-error"
        />
      );
    }
    if (runHistory.runs.length === 0) {
      return (
        <EmptyState
          icon={<IconRuns size={26} />}
          title="No runs yet"
          description="Once you trigger a run from the Tickets tab, the timeline lands here — status, branch, duration, PR link, and a button to open the live log."
          data-testid="tab-empty-runs"
        />
      );
    }
    return (
      <DataTable
        columns={runColumns}
        rows={runHistory.runs}
        rowKey={(row) => row.id}
        rowTestId={(row) => `run-row-${row.id}`}
        onRowClick={(row) => onOpenExecution?.(row.id)}
        data-testid="runs-tab-table"
      />
    );
  })();

  const trimmedQuery = ticketSearchQuery.trim().toLowerCase();
  const filteredTickets =
    trimmedQuery === ''
      ? tickets.tickets
      : tickets.tickets.filter((t) => {
          const fields = [t.key, t.summary, t.status, t.assignee ?? ''];
          return fields.some((f) => f.toLowerCase().includes(trimmedQuery));
        });

  const ticketsBody = ((): JSX.Element => {
    if (tickets.loading && tickets.tickets.length === 0) {
      return (
        <div className={styles.tableSkeleton} data-testid="tickets-loading">
          <div className={styles.skeletonRow} style={{ width: '40%' }} />
          <div className={styles.skeletonRow} style={{ width: '88%' }} />
          <div className={styles.skeletonRow} style={{ width: '72%' }} />
          <div className={styles.skeletonRow} style={{ width: '80%' }} />
        </div>
      );
    }
    if (!tickets.loading && tickets.tickets.length === 0) {
      return (
        <EmptyState
          icon={<IconJira size={26} />}
          title="No eligible tickets"
          description={
            tickets.error
              ? 'We couldn’t reach Jira — check the project’s credentials and try refreshing.'
              : 'Nothing matches this project’s JQL right now. New tickets will land here automatically.'
          }
          action={
            <Button
              variant="ghost"
              size="sm"
              leadingIcon={<IconRefresh />}
              onClick={() => {
                void tickets.refresh();
              }}
              data-testid="tickets-empty-refresh"
            >
              Refresh
            </Button>
          }
          data-testid="tickets-empty"
        />
      );
    }
    // We have tickets — render the search box + table. Filter is
    // case-insensitive substring match across key/summary/status/assignee
    // (#36). Search input value persists across re-fetches because it's
    // stored on the ProjectDetail component, not derived from `tickets`.
    return (
      <div className={styles.ticketsTableWrap}>
        <div className={styles.ticketsSearchRow}>
          <Input
            value={ticketSearchQuery}
            onChange={(e) => setTicketSearchQuery(e.target.value)}
            placeholder="Search tickets by key, summary, status, or assignee…"
            leadingIcon={<IconSearch />}
            data-testid="tickets-search-input"
            name="ticketSearch"
          />
        </div>
        {filteredTickets.length === 0 ? (
          <EmptyState
            icon={<IconJira size={26} />}
            title={`No tickets match "${ticketSearchQuery}"`}
            description="Try a different keyword, or clear the search to see everything."
            data-testid="tickets-empty-filter"
          />
        ) : (
          <DataTable
            columns={ticketColumns}
            rows={filteredTickets}
            rowKey={(row) => row.key}
            rowTestId={(row) => `ticket-row-${row.key}`}
            data-testid="tickets-table"
          />
        )}
      </div>
    );
  })();

  const runSelectedDisabled = orderedSelectedKeys.length === 0;

  return (
    <div className={styles.page} data-testid="project-detail-page">
      <header className={styles.header}>
        <div className={styles.crumbs}>
          <button
            type="button"
            className={styles.crumbBack}
            onClick={onBack}
            data-testid="detail-back"
          >
            <IconArrowLeft size={12} />
            Projects
          </button>
          <span className={styles.crumbDivider}>/</span>
          <span className={styles.crumbCurrent}>{project.name}</span>
        </div>

        <div className={styles.headRow}>
          <div className={styles.titleBlock}>
            <h1 className={styles.title} data-testid="project-detail-title">
              {project.name}
            </h1>
            <div className={styles.pillRow}>
              <span className={styles.pill}>
                <span className={styles.pillIcon}>
                  <IconJira size={12} />
                </span>
                Ticket Source
                <span className={styles.pillMono}>
                  {ticketProjectLabel(project.tickets)}
                </span>
              </span>
              <span className={styles.pill}>
                <span className={styles.pillIcon}>{repoIconFor(project.repo.type)}</span>
                Repo
                <span className={styles.pillMono}>{basenameOf(project.repo.localPath)}</span>
              </span>
              <span className={styles.pill}>
                <span className={styles.pillIcon}>
                  <IconBranch size={12} />
                </span>
                Base Branch
                <span className={styles.pillMono}>{project.repo.baseBranch}</span>
              </span>
            </div>
          </div>

          <div className={styles.headActions}>
            <Toggle
              checked={autoMode}
              onChange={setAutoMode}
              label="Auto Mode"
              data-testid="auto-mode-toggle"
            />
            <span className={styles.headDivider} aria-hidden="true" />
            <Button
              variant="primary"
              leadingIcon={<IconPlay size={12} />}
              onClick={() => handleRunSelected(orderedSelectedKeys)}
              disabled={runSelectedDisabled}
              data-testid="run-selected-button"
            >
              Run Selected
              {orderedSelectedKeys.length > 0 ? ` (${orderedSelectedKeys.length})` : ''}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              leadingIcon={
                <span className={tickets.refreshing ? styles.refreshSpinning : undefined}>
                  <IconRefresh size={14} />
                </span>
              }
              onClick={() => {
                void tickets.refresh();
              }}
              disabled={tickets.refreshing}
              data-testid="refresh-button"
            >
              Refresh
            </Button>
          </div>
        </div>
      </header>

      {tickets.error && (
        <div
          className={styles.banner}
          role="alert"
          data-testid="tickets-error-banner"
        >
          <span>
            <strong>Couldn’t refresh tickets.</strong> {tickets.error}
          </span>
          <Button
            variant="ghost"
            size="sm"
            leadingIcon={<IconClose size={12} />}
            onClick={() => {
              void tickets.refresh();
            }}
            data-testid="tickets-error-retry"
          >
            Try again
          </Button>
        </div>
      )}

      {runBanner && (
        <div
          className={styles.banner}
          role={runBanner.kind === 'error' ? 'alert' : 'status'}
          data-testid={
            runBanner.kind === 'error' ? 'run-error-banner' : 'run-queued-banner'
          }
        >
          <span>
            {runBanner.kind === 'error' ? (
              <>
                <strong>Couldn’t start run.</strong> {runBanner.message}
              </>
            ) : (
              <>
                <strong>Run started for {runBanner.firstKey}</strong> — select again
                after this run completes for the remaining {runBanner.remaining}.
              </>
            )}
          </span>
          <Button
            variant="ghost"
            size="sm"
            leadingIcon={<IconClose size={12} />}
            onClick={() => setRunBanner(null)}
            data-testid="run-banner-dismiss"
          >
            Dismiss
          </Button>
        </div>
      )}

      <div className={styles.body}>
        <Tabs
          items={tabItems}
          value={tab}
          onChange={(next) => setTab(next as TabId)}
          data-testid="project-tabs"
        />

        <div
          className={styles.tabPanel}
          role="tabpanel"
          aria-label={tab}
          data-testid={`tab-panel-${tab}`}
        >
          {tab === 'tickets' && ticketsBody}
          {tab === 'runs' && runsBody}
          {tab === 'prs' && (
            <EmptyState
              icon={<IconPullRequest size={26} />}
              title="Pull requests will gather here"
              description="Once the agent opens PRs against this repo, you’ll see status, review state, and merges in this tab."
              data-testid="tab-empty-prs"
            />
          )}
          {tab === 'settings' && (
            <EmptyState
              icon={<IconSettings size={26} />}
              title="Project settings"
              description="Editing repo paths, JQL, and credentials moves here in a future release. For now, recreate the project to make changes."
              data-testid="tab-empty-settings"
            />
          )}
        </div>
      </div>

      {activeRun && (() => {
        const { progress, index, total } = progressForRun(activeRun);
        const stateLabel = RUN_STATE_LABELS[activeRun.state];
        // #8 will populate streaming logs; for #7 the panel ships without
        // them. The empty array keeps the LogPreview height stable.
        const recentLines: string[] = [];
        return (
          <aside className={styles.activePanel} data-testid="active-execution-panel">
            <div className={styles.activeCard}>
              <div className={styles.activeLeft}>
                <div className={styles.activeHead}>
                  <div className={styles.activeBadgeRow}>
                    <span className={styles.activeKey} data-testid="active-execution-key">
                      {activeRun.ticketKey}
                    </span>
                    <Badge variant="running" pulse>
                      {activeRun.state === 'awaitingApproval' ? 'Awaiting' : 'Running'}
                    </Badge>
                  </div>
                  <div className={styles.activeActions}>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onOpenExecution?.(activeRun.id)}
                      data-testid="active-execution-open-details"
                    >
                      Open Details
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      leadingIcon={<IconClose size={12} />}
                      onClick={handleCancelActive}
                      data-testid="active-execution-cancel"
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
                <span className={styles.activeTitle}>{activeRun.ticketKey}</span>
                <ProgressBar
                  value={progress}
                  label={stateLabel}
                  hint={`Step ${index + 1} of ${total}`}
                  data-testid="active-execution-progress"
                />
              </div>
              <div className={styles.activeRight}>
                <LogPreview
                  lines={recentLines}
                  maxHeight={140}
                  data-testid="active-execution-log"
                />
              </div>
            </div>
          </aside>
        );
      })()}
    </div>
  );
}
