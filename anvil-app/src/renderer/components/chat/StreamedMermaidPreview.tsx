import DOMPurify from 'dompurify';
import { AlertTriangle, LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { renderMermaid } from '../../utils/mermaid';
import {
  beginStablePreview,
  createStablePreviewState,
  rejectStablePreview,
  resolveStablePreview,
} from './stream-preview-state';

const MERMAID_CONFIG: import('mermaid').MermaidConfig = {
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'dark',
  themeVariables: {
    primaryColor: '#172033',
    primaryTextColor: '#f8fbff',
    primaryBorderColor: '#33415f',
    lineColor: '#95a3b8',
    secondaryColor: '#111827',
    tertiaryColor: '#0b1020',
    edgeLabelBackground: '#111827',
    fontFamily: 'IBM Plex Sans, system-ui, sans-serif',
  },
};

const RENDER_DEBOUNCE_MS = 250;

export function StreamedMermaidPreview({ identity, source }: { identity: string; source: string }) {
  const [preview, setPreview] = useState(() => createStablePreviewState<string>());
  const requestIdRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestIdRef.current;
    const renderId = `anvil-mermaid-${crypto.randomUUID()}`;
    let cancelled = false;

    setPreview((current) => beginStablePreview(current, identity, source, requestId));

    if (!source.trim()) {
      return () => {
        cancelled = true;
        document.getElementById(renderId)?.remove();
      };
    }

    const timeout = window.setTimeout(() => {
      void renderMermaid(renderId, source.replace(/\\n/g, '\n'), MERMAID_CONFIG)
        .then(({ svg }) => {
          if (cancelled) return;
          const safeSvg = DOMPurify.sanitize(svg, {
            USE_PROFILES: { svg: true, svgFilters: true },
            ADD_TAGS: ['foreignObject'],
          });
          setPreview((current) =>
            resolveStablePreview(current, identity, source, requestId, safeSvg),
          );
        })
        .catch((renderError: unknown) => {
          if (cancelled) return;
          const detail = renderError instanceof Error ? renderError.message : String(renderError);
          setPreview((current) =>
            rejectStablePreview(current, identity, source, requestId, detail),
          );
        })
        .finally(() => document.getElementById(renderId)?.remove());
    }, RENDER_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      document.getElementById(renderId)?.remove();
    };
  }, [identity, source]);

  const currentPreview = preview.identity === identity ? preview : null;
  const svg = currentPreview?.value ?? null;
  const isCurrentRequest = currentPreview?.requestedSource === source;
  const hasSource = Boolean(source.trim());
  const isPending = hasSource
    ? !isCurrentRequest || currentPreview?.status === 'pending'
    : Boolean(svg);
  const error =
    isCurrentRequest && currentPreview?.status === 'error' ? currentPreview.error : null;

  return (
    <div className="min-h-full overflow-auto p-4">
      <div
        className={`mb-2 flex h-5 items-center gap-2 overflow-hidden text-xs ${error ? 'text-warning' : 'text-text-tertiary'}`}
        role={error ? 'alert' : isPending ? 'status' : undefined}
        aria-live={error || isPending ? 'polite' : undefined}
        title={error ?? undefined}
      >
        {error ? (
          <AlertTriangle size={14} className="shrink-0" />
        ) : isPending ? (
          <LoaderCircle size={14} className="shrink-0 animate-spin" />
        ) : null}
        <span className="truncate">
          {error
            ? svg
              ? 'Diagram update failed. The last valid preview is still shown.'
              : 'Diagram could not be rendered yet. The source is still available below.'
            : isPending
              ? svg
                ? 'Updating diagram preview…'
                : 'Rendering diagram…'
              : null}
        </span>
      </div>
      {svg ? (
        <div
          className="flex min-h-12 items-start justify-center [&_svg]:h-auto [&_svg]:max-w-full"
          role="img"
          aria-label="Mermaid diagram"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <pre className="overflow-auto whitespace-pre-wrap rounded-md border border-border-subtle bg-bg-tertiary p-3 text-xs leading-relaxed text-text-secondary [overflow-wrap:anywhere]">
          <code>{source || 'Waiting for diagram source…'}</code>
        </pre>
      )}
      {error && (
        <details className="mt-2 text-xs text-text-tertiary">
          <summary className="cursor-pointer hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
            Show rendering error
          </summary>
          <p className="mt-1 max-h-32 overflow-auto break-words rounded bg-bg-tertiary px-2 py-1">
            {error}
          </p>
        </details>
      )}
    </div>
  );
}
