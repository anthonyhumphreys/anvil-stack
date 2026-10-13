import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type { AgentUIIntent, AgentUISurfaceIntent } from '../../../shared/agent-ui-intents';
import type { ChatArtifact } from '../../../shared/types';
import { SurfaceWindow } from './SurfaceWindow';
import {
  scrollToSurfaceElement,
  SurfacesContext,
  type OpenStageOptions,
  type SurfacesContextValue,
} from './surfaces-context';
import {
  ARTIFACT_LINK_PARAM,
  buildArtifactSurfaceIntent,
  isSurfaceIntent,
  newerIntent,
  parseSyntheticArtifactSurfaceId,
  readStageSurfaceId,
  resolveArtifactStageSurfaceId,
  surfaceDomId,
  withStageSurface,
} from './surface-utils';

const STAGE_TARGET_PARAM = 'surfaceTarget';

/** Merges transcript copies and context copies of surfaces; revision wins, transcript order first. */
export function mergeThreadSurfaces(
  transcript: readonly AgentUISurfaceIntent[],
  intents: readonly AgentUIIntent[],
): AgentUISurfaceIntent[] {
  const byId = new Map<string, AgentUISurfaceIntent>();
  const order: string[] = [];
  const add = (intent: AgentUISurfaceIntent) => {
    const current = byId.get(intent.id);
    if (!current) order.push(intent.id);
    byId.set(intent.id, current ? newerIntent(current, intent) : intent);
  };
  transcript.forEach(add);
  [...intents]
    .filter(isSurfaceIntent)
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .forEach(add);
  return order.map((id) => byId.get(id)!);
}

