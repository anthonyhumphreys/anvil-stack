import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  RepoInfo,
  Workspace,
  WorkspaceCreateOptions,
  WorkspaceFeatureAvailability,
  WorkspacePreferences,
  WorkspaceScaffoldSession,
  WorkspaceWithRepos,
  WorkspaceSummary,
} from '../../shared/types';

interface WorkspaceContextValue {
  workspaces: WorkspaceSummary[];
  activeWorkspace: WorkspaceWithRepos | null;
  activeScaffoldSession: WorkspaceScaffoldSession | null;
  featureAvailability: WorkspaceFeatureAvailability;
  repos: RepoInfo[];
  loading: boolean;
  switchWorkspace: (id: string) => Promise<void>;
  createWorkspace: (opts: WorkspaceCreateOptions) => Promise<Workspace>;
  updateWorkspace: (id: string, opts: { name: string }) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  addRepos: (repoIds: string[]) => Promise<void>;
  removeRepos: (repoIds: string[]) => Promise<void>;
  updatePreferences: (updates: {
    workitems?: Record<string, unknown>;
    docs?: Record<string, unknown>;
    launch?: Record<string, unknown>;
  }) => Promise<WorkspacePreferences | null>;
  clearPreferences: (
    sections?: Array<'workitems' | 'docs' | 'launch'>,
  ) => Promise<WorkspacePreferences | null>;
  refreshWorkspaces: () => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function readInitialWorkspaceIdFromLocation(
  location: Pick<Location, 'hash' | 'search'>,
): string | null {
  const hashSearchIndex = location.hash.indexOf('?');
  if (hashSearchIndex >= 0) {
    const workspaceId = new URLSearchParams(location.hash.slice(hashSearchIndex)).get(
      'workspaceId',
    );
    if (workspaceId) return workspaceId;
  }

  return new URLSearchParams(location.search).get('workspaceId');
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used within <WorkspaceProvider>');
  return ctx;
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceWithRepos | null>(null);
  const [loading, setLoading] = useState(true);
  const [initialWorkspaceId] = useState(() => readInitialWorkspaceIdFromLocation(window.location));
  const activeWorkspaceLoadVersionRef = useRef(0);
  const desiredWorkspaceIdRef = useRef<string | null>(null);

  const repos = activeWorkspace?.repos ?? [];
  const activeScaffoldSession = activeWorkspace?.scaffoldSession ?? null;

  const featureAvailability: WorkspaceFeatureAvailability = (() => {
    if (activeScaffoldSession) {
      if (activeScaffoldSession.status === 'indexing') {
        return {
          statusLabel: 'indexing',
          chatEnabled: true,
          repoFeaturesEnabled: false,
          repoFeatureReason: 'Workspace setup is finishing. Repositories are being indexed.',
        };
      }

      if (activeScaffoldSession.status === 'active' || activeScaffoldSession.status === 'syncing') {
        return {
          statusLabel: 'scaffolding',
          chatEnabled: true,
          repoFeaturesEnabled: false,
          repoFeatureReason: 'Workspace setup is in progress in Chat.',
        };
      }

      if (activeScaffoldSession.status === 'failed') {
        return {
          statusLabel: 'scaffolding',
          chatEnabled: true,
          repoFeaturesEnabled: false,
          repoFeatureReason:
            activeScaffoldSession.errorMessage ??
            'Workspace setup hit a problem. Continue in Chat to finish scaffolding.',
        };
      }
    }

    if (repos.length === 0) {
      return {
        statusLabel: 'empty',
        chatEnabled: true,
        repoFeaturesEnabled: false,
        repoFeatureReason:
          'Add repositories later to unlock repo-powered features. Documentation, governance, and chat are available now.',
      };
    }

    if (repos.some((repo) => repo.status === 'indexed')) {
      return {
        statusLabel: 'ready',
        chatEnabled: true,
        repoFeaturesEnabled: true,
      };
    }

    return {
      statusLabel: 'indexing',
      chatEnabled: false,
      repoFeaturesEnabled: false,
      repoFeatureReason: 'Index repositories to unlock this feature.',
    };
  })();

  const loadActiveWorkspace = useCallback(async (id: string, select = false) => {
    if (select) {
      desiredWorkspaceIdRef.current = id;
    } else if (desiredWorkspaceIdRef.current !== id) {
      return null;
    }

    const loadVersion = ++activeWorkspaceLoadVersionRef.current;
    const ws = await window.anvil.workspace.get(id);
    let shouldApply = shouldApplyWorkspaceLoad(
      loadVersion,
      activeWorkspaceLoadVersionRef.current,
      id,
      desiredWorkspaceIdRef.current,
    );
    if (shouldApply && select) {
      await window.anvil.settings.update({
        activeWorkspaceId: id,
        activeWorkItemConnectionId: ws.preferences?.workitems.workItemConnectionId,
      });
      shouldApply = shouldApplyWorkspaceLoad(
        loadVersion,
        activeWorkspaceLoadVersionRef.current,
        id,
        desiredWorkspaceIdRef.current,
      );
    }
    if (shouldApply) {
      setActiveWorkspace(ws);
    }
    return ws;
  }, []);

  const loadWorkspaces = useCallback(async () => {
    const list = await window.anvil.workspace.list();
    setWorkspaces(list);
    return list;
  }, []);

  // Load workspaces and active workspace on mount
  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const [list, settings] = await Promise.all([
          window.anvil.workspace.list(),
          window.anvil.settings.get(),
        ]);

        if (cancelled) return;
        setWorkspaces(list);

        if (initialWorkspaceId && list.some((ws) => ws.id === initialWorkspaceId)) {
          await loadActiveWorkspace(initialWorkspaceId, true);
        } else if (settings.activeWorkspaceId) {
          // Verify the saved workspace still exists
          const exists = list.some((ws) => ws.id === settings.activeWorkspaceId);
          if (exists) {
            await loadActiveWorkspace(settings.activeWorkspaceId, true);
          } else if (list.length > 0) {
            // Saved workspace was deleted; fall back to first
            await loadActiveWorkspace(list[0].id, true);
            await window.anvil.settings.update({ activeWorkspaceId: list[0].id });
          }
        } else if (list.length > 0) {
          // No saved preference; auto-select first
          await loadActiveWorkspace(list[0].id, true);
          await window.anvil.settings.update({ activeWorkspaceId: list[0].id });
        }
      } catch (err) {
        console.error('Failed to initialise workspaces:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    init();
    return () => {
      cancelled = true;
    };
  }, [initialWorkspaceId, loadActiveWorkspace]);

