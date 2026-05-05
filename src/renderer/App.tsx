import { useState } from 'react';
import { AppShell } from './components/AppShell';
import { Dialog } from './components/Dialog';
import { AddProject } from './views/AddProject';
import { ProjectDetail } from './views/ProjectDetail';
import { ProjectList } from './views/ProjectList';
import { useProjects } from './state/projects';

type ViewState = { kind: 'list' } | { kind: 'detail'; projectId: string };

export function App(): JSX.Element {
  const [view, setView] = useState<ViewState>({ kind: 'list' });
  const [addOpen, setAddOpen] = useState<boolean>(false);
  const projects = useProjects();

  return (
    <AppShell activeNav="projects">
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
