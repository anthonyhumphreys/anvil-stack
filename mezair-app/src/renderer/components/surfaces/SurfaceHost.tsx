import { useCallback, useId, useRef, useState } from 'react';
import {
  ArrowDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Maximize2,
  PictureInPicture2,
} from 'lucide-react';
import type { AgentUISurfaceIntent } from '../../../shared/agent-ui-intents';
import { getSurfaceKind } from '../../../shared/surfaces/registry';
import type { SurfaceAnchor } from '../../../shared/surfaces/types';
import { IconButton } from '../ui';
import { SurfaceKindRenderer, SurfaceOverflowMenu, useSurfaceShare } from './SurfaceBody';
import {
  SurfaceCommentComposer,
  useSurfaceActions,
  useSurfaceComments,
} from './surface-controller';
import { SurfaceKindIcon } from './surface-icons';
import { SurfaceSkeleton } from './SurfaceSkeleton';
import { useSurfaces } from './surfaces-context';
import {
  formatSurfaceMeta,
  isEmptySurfaceData,
  readSketchSurfaceData,
  resolveSupersedingId,
  surfaceDomId,
} from './surface-utils';
import { useViewportMount } from './useViewportMount';

const DEFAULT_RESERVED_HEIGHT = 200;

function reservedHeight(intent: AgentUISurfaceIntent): number {
  const sketch =
    intent.payload.surfaceKind === 'sketch' ? readSketchSurfaceData(intent.payload.data) : null;
  return sketch?.height ? Math.min(sketch.height, 1600) : DEFAULT_RESERVED_HEIGHT;
}

const MINIMISED_STORAGE_PREFIX = 'mezair:surface-minimised:';

/**
 * Whether the user folded this surface down to its header. Only folded ids are
 * stored, so the default (the intent's own `collapsed` hint) needs no entry.
 */
export function useSurfaceMinimised(surfaceId: string, initial: boolean): [boolean, () => void] {
  const key = `${MINIMISED_STORAGE_PREFIX}${surfaceId}`;
  const [minimised, setMinimised] = useState(() => {
    try {
      const stored = window.localStorage.getItem(key);
      return stored === null ? initial : stored === 'true';
    } catch {
      return initial;
    }
  });
  const toggle = useCallback(() => {
    const next = !minimised;
    setMinimised(next);
    try {
      if (next === initial) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, String(next));
    } catch {
      // Storage is a convenience; the toggle still works for this session.
    }
  }, [initial, key, minimised]);
  return [minimised, toggle];
}

/**
 * Inline host for a published surface: shared chrome (icon, title, meta,
 * stage / window / overflow controls), streaming, updated, superseded and
 * error states, anchored comments and action confirmation.
 */
