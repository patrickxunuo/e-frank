/**
 * `<ApprovalPanel>` — right-pane UI for the approval flow.
 *
 * Renders the implementation plan, files-to-modify list, code-diff preview,
 * and an action bar with Approve / Edit / Reject buttons. Modify reveals an
 * inline `<PromptInput>` pre-filled with the plan; submitting it calls
 * `runs.modify`.
 *
 * The component is purely presentational w.r.t. IPC — `onApprove`,
 * `onReject`, and `onModify` are injected so tests can stub them. By
 * default they call `window.api.runs.{approve,reject,modify}` and resolve
 * to the IPC `result.ok` boolean.
 */

import { useCallback, useState } from 'react';
import type { ApprovalRequest } from '@shared/ipc';
import { Button } from './Button';
import { CodeDiff } from './CodeDiff';
import { PromptInput } from './PromptInput';
import styles from './ApprovalPanel.module.css';

export interface ApprovalPanelProps {
  runId: string;
  /** From `Run.pendingApproval` — guaranteed non-null by the parent. */
  approval: ApprovalRequest;
  /**
   * When true, all action buttons are disabled (e.g. parent has detected
   * the run transitioned out of awaitingApproval mid-render).
   */
  disabled?: boolean;
  /** Resolves true on success. Default: window.api.runs.approve. */
  onApprove?: (runId: string) => Promise<boolean>;
  onReject?: (runId: string) => Promise<boolean>;
  onModify?: (runId: string, text: string) => Promise<boolean>;
}

type PendingAction = 'approve' | 'reject' | 'modify' | null;

async function defaultApprove(runId: string): Promise<boolean> {
  if (typeof window === 'undefined' || !window.api) return false;
  try {
    const result = await window.api.runs.approve({ runId });
    return result.ok;
  } catch {
    return false;
  }
}

async function defaultReject(runId: string): Promise<boolean> {
  if (typeof window === 'undefined' || !window.api) return false;
  try {
    const result = await window.api.runs.reject({ runId });
    return result.ok;
  } catch {
    return false;
  }
}

async function defaultModify(runId: string, text: string): Promise<boolean> {
  if (typeof window === 'undefined' || !window.api) return false;
  try {
    const result = await window.api.runs.modify({ runId, text });
    return result.ok;
  } catch {
    return false;
  }
}

function fileBadgeLabel(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.tsx') || lower.endsWith('.ts')) return 'TS';
  if (lower.endsWith('.jsx') || lower.endsWith('.js')) return 'JS';
  if (lower.endsWith('.py')) return 'PY';
  if (lower.endsWith('.go')) return 'GO';
  return 'F';
}

export function ApprovalPanel({
  runId,
  approval,
  disabled = false,
  onApprove = defaultApprove,
  onReject = defaultReject,
  onModify = defaultModify,
}: ApprovalPanelProps): JSX.Element {
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [composerOpen, setComposerOpen] = useState<boolean>(false);

  const actionsLocked = disabled || pendingAction !== null;
  const plan = approval.plan ?? '';
  const hasPlan = plan.length > 0;
  const files = approval.filesToModify ?? [];
  const hasFiles = files.length > 0;
  const diff = approval.diff ?? '';
  const hasDiff = diff.length > 0;

  const handleApprove = useCallback(async (): Promise<void> => {
    if (actionsLocked) return;
    setPendingAction('approve');
    try {
      await onApprove(runId);
    } finally {
      setPendingAction(null);
    }
  }, [actionsLocked, onApprove, runId]);

  const handleReject = useCallback(async (): Promise<void> => {
    if (actionsLocked) return;
    setPendingAction('reject');
    try {
      await onReject(runId);
    } finally {
      setPendingAction(null);
    }
  }, [actionsLocked, onReject, runId]);

  const handleToggleModify = useCallback((): void => {
    if (actionsLocked) return;
    setComposerOpen((prev) => !prev);
  }, [actionsLocked]);

  const handleModifySubmit = useCallback(
    async (text: string): Promise<boolean> => {
      setPendingAction('modify');
      try {
        return await onModify(runId, text);
      } finally {
        setPendingAction(null);
      }
    },
    [onModify, runId],
  );

  return (
    <section className={styles.panel} data-testid="approval-panel-root">
      <div className={styles.header}>
        <h2 className={styles.title}>Approval Required</h2>
        <p className={styles.subhead}>Review and approve the proposed changes.</p>
      </div>

      {hasPlan && (
        <div className={styles.section} data-testid="approval-plan">
          <h3 className={styles.sectionHeading}>Implementation Plan</h3>
          <p className={styles.plan}>{plan}</p>
        </div>
      )}

      {hasFiles && (
        <div className={styles.section}>
          <h3 className={styles.sectionHeading}>Files to Modify</h3>
          <ul className={styles.fileList} data-testid="approval-files">
            {files.map((path, i) => (
              <li
                key={`${i}-${path}`}
                className={styles.fileItem}
                data-testid={`approval-file-${i}`}
              >
                <span className={styles.fileBadge} aria-hidden="true">
                  {fileBadgeLabel(path)}
                </span>
                <span className={styles.filePath}>{path}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {hasDiff && (
        <div className={styles.section} data-testid="approval-diff">
          <h3 className={styles.sectionHeading}>Code Diff Preview</h3>
          <CodeDiff diff={diff} />
        </div>
      )}

      <div className={styles.actionBar}>
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            void handleApprove();
          }}
          disabled={actionsLocked}
          data-testid="approve-button"
        >
          Approve
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleToggleModify}
          disabled={actionsLocked}
          data-testid="modify-button"
        >
          Edit / Modify
        </Button>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => {
            void handleReject();
          }}
          disabled={actionsLocked}
          data-testid="reject-button"
        >
          Reject
        </Button>
      </div>

      {composerOpen && (
        <div className={styles.composer} data-testid="approval-modify-composer">
          <PromptInput
            initialValue={plan}
            sendLabel="Send to AI"
            data-testid="approval-modify-input"
            sendTestId="approval-modify-send"
            disabled={disabled || pendingAction !== null}
            onSubmit={handleModifySubmit}
          />
        </div>
      )}
    </section>
  );
}
