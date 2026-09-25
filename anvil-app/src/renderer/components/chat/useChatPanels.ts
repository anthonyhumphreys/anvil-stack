import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatArtifact } from '../../../shared/types';
import type { PreviewMode } from '../browser/BrowserPanel';

/**
 * CH4 — the header exposes one mutually-exclusive "Panels" control
 * (Activity · Canvas · Preview). This hook owns the underlying state plus
 * the close-others behavior the separate toggles used to implement inline.
 * Extracted from ChatView (Phase 5 split).
 */

export type ChatPanelId = 'activity' | 'canvas' | 'preview';

export interface UseChatPanelsOptions {
  /** Active conversation; canvas selection and zoom are restored per thread. */
  threadId?: string | null;
  /** Artifacts available for the canvas. */
  artifacts: ChatArtifact[];
  /** A live (non-dismissed) plan intent exists. */
  hasVisiblePlanIntent: boolean;
  /** Total plan intents — used to decide whether plan history should open. */
  planIntentCount: number;
  /** An active goal exists. */
  hasGoal: boolean;
}

interface ThreadCanvasState {
  selectedArtifactId: string | null;
  planSelected: boolean;
  zoom: number;
  canvasOpen: boolean;
  autoOpenBlocked: boolean;
}

const DEFAULT_THREAD_CANVAS_STATE: ThreadCanvasState = {
  selectedArtifactId: null,
  planSelected: false,
  zoom: 100,
  canvasOpen: true,
  autoOpenBlocked: false,
};

