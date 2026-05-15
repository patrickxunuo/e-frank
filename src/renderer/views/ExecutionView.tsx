/**
 * `<ExecutionView>` — full-screen route for the live AI Execution Log AND
 * past-run detail view (#GH-66).
 *
 * Resolves the run snapshot in this order:
 *   1. `runs.current()` — the active run, if its id matches `runId`
 *   2. `runs.get({ runId })` — persisted sidecar from RunStore, for runs
 *      that have completed (or are running but owned by a different
 *      active slot — the renderer's `useRunLog` will load entries from
 *      disk via `readLog`)
 *   3. otherwise `not-found` (sidecar missing — likely deleted)
 *
 * Live runs subscribe to `runs.onCurrentChanged` so the page stays in
 * lockstep with the runner. Terminal runs read once.
 *
 * For runs whose persisted status is `running` / `pending` but the active
 * runner doesn't claim them, we render an `Interrupted` badge — a desktop
 * crash mid-run can leave a "running" sidecar that the runner never
 * cleared. The on-disk record is authoritative for status; if the runner
 * disagrees we trust the runner's silence as "no live process".
 *
 * The right pane hosts the `<ApprovalPanel>` (#9) when
 * `Run.pendingApproval` is populated; otherwise the body collapses to a
 * single column and the log reclaims full width.
 */

import { useCallback, useEffect, useState } from 'react';
import type {
  ProjectInstanceDto,
  Run,
  RunStateEvent,
  RunStatus,
} from '@shared/ipc';
import { ApprovalPanel } from '../components/ApprovalPanel';
import { Badge, type BadgeVariant } from '../components/Badge';
import { Button } from '../components/Button';
import { ExecutionLog } from '../components/ExecutionLog';
import { RunStatusFigure } from '../components/RunStatusFigure';
import { Toggle } from '../components/Toggle';
import {
  IconArrowLeft,
  IconClose,
} from '../components/icons';
import { useRunLog } from '../state/run-log';
import styles from './ExecutionView.module.css';

export interface ExecutionViewProps {
  runId: string;
  projectId: string;
  /**
   * Default back-handler — used for live runs (lands on the Tickets tab
   * by convention, mirroring where the user typically came from).
   */
  onBack: () => void;
  /**
   * Optional back-handler used when the resolved run is a past run
   * (#GH-66). Lets the parent land the user on the Runs tab they clicked
   * from instead of defaulting to Tickets. Falls back to `onBack` when
   * unset.
   */
  onBackToRuns?: () => void;
}

type RunResolution =
  | { kind: 'loading' }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string }
  /**
   * `isLive` is true only when this run is the runner's currently-active run.
   * Past-run lookups via `runs.get` set it to false even if `status` is still
   * `running` on disk — that means the runner doesn't know about it (crashed
   * or otherwise orphaned), so we render an `Interrupted` badge.
   */
  | { kind: 'ready'; run: Run; isLive: boolean };

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'done',
  'failed',
  'cancelled',
]);

function isTerminal(run: Run): boolean {
  return TERMINAL_STATUSES.has(run.status);
}

function statusBadge(run: Run, isLive: boolean): JSX.Element {
  let variant: BadgeVariant = 'neutral';
  let label: string = run.state;
  let pulse: 'active' | 'waiting' | false = false;
  switch (run.status) {
    case 'pending':
    case 'running':
      // The on-disk snapshot says this is in flight, but if the runner
      // doesn't claim it the most-likely cause is a crash mid-run that
      // left the sidecar stamped `running`. Surface that as Interrupted
      // so the user doesn't think a long-completed run is still ticking.
      if (!isLive) {
        variant = 'warning';
        label = 'Interrupted';
        break;
      }
      variant = 'running';
      // Differentiate the two "alive" states: actively pushing forward vs
      // paused on a checkpoint. Different cadence reads at a glance.
      if (run.state === 'awaitingApproval') {
        label = 'Awaiting';
        pulse = 'waiting';
      } else {
        label = 'Running';
        pulse = 'active';
      }
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
    <Badge variant={variant} pulse={pulse} data-testid="execution-status-badge">
      {label}
    </Badge>
  );
}

function formatDuration(startedAt: number, finishedAt: number | undefined): string | null {
  if (
    finishedAt === undefined ||
    !Number.isFinite(finishedAt) ||
    !Number.isFinite(startedAt) ||
    finishedAt <= startedAt
  ) {
    return null;
  }
  const ms = finishedAt - startedAt;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSec = seconds % 60;
  if (minutes < 60) return remSec === 0 ? `${minutes}m` : `${minutes}m ${remSec}s`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin === 0 ? `${hours}h` : `${hours}h ${remMin}m`;
}

