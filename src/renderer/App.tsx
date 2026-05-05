import { useState } from 'react';
import { AppShell } from './components/AppShell';
import { Dialog } from './components/Dialog';
import { AddProject } from './views/AddProject';
import { DetailPlaceholder } from './views/DetailPlaceholder';
import { ProjectList } from './views/ProjectList';
import { useProjects } from './state/projects';

type View = 'list' | 'detail';

export function App(): JSX.Element {
  const [view, setView] = useState<View>('list');
  const [addOpen, setAddOpen] = useState<boolean>(false);
  const [, setCurrentProjectId] = useState<string | null>(null);
  const projects = useProjects();

  return (
    <AppShell activeNav="projects">
      {view === 'list' && (
        <ProjectList
          projects={projects.projects}
          loading={projects.loading}
          error={projects.error}
          onRefresh={projects.refresh}
          onAdd={() => setAddOpen(true)}
          onOpen={(id) => {
            setCurrentProjectId(id);
            setView('detail');
          }}
        />
      )}
      {view === 'detail' && <DetailPlaceholder onBack={() => setView('list')} />}

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
