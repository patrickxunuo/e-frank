import { useCallback, useState } from 'react';
import { AppShell } from './components/AppShell';
import type { SidebarNavId } from './components/Sidebar';
import { Dialog } from './components/Dialog';
import { Titlebar } from './components/Titlebar';
import { ToastStack } from './components/ToastStack';
import { AddProject } from './views/AddProject';
import { Connections } from './views/Connections';
import { ExecutionView } from './views/ExecutionView';
import { ProjectDetail } from './views/ProjectDetail';
import { ProjectList } from './views/ProjectList';
import { useNotificationDispatchers } from './state/notification-dispatchers';
import { useProjects } from './state/projects';
import styles from './App.module.css';

type ViewState =
  | { kind: 'list' }
  | { kind: 'connections' }
  | { kind: 'detail'; projectId: string }
  | { kind: 'execution'; runId: string; projectId: string };

type DetailViewState = Extract<ViewState, { kind: 'detail' }>;
type ExecutionViewState = Extract<ViewState, { kind: 'execution' }>;
type SetView = (v: ViewState) => void;

function renderDetail(view: DetailViewState, setView: SetView): JSX.Element {
  const { projectId } = view;
  return (
    <ProjectDetail
      projectId={projectId}
      onBack={() => setView({ kind: 'list' })}
      onOpenExecution={(runId) => {
        setView({ kind: 'execution', runId, projectId });
      }}
    />
  );
}

function renderExecution(view: ExecutionViewState, setView: SetView): JSX.Element {
  const { projectId, runId } = view;
  return (
    <ExecutionView
      runId={runId}
      projectId={projectId}
      onBack={() => setView({ kind: 'detail', projectId })}
    />
  );
}

function activeNavFor(view: ViewState): SidebarNavId {
  if (view.kind === 'connections') return 'connections';
  return 'projects';
}

function routeFor(view: ViewState): 'list' | 'detail' | 'execution' | 'connections' {
  return view.kind;
}

export function App(): JSX.Element {
  const [view, setView] = useState<ViewState>({ kind: 'list' });
  const [addOpen, setAddOpen] = useState<boolean>(false);
  const projects = useProjects();

  const currentExecutionRunId = view.kind === 'execution' ? view.runId : null;
  const handleNavigateToExecution = useCallback(
    (runId: string, projectId: string): void => {
      setView({ kind: 'execution', runId, projectId });
    },
    [],
  );
  useNotificationDispatchers({
    currentExecutionRunId,
    onNavigateToExecution: handleNavigateToExecution,
  });

  const handleNavigate = (id: SidebarNavId): void => {
    if (id === 'connections') {
      setView({ kind: 'connections' });
    } else if (id === 'projects') {
      setView({ kind: 'list' });
    }
    // 'settings' is a no-op until a settings view ships.
  };

  return (
    <div className={styles.root}>
      <Titlebar />
      <AppShell
        activeNav={activeNavFor(view)}
        route={routeFor(view)}
        onNavigate={handleNavigate}
      >
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
        {view.kind === 'connections' && <Connections />}
        {view.kind === 'detail' && renderDetail(view, setView)}
        {view.kind === 'execution' && renderExecution(view, setView)}

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
      <ToastStack />
    </div>
  );
}

export default App;
