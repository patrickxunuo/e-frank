import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SkillSource, SkillSummary } from '@shared/ipc';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { DataTable, type DataTableColumn } from '../components/DataTable';
import { Dialog } from '../components/Dialog';
import { EmptyState } from '../components/EmptyState';
import { FindSkillDialog } from '../components/FindSkillDialog';
import { IconRefresh, IconSkills, IconTrash } from '../components/icons';
import { useSkills } from '../state/skills';
import { clearFindSkillCache } from '../state/find-skill-cache';
import styles from './Skills.module.css';

function sourceLabel(source: SkillSource): string {
  return source === 'project' ? 'Project' : 'User';
}

export function Skills(): JSX.Element {
  const { skills, loading, error, refresh, remove } = useSkills();
  const [findOpen, setFindOpen] = useState<boolean>(false);
  const [findPrefill, setFindPrefill] = useState<string>('');
  // Remove-skill confirmation state. `pending` carries the skill being
  // confirmed so the dialog can show its name. `removing` blocks the
  // confirm button while the IPC round-trip is in flight so a
  // double-click can't fan out two npm removes. `error` surfaces the
  // result inline in the dialog rather than the page-level area.
  const [pendingRemove, setPendingRemove] = useState<SkillSummary | null>(null);
  const [removing, setRemoving] = useState<boolean>(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  // "Refreshing" = a refetch with data already on screen. The Skills page
  // separates this from the initial load so the table stays mounted +
  // the user gets a spinning icon as feedback. (The icon-only feedback
  // is why the previous build felt like the Refresh button did nothing.)
  const refreshing = loading && skills.length > 0;

  // Wipe the FindSkillDialog result cache when the Skills page
  // unmounts. The cache is meant to survive dialog close/reopen
  // *within* the Skills page (so the user can flick the dialog open
  // and see their last results), but should NOT persist across
  // navigation — stale results from an earlier visit are surprising.
  // App-close already clears naturally (memory-only store), and the
  // FindSkillDialog clears on a new search; this hook handles the
  // third trigger the user asked for.
  useEffect(() => {
    return () => {
      clearFindSkillCache();
    };
  }, []);

  const openFindDialog = useCallback((prefill: string): void => {
    setFindPrefill(prefill);
    setFindOpen(true);
  }, []);

  const handleOpenFolder = useCallback((row: SkillSummary): void => {
    if (typeof window === 'undefined' || !window.api) return;
    void window.api.shell.openPath({ path: row.dirPath });
  }, []);

  const handleAfterInstall = useCallback((): void => {
    void refresh();
  }, [refresh]);

  const handleConfirmRemove = useCallback(async (): Promise<void> => {
    if (pendingRemove === null || removing) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      // The scanner uses the directory basename as `id`, which is also
      // the install ref (`ef-feature` for `~/.claude/skills/ef-feature/`).
      // Pass it through to the remove IPC. `name` is the human label
      // for the success toast.
      const result = await remove(pendingRemove.id, pendingRemove.name);
      if (result.ok) {
        // useSkills.remove() already refreshed the list — just dismiss.
        setPendingRemove(null);
      } else {
        setRemoveError(result.error ?? 'Failed to remove skill');
      }
    } finally {
      // Always clear the in-flight flag — protects against `remove()`
      // throwing or the IPC bridge crashing. Without this, the dialog
      // could be stuck on "Removing…" with no way out.
      setRemoving(false);
    }
  }, [pendingRemove, removing, remove]);

  const columns: DataTableColumn<SkillSummary>[] = useMemo(
    () => [
      {
        key: 'name',
        header: 'Name',
        render: (row) => <span className={styles.cellPrimary}>{row.name}</span>,
      },
      {
        key: 'description',
        header: 'Description',
        render: (row) => (
          <span className={styles.cellSecondary} title={row.description}>
            {row.description || '—'}
          </span>
        ),
      },
      {
        key: 'source',
        header: 'Source',
        width: '110px',
        render: (row) => (
          <Badge variant={row.source === 'project' ? 'success' : 'neutral'}>
            {sourceLabel(row.source)}
          </Badge>
        ),
      },
      {
        key: 'actions',
        header: '',
        align: 'right',
        width: '180px',
        render: (row) => (
          <div className={styles.actionsCell}>
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                handleOpenFolder(row);
              }}
              data-testid={`skill-row-${row.id}-open`}
            >
              Open
            </Button>
            <Button
              variant="ghost"
              size="sm"
              leadingIcon={<IconTrash size={14} />}
              onClick={(e) => {
                e.stopPropagation();
                setRemoveError(null);
                setPendingRemove(row);
              }}
              data-testid={`skill-row-${row.id}-remove`}
              aria-label={`Remove ${row.name}`}
            />
          </div>
        ),
      },
    ],
    [handleOpenFolder],
  );

  const showSkeleton = loading && skills.length === 0;
  const showEmpty = !loading && !error && skills.length === 0;
  const showTable = skills.length > 0;

  return (
    <div className={styles.page} data-testid="skills-page">
      <header className={styles.head}>
        <div className={styles.titleBlock}>
          <span className={styles.eyebrow}>Workspace · Skills</span>
          <h1 className={styles.title} data-testid="skills-title">
            Skills
          </h1>
          <p className={styles.subtitle}>
            Claude Code skills installed at the user level (
            <code>~/.claude/skills/</code>) and project level (
            <code>.claude/skills/</code>). Skills drive workflows like
            <code> ef-feature</code> and <code>ef-auto-feature</code>.
          </p>
        </div>
        <div className={styles.headActions}>
          <Button
            variant="ghost"
            size="sm"
            leadingIcon={
              <span
                className={`${styles.refreshIcon} ${refreshing ? styles.refreshSpinning : ''}`}
              >
                <IconRefresh size={14} />
              </span>
            }
            onClick={() => {
              void refresh();
            }}
            disabled={refreshing}
            data-testid="skills-refresh"
          >
            Refresh
          </Button>
          <Button
            variant="primary"
            leadingIcon={<IconSkills size={14} />}
            onClick={() => openFindDialog('')}
            data-testid="skills-find-button"
          >
            Find Skill
          </Button>
        </div>
      </header>

      <div className={styles.body}>
        {error && (
          <div className={styles.errorBanner} role="alert" data-testid="skills-error">
            <span>
              <strong>Couldn't load skills.</strong> {error}
            </span>
            <Button
              variant="ghost"
              size="sm"
              leadingIcon={<IconRefresh />}
              onClick={() => {
                void refresh();
              }}
              data-testid="skills-retry"
            >
              Retry
            </Button>
          </div>
        )}

        {showSkeleton && (
          <div className={styles.skeleton} data-testid="skills-loading">
            <div className={styles.skeletonRow} style={{ width: '36%' }} />
            <div className={styles.skeletonRow} style={{ width: '92%' }} />
            <div className={styles.skeletonRow} style={{ width: '78%' }} />
          </div>
        )}

        {showEmpty && (
          <EmptyState
            icon={<IconSkills size={26} />}
            title="No skills installed yet"
            description="Skills extend Claude with custom commands. Install ef-feature to unlock the human-paced ticket-to-PR workflow, or browse other skills."
            action={
              <Button
                variant="primary"
                leadingIcon={<IconSkills size={14} />}
                onClick={() => openFindDialog('ef-feature')}
                data-testid="skills-empty-cta"
              >
                Find Skill
              </Button>
            }
            data-testid="skills-empty"
          />
        )}

        {showTable && (
          <DataTable
            columns={columns}
            rows={skills}
            rowKey={(row) => row.id}
            rowTestId={(row) => `skill-row-${row.id}`}
            fillHeight
            data-testid="skills-table"
          />
        )}
      </div>

      <FindSkillDialog
        open={findOpen}
        initialQuery={findPrefill}
        onClose={() => setFindOpen(false)}
        onInstalled={handleAfterInstall}
      />

      <Dialog
        open={pendingRemove !== null}
        onClose={() => {
          if (removing) return; // can't dismiss while npm is running
          setPendingRemove(null);
          setRemoveError(null);
        }}
        title="Remove skill?"
        subtitle={
          pendingRemove !== null
            ? `${pendingRemove.name} (${pendingRemove.id})`
            : undefined
        }
        data-testid="skill-remove-dialog"
      >
        <div className={styles.removeDialogBody}>
          <p>
            This runs <code>npx skills remove {pendingRemove?.id ?? ''}</code>{' '}
            and refreshes the list. The skill folder is gone after the
            command succeeds — undo means reinstalling from{' '}
            <strong>Find Skill</strong>.
          </p>
          {removeError !== null && (
            <div
              className={styles.removeDialogError}
              role="alert"
              data-testid="skill-remove-error"
            >
              {removeError}
            </div>
          )}
          <div className={styles.removeDialogActions}>
            <Button
              variant="ghost"
              onClick={() => {
                setPendingRemove(null);
                setRemoveError(null);
              }}
              disabled={removing}
              data-testid="skill-remove-cancel"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              leadingIcon={<IconTrash size={12} />}
              onClick={() => {
                void handleConfirmRemove();
              }}
              disabled={removing}
              data-testid="skill-remove-confirm"
            >
              {removing ? 'Removing…' : 'Remove skill'}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
