/**
 * `<ProjectSettingsTab>` — body of the Project Detail "Settings" tab (GH-68).
 *
 * Replaces the pre-GH-68 `tab-empty-settings` placeholder with a real,
 * working settings panel. Layered on top of the existing AddProject form
 * (in editing mode) — saving reuses `projects:update`, validation reuses
 * the same hand-rolled validator, and the connection pickers + broken-
 * connection banner come "for free" from AddProject's editing path.
 *
 * The Destructive Zone (delete the project) lives BELOW the form in a
 * separately-bordered red panel, gated by a "Type project name to confirm"
 * dialog. When an active workflow run targets THIS project, the Delete
 * button is disabled and replaced with an explanatory banner — UI-level
 * companion to the existing backend `projects:delete` handler which
 * cancels-then-deletes (per GH-13 cross-session lock semantics).
 *
 * Plan deviations from the GH-68 ticket — flagged in the PR for review:
 *  - No per-section read-mode/Edit-mode flip; the whole AddProject form
 *    is editable as-is. Ticket explicitly says "structural lift-and-shift,
 *    not new component design", so we lean on AddProject verbatim.
 *  - No sticky save bar. AddProject's existing bottom `.actions` row
 *    (Save Changes / Cancel) carries the save + discard affordances.
 *  - Repo-path-change-during-run + connection-rebind-mid-poll are flagged
 *    as risks in the ticket but not as acceptance criteria; left as
 *    backend follow-ups.
 */
import { useState } from 'react';
import type { JSX } from 'react';
import type { ProjectInstanceDto, Run } from '@shared/ipc';
import { AddProject } from './AddProject';
import { Button } from '../components/Button';
import { Dialog } from '../components/Dialog';
import { Input } from '../components/Input';
import { IconAlert, IconTrash } from '../components/icons';
import { dispatchToast } from '../state/notifications';
import styles from './ProjectSettingsTab.module.css';

export interface ProjectSettingsTabProps {
  project: ProjectInstanceDto;
  /** Active workflow run for this project, if any. Drives the delete-guard. */
  activeRun: Run | null;
  /** Re-fetch the project from the store and refresh local state. */
  onProjectChanged: () => Promise<void> | void;
  /** Called after a successful delete so the page can navigate back. */
  onDeleted: () => void;
}

