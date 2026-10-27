import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { buildSketchDocument } from '../../../../../shared/surfaces/sketch-runtime';
import { requestChatPrefill } from '../../../chat/chat-prefill';
import { sketchThemeName, useSketchTokens } from '../../sketch-tokens';
import { describeRegion, normaliseRegion } from '../../surface-utils';
import { clampSketchHeight, parseSketchBridgeMessage } from './sketch-bridge';

export interface SketchRegion {
  rect: { x: number; y: number; width: number; height: number };
  label: string;
}

/**
 * Sandboxed, opaque-origin frame for a sketch. Grows to its reported content
 * height (never scrolls inside the thread), follows theme changes live and
 * accepts bridge messages only from its own contentWindow.
 */
export function SketchFrame({
  html,
  title,
  initialHeight,
  selectingRegion = false,
  onRegion,
  onCancelRegion,
  className = '',
}: {
  html: string;
  title: string;
  initialHeight?: number;
  selectingRegion?: boolean;
  onRegion?: (region: SketchRegion) => void;
  onCancelRegion?: () => void;
  className?: string;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const tokens = useSketchTokens();
  const tokensRef = useRef(tokens);
  tokensRef.current = tokens;
  const [height, setHeight] = useState(() => clampSketchHeight(initialHeight ?? 160));
  const srcDoc = useMemo(
    () => buildSketchDocument(html, { tokens: tokensRef.current, mode: 'inline' }),
    [html],
  );

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const hostWindow = iframe.ownerDocument.defaultView ?? window;
    const post = (message: unknown) => iframe.contentWindow?.postMessage(message, '*');
    const respond = (id: string | number | undefined, result: unknown) => {
      if (id !== undefined) post({ jsonrpc: '2.0', id, result });
    };
    const handleMessage = (event: MessageEvent) => {
      if (!iframe.contentWindow || event.source !== iframe.contentWindow) return;
      const message = parseSketchBridgeMessage(event.data);
      switch (message.kind) {
        case 'initialize':
          respond(message.id, {
            protocolVersion: '2026-01-26',
            hostInfo: { name: 'Mezair' },
            hostCapabilities: { openLinks: {} },
            hostContext: {
              theme: sketchThemeName(tokensRef.current),
              displayMode: 'inline',
              styles: { variables: tokensRef.current },
            },
          });
          break;
        case 'size':
          setHeight(message.height);
          break;
        case 'open-link':
          window.open(message.url, '_blank', 'noopener,noreferrer');
          respond(message.id, {});
          break;
        case 'ask':
          requestChatPrefill(message.prompt);
          respond(message.id, {});
          break;
        case 'unsupported-request':
          post({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: 'Method not available in Mezair sketches' },
          });
          break;
        default:
          break;
      }
    };
    hostWindow.addEventListener('message', handleMessage);
    return () => hostWindow.removeEventListener('message', handleMessage);
  }, [srcDoc]);

  const appliedTokensRef = useRef(tokens);
  useEffect(() => {
    if (appliedTokensRef.current === tokens) return;
    appliedTokensRef.current = tokens;
    iframeRef.current?.contentWindow?.postMessage(
      {
        jsonrpc: '2.0',
        method: 'ui/notifications/host-context-changed',
        params: { theme: sketchThemeName(tokens), styles: { variables: tokens } },
      },
      '*',
    );
  }, [tokens]);

  return (
    <div className={`relative ${className}`.trim()}>
      <iframe
        ref={iframeRef}
        title={title}
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        referrerPolicy="no-referrer"
        scrolling="no"
        className="block w-full border-0 bg-transparent"
        style={{ height }}
      />
      {selectingRegion && onRegion && (
        <RegionSelector onRegion={onRegion} onCancel={() => onCancelRegion?.()} />
      )}
    </div>
  );
}

function RegionSelector({
  onRegion,
  onCancel,
}: {
  onRegion: (region: SketchRegion) => void;
  onCancel: () => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [start, setStart] = useState<{ x: number; y: number } | null>(null);
  const [current, setCurrent] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    overlayRef.current?.focus({ preventScroll: true });
  }, []);

  const point = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const finish = (event: PointerEvent<HTMLDivElement>) => {
    if (!start) return;
    const box = event.currentTarget.getBoundingClientRect();
    const region = normaliseRegion(start, point(event), box);
    setStart(null);
    setCurrent(null);
    if (region) onRegion({ rect: region, label: describeRegion(region) });
  };

  const selection =
    start && current
      ? {
          left: Math.min(start.x, current.x),
          top: Math.min(start.y, current.y),
          width: Math.abs(current.x - start.x),
          height: Math.abs(current.y - start.y),
        }
      : null;

  return (
    <div
      ref={overlayRef}
      tabIndex={0}
      role="application"
      aria-label="Drag to select a region of the sketch to comment on. Press Escape to cancel."
      className="absolute inset-0 cursor-crosshair rounded-md bg-bg-primary/10 outline outline-1 outline-border focus-visible:outline-2 focus-visible:outline-accent"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        const next = point(event);
        setStart(next);
        setCurrent(next);
      }}
      onPointerMove={(event) => {
        if (start) setCurrent(point(event));
      }}
      onPointerUp={finish}
      onPointerCancel={() => {
        setStart(null);
        setCurrent(null);
      }}
    >
      {selection && (
        <div
          aria-hidden="true"
          className="absolute border-2 border-accent bg-accent/10"
          style={selection}
        />
      )}
    </div>
  );
}
