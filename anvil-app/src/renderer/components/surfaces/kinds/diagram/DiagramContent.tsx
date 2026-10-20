import { useMemo, type MouseEvent } from 'react';
import { AlertTriangle, LoaderCircle } from 'lucide-react';
import type { DiagramSurfaceData } from '../../../../../shared/surfaces/kinds/diagram';
import { DrawioSvg } from './DrawioSvg';
import { drawioView, mermaidNodeIdFromElement, type DrawioView } from './model';
import { useMermaidSvg, type MermaidRender } from './useMermaidSvg';

export interface DiagramRender {
  format: DiagramSurfaceData['format'];
  /** Natural size of the drawing in CSS pixels (0 while unknown). */
  width: number;
  height: number;
  ready: boolean;
  mermaid: MermaidRender | null;
  drawio: DrawioView | null;
}

/** Renders the diagram (Mermaid via the app's Mermaid util, draw.io via the geometry model). */
export function useDiagramRender(data: DiagramSurfaceData): DiagramRender {
  const mermaid = useMermaidSvg(data.format === 'mermaid' ? data.source : '');
  const drawio = useMemo(
    () => (data.format === 'drawio' ? drawioView(data.source) : null),
    [data.format, data.source],
  );
  if (data.format === 'drawio') {
    return {
      format: 'drawio',
      width: drawio?.model?.width ?? 0,
      height: drawio?.model?.height ?? 0,
      ready: Boolean(drawio?.model),
      mermaid: null,
      drawio,
    };
  }
  return {
    format: 'mermaid',
    width: mermaid.width,
    height: mermaid.height,
    ready: Boolean(mermaid.svg),
    mermaid,
    drawio: null,
  };
}

/** Status line for Mermaid rendering (pending / failed, last good render kept). */
export function DiagramRenderStatus({ render }: { render: DiagramRender }) {
  const mermaid = render.mermaid;
  if (render.format === 'drawio') {
    if (render.drawio?.model) return null;
    return (
      <p className="text-xs text-text-tertiary">
        {render.drawio?.compressed
          ? 'This draw.io page is compressed, so Anvil can’t draw it here. Open it in draw.io or view the source.'
          : 'Nothing to draw yet. View the source or open it in draw.io.'}
      </p>
    );
  }
  if (!mermaid || mermaid.status === 'ready' || mermaid.status === 'idle') return null;
  if (mermaid.status === 'pending') {
    return (
      <p role="status" className="flex items-center gap-2 text-xs text-text-tertiary">
        <LoaderCircle size={14} aria-hidden="true" className="motion-safe:animate-spin" />
        {mermaid.svg ? 'Updating diagram…' : 'Rendering diagram…'}
      </p>
    );
  }
  return (
    <div role="alert" className="flex flex-col gap-1 text-xs text-warning">
      <p className="flex items-center gap-2">
        <AlertTriangle size={14} aria-hidden="true" className="shrink-0" />
        {mermaid.svg
          ? 'The latest version could not be rendered. The last valid drawing is shown.'
          : 'This diagram could not be rendered. The source is shown instead.'}
      </p>
      {mermaid.error && (
        <details className="text-text-tertiary">
          <summary className="cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50">
            Show rendering error
          </summary>
          <p className="mt-1 max-h-32 overflow-auto break-words rounded bg-bg-tertiary px-2 py-1">
            {mermaid.error}
          </p>
        </details>
      )}
    </div>
  );
}

/** Copyable source block in Plex Mono. */
export function DiagramSource({ source, className }: { source: string; className?: string }) {
  return (
    <pre
      tabIndex={0}
      aria-label="Diagram source"
      className={`overflow-auto whitespace-pre rounded-lg border border-border-subtle bg-bg-tertiary p-3 font-mono text-xs leading-relaxed text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${className ?? ''}`}
    >
      <code>{source}</code>
    </pre>
  );
}

/**
 * The drawing itself at natural size. Mouse clicks on nodes report the node
 * id; keyboard users pick nodes from the node list instead.
 */
export function DiagramDrawing({
  data,
  render,
  selectedId,
  onSelectNode,
}: {
  data: DiagramSurfaceData;
  render: DiagramRender;
  selectedId?: string | null;
  onSelectNode?: (id: string) => void;
}) {
  const knownIds = useMemo(() => new Set((data.nodes ?? []).map((node) => node.id)), [data.nodes]);
  if (render.format === 'drawio') {
    const model = render.drawio?.model;
    return model ? (
      <DrawioSvg
        model={model}
        title={data.title}
        selectedId={selectedId}
        onSelectNode={onSelectNode}
      />
    ) : (
      <DiagramSource source={data.source} />
    );
  }
  const svg = render.mermaid?.svg;
  if (!svg) {
    return render.mermaid?.status === 'error' ? <DiagramSource source={data.source} /> : null;
  }
  const handleClick = onSelectNode
    ? (event: MouseEvent<HTMLDivElement>) => {
        const target = (event.target as Element).closest?.('g.node, g[data-id], g[id]');
        const id = mermaidNodeIdFromElement(target ?? null, knownIds);
        if (id) {
          event.stopPropagation();
          onSelectNode(id);
        }
      }
    : undefined;
  return (
    <div
      role="img"
      aria-label={`${data.title}: Mermaid diagram${knownIds.size ? ` with ${knownIds.size} nodes` : ''}`}
      onClick={handleClick}
      className="[&_svg]:block"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
