import { useCallback, useMemo, useState } from 'react';
import type { SkillSource, SkillSummary } from '@shared/ipc';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { DataTable, type DataTableColumn } from '../components/DataTable';
import { EmptyState } from '../components/EmptyState';
import { FindSkillDialog } from '../components/FindSkillDialog';
import { IconRefresh, IconSkills } from '../components/icons';
import { useSkills } from '../state/skills';
import styles from './Skills.module.css';

function sourceLabel(source: SkillSource): string {
  return source === 'project' ? 'Project' : 'User';
}

export function Skills(): JSX.Element {
  const { skills, loading, error, refresh } = useSkills();
  const [findOpen, setFindOpen] = useState<boolean>(false);
  const [findPrefill, setFindPrefill] = useState<string>('');
  // "Refreshing" = a refetch with data already on screen. The Skills page
  // separates this from the initial load so the table stays mounted +
  // the user gets a spinning icon as feedback. (The icon-only feedback
  // is why the previous build felt like the Refresh button did nothing.)
  const refreshing = loading && skills.length > 0;

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
        width: '120px',
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
              <span className={refreshing ? styles.refreshSpinning : undefined}>
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
    </div>
  );
}
