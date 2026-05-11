/**
 * `useNotificationDispatchers` — wires runner-level events into the toast
 * store (#GH-59).
 *
 * Mounted once at the app shell. Subscribes to `runs.onCurrentChanged`,
 * tracks per-runId transitions via refs, and dispatches:
 *
 *   - terminal-state toasts (success/error/warning) once per run on entry
 *     into `done` / `failed` / `cancelled`
 *   - approval toasts when a run's `pendingApproval` flips null → set AND
 *     the user is NOT looking at that run's ExecutionView (the panel is
 *     already there; a redundant toast is noise)
 *   - dismisses the matching approval toast when `pendingApproval` flips
 *     back to null (approved/rejected elsewhere) OR when the user navigates
 *     to the matching ExecutionView (the panel takes over)
 *
 * No new IPC channels — `runs.onCurrentChanged` already covers everything.
 */
import { useEffect, useRef } from 'react';
import type { ApprovalRequest, Run, RunState } from '@shared/ipc';
import { dispatchToast, dismissToastByKey, type ToastAction } from './notifications';

const TERMINAL_STATES = new Set<RunState>(['done', 'failed', 'cancelled']);
const RUN_DONE_TTL_MS = 8_000;
const RUN_CANCELLED_TTL_MS = 5_000;
const APPROVAL_BODY_MAX_CHARS = 220;

function approvalDedupeKey(runId: string): string {
  return `approval-${runId}`;
}

function runDoneDedupeKey(runId: string): string {
  return `run-finish-${runId}`;
}

export interface DispatchersConfig {
  /**
   * Run id of the currently-open ExecutionView, or null if the user is
   * on any other route. Approval toasts for this runId are suppressed.
   */
  currentExecutionRunId: string | null;
  /** Navigate to a given run's ExecutionView. Used by toast actions. */
  onNavigateToExecution?: (runId: string, projectId: string) => void;
}

function buildRunDoneActions(
  run: Run,
  onNavigate: DispatchersConfig['onNavigateToExecution'],
): ToastAction[] {
  const actions: ToastAction[] = [];
  if (run.prUrl) {
    const prUrl = run.prUrl;
    actions.push({
      label: 'Open PR',
      variant: 'primary',
      onClick: (): void => {
        // `window.open(url, '_blank')` is intercepted by the main process's
        // `setWindowOpenHandler` and routed through `shell.openExternal`,
        // so this opens in the user's default browser rather than a new
        // BrowserWindow. Same pattern as the run-history "View" anchor.
        if (typeof window !== 'undefined') {
          window.open(prUrl, '_blank', 'noreferrer');
        }
      },
    });
  }
  if (onNavigate) {
    actions.push({
      label: 'View run',
      onClick: (): void => onNavigate(run.id, run.projectId),
    });
  }
  return actions;
}

function buildTerminalNonDoneActions(
  run: Run,
  onNavigate: DispatchersConfig['onNavigateToExecution'],
): ToastAction[] | undefined {
  if (!onNavigate) return undefined;
  return [
    {
      label: 'View run',
      onClick: (): void => onNavigate(run.id, run.projectId),
    },
  ];
}

function buildApprovalActions(
  run: Run,
  onNavigate: DispatchersConfig['onNavigateToExecution'],
): ToastAction[] {
  const actions: ToastAction[] = [];
  const api = typeof window !== 'undefined' ? window.api : undefined;
  if (api) {
    actions.push({
      label: 'Approve',
      variant: 'primary',
      onClick: (): void => {
        void api.runs.approve({ runId: run.id });
      },
    });
    actions.push({
      label: 'Reject',
      variant: 'danger',
      onClick: (): void => {
        void api.runs.reject({ runId: run.id });
      },
    });
  }
  if (onNavigate) {
    actions.push({
      label: 'View details',
      onClick: (): void => onNavigate(run.id, run.projectId),
    });
  }
  return actions;
}

function summarizeApprovalBody(approval: ApprovalRequest): string | undefined {
  const plan = approval.plan?.trim();
  if (!plan) return undefined;
  if (plan.length <= APPROVAL_BODY_MAX_CHARS) return plan;
  return `${plan.slice(0, APPROVAL_BODY_MAX_CHARS - 1)}…`;
}

