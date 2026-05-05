import { useEffect, useState } from 'react';
import { AppShell } from './components/AppShell';
import { Button } from './components/Button';
import { Dialog } from './components/Dialog';
import { IconAlert, IconClose } from './components/icons';
import { AddProject } from './views/AddProject';
import { ProjectDetail } from './views/ProjectDetail';
import { ProjectList } from './views/ProjectList';
import { useProjects } from './state/projects';

type ViewState = { kind: 'list' } | { kind: 'detail'; projectId: string };

const BANNER_DURATION_MS = 4_000;

export function App(): JSX.Element {
  const [view, setView] = useState<ViewState>({ kind: 'list' });
  const [addOpen, setAddOpen] = useState<boolean>(false);
  const [banner, setBanner] = useState<string | null>(null);
  const projects = useProjects();

  // Auto-dismiss the banner after 4s. Re-runs when banner text changes,
  // including the same message twice in a row (we wipe before reset in
  // showBanner).
  useEffect(() => {
    if (!banner) return;
    const id = window.setTimeout(() => setBanner(null), BANNER_DURATION_MS);
    return () => window.clearTimeout(id);
  }, [banner]);

  const showBanner = (msg: string): void => {
    // Wipe first so an immediate re-trigger of the same message resets the
    // 4s timer. Schedule the actual set on the next tick so React doesn't
    // batch them away.
    setBanner(null);
    window.setTimeout(() => setBanner(msg), 0);
  };

  return (
    <AppShell activeNav="projects">
      {banner && (
        <div
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 5,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--space-3)',
            padding: '10px var(--space-4)',
            marginBottom: 'var(--space-4)',
            borderRadius: 'var(--radius-md)',
            border: '1px solid rgba(240,185,92,0.3)',
            background: 'var(--warning-soft)',
            color: 'var(--warning)',
            fontSize: 13,
          }}
          role="status"
          data-testid="app-banner"
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <IconAlert size={14} />
            <span style={{ color: 'var(--text-primary)' }}>{banner}</span>
          </span>
          <Button
            variant="ghost"
            size="sm"
            leadingIcon={<IconClose size={12} />}
            onClick={() => setBanner(null)}
            data-testid="app-banner-dismiss"
          >
            Dismiss
          </Button>
        </div>
      )}

      {view.kind === 'list' && (
        <ProjectList
          projects={projects.projects}
          loading={projects.loading}
          error={projects.error}
          onRefresh={projects.refresh}
          onAdd={() => setAddOpen(true)}
          onOpen={(id) => {
            setView({ kind: 'detail', projectId: id });
          }}
        />
      )}
      {view.kind === 'detail' && (
        <ProjectDetail
          projectId={view.projectId}
          onBack={() => setView({ kind: 'list' })}
          onRun={(key) => {
             
            console.info('[run] requested for ticket', key);
            showBanner('Workflow runner not yet wired — #7 will land this.');
          }}
          onRunSelected={(keys) => {
             
            console.info('[run-selected] requested for tickets', keys);
            showBanner(
              `Workflow runner not yet wired — #7 will run ${keys.length} ticket${keys.length === 1 ? '' : 's'}.`,
            );
          }}
          onOpenExecution={(key) => {
             
            console.info('[open-execution]', key);
            showBanner('Execution view lands with the workflow runner in #7.');
          }}
        />
      )}

      <Dialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        size="full"
        title="Add Project"
        subtitle="Configure repository, ticket source, and workflow settings."
        data-testid="add-project-dialog"
      >
        <AddProject
          onClose={() => setAddOpen(false)}
          onCreated={async () => {
            setAddOpen(false);
            await projects.refresh();
          }}
        />
      </Dialog>
    </AppShell>
  );
}

export default App;
