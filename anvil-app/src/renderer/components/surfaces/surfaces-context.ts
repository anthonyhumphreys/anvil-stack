import { createContext, useContext } from 'react';
import type { AgentUISurfaceIntent } from '../../../shared/agent-ui-intents';
import type { ChatArtifact } from '../../../shared/types';

export interface OpenStageOptions {
  targetId?: string;
  /** Element to refocus when the stage closes (defaults to the surface handle). */
  returnFocus?: HTMLElement | null;
}

export interface SurfacesContextValue {
  threadId: string | null;
  workspaceName: string;
  /** Latest copy of every surface in the thread, in transcript order. */
  surfaces: AgentUISurfaceIntent[];
  artifacts: ChatArtifact[];
  /** Latest known copy of a surface (revision wins). */
  resolve: (intent: AgentUISurfaceIntent) => AgentUISurfaceIntent;
  getSurface: (surfaceId: string) => AgentUISurfaceIntent | undefined;
  stageSurfaceId: string | null;
  stageTargetId: string | null;
  /** Thread access is read-only: surfaces hide mutation actions. */
  readOnly: boolean;
  openStage?: (surfaceId: string, options?: OpenStageOptions) => void;
  closeStage?: () => void;
  isWindowOpen: (surfaceId: string) => boolean;
  openWindow?: (surfaceId: string) => void;
  focusWindow?: (surfaceId: string) => void;
  closeWindow?: (surfaceId: string) => void;
  /** Surface whose pop-out window could not be opened (shown as a notice on its handle). */
  blockedWindowId?: string | null;
  scrollToSurface: (surfaceId: string) => void;
  /** Discards a session-only artifact and drops it from thread state. */
  discardArtifact?: (artifactId: string) => Promise<void>;
}

function scrollToSurfaceElement(surfaceId: string) {
  if (typeof document === 'undefined') return;
  const element = document.querySelector<HTMLElement>(
    `[data-surface-id="${CSS.escape(surfaceId)}"]`,
  );
  if (!element) return;
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  element.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
  element.querySelector<HTMLElement>('[data-surface-handle]')?.focus({ preventScroll: true });
}

const DEFAULT_VALUE: SurfacesContextValue = {
  threadId: null,
  workspaceName: '',
  surfaces: [],
  artifacts: [],
  resolve: (intent) => intent,
  getSurface: () => undefined,
  stageSurfaceId: null,
  stageTargetId: null,
  readOnly: false,
  isWindowOpen: () => false,
  scrollToSurface: scrollToSurfaceElement,
};

export const SurfacesContext = createContext<SurfacesContextValue>(DEFAULT_VALUE);

export function useSurfaces(): SurfacesContextValue {
  return useContext(SurfacesContext);
}

export { scrollToSurfaceElement };
