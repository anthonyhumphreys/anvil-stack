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
  CodexMode,
  RepoInfo,
  Workspace,
  WorkspaceCreateOptions,
  WorkspaceFeatureAvailability,
  WorkspacePreferences,
  WorkspaceScaffoldSession,
  WorkspaceWithRepos,
  WorkspaceSummary,
  WorkspaceActivitySummary,
} from '../../shared/types';
import { useOptionalRepoIndex } from './RepoIndexContext';

interface WorkspaceContextValue {
  workspaces: WorkspaceSummary[];
  /** Cross-workspace attention/activity feed, refreshed on a poll. */
  workspaceActivity: WorkspaceActivitySummary[];
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
  /**
   * WS7: set for a few seconds after a workspace switch so the shell can show
   * a "Switched to X" toast with Undo.
   */
  workspaceSwitchNotice: { fromId: string; fromName: string; toName: string } | null;
  undoWorkspaceSwitch: () => Promise<void>;
  dismissWorkspaceSwitchNotice: () => void;
  /**
   * J10 seam: per-workspace default access level. Persisted per workspace in
   * localStorage until the `workspace_preferences.access` section lands; the
   * Settings → Workspace panel should read/write through this pair.
   */
  workspaceAccessDefault: CodexMode | null;
  setWorkspaceAccessDefault: (level: CodexMode | null) => void;
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

/** True once the fast structural pass has run — the tier that unlocks repo features. */
export function repoIsMapped(repo: RepoInfo): boolean {
  return repo.indexTier === 'mapped' || repo.indexTier === 'enriched' || repo.status === 'indexed';
}

/** True while the repo has a queued/running index job or is mid-index. */
export function repoIsIndexing(repo: RepoInfo): boolean {
  return repo.status === 'indexing';
}

export interface FeatureAvailabilityInput {
  repos: RepoInfo[];
  scaffoldSession: WorkspaceScaffoldSession | null;
  /** Repo ids with a queued/running index job (from RepoIndexContext). */
  activeJobRepoIds: ReadonlySet<string>;
  /** Repo ids whose latest index job failed. */
  failedJobRepoIds: ReadonlySet<string>;
  /** False until the index-job list has hydrated — avoids flashing errors. */
  jobsHydrated: boolean;
}

/**
 * Truthful feature availability (J2/J4, §4.1):
 * - Chat is never disabled by indexing — it improves context, it isn't a gate.
 * - Repo features unlock per-repo at the `mapped` tier.
 * - `preparing` only while a job is actually queued/running; `needs-attention`
 *   when indexing failed or never ran.
 */
export function computeFeatureAvailability(
  input: FeatureAvailabilityInput,
): WorkspaceFeatureAvailability {
  const { repos, scaffoldSession, activeJobRepoIds, failedJobRepoIds, jobsHydrated } = input;

  if (scaffoldSession) {
    if (scaffoldSession.status === 'indexing') {
      const anyMapped = repos.some(repoIsMapped);
      return {
        statusLabel: 'indexing',
        chatEnabled: true,
        repoFeaturesEnabled: anyMapped,
        repoFeatureReason: anyMapped
          ? undefined
          : 'Workspace setup is finishing. Repositories are being indexed.',
      };
    }

    if (scaffoldSession.status === 'active' || scaffoldSession.status === 'syncing') {
      return {
        statusLabel: 'scaffolding',
        chatEnabled: true,
        repoFeaturesEnabled: false,
        repoFeatureReason: 'Workspace setup is in progress in Chat.',
      };
    }

    if (scaffoldSession.status === 'failed') {
      return {
        statusLabel: 'scaffolding',
        chatEnabled: true,
        repoFeaturesEnabled: repos.some(repoIsMapped),
        repoFeatureReason:
          scaffoldSession.errorMessage ??
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

  const anyMapped = repos.some(repoIsMapped);
  const anyActive = repos.some((repo) => activeJobRepoIds.has(repo.id) || repoIsIndexing(repo));
  const anyFailed = repos.some((repo) => repo.status === 'error' || failedJobRepoIds.has(repo.id));

  if (anyActive) {
    return {
      statusLabel: 'preparing',
      chatEnabled: true,
      repoFeaturesEnabled: anyMapped,
      repoFeatureReason: anyMapped
        ? undefined
        : 'Repositories are being indexed — repo features unlock as soon as the structural pass finishes.',
    };
  }

  if (anyMapped) {
    return {
      statusLabel: 'ready',
      chatEnabled: true,
      repoFeaturesEnabled: true,
    };
  }

  if (anyFailed) {
    return {
      statusLabel: 'needs-attention',
      chatEnabled: true,
      repoFeaturesEnabled: false,
      repoFeatureReason:
        'Repository indexing failed. Open the Workspace view to see the error and retry.',
    };
  }

  if (!jobsHydrated) {
    // Jobs are still loading — assume indexing may be queued rather than
    // flashing a misleading "needs attention".
    return {
      statusLabel: 'preparing',
      chatEnabled: true,
      repoFeaturesEnabled: false,
      repoFeatureReason: 'Checking repository indexing status…',
    };
  }

  return {
    statusLabel: 'needs-attention',
    chatEnabled: true,
    repoFeaturesEnabled: false,
    repoFeatureReason:
      'Repositories are connected but not indexed yet. Open the Workspace view to start indexing.',
  };
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workspaceActivity, setWorkspaceActivity] = useState<WorkspaceActivitySummary[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceWithRepos | null>(null);
  const [loading, setLoading] = useState(true);
  const [initialWorkspaceId] = useState(() => readInitialWorkspaceIdFromLocation(window.location));
  const activeWorkspaceLoadVersionRef = useRef(0);
  const desiredWorkspaceIdRef = useRef<string | null>(null);
  const [workspaceSwitchNotice, setWorkspaceSwitchNotice] = useState<{
    fromId: string;
    fromName: string;
    toName: string;
  } | null>(null);
  const [workspaceAccessDefault, setWorkspaceAccessDefaultState] = useState<CodexMode | null>(null);

  const repoIndex = useOptionalRepoIndex();

  const repos = activeWorkspace?.repos ?? [];
  const activeScaffoldSession = activeWorkspace?.scaffoldSession ?? null;

  const featureAvailability: WorkspaceFeatureAvailability = (() => {
    const activeJobRepoIds = new Set<string>();
    const failedJobRepoIds = new Set<string>();
    if (repoIndex) {
      for (const repo of repos) {
        if (repoIndex.activeJobForRepo(repo.id)) activeJobRepoIds.add(repo.id);
        if (repoIndex.lastErrorForRepo(repo.id)) failedJobRepoIds.add(repo.id);
      }
    }
    return computeFeatureAvailability({
      repos,
      scaffoldSession: activeScaffoldSession,
      activeJobRepoIds,
      failedJobRepoIds,
      jobsHydrated: repoIndex?.hydrated ?? false,
    });
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

  // Cross-workspace attention feed — powers the workspace rail badges and the
  // activity view. Polled rather than pushed; the query is a single cheap pass.
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      window.anvil.workspace
        .activityFeed()
        .then((feed) => {
          if (!cancelled) setWorkspaceActivity(feed);
        })
        .catch(() => {
          if (!cancelled) setWorkspaceActivity([]);
        });
    };
    refresh();
    const interval = window.setInterval(refresh, 8000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
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

  // Refresh workspace/repo data when index jobs settle so `indexTier`,
  // `status` and summaries reflect the completed pass (replaces the old
  // per-view polling).
  const settledJobsVersion = repoIndex?.settledJobsVersion ?? 0;
  const prevSettledVersionRef = useRef(settledJobsVersion);
  useEffect(() => {
    if (settledJobsVersion === prevSettledVersionRef.current) return;
    prevSettledVersionRef.current = settledJobsVersion;
    void loadWorkspaces();
    if (desiredWorkspaceIdRef.current) {
      void loadActiveWorkspace(desiredWorkspaceIdRef.current);
    }
  }, [settledJobsVersion, loadWorkspaces, loadActiveWorkspace]);

  // J10 seam: per-workspace default access level. Persisted in localStorage
  // until `workspace_preferences.access` exists — the Settings → Workspace
  // panel (later wave) reads/writes through this context pair so only the
  // storage adapter changes.
  const accessDefaultKey = activeWorkspace
    ? `anvil:workspace-access-default:${activeWorkspace.id}`
    : null;
  useEffect(() => {
    if (!accessDefaultKey) {
      setWorkspaceAccessDefaultState(null);
      return;
    }
    try {
      const raw = window.localStorage.getItem(accessDefaultKey);
      setWorkspaceAccessDefaultState((raw as CodexMode | null) ?? null);
    } catch {
      setWorkspaceAccessDefaultState(null);
    }
  }, [accessDefaultKey]);

  const setWorkspaceAccessDefault = useCallback(
    (level: CodexMode | null) => {
      setWorkspaceAccessDefaultState(level);
      if (!accessDefaultKey) return;
      try {
        if (level === null) window.localStorage.removeItem(accessDefaultKey);
        else window.localStorage.setItem(accessDefaultKey, level);
      } catch {
        /* localStorage unavailable — keep the in-memory value */
      }
    },
    [accessDefaultKey],
  );

  const switchWorkspace = useCallback(
    async (id: string) => {
      const previous = activeWorkspace;
      await loadActiveWorkspace(id, true);
      if (desiredWorkspaceIdRef.current !== id) return;
      await window.anvil.settings.update({ activeWorkspaceId: id });
      // WS7: surface the switch so the shell can offer an Undo toast.
      const next = workspaces.find((ws) => ws.id === id);
      if (previous && previous.id !== id) {
        setWorkspaceSwitchNotice({
          fromId: previous.id,
          fromName: previous.name,
          toName: next?.name ?? 'workspace',
        });
      }
    },
    [loadActiveWorkspace, activeWorkspace, workspaces],
  );

  const undoWorkspaceSwitch = useCallback(async () => {
    const notice = workspaceSwitchNotice;
    setWorkspaceSwitchNotice(null);
    if (!notice) return;
    await loadActiveWorkspace(notice.fromId, true);
    if (desiredWorkspaceIdRef.current !== notice.fromId) return;
    await window.anvil.settings.update({ activeWorkspaceId: notice.fromId });
  }, [loadActiveWorkspace, workspaceSwitchNotice]);

  const dismissWorkspaceSwitchNotice = useCallback(() => {
    setWorkspaceSwitchNotice(null);
  }, []);

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
        workspaceActivity,
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
        workspaceSwitchNotice,
        undoWorkspaceSwitch,
        dismissWorkspaceSwitchNotice,
        workspaceAccessDefault,
        setWorkspaceAccessDefault,
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