export function useChatPanels({
  threadId,
  artifacts,
  hasVisiblePlanIntent,
  planIntentCount,
  hasGoal,
}: UseChatPanelsOptions) {
  const threadKey = threadId ?? '__unscoped__';
  const [activityOpen, setActivityOpen] = useState(false);
  const [canvasExpanded, setCanvasExpanded] = useState(false);
  const [canvasDetached, setCanvasDetached] = useState(false);
  const [canvasStateByThread, setCanvasStateByThread] = useState<Record<string, ThreadCanvasState>>(
    {},
  );
  const [previewMode, setPreviewMode] = useState<PreviewMode | null>(null);
  const [previewInitialUrl, setPreviewInitialUrl] = useState('');
  const [showPlanHistory, setShowPlanHistory] = useState(false);
  const [itsmWorkbenchOpen, setItsmWorkbenchOpen] = useState(true);
  const [goalPopoverOpen, setGoalPopoverOpen] = useState(false);
  const activityOpenRef = useRef(activityOpen);
  const lastPreviewModeRef = useRef<PreviewMode>('browser');
  const seenArtifactIdsByThreadRef = useRef(new Map<string, Set<string>>());
  const scopedArtifacts = useMemo(
    () => (threadId ? artifacts.filter((artifact) => artifact.threadId === threadId) : artifacts),
    [artifacts, threadId],
  );
  const threadCanvasState = canvasStateByThread[threadKey] ?? DEFAULT_THREAD_CANVAS_STATE;
  const selectedArtifactId = threadCanvasState.selectedArtifactId;
  const canvasPlanSelected = threadCanvasState.planSelected;
  const canvasZoom = threadCanvasState.zoom;
  const canvasOpen = threadCanvasState.canvasOpen;
  const artifactCount = scopedArtifacts.length;

  const updateCanvasState = useCallback(
    (update: (current: ThreadCanvasState) => ThreadCanvasState) => {
      setCanvasStateByThread((current) => {
        const currentThread = current[threadKey] ?? DEFAULT_THREAD_CANVAS_STATE;
        const nextThread = update(currentThread);
        if (
          nextThread.selectedArtifactId === currentThread.selectedArtifactId &&
          nextThread.planSelected === currentThread.planSelected &&
          nextThread.zoom === currentThread.zoom &&
          nextThread.canvasOpen === currentThread.canvasOpen &&
          nextThread.autoOpenBlocked === currentThread.autoOpenBlocked
        ) {
          return current;
        }
        return { ...current, [threadKey]: nextThread };
      });
    },
    [threadKey],
  );

  const setSelectedArtifactId = useCallback(
    (value: string | null | ((current: string | null) => string | null)) => {
      updateCanvasState((current) => ({
        ...current,
        selectedArtifactId: typeof value === 'function' ? value(current.selectedArtifactId) : value,
      }));
    },
    [updateCanvasState],
  );

  const setCanvasZoom = useCallback(
    (value: number | ((current: number) => number)) => {
      updateCanvasState((current) => ({
        ...current,
        zoom: typeof value === 'function' ? value(current.zoom) : value,
      }));
    },
    [updateCanvasState],
  );

  const setCanvasOpen = useCallback(
    (value: boolean | ((current: boolean) => boolean)) => {
      updateCanvasState((current) => ({
        ...current,
        canvasOpen: typeof value === 'function' ? value(current.canvasOpen) : value,
      }));
    },
    [updateCanvasState],
  );

  const setAutoOpenBlocked = useCallback(
    (autoOpenBlocked: boolean) => updateCanvasState((current) => ({ ...current, autoOpenBlocked })),
    [updateCanvasState],
  );

  useEffect(() => {
    activityOpenRef.current = activityOpen;
  }, [activityOpen]);

  useEffect(() => {
    if (previewMode) lastPreviewModeRef.current = previewMode;
  }, [previewMode]);

  // Ignore stale artifacts during thread hydration. Auto-open only for new artifact ids.
  useEffect(() => {
    if (scopedArtifacts.length === 0) return;
    const seenIds = seenArtifactIdsByThreadRef.current.get(threadKey) ?? new Set<string>();
    const hasNewArtifact = scopedArtifacts.some((artifact) => !seenIds.has(artifact.id));
    for (const artifact of scopedArtifacts) seenIds.add(artifact.id);
    seenArtifactIdsByThreadRef.current.set(threadKey, seenIds);

    if (hasNewArtifact && !activityOpenRef.current && !threadCanvasState.autoOpenBlocked) {
      setCanvasOpen(true);
    }
    setSelectedArtifactId((current) => {
      const next =
        current && scopedArtifacts.some((artifact) => artifact.id === current)
          ? current
          : scopedArtifacts[0].id;
      return current === next ? current : next;
    });
  }, [
    scopedArtifacts,
    threadCanvasState.autoOpenBlocked,
    threadKey,
    setCanvasOpen,
    setSelectedArtifactId,
  ]);

  // A fresh plan intent with no artifacts selects the plan tab.
  useEffect(() => {
    if (!hasVisiblePlanIntent || artifactCount > 0) return;
    updateCanvasState((current) => ({ ...current, planSelected: true }));
    if (!activityOpenRef.current && !threadCanvasState.autoOpenBlocked) setCanvasOpen(true);
  }, [
    artifactCount,
    hasVisiblePlanIntent,
    threadCanvasState.autoOpenBlocked,
    threadKey,
    setCanvasOpen,
    updateCanvasState,
  ]);

  // Nothing to show → collapse and close the canvas.
  useEffect(() => {
    if (artifactCount > 0 || hasVisiblePlanIntent || hasGoal) return;
    // A thread we have already seen may be between the thread switch and its
    // artifact hydration. Keep its saved panel state until that thread's data
    // arrives; the sidebar is hidden while the active thread has no content.
    if (seenArtifactIdsByThreadRef.current.has(threadKey)) return;
    setCanvasExpanded(false);
    setCanvasDetached(false);
    setCanvasOpen(false);
  }, [artifactCount, hasGoal, hasVisiblePlanIntent, setCanvasOpen, threadKey]);

  // Escape exits the expanded canvas overlay.
  useEffect(() => {
    if (!canvasExpanded) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCanvasExpanded(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [canvasExpanded]);

  const canvasHasContent =
    artifactCount > 0 ||
    hasVisiblePlanIntent ||
    hasGoal ||
    (showPlanHistory && planIntentCount > 0);

  const activePanel: ChatPanelId | null = previewMode
    ? 'preview'
    : activityOpen
      ? 'activity'
      : canvasDetached || canvasExpanded || (canvasOpen && canvasHasContent)
        ? 'canvas'
        : null;

  /** CH4 close-others: opening one panel closes every other surface. */
  const setActivePanel = useCallback(
    (panel: ChatPanelId | null) => {
      setActivityOpen(false);
      setCanvasOpen(false);
      setCanvasExpanded(false);
      setPreviewMode(null);
      setItsmWorkbenchOpen(false);
      setGoalPopoverOpen(false);
      if (panel === 'activity') {
        setAutoOpenBlocked(true);
        setActivityOpen(true);
      } else if (panel === 'canvas') {
        setAutoOpenBlocked(false);
        if (canvasDetached) setCanvasDetached(false);
        else setShowPlanHistory(!hasVisiblePlanIntent && planIntentCount > 0);
        setCanvasOpen(true);
      } else if (panel === 'preview') {
        setAutoOpenBlocked(true);
        setPreviewMode(lastPreviewModeRef.current);
      } else {
        setAutoOpenBlocked(true);
      }
    },
    [canvasDetached, hasVisiblePlanIntent, planIntentCount, setAutoOpenBlocked, setCanvasOpen],
  );

  /** Route intents (`?preview=…`) jump straight to a specific preview mode. */
  const openPreview = useCallback(
    (mode: PreviewMode, initialUrl = '') => {
      setPreviewMode(mode);
      setPreviewInitialUrl(initialUrl);
      setCanvasOpen(false);
      setAutoOpenBlocked(true);
      setCanvasExpanded(false);
      setItsmWorkbenchOpen(false);
      setActivityOpen(false);
    },
    [setAutoOpenBlocked, setCanvasOpen],
  );

  const toggleItsmWorkbench = useCallback(() => {
    setItsmWorkbenchOpen((open) => {
      if (!open) {
        setCanvasOpen(false);
        setAutoOpenBlocked(true);
        setActivityOpen(false);
        setPreviewMode(null);
      }
      return !open;
    });
  }, [setAutoOpenBlocked, setCanvasOpen]);

  const selectArtifact = useCallback(
    (artifactId: string) => {
      updateCanvasState((current) => ({
        ...current,
        planSelected: false,
        selectedArtifactId: artifactId,
      }));
    },
    [updateCanvasState],
  );

  const selectPlan = useCallback(
    () => updateCanvasState((current) => ({ ...current, planSelected: true })),
    [updateCanvasState],
  );

  const handleDetachedCanvasClose = useCallback(() => {
    setCanvasDetached(false);
    setAutoOpenBlocked(false);
    setCanvasOpen(true);
  }, [setAutoOpenBlocked, setCanvasOpen]);

  const closeActivity = useCallback(() => {
    setActivityOpen(false);
    setGoalPopoverOpen(false);
  }, []);

  return {
    activePanel,
    setActivePanel,
    openPreview,
    activityOpen,
    closeActivity,
    canvasOpen,
    canvasExpanded,
    setCanvasExpanded,
    canvasDetached,
    setCanvasDetached,
    canvasZoom,
    setCanvasZoom,
    previewMode,
    previewInitialUrl,
    selectedArtifactId,
    setSelectedArtifactId,
    canvasPlanSelected,
    selectArtifact,
    selectPlan,
    showPlanHistory,
    itsmWorkbenchOpen,
    toggleItsmWorkbench,
    goalPopoverOpen,
    setGoalPopoverOpen,
    handleDetachedCanvasClose,
  };
}
