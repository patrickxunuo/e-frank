import { useEffect, useMemo, useState } from 'react';
import type { ProjectInstanceDto, TicketDto } from '@shared/ipc';
import { Badge, type BadgeVariant } from '../components/Badge';
import { Button } from '../components/Button';
import { Checkbox } from '../components/Checkbox';
import { DataTable, type DataTableColumn } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
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
  onOpenExecution: (ticketKey: string) => void;
  onRun: (ticketKey: string) => void;
  onRunSelected: (ticketKeys: string[]) => void;
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

function extractTicketKey(query: string): string {
  const trimmed = query.trim();
  const projectMatch = trimmed.match(/project\s*=\s*"?([A-Z0-9_-]+)"?/i);
  if (projectMatch?.[1]) return projectMatch[1].toUpperCase();
  return 'Jira';
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
  onRun,
  onRunSelected,
}: ProjectDetailProps): JSX.Element {
  const [state, setState] = useState<ProjectState>({ kind: 'loading' });
  const [tab, setTab] = useState<TabId>('tickets');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const tickets = useTickets(projectId);
  const activeRun = useActiveRun(projectId);
  const [autoMode, setAutoMode] = useAutoMode(projectId);

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
            onRun(row.key);
          }}
          data-testid={`ticket-run-button-${row.key}`}
        >
          Run
        </Button>
      ),
    },
  ];

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
    return (
      <DataTable
        columns={ticketColumns}
        rows={tickets.tickets}
        rowKey={(row) => row.key}
        rowTestId={(row) => `ticket-row-${row.key}`}
        data-testid="tickets-table"
      />
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
                  {extractTicketKey(project.tickets.query)}
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
              onClick={() => onRunSelected(orderedSelectedKeys)}
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
          {tab === 'runs' && (
            <EmptyState
              icon={<IconRuns size={26} />}
              title="Run history is on the way"
              description="The full timeline of agent runs — with logs, durations, and outcomes — will land alongside the workflow runner."
              data-testid="tab-empty-runs"
            />
          )}
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

      {activeRun && (
        <aside className={styles.activePanel} data-testid="active-execution-panel">
          <div className={styles.activeCard}>
            <div className={styles.activeLeft}>
              <div className={styles.activeHead}>
                <div className={styles.activeBadgeRow}>
                  <span className={styles.activeKey} data-testid="active-execution-key">
                    {activeRun.ticketKey}
                  </span>
                  <Badge variant="running" pulse>
                    Running
                  </Badge>
                </div>
                <div className={styles.activeActions}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onOpenExecution(activeRun.ticketKey)}
                    data-testid="active-execution-open-details"
                  >
                    Open Details
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    leadingIcon={<IconClose size={12} />}
                    data-testid="active-execution-cancel"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
              <span className={styles.activeTitle}>{activeRun.ticketTitle}</span>
              <ProgressBar
                value={activeRun.progress}
                label={activeRun.currentStep}
                hint={`Step ${activeRun.stepIndex + 1} of ${activeRun.totalSteps}`}
                data-testid="active-execution-progress"
              />
            </div>
            <div className={styles.activeRight}>
              <LogPreview
                lines={activeRun.recentLines}
                maxHeight={140}
                data-testid="active-execution-log"
              />
            </div>
          </div>
        </aside>
      )}
    </div>
  );
}
