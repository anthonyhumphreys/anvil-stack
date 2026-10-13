import { useEffect, useId, useRef, useState } from 'react';
import { MessageSquare, PictureInPicture2, X } from 'lucide-react';
import type { AgentUISurfaceIntent } from '../../../shared/agent-ui-intents';
import type { SurfaceAnchor } from '../../../shared/surfaces/types';
import { Button, IconButton } from '../ui';
import { SurfaceKindRenderer, SurfaceOverflowMenu, useSurfaceShare } from './SurfaceBody';
import {
  SurfaceCommentComposer,
  SurfaceCommentList,
  useSurfaceActions,
  useSurfaceComments,
} from './surface-controller';
import { SurfaceKindIcon } from './surface-icons';
import { useSurfaces } from './surfaces-context';
import { formatSurfaceMeta } from './surface-utils';

/**
 * Full stage over the chat column (rail and sidebar stay visible). State lives
 * in `?surface=<id>`; Esc or back closes and focus returns to the handle.
 */
export function SurfaceStage() {
  const context = useSurfaces();
  const { stageSurfaceId, closeStage } = context;
  if (!stageSurfaceId || !closeStage) return null;
  const intent = context.getSurface(stageSurfaceId);
  return (
    <SurfaceStageFrame
      key={stageSurfaceId}
      intent={intent}
      surfaceId={stageSurfaceId}
      onClose={closeStage}
    />
  );
}

function SurfaceStageFrame({
  intent,
  surfaceId,
  onClose,
}: {
  intent: AgentUISurfaceIntent | undefined;
  surfaceId: string;
  onClose: () => void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    frameRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      ref={frameRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      tabIndex={-1}
      className="surface-stage absolute inset-0 z-30 flex min-h-0 flex-col bg-bg-primary focus:outline-none"
    >
      {intent ? (
        <StageContent intent={intent} titleId={titleId} onClose={onClose} />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <h2 id={titleId} className="text-sm font-semibold text-text-primary">
            Surface not found
          </h2>
          <p className="max-w-sm text-xs text-text-secondary">
            “{surfaceId}” isn’t part of this conversation, or it hasn’t loaded yet.
          </p>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      )}
    </div>
  );
}

function StageContent({
  intent: incoming,
  titleId,
  onClose,
}: {
  intent: AgentUISurfaceIntent;
  titleId: string;
  onClose: () => void;
}) {
  const context = useSurfaces();
  const intent = context.resolve(incoming);
  const actions = useSurfaceActions(intent);
  const comments = useSurfaceComments(intent.id, true);
  const share = useSurfaceShare(intent);
  const [railOpen, setRailOpen] = useState(true);
  const [anchor, setAnchor] = useState<SurfaceAnchor | null>(null);

  const startComment = (next: SurfaceAnchor) => {
    if (!comments.supported) return;
    setRailOpen(true);
    setAnchor(next);
  };

  return (
    <>
      <header className="flex shrink-0 items-center gap-2.5 border-b border-border/60 bg-bg-secondary px-4 py-2.5">
        <SurfaceKindIcon kind={intent.payload.surfaceKind} className="text-text-tertiary" />
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="truncate text-sm font-semibold text-text-primary">
            {intent.payload.title}
          </h2>
          <p className="truncate text-xs text-text-tertiary">{formatSurfaceMeta(intent)}</p>
        </div>
        {comments.supported && (
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={railOpen}
            onClick={() => setRailOpen((open) => !open)}
          >
            <MessageSquare size={13} aria-hidden="true" />
            Comments
            {comments.openCount > 0 && (
              <span className="rounded-full bg-bg-tertiary px-1.5 text-eyebrow font-semibold text-text-primary">
                {comments.openCount}
              </span>
            )}
          </Button>
        )}
        {context.openWindow && (
          <IconButton
            icon={PictureInPicture2}
            label="Open in window"
            onClick={() => {
              context.openWindow?.(intent.id);
              onClose();
            }}
          />
        )}
        <SurfaceOverflowMenu
          intent={intent}
          canComment={comments.supported}
          onCommentSurface={() => startComment({ type: 'surface' })}
          share={share}
        />
        <IconButton icon={X} label="Close stage (Esc)" onClick={onClose} />
      </header>
      {(actions.notice || share.error) && (
        <p
          role="status"
          className={`shrink-0 border-b border-border/60 px-4 py-2 text-xs ${actions.notice?.tone === 'error' || share.error ? 'text-error' : 'text-text-secondary'}`}
        >
          {share.error ?? actions.notice?.text}
        </p>
      )}
      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-auto px-6 py-5">
          <SurfaceKindRenderer
            intent={intent}
            presentation="stage"
            onAction={actions.onAction}
            onComment={startComment}
            onOpenStage={() => undefined}
            focusTargetId={context.stageTargetId ?? undefined}
          />
        </main>
        {comments.supported && railOpen && (
          <aside
            aria-label="Comments"
            className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-l border-border/60 bg-bg-secondary/40 p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold text-text-primary">
                Comments{comments.comments.length > 0 ? ` (${comments.comments.length})` : ''}
              </h3>
              {!anchor && (
                <Button variant="ghost" size="sm" onClick={() => setAnchor({ type: 'surface' })}>
                  Add comment
                </Button>
              )}
            </div>
            {anchor && (
              <SurfaceCommentComposer
                anchor={anchor}
                onCancel={() => setAnchor(null)}
                onSubmit={async (body, sendToAgent) => {
                  await comments.add(anchor, body, sendToAgent);
                  setAnchor(null);
                }}
              />
            )}
            {comments.error && <p className="text-xs text-error">{comments.error}</p>}
            <SurfaceCommentList
              comments={comments.comments}
              onSetStatus={(id, status) => void comments.setStatus(id, status)}
            />
          </aside>
        )}
      </div>
      {actions.confirmElement}
      {share.dialog}
    </>
  );
}
