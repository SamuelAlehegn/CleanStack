import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { MetaResponse, ProjectSummary, WorkspaceResponse } from '../../src/web/contracts';
import { api, ApiError, enableStaticDemo } from './api';
import { demoMeta, demoWorkspace } from './demo';

interface WorkspaceContextValue {
  workspace: WorkspaceResponse | null;
  meta: MetaResponse | null;
  projects: ProjectSummary[];
  selectedProject: ProjectSummary | null;
  selectedPath: string | null;
  loading: boolean;
  error: string | null;
  /** True when the UI could not reach the engine and fell back to bundled data. */
  demo: boolean;
  selectProject(path: string): void;
  refresh(preferredPath?: string): Promise<void>;
  clearError(): void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);
const STORAGE_KEY = 'cleanstack-studio-active-project';

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null);
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(() =>
    window.localStorage.getItem(STORAGE_KEY),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [demo, setDemo] = useState(false);

  const applyWorkspace = useCallback((next: WorkspaceResponse, preferredPath?: string) => {
    setWorkspace(next);
    setSelectedPath((current) => {
      const preferred = preferredPath ?? current;
      if (preferred !== null && next.projects.some((project) => project.rootDir === preferred)) {
        return preferred;
      }
      return next.projects[0]?.rootDir ?? null;
    });
  }, []);

  const refresh = useCallback(
    async (preferredPath?: string) => {
      try {
        const next = await api.workspace();
        applyWorkspace(next, preferredPath);
        setError(null);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [applyWorkspace],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [nextWorkspace, nextMeta] = await Promise.all([api.workspace(), api.meta()]);
        if (cancelled) return;
        applyWorkspace(nextWorkspace);
        setMeta(nextMeta);
        setError(null);
      } catch {
        if (cancelled) return;
        // A pure static build has no /api server. Keep the studio usable by
        // switching to the bundled demo workspace once, clearly marked in the shell.
        enableStaticDemo();
        setDemo(true);
        applyWorkspace(demoWorkspace());
        setMeta(demoMeta());
        setError(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyWorkspace]);

  useEffect(() => {
    if (selectedPath === null) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, selectedPath);
    }
  }, [selectedPath]);

  const selectProject = useCallback((projectPath: string) => {
    setSelectedPath(projectPath);
  }, []);

  const selectedProject = useMemo(
    () => workspace?.projects.find((project) => project.rootDir === selectedPath) ?? null,
    [selectedPath, workspace],
  );

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      workspace,
      meta,
      projects: workspace?.projects ?? [],
      selectedProject,
      selectedPath,
      loading,
      error,
      demo,
      selectProject,
      refresh,
      clearError: () => setError(null),
    }),
    [demo, error, loading, meta, refresh, selectProject, selectedPath, selectedProject, workspace],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (context === null) throw new Error('useWorkspace must be used inside WorkspaceProvider.');
  return context;
}

export function errorDetails(error: unknown): { message: string; suggestions: string[] } {
  if (error instanceof ApiError) {
    return { message: error.message, suggestions: error.suggestions };
  }
  if (error instanceof Error) return { message: error.message, suggestions: [] };
  return { message: String(error), suggestions: [] };
}
