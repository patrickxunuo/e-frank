import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ProjectInstanceDto,
  Run,
  RunState,
  TicketDto,
  TicketsSortBy,
  TicketsSortDir,
} from '@shared/ipc';
import { Badge, type BadgeVariant } from '../components/Badge';
import { Button } from '../components/Button';
import {
  DataTable,
  type DataTableColumn,
  type DataTableSortState,
} from '../components/DataTable';
import { Dialog } from '../components/Dialog';
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
  IconCheck,
  IconClipboard,
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
  IconTrash,
} from '../components/icons';
import { normalizePriority, type PriorityBucket } from '../lib/priority';
import { formatRelative } from '../lib/time';
import { useActiveRun } from '../state/active-run';
import { useAutoMode } from '../state/auto-mode';
import { useRunLog } from '../state/run-log';
import { stripAnsi } from '../components/ansi';
import {
  useTicketPages,
  type TicketPagesQuery,
} from '../state/ticket-pages';
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
  fetchingTicket: 'Fetching ticket',
  branching: 'Setting up branch',
  understandingContext: 'Understanding context',
  planning: 'Planning',
  running: 'Implementing feature',
  awaitingApproval: 'Awaiting approval',
  implementing: 'Implementing feature',
  evaluatingTests: 'Evaluating tests',
  reviewingCode: 'Reviewing code',
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
/**
 * After #37 the runner only directly enters `locking → running →
 * unlocking → done`; the legacy `preparing` is gone, and the inner
 * phases (`branching | committing | pushing | creatingPr |
 * updatingTicket`) only fire when Claude emits markers — not all skills
 * emit all phases (e.g. a no-op ticket update). The progression order
 * is what we *expect* in the canonical happy path; the bar advances
 * incrementally as markers land, and skipped phases just bump the bar
 * forward when the next one fires.
 */
const STATE_PROGRESS_ORDER: RunState[] = [
  'locking',
  'running',
  'fetchingTicket',
  'branching',
  'understandingContext',
  'planning',
  'implementing',
  'evaluatingTests',
  'reviewingCode',
  'committing',
  'pushing',
  'creatingPr',
  'updatingTicket',
  'unlocking',
  'done',
];