export function ProjectSettingsTab({
  project,
  activeRun,
  onProjectChanged,
  onDeleted,
}: ProjectSettingsTabProps): JSX.Element {
  /**
   * Bumping `formNonce` remounts `<AddProject>` with a fresh copy of the
   * editing project — the cheap way to drive a "Discard changes" affordance
   * without reaching into AddProject's internal form state. Only the
   * discard path bumps this; on successful save AddProject's own
   * `useEffect([editing])` re-derives the form when the parent's
   * `onProjectChanged()` propagates a refreshed project reference, so we
   * don't double-bump there and risk an unmount-setState in AddProject's
   * submit-finally block.
   */
  const [formNonce, setFormNonce] = useState(0);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [typedName, setTypedName] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const hasActiveRun = activeRun !== null && activeRun.projectId === project.id;

  const handleSaved = async (): Promise<void> => {
    // Refresh the project FIRST so AddProject's `editing` prop sees the
    // fresh data on the same render the toast lands on. The dedupeKey
    // includes `project.updatedAt` so a second save in the same session
    // fires a brand-new toast (and a fresh auto-dismiss timer) instead
    // of replacing an in-flight toast in place — see `dispatchToast`'s
    // dedupe contract in `state/notifications.ts`.
    await onProjectChanged();
    dispatchToast({
      type: 'success',
      title: 'Project updated',
      ttlMs: 4000,
      dedupeKey: `project-updated-${project.id}-${Date.now()}`,
    });
  };

  const handleDiscard = (): void => {
    setFormNonce((n) => n + 1);
  };

  const openConfirmDialog = (): void => {
    setTypedName('');
    setDeleteError(null);
    setConfirmOpen(true);
  };

  const closeConfirmDialog = (): void => {
    if (deleting) return;
    setConfirmOpen(false);
    setTypedName('');
    setDeleteError(null);
  };

  const canConfirmDelete = typedName === project.name && !deleting;

  const handleConfirmDelete = async (): Promise<void> => {
    if (!canConfirmDelete) return;
    if (typeof window === 'undefined' || !window.api) {
      setDeleteError('IPC bridge unavailable');
      return;
    }
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await window.api.projects.delete({ id: project.id });
      if (!res.ok) {
        setDeleteError(res.error.message || res.error.code || 'Failed to delete project');
        setDeleting(false);
        return;
      }
      dispatchToast({
        type: 'success',
        title: 'Project deleted',
        body: project.name,
        ttlMs: 4000,
        dedupeKey: `project-deleted-${project.id}`,
      });
      // Don't reset `deleting` here — the parent will unmount us on the
      // navigation away. Leaving it true blocks any racing double-click.
      onDeleted();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
    }
  };

  return (
    <div className={styles.tab} data-testid="project-settings-tab">
      {/*
       * Remount-key forces AddProject to re-derive its internal form state
       * from `project` on each bump — handles both "discard pending edits"
       * and "successful save makes new values the clean baseline".
       */}
      <div className={styles.formWrap}>
        <AddProject
          key={`settings-form-${project.id}-${formNonce}`}
          editing={project}
          onClose={handleDiscard}
          onCreated={handleSaved}
        />
      </div>

      <section
        className={styles.dangerZone}
        aria-labelledby={`danger-zone-${project.id}`}
        data-testid="settings-danger-zone"
      >
        <div className={styles.dangerHead}>
          <span className={styles.dangerIcon} aria-hidden="true">
            <IconAlert size={18} />
          </span>
          <div className={styles.dangerTitles}>
            <h3 id={`danger-zone-${project.id}`} className={styles.dangerTitle}>
              Destructive zone
            </h3>
            <p className={styles.dangerSubtitle}>
              Deleting the project removes its config, polled tickets, and run
              history. The repo on disk and any open PRs are left alone.
            </p>
          </div>
        </div>

        {hasActiveRun && (
          <div
            className={styles.dangerBanner}
            role="alert"
            data-testid="settings-delete-blocked-banner"
          >
            Cannot delete while a run is active. Cancel the run first or wait
            for it to finish.
          </div>
        )}

        <div className={styles.dangerActions}>
          <Button
            variant="destructive"
            leadingIcon={<IconTrash size={14} />}
            onClick={openConfirmDialog}
            disabled={hasActiveRun}
            data-testid="settings-delete-project"
          >
            Delete project
          </Button>
        </div>
      </section>

      <Dialog
        open={confirmOpen}
        onClose={closeConfirmDialog}
        title="Delete project?"
        subtitle="This cannot be undone."
        size="md"
        data-testid="settings-delete-dialog"
      >
        <div className={styles.confirmBody}>
          <p>
            Type{' '}
            <strong className={styles.confirmProjectName}>{project.name}</strong>{' '}
            to confirm. The project's config, polled tickets, and run history
            will be permanently removed.
          </p>
          <Input
            label="Project name to confirm"
            value={typedName}
            onChange={(e) => setTypedName(e.target.value)}
            placeholder={project.name}
            data-testid="settings-delete-confirm-input"
            name="confirmProjectName"
          />
          {deleteError !== null && (
            <div
              className={styles.confirmError}
              role="alert"
              data-testid="settings-delete-confirm-error"
            >
              {deleteError}
            </div>
          )}
          <div className={styles.confirmActions}>
            <Button
              variant="ghost"
              onClick={closeConfirmDialog}
              disabled={deleting}
              data-testid="settings-delete-confirm-cancel"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              leadingIcon={<IconTrash size={14} />}
              onClick={() => {
                void handleConfirmDelete();
              }}
              disabled={!canConfirmDelete}
              data-testid="settings-delete-confirm"
            >
              {deleting ? 'Deleting…' : 'Delete project'}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
