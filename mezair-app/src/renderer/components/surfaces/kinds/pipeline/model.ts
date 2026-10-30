import {
  compactPipelineGraph,
  type PipelineEdge,
  type PipelineNode,
  type PipelineNodeStatus,
  type PipelineSurfaceData,
} from '../../../../../shared/surfaces/kinds/pipeline';
import {
  layoutDag,
  type GraphLayout,
  type LayoutOptions,
} from '../../../../../shared/surfaces/kinds/pipeline/layout';
import type { SurfaceAnchor } from '../../../../../shared/surfaces/types';

export const STATUS_META: Record<
  PipelineNodeStatus,
  { label: string; textClass: string; stroke: string }
> = {
  configured: { label: 'Configured', textClass: 'text-success', stroke: 'var(--color-border)' },
  warning: { label: 'Warning', textClass: 'text-warning', stroke: 'var(--color-warning)' },
  error: { label: 'Error', textClass: 'text-error', stroke: 'var(--color-error)' },
};

export function readPipelineData(data: unknown): PipelineSurfaceData {
  const value = (data ?? {}) as Partial<PipelineSurfaceData>;
  return {
    repoId: value.repoId ?? '',
    generatedAt: value.generatedAt ?? '',
    ...value,
    providers: Array.isArray(value.providers) ? value.providers : [],
    files: Array.isArray(value.files) ? value.files : [],
    nodes: Array.isArray(value.nodes) ? value.nodes : [],
    edges: Array.isArray(value.edges) ? value.edges : [],
    issues: Array.isArray(value.issues) ? value.issues : [],
  } as PipelineSurfaceData;
}

export interface PreparedGraph {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  hiddenSteps: Map<string, number>;
  layout: GraphLayout;
  byId: Map<string, PipelineNode>;
}

export const INLINE_LAYOUT: LayoutOptions = { nodeWidth: 152, nodeHeight: 40, gapX: 36, gapY: 10 };
export const STAGE_LAYOUT: LayoutOptions = { nodeWidth: 176, nodeHeight: 44, gapX: 52, gapY: 14 };

export function prepareGraph(
  data: Pick<PipelineSurfaceData, 'nodes' | 'edges'>,
  includeSteps: boolean,
  options: LayoutOptions,
): PreparedGraph {
  const view = compactPipelineGraph(data, includeSteps);
  return {
    ...view,
    layout: layoutDag(view.nodes, view.edges, options),
    byId: new Map(view.nodes.map((node) => [node.id, node])),
  };
}

/** Keyboard movement through the graph: right = downstream, left = upstream, up/down = same layer. */
export function neighbourNode(
  graph: Pick<PreparedGraph, 'layout'>,
  currentId: string | null,
  key: 'ArrowRight' | 'ArrowLeft' | 'ArrowUp' | 'ArrowDown',
): string | null {
  const { nodes, edges } = graph.layout;
  if (nodes.length === 0) return null;
  const current = nodes.find((node) => node.id === currentId);
  if (!current) return nodes[0].id;
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const sameLayer = nodes
      .filter((node) => node.layer === current.layer)
      .sort((a, b) => a.order - b.order);
    const index = sameLayer.findIndex((node) => node.id === current.id);
    const next = sameLayer[index + (key === 'ArrowDown' ? 1 : -1)];
    return next?.id ?? current.id;
  }
  const candidates = edges
    .filter((edge) => (key === 'ArrowRight' ? edge.from === current.id : edge.to === current.id))
    .map((edge) => nodes.find((node) => node.id === (key === 'ArrowRight' ? edge.to : edge.from)))
    .filter((node): node is NonNullable<typeof node> => Boolean(node))
    .sort((a, b) => Math.abs(a.y - current.y) - Math.abs(b.y - current.y));
  if (candidates[0]) return candidates[0].id;
  // No edge that way: fall back to the nearest node in the adjacent layer.
  const layer = current.layer + (key === 'ArrowRight' ? 1 : -1);
  const adjacent = nodes
    .filter((node) => node.layer === layer)
    .sort((a, b) => Math.abs(a.y - current.y) - Math.abs(b.y - current.y));
  return adjacent[0]?.id ?? current.id;
}

export interface Viewport {
  x: number;
  y: number;
  scale: number;
}

export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 2.5;

export function clampZoom(scale: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale));
}

/** Zoom by `factor` keeping the point (px, py) in screen space fixed. */
export function zoomAround(viewport: Viewport, factor: number, px: number, py: number): Viewport {
  const scale = clampZoom(viewport.scale * factor);
  const ratio = scale / viewport.scale;
  return { scale, x: px - (px - viewport.x) * ratio, y: py - (py - viewport.y) * ratio };
}

/** Fit the layout into a box (never upscales past 1). */
export function fitViewport(
  layout: Pick<GraphLayout, 'width' | 'height'>,
  width: number,
  height: number,
  padding = 16,
): Viewport {
  const scale = clampZoom(
    Math.min(
      1,
      (width - padding * 2) / Math.max(1, layout.width),
      (height - padding * 2) / Math.max(1, layout.height),
    ),
  );
  return {
    scale,
    x: (width - layout.width * scale) / 2,
    y: Math.max(padding, (height - layout.height * scale) / 2),
  };
}

/** Pan so a node is visible within the box. */
export function ensureVisible(
  viewport: Viewport,
  node: { x: number; y: number; width: number; height: number },
  width: number,
  height: number,
  margin = 24,
): Viewport {
  const left = viewport.x + node.x * viewport.scale;
  const right = left + node.width * viewport.scale;
  const top = viewport.y + node.y * viewport.scale;
  const bottom = top + node.height * viewport.scale;
  let { x, y } = viewport;
  if (left < margin) x += margin - left;
  else if (right > width - margin) x -= right - (width - margin);
  if (top < margin) y += margin - top;
  else if (bottom > height - margin) y -= bottom - (height - margin);
  return { ...viewport, x, y };
}

export function nodeAnchor(node: PipelineNode): SurfaceAnchor {
  return {
    type: 'node',
    targetId: node.id,
    filePath: node.filePath,
    ...(node.excerptStartLine ? { lineStart: node.excerptStartLine } : {}),
    label: `${node.type} ${node.label}`,
  };
}

export function truncateLabel(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