function progressForRun(run: Run): { progress: number; index: number; total: number } {
  const total = STATE_PROGRESS_ORDER.length;
  // `awaitingApproval` is a side trip — collapse it to whichever phase
  // came before it. Default to `planning` (the most common pre-approval
  // phase) so the bar doesn't snap backward to the umbrella state.
  const effective: RunState = run.state === 'awaitingApproval' ? 'planning' : run.state;
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

interface CopyBranchButtonProps {
  branchName: string;
}

function CopyBranchButton({ branchName }: CopyBranchButtonProps): JSX.Element {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const handleClick = (): void => {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clipboard || typeof clipboard.writeText !== 'function') return;
    void clipboard.writeText(branchName).then(
      () => {
        setCopied(true);
        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => {
          setCopied(false);
          timerRef.current = null;
        }, 1500);
      },
      () => {
        // Silent failure per spec — clipboard rejected, just leave label as "Copy".
      },
    );
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      leadingIcon={copied ? <IconCheck size={12} /> : <IconClipboard size={12} />}
      onClick={handleClick}
      data-testid="active-execution-copy-branch"
      aria-label={copied ? 'Branch name copied' : `Copy branch name ${branchName}`}
    >
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

interface ActiveExecutionPanelProps {
  run: Run;
  onOpenExecution?: (runId: string) => void;
  onCancel: () => void;
}

const TERMINAL_STATUSES_LOCAL = new Set(['done', 'failed', 'cancelled']);

/**
 * Bottom widget that hovers over the project detail page while a run is
 * active. After GH-52 it does three new things:
 *
 *   #1 — surface the latest streamed line via `useRunLog`, so the
 *        LogPreview no longer reads "Awaiting output…" forever.
 *   #2 — pass `running` to ProgressBar so the fill subtly breathes
 *        on non-terminal states.
 *   #3 — when the run is awaitingApproval, the page-level Open Details +
 *        Cancel actions are joined by inline Approve / Reject buttons
 *        wired to the same `runs.approve` / `runs.reject` IPC calls
 *        ApprovalPanel uses. The Modify flow stays in ExecutionView
 *        (it needs a textarea), so the widget links over for that case.
 */
function ActiveExecutionPanel({
  run,
  onOpenExecution,
  onCancel,
}: ActiveExecutionPanelProps): JSX.Element {
  const log = useRunLog(run);
  const [pendingDecision, setPendingDecision] = useState<
    'approve' | 'reject' | null
  >(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);

  const { progress } = progressForRun(run);
  const stateLabel = RUN_STATE_LABELS[run.state];
  const isTerminal = TERMINAL_STATUSES_LOCAL.has(run.status);
  const awaiting = run.pendingApproval !== null;

  // Derive the latest streamed line from the current step's tail.
  const currentStep =
    log.currentUserVisibleIndex >= 0
      ? log.steps[log.currentUserVisibleIndex]
      : log.steps[log.steps.length - 1];
  const latestLineRaw = currentStep?.lines.length
    ? currentStep.lines[currentStep.lines.length - 1]?.line ?? ''
    : '';
  const recentLines: string[] = latestLineRaw
    ? [stripAnsi(latestLineRaw)]
    : [];

  const dispatchApproval = useCallback(
    async (decision: 'approve' | 'reject'): Promise<void> => {
      if (typeof window === 'undefined' || !window.api) return;
      if (pendingDecision !== null) return;
      setPendingDecision(decision);
      setApprovalError(null);
      try {
        const fn =
          decision === 'approve' ? window.api.runs.approve : window.api.runs.reject;
        const res = await fn({ runId: run.id });
        if (!res.ok) {
          setApprovalError(
            res.error.message || res.error.code || `Failed to ${decision}`,
          );
        }
      } catch (err) {
        setApprovalError(err instanceof Error ? err.message : String(err));
      } finally {
        setPendingDecision(null);
      }
    },
    [pendingDecision, run.id],
  );

  return (
    <aside
      className={styles.activePanel}
      data-testid="active-execution-panel"
      data-awaiting-approval={awaiting ? 'true' : 'false'}
    >
      <div className={styles.activeCard}>
        <div className={styles.activeLeft}>
          <div className={styles.activeHead}>
            <div className={styles.activeBadgeRow}>
              <span className={styles.activeKey} data-testid="active-execution-key">
                {run.ticketKey}
              </span>
              <Badge variant="running" pulse>
                {awaiting ? 'Awaiting' : 'Running'}
              </Badge>
            </div>
            <div className={styles.activeActions}>
              {awaiting && (
                <>
                  <Button
                    variant="primary"
                    size="sm"
                    leadingIcon={<IconCheck size={12} />}
                    onClick={() => {
                      void dispatchApproval('approve');
                    }}
                    disabled={pendingDecision !== null}
                    data-testid="panel-approve"
                  >
                    Approve
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    leadingIcon={<IconClose size={12} />}
                    onClick={() => {
                      void dispatchApproval('reject');
                    }}
                    disabled={pendingDecision !== null}
                    data-testid="panel-reject"
                  >
                    Reject
                  </Button>
                </>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onOpenExecution?.(run.id)}
                data-testid="active-execution-open-details"
              >
                Open Details
              </Button>
              {!awaiting && (
                <Button
                  variant="destructive"
                  size="sm"
                  leadingIcon={<IconClose size={12} />}
                  onClick={onCancel}
                  data-testid="active-execution-cancel"
                >
                  Cancel
                </Button>
              )}
            </div>
          </div>
          <span className={styles.activeTitle}>{run.ticketKey}</span>
          <div className={styles.activeBranchRow}>
            <span className={styles.activeBranchIcon} aria-hidden="true">
              <IconBranch size={12} />
            </span>
            <span
              className={styles.activeBranchName}
              title={run.branchName}
              data-testid="active-execution-branch"
            >
              {run.branchName}
            </span>
            <CopyBranchButton branchName={run.branchName} />
          </div>
          <ProgressBar
            value={progress}
            label={stateLabel}
            running={!isTerminal}
            data-testid="active-execution-progress"
          />
          {approvalError !== null && (
            <span
              className={styles.activeApprovalError}
              role="alert"
              data-testid="active-execution-approval-error"
            >
              {approvalError}
            </span>
          )}
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
}

export function ProjectDetail({
  projectId,
  onBack,
  onOpenExecution,
}: ProjectDetailProps): JSX.Element {
  const [state, setState] = useState<ProjectState>({ kind: 'loading' });
  const [tab, setTab] = useState<TabId>('tickets');
  /**
   * Local search input value. Server-side search lives on `ticketQuery.search`;
   * we debounce keystrokes into that field so each character doesn't trigger
   * a fresh page-1 fetch.
   */
  const [ticketSearchInput, setTicketSearchInput] = useState<string>('');
  const [committedSearch, setCommittedSearch] = useState<string>('');
  const [sortState, setSortState] = useState<DataTableSortState | null>(null);
  const [runHistory, setRunHistory] = useState<{
    runs: Run[];
    loading: boolean;
    error: string | null;
  }>({ runs: [], loading: false, error: null });
  const [runBanner, setRunBanner] = useState<
    { kind: 'error'; message: string } | null
  >(null);
  /**
   * Run-row delete UX state. `confirmRunId` drives the modal's open/close;
   * `deletingRunId` blocks the confirm button while the IPC round-trip is
   * in flight so a double-click can't fire two deletes.
   */
  const [confirmRunId, setConfirmRunId] = useState<string | null>(null);
  const [deletingRunId, setDeletingRunId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Source kind drives which sort options are usable. GitHub Issues doesn't
  // expose a priority sort server-side, so we degrade to id-only there.
  const sourceKind = state.kind === 'ready' ? state.project.tickets.source : 'jira';
  const isGithubSource = sourceKind === 'github-issues';

  const defaultSort: DataTableSortState = isGithubSource
    ? { key: 'id', dir: 'desc' }
    : { key: 'priority', dir: 'desc' };
  const effectiveSort: DataTableSortState = sortState ?? defaultSort;

  // Build the server-paginated query. Memoized so identical sort/search
  // values don't reset pagination on unrelated re-renders.
  const ticketQuery: TicketPagesQuery = useMemo(() => {
    const q: TicketPagesQuery = {
      sortBy: effectiveSort.key as TicketsSortBy,
      sortDir: effectiveSort.dir as TicketsSortDir,
      search: undefined,
    };
    if (committedSearch.trim() !== '') q.search = committedSearch.trim();
    return q;
  }, [effectiveSort.key, effectiveSort.dir, committedSearch]);

  const pages = useTicketPages(projectId, ticketQuery);
  const activeRun = useActiveRun(projectId);
  const [autoMode, setAutoMode] = useAutoMode(projectId);

  // Debounce search keystrokes → committedSearch. 300ms feels responsive
  // without firing on every character. The hook restarts pagination from
  // page-1 whenever `ticketQuery.search` changes.
  useEffect(() => {
    if (ticketSearchInput === committedSearch) return;
    const handle = window.setTimeout(() => {
      setCommittedSearch(ticketSearchInput);
    }, 300);
    return () => {
      window.clearTimeout(handle);
    };
  }, [ticketSearchInput, committedSearch]);

  /**
   * Infinite-scroll sentinel for the tickets table. The ref callback is
   * declared up here (above the early returns) so React's hook order is
   * stable across `state.kind` transitions. It's a ref-callback rather
   * than a `useRef` because the sentinel mounts and unmounts as the table
   * empty/skeleton/loaded states swap — re-attaching the observer on each
   * mount is the reliable shape. Stored observer in a ref so the cleanup
   * effect below can disconnect on unmount.
   */
  const sentinelObserver = useRef<IntersectionObserver | null>(null);
  const loadMoreRef = useRef(pages.loadMore);
  loadMoreRef.current = pages.loadMore;

  const sentinelRef = useCallback((node: HTMLDivElement | null) => {
    if (sentinelObserver.current !== null) {
      sentinelObserver.current.disconnect();
      sentinelObserver.current = null;
    }
    if (node === null) return;
    // Walk up to the DataTable's scroll-root; null root falls back to
    // the document viewport (fine for SSR/test environments).
    const root = node.closest('[data-scroll-root]') as Element | null;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            void loadMoreRef.current();
          }
        }
      },
      // 200px rootMargin pre-loads the next page before the sentinel
      // scrolls fully into view — keeps the feed feeling continuous.
      { root, rootMargin: '0px 0px 200px 0px' },
    );
    observer.observe(node);
    sentinelObserver.current = observer;
  }, []);

  // Tear down the observer on unmount.
  useEffect(() => {
    return () => {
      if (sentinelObserver.current !== null) {
        sentinelObserver.current.disconnect();
        sentinelObserver.current = null;
      }
    };
  }, []);

  /**
   * Start a run for `key`. On success, route the user to the live
   * ExecutionView so they can see Claude's output stream from the first
   * second — and so the stdin textarea is mounted in time to answer any
   * mid-run question. On error, surface an inline banner.
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
          return;
        }
        // Auto-navigate to the ExecutionView so the input textarea is
        // mounted before Claude's CLI hits its 3-second stdin window.
        // The active-run panel on this page is also fine for casual
        // observation, but the ExecutionView is the only place with
        // the textarea wired to `claude.write`.
        onOpenExecution?.(result.data.run.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setRunBanner({ kind: 'error', message });
      }
    })();
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

  /**
   * Delete a finished run. Confirmation lives in `confirmRunId`; this is
   * called from the dialog's confirm button. On success: drop the row from
   * the in-memory history, close the dialog. On failure: surface in the
   * dialog (rather than the page banner) so the user can retry without
   * losing context.
   */
  const handleConfirmDeleteRun = useCallback(async (): Promise<void> => {
    const runId = confirmRunId;
    if (runId === null) return;
    if (typeof window === 'undefined' || !window.api) {
      setDeleteError('IPC bridge unavailable');
      return;
    }
    setDeletingRunId(runId);
    setDeleteError(null);
    try {
      const res = await window.api.runs.delete({ runId });
      if (!res.ok) {
        setDeleteError(res.error.message || res.error.code || 'Failed to delete run');
        setDeletingRunId(null);
        return;
      }
      setRunHistory((prev) => ({
        ...prev,
        runs: prev.runs.filter((r) => r.id !== runId),
      }));
      setConfirmRunId(null);
      setDeletingRunId(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
      setDeletingRunId(null);
    }
  }, [confirmRunId]);

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
      // Show the loaded count — "20+" hint is implicit via the row count
      // jumping when the user scrolls past the sentinel.
      badge: pages.rows.length > 0 ? pages.rows.length : undefined,
    },
    { id: 'runs', label: 'Runs' },
    { id: 'prs', label: 'Pull Requests' },
    { id: 'settings', label: 'Settings' },
  ];

  const ticketColumns: DataTableColumn<TicketDto>[] = [
    {
      // Run is the leftmost column. Multi-select used to live here as
      // a checkbox column with a "Run Selected" button up top, but the
      // runner enforces a single active run (`ALREADY_RUNNING`) — git
      // can't check out two branches in one working directory anyway —
      // so multi-select was theater. Per-row Run is the honest UI.
      key: 'run',
      header: '',
      width: '88px',
      render: (row) => (
        <Button
          variant="primary"
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
    {
      key: 'id',
      header: 'ID',
      width: '120px',
      sortable: true,
      defaultSortDir: 'desc',
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
      sortable: true,
      defaultSortDir: 'desc',
      // GitHub's repo issues endpoint can't sort by label-driven priority;
      // the column header degrades to plain text on GitHub-backed projects.
      sortDisabled: isGithubSource,
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
            {isGithubSource ? <IconGitHub size={14} /> : <IconJira size={14} />}
          </span>
          {isGithubSource ? 'GitHub' : 'Jira'}
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
        width: '180px',
        render: (row) => {
          const isActive = activeRun !== null && activeRun.id === row.id;
          return (
            <span className={styles.runActions}>
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
              {!isActive && (
                <Button
                  variant="ghost"
                  size="sm"
                  leadingIcon={<IconTrash size={14} />}
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteError(null);
                    setConfirmRunId(row.id);
                  }}
                  data-testid={`run-delete-${row.id}`}
                  aria-label={`Delete run for ${row.ticketKey}`}
                />
              )}
            </span>
          );
        },
      },
    ];

  const runsBody = ((): JSX.Element => {
    const isReloading = runHistory.loading;
    const hasRuns = runHistory.runs.length > 0;
    if (!isReloading && runHistory.error !== null && !hasRuns) {
      return (
        <EmptyState
          icon={<IconRuns size={26} />}
          title="Couldn't load run history"
          description={runHistory.error}
          data-testid="runs-error"
        />
      );
    }
    if (!isReloading && !hasRuns) {
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
        fillHeight
        loadingRows={isReloading && !hasRuns ? 5 : undefined}
        data-testid="runs-tab-table"
      />
    );
  })();

  const ticketsBody = ((): JSX.Element => {
    const isReloading = pages.loading;
    const hasRows = pages.rows.length > 0;

    const tableFooter: JSX.Element | undefined = pages.hasMore || pages.loadingMore
      ? (
          <div className={styles.scrollSentinelRow}>
            <div ref={sentinelRef} className={styles.scrollSentinel} aria-hidden="true" />
            {pages.loadingMore && (
              <span data-testid="tickets-loading-more">Loading more…</span>
            )}
          </div>
        )
      : undefined;

    /**
     * Empty-state branch: only when we've actually finished loading and
     * there are zero rows. During a reload we keep the table mounted
     * (sticky headers + skeleton rows) so the column context doesn't
     * vanish on every sort flip.
     */
    const showEmpty = !isReloading && !hasRows;
    const emptyContent = showEmpty
      ? committedSearch.trim() !== ''
        ? (
            <EmptyState
              icon={<IconJira size={26} />}
              title={`No tickets match "${committedSearch}"`}
              description="Try a different keyword, or clear the search to see everything."
              data-testid="tickets-empty-filter"
            />
          )
        : (
            <EmptyState
              icon={<IconJira size={26} />}
              title="No eligible tickets"
              description={
                pages.error
                  ? 'We couldn’t reach the ticket source — check the project’s credentials and try refreshing.'
                  : 'Nothing matches this project’s configured filter right now. New tickets will land here automatically.'
              }
              action={
                <Button
                  variant="ghost"
                  size="sm"
                  leadingIcon={<IconRefresh />}
                  onClick={() => {
                    void pages.refresh();
                  }}
                  data-testid="tickets-empty-refresh"
                >
                  Refresh
                </Button>
              }
              data-testid="tickets-empty"
            />
          )
      : null;

    return (
      <div className={styles.ticketsTableWrap}>
        <div className={styles.ticketsSearchRow}>
          <Input
            value={ticketSearchInput}
            onChange={(e) => setTicketSearchInput(e.target.value)}
            placeholder={
              isGithubSource
                ? 'Search tickets (filters loaded pages on GitHub sources)'
                : 'Search tickets by key, summary, status, or assignee…'
            }
            leadingIcon={<IconSearch />}
            data-testid="tickets-search-input"
            name="ticketSearch"
          />
        </div>
        {showEmpty ? (
          emptyContent
        ) : (
          <DataTable
            columns={ticketColumns}
            rows={pages.rows}
            rowKey={(row) => row.key}
            rowTestId={(row) => `ticket-row-${row.key}`}
            fillHeight
            sort={effectiveSort}
            onSortChange={(next) => setSortState(next)}
            footer={tableFooter}
            // 8 placeholder rows when we're actively fetching the first
            // page (mount, sort flip, or refresh) — keeps the sticky
            // headers in place during the round-trip.
            loadingRows={isReloading && !hasRows ? 8 : undefined}
            data-testid="tickets-table"
          />
        )}
      </div>
    );
  })();

  return (
    <div
      className={styles.page}
      data-testid="project-detail-page"
      data-active-run={activeRun !== null ? 'true' : 'false'}
    >
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
              variant="ghost"
              size="sm"
              leadingIcon={
                <span className={pages.refreshing ? styles.refreshSpinning : undefined}>
                  <IconRefresh size={14} />
                </span>
              }
              onClick={() => {
                void pages.refresh();
              }}
              disabled={pages.refreshing}
              data-testid="refresh-button"
            >
              Refresh
            </Button>
          </div>
        </div>
      </header>

      {pages.error && (
        <div
          className={styles.banner}
          role="alert"
          data-testid="tickets-error-banner"
        >
          <span>
            <strong>Couldn’t refresh tickets.</strong> {pages.error}
          </span>
          <Button
            variant="ghost"
            size="sm"
            leadingIcon={<IconClose size={12} />}
            onClick={() => {
              void pages.refresh();
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
          role="alert"
          data-testid="run-error-banner"
        >
          <span>
            <strong>Couldn’t start run.</strong> {runBanner.message}
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

      {(() => {
        const target = runHistory.runs.find((r) => r.id === confirmRunId);
        const open = confirmRunId !== null && target !== undefined;
        const isDeleting = deletingRunId !== null;
        return (
          <Dialog
            open={open}
            onClose={() => {
              if (isDeleting) return; // don't dismiss mid-flight
              setConfirmRunId(null);
              setDeleteError(null);
            }}
            title="Delete run?"
            subtitle={
              target !== undefined
                ? `Run for ${target.ticketKey} on branch ${target.branchName}`
                : undefined
            }
            data-testid="run-delete-dialog"
          >
            <div className={styles.deleteDialogBody}>
              <p>
                This permanently deletes the run’s metadata and the streamed log.
                The PR (if any) is left alone.
              </p>
              {deleteError !== null && (
                <div
                  className={styles.deleteDialogError}
                  role="alert"
                  data-testid="run-delete-error"
                >
                  {deleteError}
                </div>
              )}
              <div className={styles.deleteDialogActions}>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setConfirmRunId(null);
                    setDeleteError(null);
                  }}
                  disabled={isDeleting}
                  data-testid="run-delete-cancel"
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  leadingIcon={<IconTrash size={12} />}
                  onClick={() => {
                    void handleConfirmDeleteRun();
                  }}
                  disabled={isDeleting}
                  data-testid="run-delete-confirm"
                >
                  {isDeleting ? 'Deleting…' : 'Delete run'}
                </Button>
              </div>
            </div>
          </Dialog>
        );
      })()}

      {activeRun && (
        <ActiveExecutionPanel
          run={activeRun}
          onOpenExecution={onOpenExecution}
          onCancel={handleCancelActive}
        />
      )}
    </div>
  );
}
