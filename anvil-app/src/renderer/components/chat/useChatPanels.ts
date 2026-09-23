import { useCallback, useEffect, useRef, useState } from 'react';
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
  /** Artifacts available for the canvas. */
  artifacts: ChatArtifact[];
  /** A live (non-dismissed) plan intent exists. */
  hasVisiblePlanIntent: boolean;
  /** Total plan intents — used to decide whether plan history should open. */
  planIntentCount: number;
  /** An active goal exists. */
  hasGoal: boolean;
}

export function useChatPanels({
  artifacts,
  hasVisiblePlanIntent,
  planIntentCount,
  hasGoal,
}: UseChatPanelsOptions) {
  const [activityOpen, setActivityOpen] = useState(false);
  const [canvasOpen, setCanvasOpen] = useState(true);
  const [canvasExpanded, setCanvasExpanded] = useState(false);
  const [canvasDetached, setCanvasDetached] = useState(false);
  const [canvasZoom, setCanvasZoom] = useState(100);
  const [previewMode, setPreviewMode] = useState<PreviewMode | null>(null);
  const [previewInitialUrl, setPreviewInitialUrl] = useState('');
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [canvasPlanSelected, setCanvasPlanSelected] = useState(false);
  const [showPlanHistory, setShowPlanHistory] = useState(false);
  const [itsmWorkbenchOpen, setItsmWorkbenchOpen] = useState(true);
  const [goalPopoverOpen, setGoalPopoverOpen] = useState(false);
  const activityOpenRef = useRef(activityOpen);
  const lastPreviewModeRef = useRef<PreviewMode>('browser');
  const artifactCount = artifacts.length;

  useEffect(() => {
    activityOpenRef.current = activityOpen;
  }, [activityOpen]);

  useEffect(() => {
    if (previewMode) lastPreviewModeRef.current = previewMode;
  }, [previewMode]);

  // Auto-open the canvas when artifacts land; keep the selection valid.
  useEffect(() => {
    if (artifacts.length === 0) {
      setSelectedArtifactId(null);
      return;
    }
    if (!activityOpenRef.current) setCanvasOpen(true);
    setSelectedArtifactId((current) =>
      current && artifacts.some((artifact) => artifact.id === current) ? current : artifacts[0].id,
    );
  }, [artifacts]);

  // A fresh plan intent with no artifacts selects the plan tab.
  useEffect(() => {
    if (!hasVisiblePlanIntent || artifactCount > 0) return;
    setCanvasPlanSelected(true);
    if (!activityOpenRef.current) setCanvasOpen(true);
  }, [artifactCount, hasVisiblePlanIntent]);

  // Nothing to show → collapse and close the canvas.
  useEffect(() => {
    if (artifactCount > 0 || hasVisiblePlanIntent || hasGoal) return;
    setCanvasExpanded(false);
    setCanvasDetached(false);
    setCanvasOpen(false);
  }, [artifactCount, hasGoal, hasVisiblePlanIntent]);

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
        setActivityOpen(true);
      } else if (panel === 'canvas') {
        if (canvasDetached) setCanvasDetached(false);
        else setShowPlanHistory(!hasVisiblePlanIntent && planIntentCount > 0);
        setCanvasOpen(true);
      } else if (panel === 'preview') {
        setPreviewMode(lastPreviewModeRef.current);
      }
    },
    [canvasDetached, hasVisiblePlanIntent, planIntentCount],
  );

  /** Route intents (`?preview=…`) jump straight to a specific preview mode. */
  const openPreview = useCallback((mode: PreviewMode, initialUrl = '') => {
    setPreviewMode(mode);
    setPreviewInitialUrl(initialUrl);
    setCanvasOpen(false);
    setCanvasExpanded(false);
    setItsmWorkbenchOpen(false);
    setActivityOpen(false);
  }, []);

  const toggleItsmWorkbench = useCallback(() => {
    setItsmWorkbenchOpen((open) => {
      if (!open) {
        setCanvasOpen(false);
        setActivityOpen(false);
        setPreviewMode(null);
      }
      return !open;
    });
  }, []);

  const selectArtifact = useCallback((artifactId: string) => {
    setCanvasPlanSelected(false);
    setSelectedArtifactId(artifactId);
  }, []);

  const selectPlan = useCallback(() => setCanvasPlanSelected(true), []);

  const handleDetachedCanvasClose = useCallback(() => {
    setCanvasDetached(false);
    setCanvasOpen(true);
  }, []);

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