export function ExecutionView({
  runId,
  projectId,
  onBack,
  onBackToRuns,
}: ExecutionViewProps): JSX.Element {
  const [resolution, setResolution] = useState<RunResolution>({ kind: 'loading' });
  const [project, setProject] = useState<ProjectInstanceDto | null>(null);
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  // Route the Back button: past-run lookups land on Runs tab when the
  // parent provided that handler; everything else (live runs, loading,
  // not-found, error) routes to the default onBack.
  const handleBack = useCallback((): void => {
    if (
      resolution.kind === 'ready' &&
      !resolution.isLive &&
      onBackToRuns !== undefined
    ) {
      onBackToRuns();
      return;
    }
    onBack();
  }, [onBack, onBackToRuns, resolution]);

  const run = resolution.kind === 'ready' ? resolution.run : null;
  const log = useRunLog(run);
  const expandIndex =
    log.currentUserVisibleIndex >= 0 ? log.currentUserVisibleIndex : log.steps.length - 1;

  // Resolve the run + project on mount (and whenever the runId changes).
  useEffect(() => {
    let cancelled = false;
    setResolution({ kind: 'loading' });

    if (typeof window === 'undefined' || !window.api) {
      setResolution({ kind: 'error', message: 'IPC bridge unavailable' });
      return () => {
        cancelled = true;
      };
    }

    const api = window.api;

    void (async () => {
      try {
        const cur = await api.runs.current();
        if (cancelled) return;
        if (cur.ok && cur.data.run !== null && cur.data.run.id === runId) {
          setResolution({ kind: 'ready', run: cur.data.run, isLive: true });
          return;
        }
        // Not the active run — load the persisted sidecar from RunStore.
        // The log entries (if any) come from useRunLog's terminal path.
        const get = await api.runs.get({ runId });
        if (cancelled) return;
        if (get.ok) {
          setResolution({ kind: 'ready', run: get.data.run, isLive: false });
          return;
        }
        if (get.error.code === 'NOT_FOUND') {
          setResolution({ kind: 'not-found' });
          return;
        }
        setResolution({ kind: 'error', message: get.error.message });
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setResolution({ kind: 'error', message });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [runId]);

  // Subscribe to current-changed for live runs only. Past-run lookups
  // (`isLive: false`) are static — the runner won't emit transitions for
  // them, and any future runner-restart that re-attaches will be picked
  // up on the next page mount.
  useEffect(() => {
    if (resolution.kind !== 'ready') return;
    if (!resolution.isLive) return;
    if (typeof window === 'undefined' || !window.api) return;
    const api = window.api;
    if (isTerminal(resolution.run)) return;

    const offCurrent = api.runs.onCurrentChanged((event) => {
      if (event.run !== null && event.run.id === runId) {
        setResolution({ kind: 'ready', run: event.run, isLive: true });
      }
    });
    const offState = api.runs.onStateChanged((event: RunStateEvent) => {
      if (event.runId === runId) {
        setResolution({ kind: 'ready', run: event.run, isLive: true });
      }
    });
    return () => {
      offCurrent();
      offState();
    };
  }, [resolution, runId]);

  // Resolve the project for the header label.
  useEffect(() => {
    let cancelled = false;
    if (typeof window === 'undefined' || !window.api) return;
    const api = window.api;
    void (async () => {
      try {
        const result = await api.projects.get({ id: projectId });
        if (cancelled) return;
        if (result.ok) {
          setProject(result.data);
        }
      } catch {
        // Header just shows the projectId fallback if the lookup fails.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const handleCancel = useCallback((): void => {
    if (typeof window === 'undefined' || !window.api) return;
    if (run === null) return;
    void window.api.runs.cancel({ runId: run.id });
  }, [run]);

  // ---------- Render branches ----------

  if (resolution.kind === 'loading') {
    return (
      <div className={styles.page} data-testid="execution-view-loading">
        <header className={styles.header}>
          <div className={styles.crumbs}>
            <button
              type="button"
              className={styles.back}
              onClick={handleBack}
              data-testid="execution-back"
            >
              <IconArrowLeft size={12} />
              Back
            </button>
          </div>
        </header>
        <div className={styles.errorPanel}>
          <div className={styles.errorCard} role="status">
            Loading run…
          </div>
        </div>
      </div>
    );
  }

  if (resolution.kind === 'not-found' || resolution.kind === 'error') {
    const isNotFound = resolution.kind === 'not-found';
    return (
      <div
        className={styles.page}
        data-testid={isNotFound ? 'execution-not-found' : 'execution-error'}
      >
        <header className={styles.header}>
          <div className={styles.crumbs}>
            <button
              type="button"
              className={styles.back}
              onClick={handleBack}
              data-testid="execution-back"
            >
              <IconArrowLeft size={12} />
              Back
            </button>
          </div>
        </header>
        <div className={styles.errorPanel}>
          <div className={styles.errorCard} role="alert">
            <span className={styles.errorTitle}>
              {isNotFound ? 'Run not found' : 'Couldn’t load run'}
            </span>
            <span className={styles.errorBody}>
              {isNotFound
                ? 'This run no longer exists — its history record may have been deleted.'
                : resolution.kind === 'error'
                  ? resolution.message
                  : ''}
            </span>
            <Button variant="ghost" size="sm" onClick={handleBack}>
              Back to project
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // ---------- Ready ----------

  const ready = resolution.run;
  const isLive = resolution.isLive;
  const showApproval = isLive && ready.pendingApproval !== null;
  const terminal = isTerminal(ready);
  // Hide the Cancel button for past-run lookups even if the on-disk snapshot
  // is mid-pipeline — `runs.cancel` would 404 because the runner doesn't
  // know about this run. `terminal` already covers done/failed/cancelled;
  // `!isLive` extends the hide to Interrupted (stale running) runs.
  const hideCancel = terminal || !isLive;
  const duration = formatDuration(ready.startedAt, ready.finishedAt);
  const showMetaRow = !isLive || terminal;

  const counterText =
    log.totalUserVisibleSteps === 0
      ? 'Step 0 of 0'
      : (() => {
          // Map the index in `steps` back to user-visible position.
          const userVisible = log.steps
            .map((s, i) => ({ s, i }))
            .filter((x) => x.s.label !== null);
          const slot = userVisible.findIndex(
            (x) => x.i === log.currentUserVisibleIndex,
          );
          const oneBased = slot >= 0 ? slot + 1 : log.totalUserVisibleSteps;
          return `Step ${oneBased} of ${log.totalUserVisibleSteps}`;
        })();

  return (
    <div className={styles.page} data-testid="execution-view-page">
      <header className={styles.header}>
        <div className={styles.crumbs}>
          <button
            type="button"
            className={styles.back}
            onClick={handleBack}
            data-testid="execution-back"
          >
            <IconArrowLeft size={12} />
            Back
          </button>
          <span aria-hidden="true" style={{ opacity: 0.5 }}>
            /
          </span>
          <span>{project?.name ?? projectId}</span>
        </div>
        <div className={styles.headRow}>
          <div className={styles.titleSection}>
            <RunStatusFigure
              status={ready.status}
              state={ready.state}
              size={60}
            />
            <div className={styles.titleBlock}>
              <div className={styles.titleRow}>
                {/*
                 * Title is "{ticketKey} — {ticketSummary}" when the summary
                 * is available; bare ticketKey otherwise. Matches
                 * design/flow_detail.png. The ticketSummary lands on the Run
                 * snapshot at workflow-runner start (from the poller's
                 * cached list); legacy runs without it just show the key.
                 */}
                <h1 className={styles.title} data-testid="execution-title">
                  {ready.ticketSummary !== undefined
                    ? `${ready.ticketKey} — ${ready.ticketSummary}`
                    : ready.ticketKey}
                </h1>
                {statusBadge(ready, isLive)}
              </div>
              <span className={styles.subtitle}>
                {project?.name ?? projectId} · Run {ready.id.slice(0, 8)}
              </span>
              {showMetaRow && (
                <div className={styles.metaRow} data-testid="execution-meta">
                  {ready.branchName !== '' && (
                    <span className={styles.metaItem} data-testid="execution-meta-branch">
                      <span className={styles.metaLabel}>Branch</span>
                      <span className={styles.metaValue}>{ready.branchName}</span>
                    </span>
                  )}
                  {duration !== null && (
                    <span className={styles.metaItem} data-testid="execution-meta-duration">
                      <span className={styles.metaLabel}>Duration</span>
                      <span className={styles.metaValue}>{duration}</span>
                    </span>
                  )}
                  {ready.prUrl !== undefined && (() => {
                    const prUrl = ready.prUrl;
                    return (
                      <span className={styles.metaItem} data-testid="execution-meta-pr">
                        <span className={styles.metaLabel}>PR</span>
                        <button
                          type="button"
                          className={styles.metaLink}
                          onClick={(): void => {
                            if (typeof window !== 'undefined' && window.api) {
                              void window.api.shell.openExternal({ url: prUrl });
                            }
                          }}
                          data-testid="execution-meta-pr-link"
                        >
                          Open PR
                        </button>
                      </span>
                    );
                  })()}
                </div>
              )}
            </div>
          </div>
          <div className={styles.headActions}>
            <span className={styles.progress} data-testid="execution-progress">
              {counterText}
            </span>
            <span className={styles.divider} aria-hidden="true" />
            <Toggle
              checked={autoScroll}
              onChange={setAutoScroll}
              label="Auto-scroll"
              data-testid="log-autoscroll-toggle"
            />
            {!hideCancel && (
              <Button
                variant="destructive"
                size="sm"
                leadingIcon={<IconClose size={12} />}
                onClick={handleCancel}
                data-testid="log-cancel-button"
              >
                Cancel
              </Button>
            )}
          </div>
        </div>
      </header>

      <div
        className={styles.body}
        data-has-panel={showApproval ? 'true' : 'false'}
      >
        <div className={styles.leftPane}>
          <h2 className={styles.logSectionTitle}>AI Execution Log</h2>
          <ExecutionLog
            steps={log.steps}
            autoScroll={autoScroll}
            expandIndex={expandIndex}
            data-testid="execution-log"
          />
        </div>
        {showApproval && (
          <aside className={styles.rightPane} aria-label="Approval panel">
            <ApprovalPanel
              runId={ready.id}
              approval={ready.pendingApproval!}
              disabled={isTerminal(ready) || !isLive}
            />
          </aside>
        )}
      </div>
    </div>
  );
}
