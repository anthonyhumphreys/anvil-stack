import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MessageSquarePlus, Share2 } from 'lucide-react';
import type { AgentUISurfaceIntent } from '../../../shared/agent-ui-intents';
import type { SurfaceAnchor } from '../../../shared/surfaces/types';
import { Button } from '../ui';
import { SurfaceKindRenderer, useSurfaceShare } from './SurfaceBody';
import {
  SurfaceCommentComposer,
  useSurfaceActions,
  useSurfaceComments,
} from './surface-controller';
import { SurfaceKindIcon } from './surface-icons';
import { formatSurfaceMeta } from './surface-utils';

export function surfaceWindowName(surfaceId: string): string {
  return `mezair-surface-${surfaceId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

export function surfaceWindowTitle(title: string, workspaceName: string): string {
  return workspaceName ? `${title} — ${workspaceName}` : title;
}

function mirrorRootAttributes(source: HTMLElement, target: HTMLElement) {
  for (const attribute of Array.from(target.attributes)) {
    if (!source.hasAttribute(attribute.name)) target.removeAttribute(attribute.name);
  }
  for (const attribute of Array.from(source.attributes)) {
    target.setAttribute(attribute.name, attribute.value);
  }
}

/**
 * Pop-out window for one surface, keyed by surface id so several can be open.
 * Renders presentation 'window' through a portal into a same-origin popup.
 */
export function SurfaceWindow({
  intent,
  workspaceName,
  onReady,
  onClose,
}: {
  intent: AgentUISurfaceIntent;
  workspaceName: string;
  onReady: (popup: Window) => void;
  onClose: (reason?: 'blocked') => void;
}) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const popupRef = useRef<Window | null>(null);
  const onReadyRef = useRef(onReady);
  const onCloseRef = useRef(onClose);
  onReadyRef.current = onReady;
  onCloseRef.current = onClose;
  const surfaceId = intent.id;
  const title = surfaceWindowTitle(intent.payload.title, workspaceName);

  useEffect(() => {
    const popup = window.open(
      '',
      surfaceWindowName(surfaceId),
      'popup=yes,width=1100,height=800,minWidth=560,minHeight=420',
    );
    if (!popup) {
      onCloseRef.current('blocked');
      return;
    }
    popupRef.current = popup;
    const popupDocument = popup.document;
    mirrorRootAttributes(document.documentElement, popupDocument.documentElement);
    popupDocument.body.className = `${document.body.className} overflow-hidden bg-bg-primary`;

    const base = popupDocument.createElement('base');
    base.href = document.baseURI;
    popupDocument.head.appendChild(base);
    for (const node of document.head.querySelectorAll('style, link[rel="stylesheet"]')) {
      popupDocument.head.appendChild(node.cloneNode(true));
    }

    const mount = popupDocument.createElement('div');
    mount.className = 'h-screen w-screen overflow-hidden bg-bg-primary text-text-primary';
    popupDocument.body.replaceChildren(mount);
    setContainer(mount);

    // Follow theme changes live.
    const themeObserver = new MutationObserver(() =>
      mirrorRootAttributes(document.documentElement, popupDocument.documentElement),
    );
    themeObserver.observe(document.documentElement, { attributes: true });

    const handleUnload = () => onCloseRef.current();
    popup.addEventListener('beforeunload', handleUnload);
    onReadyRef.current(popup);
    popup.focus();

    return () => {
      themeObserver.disconnect();
      popup.removeEventListener('beforeunload', handleUnload);
      if (!popup.closed) popup.close();
      popupRef.current = null;
      setContainer(null);
    };
  }, [surfaceId]);

  useEffect(() => {
    if (popupRef.current && !popupRef.current.closed) popupRef.current.document.title = title;
  }, [title, container]);

  return container ? createPortal(<SurfaceWindowContent intent={intent} />, container) : null;
}

function SurfaceWindowContent({ intent }: { intent: AgentUISurfaceIntent }) {
  const actions = useSurfaceActions(intent);
  const comments = useSurfaceComments(intent.id, true);
  const share = useSurfaceShare(intent);
  const [anchor, setAnchor] = useState<SurfaceAnchor | null>(null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2.5 border-b border-border/60 bg-bg-secondary px-4 py-2.5">
        <SurfaceKindIcon kind={intent.payload.surfaceKind} className="text-text-tertiary" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold text-text-primary">
            {intent.payload.title}
          </h1>
          <p className="truncate text-xs text-text-tertiary">
            {formatSurfaceMeta(intent)}
            {comments.openCount > 0 &&
              ` · ${comments.openCount} open comment${comments.openCount === 1 ? '' : 's'}`}
          </p>
        </div>
        {comments.supported && (
          <Button variant="ghost" size="sm" onClick={() => setAnchor({ type: 'surface' })}>
            <MessageSquarePlus size={13} aria-hidden="true" />
            Comment
          </Button>
        )}
        {share.canShare && (
          <Button
            variant="ghost"
            size="sm"
            disabled={share.busy}
            onClick={() => void share.start()}
          >
            <Share2 size={13} aria-hidden="true" />
            Share…
          </Button>
        )}
      </header>
      {anchor && (
        <div className="border-b border-border/60 px-4 py-3">
          <SurfaceCommentComposer
            anchor={anchor}
            onCancel={() => setAnchor(null)}
            onSubmit={async (body, sendToAgent) => {
              await comments.add(anchor, body, sendToAgent);
              setAnchor(null);
            }}
          />
        </div>
      )}
      {(actions.notice || share.error) && (
        <p
          role="status"
          className={`border-b border-border/60 px-4 py-2 text-xs ${actions.notice?.tone === 'error' || share.error ? 'text-error' : 'text-text-secondary'}`}
        >
          {share.error ?? actions.notice?.text}
        </p>
      )}
      <main className="min-h-0 flex-1 overflow-auto px-6 py-5">
        <SurfaceKindRenderer
          intent={intent}
          presentation="window"
          onAction={actions.onAction}
          onComment={(next) => (comments.supported ? setAnchor(next) : undefined)}
          onOpenStage={() => undefined}
        />
      </main>
      {actions.confirmElement}
      {share.dialog}
    </div>
  );
}