  useEffect(() => {
    if (!activeWorkspace?.id || !activeScaffoldSession) return;
    if (
      activeScaffoldSession.status === 'completed' ||
      activeScaffoldSession.status === 'cancelled'
    ) {
      return;
    }

    const interval = window.setInterval(() => {
      void loadActiveWorkspace(activeWorkspace.id);
      void loadWorkspaces();
    }, 3000);

    return () => window.clearInterval(interval);
  }, [
    activeWorkspace?.id,
    activeScaffoldSession?.id,
    activeScaffoldSession?.status,
    loadActiveWorkspace,
    loadWorkspaces,
  ]);

  const switchWorkspace = useCallback(
    async (id: string) => {
      await loadActiveWorkspace(id, true);
      if (desiredWorkspaceIdRef.current !== id) return;
      await window.anvil.settings.update({ activeWorkspaceId: id });
    },
    [loadActiveWorkspace],
  );

  const createWorkspace = useCallback(
    async (opts: WorkspaceCreateOptions): Promise<Workspace> => {
      const ws = await window.anvil.workspace.create(opts);
      await loadWorkspaces();
      // Auto-switch to the newly created workspace
      await loadActiveWorkspace(ws.id, true);
      await window.anvil.settings.update({ activeWorkspaceId: ws.id });
      return ws;
    },
    [loadWorkspaces, loadActiveWorkspace],
  );

  const updateWorkspace = useCallback(
    async (id: string, opts: { name: string }) => {
      await window.anvil.workspace.update(id, opts);
      await loadWorkspaces();
      // Refresh active workspace if it was the one updated
      if (activeWorkspace?.id === id) {
        await loadActiveWorkspace(id);
      }
    },
    [loadWorkspaces, loadActiveWorkspace, activeWorkspace?.id],
  );

  const deleteWorkspace = useCallback(
    async (id: string) => {
      await window.anvil.workspace.delete(id);
      const list = await loadWorkspaces();

      if (activeWorkspace?.id === id) {
        if (list.length > 0) {
          await loadActiveWorkspace(list[0].id, true);
          await window.anvil.settings.update({ activeWorkspaceId: list[0].id });
        } else {
          desiredWorkspaceIdRef.current = null;
          setActiveWorkspace(null);
          await window.anvil.settings.update({ activeWorkspaceId: undefined });
        }
      }
    },
    [loadWorkspaces, loadActiveWorkspace, activeWorkspace?.id],
  );

  const addRepos = useCallback(
    async (repoIds: string[]) => {
      if (!activeWorkspace) return;
      await window.anvil.workspace.addRepos(activeWorkspace.id, repoIds);
      await loadActiveWorkspace(activeWorkspace.id);
    },
    [activeWorkspace, loadActiveWorkspace],
  );

  const removeRepos = useCallback(
    async (repoIds: string[]) => {
      if (!activeWorkspace) return;
      await window.anvil.workspace.removeRepos(activeWorkspace.id, repoIds);
      await loadActiveWorkspace(activeWorkspace.id);
    },
    [activeWorkspace, loadActiveWorkspace],
  );

  const refreshWorkspaces = useCallback(async () => {
    await loadWorkspaces();
    if (activeWorkspace) {
      await loadActiveWorkspace(activeWorkspace.id);
    }
  }, [loadWorkspaces, loadActiveWorkspace, activeWorkspace]);

  const updatePreferences = useCallback(
    async (updates: {
      workitems?: Record<string, unknown>;
      docs?: Record<string, unknown>;
      launch?: Record<string, unknown>;
    }) => {
      if (!activeWorkspace) return null;
      const prefs = await window.anvil.workspace.updatePreferences(activeWorkspace.id, updates);
      await loadActiveWorkspace(activeWorkspace.id);
      return prefs;
    },
    [activeWorkspace, loadActiveWorkspace],
  );

  const clearPreferences = useCallback(
    async (sections?: Array<'workitems' | 'docs' | 'launch'>) => {
      if (!activeWorkspace) return null;
      const prefs = await window.anvil.workspace.clearPreferences(activeWorkspace.id, sections);
      await loadActiveWorkspace(activeWorkspace.id);
      return prefs;
    },
    [activeWorkspace, loadActiveWorkspace],
  );

  return (
    <WorkspaceContext.Provider
      value={{
        workspaces,
        activeWorkspace,
        activeScaffoldSession,
        featureAvailability,
        repos,
        loading,
        switchWorkspace,
        createWorkspace,
        updateWorkspace,
        deleteWorkspace,
        addRepos,
        removeRepos,
        updatePreferences,
        clearPreferences,
        refreshWorkspaces,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}

export function shouldApplyWorkspaceLoad(
  loadVersion: number,
  currentLoadVersion: number,
  requestedWorkspaceId: string,
  desiredWorkspaceId: string | null,
): boolean {
  return loadVersion === currentLoadVersion && requestedWorkspaceId === desiredWorkspaceId;
}
