/**
 * `<ExecutionView>` — full-screen route for the live AI Execution Log.
 *
 * Resolves the run snapshot in this order:
 *   1. `runs.current()` — the active run
 *   2. otherwise treat as a terminal run (the hook will load via readLog)
 *
 * Live runs subscribe to `runs.onCurrentChanged` so the page stays in
 * lockstep with the runner. Terminal runs are read once via the hook.
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
import { PromptInput } from '../components/PromptInput';
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
  onBack: () => void;
}

type RunResolution =
  | { kind: 'loading' }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; run: Run };

const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'done',
  'failed',
  'cancelled',
]);

function isTerminal(run: Run): boolean {
  return TERMINAL_STATUSES.has(run.status);
}

function statusBadge(run: Run): JSX.Element {
  let variant: BadgeVariant = 'neutral';
  let label: string = run.state;
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
    <Badge
      variant={variant}
      pulse={run.status === 'running'}
      data-testid="execution-status-badge"
    >
      {label}
    </Badge>
  );
}

export function ExecutionView({
  runId,
  projectId,
  onBack,
}: ExecutionViewProps): JSX.Element {
  const [resolution, setResolution] = useState<RunResolution>({ kind: 'loading' });
  const [project, setProject] = useState<ProjectInstanceDto | null>(null);
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [claudeRunId, setClaudeRunId] = useState<string | null>(null);

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
          setResolution({ kind: 'ready', run: cur.data.run });
        } else {
          // Not the active run — for #8, treat the runId as a completed
          // run. The Runs tab (future issue) will provide a proper
          // history loader; here we synthesize a thin terminal-shaped Run
          // from readLog if any entries exist, else show a not-found.
          // We don't have a runs.get() yet, so fall back to a minimal
          // shell + the log hook handles loading entries.
          //
          // If `runs.current()` returns a different runId, we can still
          // render — the ExecutionLog hook will pull entries from the
          // log file. We DON'T have the runner snapshot, so steps will
          // be derived from the log alone.
          setResolution({ kind: 'not-found' });
        }
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

  // Subscribe to current-changed for live runs.
  useEffect(() => {
    if (resolution.kind !== 'ready') return;
    if (typeof window === 'undefined' || !window.api) return;
    const api = window.api;
    if (isTerminal(resolution.run)) return;

    const offCurrent = api.runs.onCurrentChanged((event) => {
      if (event.run !== null && event.run.id === runId) {
        setResolution({ kind: 'ready', run: event.run });
      }
    });
    const offState = api.runs.onStateChanged((event: RunStateEvent) => {
      if (event.runId === runId) {
        setResolution({ kind: 'ready', run: event.run });
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

  // Track the claude runId so PromptInput knows where to write. Refreshes
  // on a debounce schedule via the active-run subscription, but we also
  // re-resolve when the user submits — claude runs can swap between
  // interactive turns.
  useEffect(() => {
    let cancelled = false;
    if (typeof window === 'undefined' || !window.api) return;
    const api = window.api;
    void (async () => {
      try {
        const result = await api.claude.status();
        if (cancelled) return;
        if (result.ok) {
          setClaudeRunId(result.data.active?.runId ?? null);
        }
      } catch {
        if (cancelled) return;
      }
    })();
    // Listen for exit events so we drop the claude runId promptly.
    const offExit = api.claude.onExit((event) => {
      if (cancelled) return;
      setClaudeRunId((prev) => (prev === event.runId ? null : prev));
    });
    return () => {
      cancelled = true;
      offExit();
    };
  }, [run?.id]);

  const handleCancel = useCallback((): void => {
    if (typeof window === 'undefined' || !window.api) return;
    if (run === null) return;
    void window.api.runs.cancel({ runId: run.id });
  }, [run]);

  const handleSubmit = useCallback(
    async (text: string): Promise<boolean> => {
      if (typeof window === 'undefined' || !window.api) return false;
      const api = window.api;
      // Always re-resolve the claude runId at submit time (per spec) so
      // we don't write to a process that already exited.
      let activeRunId = claudeRunId;
      try {
        const status = await api.claude.status();
        if (status.ok) {
          activeRunId = status.data.active?.runId ?? null;
          setClaudeRunId(activeRunId);
        }
      } catch {
        // Fall through to whatever we already had.
      }
      if (activeRunId === null) return false;
      try {
        const result = await api.claude.write({ runId: activeRunId, text });
        return result.ok;
      } catch {
        return false;
      }
    },
    [claudeRunId],
  );

  // ---------- Render branches ----------

  if (resolution.kind === 'loading') {
    return (
      <div className={styles.page} data-testid="execution-view-loading">
        <header className={styles.header}>
          <div className={styles.crumbs}>
            <button
              type="button"
              className={styles.back}
              onClick={onBack}
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
              onClick={onBack}
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
                ? 'This run is no longer the active run, and full history navigation lands when the Runs tab ships. Head back to the project for now.'
                : resolution.kind === 'error'
                  ? resolution.message
                  : ''}
            </span>
            <Button variant="ghost" size="sm" onClick={onBack}>
              Back to project
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // ---------- Ready ----------

  const ready = resolution.run;
  const showApproval = ready.pendingApproval !== null;
  const terminal = isTerminal(ready);
  const promptDisabled = terminal || claudeRunId === null;

  // When the run reaches terminal, an in-flight pause would otherwise leave
  // the Pause button stuck on "Resume" + disabled — a dead control. Reset
  // local pause state to false so the label flips back to "Pause" and the
  // (also disabled) button reads sensibly.
  if (terminal && log.paused) {
    log.setPaused(false);
  }

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
            onClick={onBack}
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
          <div className={styles.titleBlock}>
            <div className={styles.titleRow}>
              <h1 className={styles.title} data-testid="execution-title">
                {project?.name ?? 'Run'}
              </h1>
              <span className={styles.ticketKey} data-testid="execution-ticket-key">
                {ready.ticketKey}
              </span>
              {statusBadge(ready)}
            </div>
            <span className={styles.subtitle}>Run · {ready.id.slice(0, 8)}</span>
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
            <Button
              variant="ghost"
              size="sm"
              onClick={() => log.setPaused(!log.paused)}
              data-testid="log-pause-button"
              disabled={terminal}
            >
              {log.paused
                ? `Resume${log.bufferedLineCount > 0 ? ` (${log.bufferedLineCount})` : ''}`
                : 'Pause'}
            </Button>
            {!terminal && (
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
              disabled={isTerminal(ready)}
            />
          </aside>
        )}
      </div>

      <div
        className={`${styles.footer} ${promptDisabled ? styles.footerDisabled : ''}`}
      >
        <PromptInput
          onSubmit={handleSubmit}
          disabled={promptDisabled}
          placeholder={
            terminal
              ? 'Run finished — input disabled.'
              : claudeRunId === null
                ? 'No active claude process — input disabled.'
                : 'Send a message to Claude…'
          }
        />
      </div>
    </div>
  );
}
