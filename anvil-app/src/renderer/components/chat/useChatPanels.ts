import { useCallback, useEffect, useRef, useState } from 'react';
import type { PreviewMode } from '../browser/BrowserPanel';

/**
 * CH4 — the header exposes one mutually-exclusive "Panels" control
 * (Activity · Preview). This hook owns the underlying state plus the
 * close-others behavior. Agent output renders inline in the thread as
 * surfaces, so there is no canvas pane.
 */

export type ChatPanelId = 'activity' | 'preview';

export function useChatPanels() {
  const [activityOpen, setActivityOpen] = useState(false);
  const [previewMode, setPreviewMode] = useState<PreviewMode | null>(null);
  const [previewInitialUrl, setPreviewInitialUrl] = useState('');
  const [itsmWorkbenchOpen, setItsmWorkbenchOpen] = useState(true);
  const [goalPopoverOpen, setGoalPopoverOpen] = useState(false);
  const lastPreviewModeRef = useRef<PreviewMode>('browser');

  useEffect(() => {
    if (previewMode) lastPreviewModeRef.current = previewMode;
  }, [previewMode]);

  const activePanel: ChatPanelId | null = previewMode
    ? 'preview'
    : activityOpen
      ? 'activity'
      : null;

  /** CH4 close-others: opening one panel closes every other surface. */
  const setActivePanel = useCallback((panel: ChatPanelId | null) => {
    setActivityOpen(false);
    setPreviewMode(null);
    setItsmWorkbenchOpen(false);
    setGoalPopoverOpen(false);
    if (panel === 'activity') setActivityOpen(true);
    else if (panel === 'preview') setPreviewMode(lastPreviewModeRef.current);
  }, []);

  /** Route intents (`?preview=…`) jump straight to a specific preview mode. */
  const openPreview = useCallback((mode: PreviewMode, initialUrl = '') => {
    setPreviewMode(mode);
    setPreviewInitialUrl(initialUrl);
    setItsmWorkbenchOpen(false);
    setActivityOpen(false);
  }, []);

  const toggleItsmWorkbench = useCallback(() => {
    setItsmWorkbenchOpen((open) => {
      if (!open) {
        setActivityOpen(false);
        setPreviewMode(null);
      }
      return !open;
    });
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
    previewMode,
    previewInitialUrl,
    itsmWorkbenchOpen,
    toggleItsmWorkbench,
    goalPopoverOpen,
    setGoalPopoverOpen,
  };
}