export function SurfaceHost({ intent: incoming }: { intent: AgentUISurfaceIntent }) {
  const context = useSurfaces();
  const intent = context.resolve(incoming);
  const definition = getSurfaceKind(intent.payload.surfaceKind);
  const supersedingId = resolveSupersedingId(intent, context.surfaces);
  const handleRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const mounted = useViewportMount(bodyRef);
  const actions = useSurfaceActions(intent);
  const comments = useSurfaceComments(intent.id, mounted && !supersedingId);
  const share = useSurfaceShare(intent);
  const [composerAnchor, setComposerAnchor] = useState<SurfaceAnchor | null>(null);
  const [seenRevision, setSeenRevision] = useState(intent.revision);
  const windowOpen = context.isWindowOpen(intent.id);
  const wide = definition?.wide === true;
  const surfaceId = intent.id;
  const bodyId = useId();
  const [minimised, toggleMinimised] = useSurfaceMinimised(
    surfaceId,
    intent.presentation.collapsed,
  );
  const { openStage } = context;

  const handleOpenStage = useCallback(
    (targetId?: string) => {
      openStage?.(surfaceId, { targetId, returnFocus: handleRef.current });
    },
    [openStage, surfaceId],
  );

  const handleComment = useCallback(
    (anchor: SurfaceAnchor) => {
      if (comments.supported) setComposerAnchor(anchor);
    },
    [comments.supported],
  );

  const widthClass = wide ? 'w-full' : 'w-full max-w-[72ch]';

  if (supersedingId) {
    return (
      <div
        id={surfaceDomId(intent.id)}
        data-surface-id={intent.id}
        className={`${widthClass} flex items-center gap-2 px-1 text-xs text-text-tertiary`}
      >
        <SurfaceKindIcon kind={intent.payload.surfaceKind} size={13} />
        <span className="min-w-0 truncate">{intent.payload.title}</span>
        <button
          type="button"
          data-surface-handle
          onClick={() => context.scrollToSurface(supersedingId)}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          Updated version below
          <ArrowDown size={12} aria-hidden="true" />
        </button>
      </div>
    );
  }

  const streaming = intent.payload.streaming;
  const updated = !streaming && intent.revision > seenRevision;
  const meta = formatSurfaceMeta(intent);

  return (
    <section
      id={surfaceDomId(intent.id)}
      data-surface-id={intent.id}
      aria-label={intent.payload.title}
      aria-busy={streaming || undefined}
      className={`${widthClass} group/surface space-y-2 px-1`}
    >
      <header className="flex min-h-8 items-start gap-2">
        <button
          ref={handleRef}
          type="button"
          data-surface-handle
          disabled={!openStage}
          onClick={() => handleOpenStage()}
          className="flex min-w-0 flex-1 items-start gap-2 rounded-md text-left disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary"
          aria-label={`${intent.payload.title}${openStage ? ', expand' : ''}`}
        >
          <SurfaceKindIcon
            kind={intent.payload.surfaceKind}
            className="mt-0.5 text-text-tertiary"
          />
          <span className="min-w-0">
            <span className="block break-words text-sm font-semibold leading-5 text-text-primary">
              {intent.payload.title}
            </span>
            <span className="block text-xs text-text-tertiary">
              {[
                definition?.label,
                meta,
                comments.openCount > 0
                  ? `${comments.openCount} open comment${comments.openCount === 1 ? '' : 's'}`
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </span>
        </button>
        {updated && (
          <button
            type="button"
            onClick={() => setSeenRevision(intent.revision)}
            className="mt-0.5 shrink-0 rounded-full border border-info/30 px-2 py-0.5 text-xs font-medium text-info hover:bg-info/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            title="The agent updated this output. Dismiss"
          >
            Updated · v{intent.revision}
          </button>
        )}
        <div className="flex shrink-0 items-center gap-0.5">
          <div className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/surface:opacity-100 [@media(hover:none)]:opacity-100">
            {openStage && (
              <IconButton
                icon={Maximize2}
                label="Expand preview"
                onClick={() => handleOpenStage()}
              />
            )}
            {context.openWindow && (
              <IconButton
                icon={PictureInPicture2}
                label={windowOpen ? 'Bring window to front' : 'Open in window'}
                onClick={() =>
                  windowOpen ? context.focusWindow?.(intent.id) : context.openWindow?.(intent.id)
                }
              />
            )}
            <SurfaceOverflowMenu
              intent={intent}
              canComment={comments.supported}
              onCommentSurface={() => setComposerAnchor({ type: 'surface' })}
              share={share}
            />
          </div>
          {/* Always visible: once folded, this is the way back. */}
          <IconButton
            icon={minimised ? ChevronsUpDown : ChevronsDownUp}
            label={minimised ? 'Restore' : 'Minimise'}
            aria-expanded={!minimised}
            aria-controls={bodyId}
            onClick={toggleMinimised}
          />
        </div>
      </header>

      {/* Folded, not unmounted: previews keep their state and need no re-render. */}
      <div id={bodyId} hidden={minimised}>
        {windowOpen ? (
          <p className="flex items-center gap-2 text-xs text-text-tertiary">
            <PictureInPicture2 size={13} aria-hidden="true" />
            Open in window ·
            <button
              type="button"
              onClick={() => context.focusWindow?.(intent.id)}
              className="rounded-md px-1 font-medium text-text-secondary underline-offset-2 hover:text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            >
              Bring to front
            </button>
          </p>
        ) : (
          <div
            ref={bodyRef}
            style={mounted ? undefined : { minHeight: reservedHeight(intent) }}
            className="min-w-0"
          >
            {!mounted || (streaming && isEmptySurfaceData(intent.payload.data)) ? (
              <SurfaceSkeleton
                label={streaming ? 'The agent is preparing this output' : undefined}
              />
            ) : (
              <SurfaceKindRenderer
                intent={intent}
                presentation="inline"
                onAction={actions.onAction}
                onComment={handleComment}
                onOpenStage={handleOpenStage}
              />
            )}
          </div>
        )}
      </div>

      {context.blockedWindowId === intent.id && (
        <p role="status" className="text-xs text-warning">
          This window couldn’t be opened. Use Expand preview to view it here.
        </p>
      )}
      {(actions.notice || share.error) && (
        <p
          role="status"
          className={`text-xs ${actions.notice?.tone === 'error' || share.error ? 'text-error' : 'text-text-secondary'}`}
        >
          {share.error ?? actions.notice?.text}
        </p>
      )}
      {composerAnchor && (
        <SurfaceCommentComposer
          anchor={composerAnchor}
          onCancel={() => {
            setComposerAnchor(null);
            handleRef.current?.focus();
          }}
          onSubmit={async (body, sendToAgent) => {
            await comments.add(composerAnchor, body, sendToAgent);
            setComposerAnchor(null);
            window.requestAnimationFrame(() => {
              if (document.activeElement === document.body) handleRef.current?.focus();
            });
          }}
        />
      )}
      {actions.confirmElement}
      {share.dialog}
    </section>
  );
}