export function SurfacesProvider({
  threadId,
  workspaceName,
  transcriptSurfaces,
  intents,
  artifacts,
  discardArtifact,
  readOnly = false,
  children,
}: {
  threadId: string | null;
  workspaceName: string;
  transcriptSurfaces: readonly AgentUISurfaceIntent[];
  intents: readonly AgentUIIntent[];
  artifacts: ChatArtifact[];
  discardArtifact?: (artifactId: string) => Promise<void>;
  readOnly?: boolean;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [openWindows, setOpenWindows] = useState<
    Array<{ intent: AgentUISurfaceIntent; workspaceName: string }>
  >([]);
  const windowsRef = useRef(new Map<string, Window>());
  const [blockedWindowId, setBlockedWindowId] = useState<string | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const surfaces = useMemo(
    () => mergeThreadSurfaces(transcriptSurfaces, intents),
    [intents, transcriptSurfaces],
  );
  const byId = useMemo(() => new Map(surfaces.map((surface) => [surface.id, surface])), [surfaces]);

  const getSurface = useCallback(
    (surfaceId: string): AgentUISurfaceIntent | undefined => {
      const surface = byId.get(surfaceId);
      if (surface) return surface;
      const artifactId = parseSyntheticArtifactSurfaceId(surfaceId);
      const artifact = artifactId ? artifacts.find((item) => item.id === artifactId) : undefined;
      return artifact ? buildArtifactSurfaceIntent(artifact) : undefined;
    },
    [artifacts, byId],
  );

  const resolve = useCallback(
    (intent: AgentUISurfaceIntent) => {
      const known = byId.get(intent.id);
      return known ? newerIntent(known, intent) : intent;
    },
    [byId],
  );

  const stageSurfaceId = readStageSurfaceId(searchParams);
  const stageTargetId = searchParams.get(STAGE_TARGET_PARAM);

  // `?artifact=` deep links (Library) become a stage surface once the owning
  // thread is selected (`?thread=` consumed) and its surfaces/artifacts load.
  const linkedArtifactId = searchParams.get(ARTIFACT_LINK_PARAM);
  const threadPending = searchParams.has('thread');
  useEffect(() => {
    if (!linkedArtifactId || threadPending) return;
    const surfaceId = resolveArtifactStageSurfaceId(linkedArtifactId, surfaces, artifacts);
    if (!surfaceId) return;
    const next = withStageSurface(searchParams, surfaceId);
    next.delete(ARTIFACT_LINK_PARAM);
    setSearchParams(next, { replace: true });
  }, [artifacts, linkedArtifactId, searchParams, setSearchParams, surfaces, threadPending]);

  const openStage = useCallback(
    (surfaceId: string, options?: OpenStageOptions) => {
      returnFocusRef.current =
        options?.returnFocus ??
        (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      const next = withStageSurface(searchParams, surfaceId);
      if (options?.targetId) next.set(STAGE_TARGET_PARAM, options.targetId);
      else next.delete(STAGE_TARGET_PARAM);
      const pushed = readStageSurfaceId(searchParams) === null;
      navigate(
        { pathname: location.pathname, search: `?${next.toString()}` },
        { replace: !pushed, state: { surfaceStage: true } },
      );
    },
    [location.pathname, navigate, searchParams],
  );

  const closeStage = useCallback(() => {
    const closingId = readStageSurfaceId(searchParams);
    const state = location.state as { surfaceStage?: boolean } | null;
    if (state?.surfaceStage && window.history.length > 1) {
      navigate(-1);
    } else {
      const next = withStageSurface(searchParams, null);
      next.delete(STAGE_TARGET_PARAM);
      setSearchParams(next, { replace: true });
    }
    const focusTarget = returnFocusRef.current;
    returnFocusRef.current = null;
    window.requestAnimationFrame(() => {
      if (focusTarget?.isConnected) {
        focusTarget.focus({ preventScroll: true });
        return;
      }
      if (!closingId) return;
      document
        .getElementById(surfaceDomId(closingId))
        ?.querySelector<HTMLElement>('[data-surface-handle]')
        ?.focus({ preventScroll: true });
    });
  }, [location.state, navigate, searchParams, setSearchParams]);

  const openWindow = useCallback(
    (surfaceId: string) => {
      const existing = windowsRef.current.get(surfaceId);
      if (existing && !existing.closed) {
        existing.focus();
        return;
      }
      const intent = getSurface(surfaceId);
      if (!intent) return;
      setBlockedWindowId(null);
      setOpenWindows((current) =>
        current.some((entry) => entry.intent.id === surfaceId)
          ? current
          : [...current, { intent, workspaceName }],
      );
    },
    [getSurface, workspaceName],
  );

  const focusWindow = useCallback((surfaceId: string) => {
    windowsRef.current.get(surfaceId)?.focus();
  }, []);

  const closeWindow = useCallback((surfaceId: string) => {
    windowsRef.current.delete(surfaceId);
    setOpenWindows((current) => current.filter((entry) => entry.intent.id !== surfaceId));
  }, []);

  // Windows keep the surface they opened with (they never re-bind on thread or
  // workspace switch) and pick up newer revisions while that thread is loaded.
  useEffect(() => {
    setOpenWindows((current) => {
      let changed = false;
      const next = current.map((entry) => {
        const latest = byId.get(entry.intent.id);
        if (!latest || newerIntent(entry.intent, latest) === entry.intent) return entry;
        changed = true;
        return { ...entry, intent: latest };
      });
      return changed ? next : current;
    });
  }, [byId]);

  const isWindowOpen = useCallback(
    (surfaceId: string) => openWindows.some((entry) => entry.intent.id === surfaceId),
    [openWindows],
  );

  const value = useMemo<SurfacesContextValue>(
    () => ({
      threadId,
      workspaceName,
      surfaces,
      artifacts,
      resolve,
      getSurface,
      stageSurfaceId,
      stageTargetId,
      readOnly,
      openStage,
      closeStage,
      isWindowOpen,
      openWindow,
      focusWindow,
      closeWindow,
      scrollToSurface: scrollToSurfaceElement,
      discardArtifact,
      blockedWindowId,
    }),
    [
      blockedWindowId,
      artifacts,
      closeStage,
      closeWindow,
      discardArtifact,
      focusWindow,
      getSurface,
      isWindowOpen,
      openStage,
      openWindow,
      resolve,
      stageSurfaceId,
      stageTargetId,
      readOnly,
      surfaces,
      threadId,
      workspaceName,
    ],
  );

  return (
    <SurfacesContext.Provider value={value}>
      {children}
      {openWindows.map((entry) => (
        <SurfaceWindow
          key={entry.intent.id}
          intent={entry.intent}
          workspaceName={entry.workspaceName}
          onReady={(popup) => windowsRef.current.set(entry.intent.id, popup)}
          onClose={(reason) => {
            closeWindow(entry.intent.id);
            if (reason === 'blocked') setBlockedWindowId(entry.intent.id);
          }}
        />
      ))}
    </SurfacesContext.Provider>
  );
}
