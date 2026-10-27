import { useId, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react';
import type {
  PipelineIssue,
  PipelineNodeStatus,
} from '../../../../../shared/surfaces/kinds/pipeline';
import { edgePath } from '../../../../../shared/surfaces/kinds/pipeline/layout';
import { cx } from '../../../ui';
import {
  STATUS_META,
  neighbourNode,
  truncateLabel,
  type PreparedGraph,
  type Viewport,
} from './model';

export function StatusGlyph({
  status,
  x,
  y,
}: {
  status: PipelineNodeStatus;
  x: number;
  y: number;
}) {
  const color =
    status === 'error'
      ? 'var(--color-error)'
      : status === 'warning'
        ? 'var(--color-warning)'
        : 'var(--color-success)';
  if (status === 'warning') {
    return (
      <g transform={`translate(${x},${y})`} aria-hidden="true">
        <path d="M6 0.5 11.5 10.5H0.5Z" fill={color} />
        <path d="M6 4v3" stroke="var(--color-bg-primary)" strokeWidth={1.4} strokeLinecap="round" />
        <circle cx={6} cy={8.6} r={0.8} fill="var(--color-bg-primary)" />
      </g>
    );
  }
  if (status === 'error') {
    return (
      <g transform={`translate(${x},${y})`} aria-hidden="true">
        <circle cx={6} cy={6} r={5.5} fill={color} />
        <path
          d="M4 4l4 4M8 4l-4 4"
          stroke="var(--color-bg-primary)"
          strokeWidth={1.4}
          strokeLinecap="round"
        />
      </g>
    );
  }
  return (
    <g transform={`translate(${x},${y})`} aria-hidden="true">
      <circle cx={6} cy={6} r={5.5} fill="none" stroke={color} strokeWidth={1.2} />
      <path
        d="M3.6 6.2l1.6 1.6 3.2-3.4"
        fill="none"
        stroke={color}
        strokeWidth={1.4}
        strokeLinecap="round"
      />
    </g>
  );
}

export interface PipelineGraphProps {
  graph: PreparedGraph;
  issues: Map<string, PipelineIssue[]>;
  activeId: string | null;
  onSelect: (id: string) => void;
  /** Enter on a node. */
  onActivate?: (id: string) => void;
  /** Extra keys on a focused node (f, c, +/-…). Return true when handled. */
  onNodeKey?: (event: KeyboardEvent<SVGGElement>, id: string) => boolean;
  width: number | string;
  height: number | string;
  viewport?: Viewport;
  labelMax?: number;
  onPointerDown?: (event: PointerEvent<SVGSVGElement>) => void;
  onPointerMove?: (event: PointerEvent<SVGSVGElement>) => void;
  onPointerUp?: (event: PointerEvent<SVGSVGElement>) => void;
  onWheel?: (event: WheelEvent<SVGSVGElement>) => void;
  className?: string;
  label: string;
}

export function PipelineGraph({
  graph,
  issues,
  activeId,
  onSelect,
  onActivate,
  onNodeKey,
  width,
  height,
  viewport,
  labelMax = 20,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onWheel,
  className,
  label,
}: PipelineGraphProps) {
  const markerId = useId().replace(/:/g, '');
  const { layout, byId, hiddenSteps } = graph;
  const nodeHeight = layout.nodes[0]?.height ?? 44;
  const rovingId = activeId && byId.has(activeId) ? activeId : layout.nodes[0]?.id;
  const connected = new Set<string>();
  if (activeId) {
    for (const edge of layout.edges) {
      if (edge.from === activeId || edge.to === activeId) connected.add(`${edge.from}>${edge.to}`);
    }
  }

  const focusNode = (svg: SVGSVGElement | null, id: string | null) => {
    if (!id || !svg) return;
    svg.querySelector<SVGGElement>(`[data-node-id="${CSS.escape(id)}"]`)?.focus();
    onSelect(id);
  };

  const handleKeyDown = (event: KeyboardEvent<SVGGElement>, id: string) => {
    if (
      event.key === 'ArrowRight' ||
      event.key === 'ArrowLeft' ||
      event.key === 'ArrowUp' ||
      event.key === 'ArrowDown'
    ) {
      event.preventDefault();
      focusNode(event.currentTarget.ownerSVGElement, neighbourNode(graph, id, event.key));
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(id);
      onActivate?.(id);
      return;
    }
    onNodeKey?.(event, id);
  };

  return (
    <svg
      role="group"
      aria-label={label}
      width={width}
      height={height}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
      className={cx('block select-none', className)}
    >
      <defs>
        <marker
          id={markerId}
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M0 0 8 4 0 8Z" fill="var(--color-text-muted)" />
        </marker>
      </defs>
      <g
        transform={
          viewport ? `translate(${viewport.x},${viewport.y}) scale(${viewport.scale})` : undefined
        }
      >
        {layout.edges.map((edge) => {
          const highlighted = connected.has(`${edge.from}>${edge.to}`);
          return (
            <path
              key={`${edge.from}>${edge.to}`}
              d={edgePath(edge, nodeHeight)}
              fill="none"
              stroke={highlighted ? 'var(--color-text-secondary)' : 'var(--color-border)'}
              strokeWidth={highlighted ? 1.5 : 1}
              strokeDasharray={edge.back ? '4 3' : undefined}
              markerEnd={`url(#${markerId})`}
            />
          );
        })}
        {layout.nodes.map((placed) => {
          const node = byId.get(placed.id)!;
          const meta = STATUS_META[node.status];
          const nodeIssues = issues.get(node.id) ?? [];
          const steps = hiddenSteps.get(node.id);
          const active = node.id === activeId;
          const subtitle = [node.type, steps ? `${steps} step${steps === 1 ? '' : 's'}` : '']
            .filter(Boolean)
            .join(' · ');
          return (
            <g
              key={node.id}
              data-node-id={node.id}
              role="button"
              tabIndex={node.id === rovingId ? 0 : -1}
              aria-pressed={active}
              aria-label={`${node.type} ${node.label}, ${meta.label}${nodeIssues.length ? `, ${nodeIssues.length} issue${nodeIssues.length === 1 ? '' : 's'}` : ''}${steps ? `, ${steps} steps` : ''}`}
              transform={`translate(${placed.x},${placed.y})`}
              onClick={(event) => {
                event.stopPropagation();
                onSelect(node.id);
              }}
              onDoubleClick={() => onActivate?.(node.id)}
              onKeyDown={(event) => handleKeyDown(event, node.id)}
              className="cursor-pointer outline-none [&:focus-visible>rect]:stroke-[var(--color-accent)] [&:focus-visible>rect]:[stroke-width:2]"
            >
              <title>{`${node.label} (${node.type}) · ${node.filePath}`}</title>
              <rect
                width={placed.width}
                height={placed.height}
                rx={8}
                fill={active ? 'var(--color-bg-tertiary)' : 'var(--color-bg-secondary)'}
                stroke={active ? 'var(--color-accent)' : meta.stroke}
                strokeWidth={active ? 1.5 : 1}
              />
              <StatusGlyph status={node.status} x={10} y={placed.height / 2 - 12} />
              <text
                x={28}
                y={placed.height / 2 - 2}
                className="fill-text-primary text-[12px] font-medium"
              >
                {truncateLabel(node.label, labelMax)}
              </text>
              <text x={28} y={placed.height / 2 + 12} className="fill-text-tertiary text-[11px]">
                {truncateLabel(subtitle, labelMax + 6)}
              </text>
              {nodeIssues.length > 0 && (
                <g transform={`translate(${placed.width - 26},${-7})`} aria-hidden="true">
                  <rect
                    width={24}
                    height={16}
                    rx={8}
                    fill="var(--color-bg-primary)"
                    stroke={
                      nodeIssues.some((issue) => issue.severity === 'error')
                        ? 'var(--color-error)'
                        : 'var(--color-warning)'
                    }
                  />
                  <text
                    x={12}
                    y={12}
                    textAnchor="middle"
                    className="fill-text-primary text-[11px] font-semibold"
                  >
                    {nodeIssues.length}
                  </text>
                </g>
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}
