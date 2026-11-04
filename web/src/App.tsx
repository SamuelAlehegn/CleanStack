import { AppShell } from './components/AppShell';
import { EntitiesPage } from './pages/EntitiesPage';
import { HomePage } from './pages/HomePage';
import { NewProjectPage } from './pages/NewProjectPage';
import { PreviewPage } from './pages/PreviewPage';
import { useRoute } from './router';
import { WorkspaceProvider, useWorkspace } from './workspace';

export function App() {
  return (
    <WorkspaceProvider>
      <StudioShell />
    </WorkspaceProvider>
  );
}

function StudioShell() {
  const route = useRoute();
  const { workspace, projects, error, loading, demo } = useWorkspace();

  const page =
    route === 'new' ? (
      <NewProjectPage />
    ) : route === 'entities' ? (
      <EntitiesPage />
    ) : route === 'preview' ? (
      <PreviewPage />
    ) : (
      <HomePage />
    );

  return (
    <AppShell
      route={route}
      workspacePath={workspace?.workspacePath ?? ''}
      projectCount={projects.length}
      engineOnline={!demo && !loading && workspace !== null && error === null}
      demo={demo}
    >
      {page}
    </AppShell>
  );
}
