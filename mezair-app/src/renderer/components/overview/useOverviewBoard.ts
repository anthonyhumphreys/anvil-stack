import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Feature } from '../../../shared/types';
import { ROLE_FEATURES } from '../../../shared/types';
import {
  overviewLayoutTarget,
  overviewLayoutsEqual,
  type OverviewLayout,
  type OverviewLayoutState,
  type OverviewScope,
  type OverviewSources,
  type OverviewTarget,
  type OverviewTimeRange,
} from '../../../shared/overview';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import {
  cleanIpcError,
  overviewScopeKey,
  readStoredTimeRange,
  writeStoredTimeRange,
} from './overview-format';

/** Where Save layout writes for a workspace overview. */
export type OverviewSaveTarget = 'workspace' | 'all-workspaces';

export interface OverviewBoardController {
  scope: OverviewScope;
  scopeKey: string;
  loading: boolean;
  error: string | null;
  layoutState: OverviewLayoutState | null;
  /** The draft while customising, otherwise the saved layout. */
  layout: OverviewLayout | null;
  sources: OverviewSources | null;
  /** Role-available features; `null` means every feature is shown. */
  features: ReadonlySet<Feature> | null;
  editing: boolean;
  dirty: boolean;
  saving: boolean;
  saveTarget: OverviewSaveTarget;
  setSaveTarget: (target: OverviewSaveTarget) => void;
  timeRange: OverviewTimeRange;
  setTimeRange: (range: OverviewTimeRange) => void;
  refreshToken: number;
  refreshAll: () => void;
  startEditing: (configureModuleId?: string) => void;
  cancelEditing: () => void;
  save: () => Promise<void>;
  resetToFallback: () => void;
  updateDraft: (update: (layout: OverviewLayout) => OverviewLayout) => void;
  configuringId: string | null;
  setConfiguringId: (moduleId: string | null) => void;
}

export function useOverviewBoard(scope: OverviewScope): OverviewBoardController {
  const scopeKey = overviewScopeKey(scope);
  // Keep the scope object stable per key so effects don't loop.
  const stableScope = useMemo(() => scope, [scopeKey]);
  const [layoutState, setLayoutState] = useState<OverviewLayoutState | null>(null);
  const [sources, setSources] = useState<OverviewSources | null>(null);
  const [features, setFeatures] = useState<ReadonlySet<Feature> | null>(null);
  const [draft, setDraft] = useState<OverviewLayout | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveTarget, setSaveTarget] = useState<OverviewSaveTarget>('workspace');
  const [timeRange, setTimeRangeState] = useState<OverviewTimeRange>(() =>
    readStoredTimeRange(scopeKey),
  );
  const [refreshToken, setRefreshToken] = useState(0);
  const [configuringId, setConfiguringId] = useState<string | null>(null);
  const loadVersion = useRef(0);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setLoading(true);
    setError(null);
    try {
      const [nextLayout, nextSources, settings] = await Promise.all([
        window.mezair.overview.getLayout(stableScope),
        window.mezair.overview.sources(),
        window.mezair.settings.get(),
      ]);
      if (version !== loadVersion.current) return;
      setLayoutState(nextLayout);
      setSources(nextSources);
      setFeatures(
        settings.showAllTools || !settings.userRole
          ? null
          : new Set(ROLE_FEATURES[settings.userRole]),
      );
    } catch (err) {
      if (version === loadVersion.current) setError(cleanIpcError(err));
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }, [stableScope]);

  useEffect(() => {
    setDraft(null);
    setConfiguringId(null);
    setSaveTarget('workspace');
    setTimeRangeState(readStoredTimeRange(scopeKey));
    void load();
  }, [load, scopeKey]);

  const setTimeRange = useCallback(
    (range: OverviewTimeRange) => {
      setTimeRangeState(range);
      writeStoredTimeRange(scopeKey, range);
    },
    [scopeKey],
  );

  const startEditing = useCallback(
    (configureModuleId?: string) => {
      if (!layoutState) return;
      setDraft((current) => current ?? layoutState.layout);
      setSaveTarget(layoutState.source === 'workspace-default' ? 'all-workspaces' : 'workspace');
      if (configureModuleId) setConfiguringId(configureModuleId);
    },
    [layoutState],
  );

  const cancelEditing = useCallback(() => {
    setDraft(null);
    setConfiguringId(null);
  }, []);

  const resetToFallback = useCallback(() => {
    if (layoutState) setDraft(layoutState.fallback);
  }, [layoutState]);

  const updateDraft = useCallback((update: (layout: OverviewLayout) => OverviewLayout) => {
    setDraft((current) => (current ? update(current) : current));
  }, []);

  const save = useCallback(async () => {
    if (!draft || !layoutState) return;
    setSaving(true);
    setError(null);
    try {
      const ownTarget = overviewLayoutTarget(stableScope);
      if (stableScope.kind === 'workspace' && saveTarget === 'all-workspaces') {
        await window.mezair.overview.saveWorkspaceDefault(stableScope.workspaceId, draft);
      } else if (overviewLayoutsEqual(draft, layoutState.fallback)) {
        // Matching the fallback: drop the saved copy so future defaults apply.
        await window.mezair.overview.resetLayout(ownTarget);
      } else {
        await window.mezair.overview.saveLayout(ownTarget, draft);
      }
      setDraft(null);
      setConfiguringId(null);
      await load();
    } catch (err) {
      setError(cleanIpcError(err));
    } finally {
      setSaving(false);
    }
  }, [draft, layoutState, load, saveTarget, stableScope]);

  const editing = draft !== null;
  const dirty = Boolean(
    draft &&
    layoutState &&
    (!overviewLayoutsEqual(draft, layoutState.layout) ||
      saveTarget !== initialSaveTarget(layoutState)),
  );

  return {
    scope: stableScope,
    scopeKey,
    loading,
    error,
    layoutState,
    layout: draft ?? layoutState?.layout ?? null,
    sources,
    features,
    editing,
    dirty,
    saving,
    saveTarget,
    setSaveTarget,
    timeRange,
    setTimeRange,
    refreshToken,
    refreshAll: () => setRefreshToken((token) => token + 1),
    startEditing,
    cancelEditing,
    save,
    resetToFallback,
    updateDraft,
    configuringId,
    setConfiguringId,
  };
}

function initialSaveTarget(state: OverviewLayoutState): OverviewSaveTarget {
  return state.source === 'workspace-default' ? 'all-workspaces' : 'workspace';
}

/**
 * Open an overview row: external records in the browser, in-app routes after
 * switching to the row's workspace so the destination shows the right data.
 */
export function useOverviewNavigate(): (target: OverviewTarget) => void {
  const navigate = useNavigate();
  const { activeWorkspace, switchWorkspace } = useWorkspace();
  return useCallback(
    (target: OverviewTarget) => {
      if (target.url) {
        window.open(target.url, '_blank', 'noopener');
        return;
      }
      if (!target.route) return;
      const route = target.route;
      if (target.workspaceId && target.workspaceId !== activeWorkspace?.id) {
        void switchWorkspace(target.workspaceId).then(() => navigate(route));
        return;
      }
      navigate(route);
    },
    [activeWorkspace?.id, navigate, switchWorkspace],
  );
}