function approvalIdentity(approval: ApprovalRequest | null): string | null {
  if (!approval) return null;
  // Stable identity from the raw payload; if it can't be serialised
  // (cyclic, unlikely for marker JSON) fall back to a static key so we
  // still fire exactly once per approval.
  try {
    return JSON.stringify(approval.raw ?? approval);
  } catch {
    return 'approval';
  }
}

interface RunSnapshotMemo {
  state: RunState;
  approvalKey: string | null;
  terminalFired: boolean;
}

export function useNotificationDispatchers(config: DispatchersConfig): void {
  const { currentExecutionRunId, onNavigateToExecution } = config;

  // Keep the latest config in refs so the long-lived subscription doesn't
  // tear down on each route change.
  const currentRunIdRef = useRef<string | null>(currentExecutionRunId);
  const navigateRef = useRef<DispatchersConfig['onNavigateToExecution']>(onNavigateToExecution);
  useEffect(() => {
    currentRunIdRef.current = currentExecutionRunId;
  }, [currentExecutionRunId]);
  useEffect(() => {
    navigateRef.current = onNavigateToExecution;
  }, [onNavigateToExecution]);

  // When the user navigates INTO an ExecutionView, drop any approval toast
  // for that run — the ApprovalPanel is now visible, the toast is noise.
  useEffect(() => {
    if (currentExecutionRunId !== null) {
      dismissToastByKey(approvalDedupeKey(currentExecutionRunId));
    }
  }, [currentExecutionRunId]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.api) return undefined;
    const api = window.api;

    const memo = new Map<string, RunSnapshotMemo>();

    const off = api.runs.onCurrentChanged((event) => {
      const run = event.run;
      if (run === null) return;

      const prev = memo.get(run.id) ?? {
        state: 'idle' as RunState,
        approvalKey: null,
        terminalFired: false,
      };
      let terminalFired = prev.terminalFired;

      // -- Run-finish trigger ------------------------------------------------
      if (!terminalFired && TERMINAL_STATES.has(run.state)) {
        if (run.state === 'done') {
          dispatchToast({
            type: 'success',
            title: `${run.ticketKey} — done`,
            body: run.branchName ? `Branch ${run.branchName} is ready.` : undefined,
            actions: buildRunDoneActions(run, navigateRef.current),
            ttlMs: RUN_DONE_TTL_MS,
            dedupeKey: runDoneDedupeKey(run.id),
          });
        } else if (run.state === 'failed') {
          dispatchToast({
            type: 'error',
            title: `${run.ticketKey} — failed`,
            body: run.error ?? undefined,
            actions: buildTerminalNonDoneActions(run, navigateRef.current),
            // No ttl — persists until user dismisses.
            dedupeKey: runDoneDedupeKey(run.id),
          });
        } else if (run.state === 'cancelled') {
          dispatchToast({
            type: 'warning',
            title: `${run.ticketKey} — cancelled`,
            actions: buildTerminalNonDoneActions(run, navigateRef.current),
            ttlMs: RUN_CANCELLED_TTL_MS,
            dedupeKey: runDoneDedupeKey(run.id),
          });
        }
        terminalFired = true;
      }

      // -- Approval trigger --------------------------------------------------
      const nextApprovalKey = approvalIdentity(run.pendingApproval);
      if (nextApprovalKey !== prev.approvalKey) {
        if (nextApprovalKey === null) {
          // set → null: approval was acted on (here or elsewhere). Drop
          // any matching toast.
          dismissToastByKey(approvalDedupeKey(run.id));
        } else if (currentRunIdRef.current !== run.id) {
          // null → set (or replaced), and user is NOT on the matching
          // ExecutionView. Fire/refresh the approval toast.
          const approval = run.pendingApproval as ApprovalRequest;
          dispatchToast({
            type: 'approval',
            title: `${run.ticketKey} — awaiting approval`,
            body: summarizeApprovalBody(approval),
            actions: buildApprovalActions(run, navigateRef.current),
            dedupeKey: approvalDedupeKey(run.id),
          });
        }
      }

      memo.set(run.id, {
        state: run.state,
        approvalKey: nextApprovalKey,
        terminalFired,
      });
    });

    return () => off();
  }, []);
}
