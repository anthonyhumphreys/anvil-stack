import { useId } from 'react';
import {
  drawioEdgePath,
  drawioLabelBaselines,
  drawioNodeOutline,
  type DrawioSvgModel,
  type DrawioSvgNode,
} from '../../../../../shared/surfaces/kinds/diagram/drawio';

function NodeShape({ node, selected }: { node: DrawioSvgNode; selected: boolean }) {
  const outline = drawioNodeOutline(node);
  const stroke = selected ? 'var(--color-accent)' : 'var(--color-border)';
  const strokeWidth = selected ? 2 : 1;
  if (outline.kind === 'rect') {
    return (
      <rect
        width={node.width}
        height={node.height}
        rx={outline.rx}
        fill={outline.dashed ? 'none' : 'var(--color-bg-secondary)'}
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeDasharray={outline.dashed && !selected ? '4 3' : undefined}
      />
    );
  }
  if (outline.kind === 'ellipse') {
    return (
      <ellipse
        cx={outline.cx}
        cy={outline.cy}
        rx={outline.rx}
        ry={outline.ry}
        fill="var(--color-bg-secondary)"
        stroke={stroke}
        strokeWidth={strokeWidth}
      />
    );
  }
  if (outline.kind === 'path') {
    return (
      <path
        d={outline.d}
        fill="var(--color-bg-secondary)"
        stroke={stroke}
        strokeWidth={strokeWidth}
      />
    );
  }
  return selected ? (
    <rect
      width={node.width}
      height={node.height}
      rx={4}
      fill="none"
      stroke={stroke}
      strokeWidth={strokeWidth}
    />
  ) : null;
}

/**
 * Read-only drawing of draw.io geometry: shapes, wrapped labels and
 * connectors in theme colours (the source's own colours are ignored so the
 * drawing stays legible in every theme).
 */
export function DrawioSvg({
  model,
  title,
  selectedId,
  onSelectNode,
}: {
  model: DrawioSvgModel;
  title: string;
  selectedId?: string | null;
  onSelectNode?: (id: string) => void;
}) {
  const markerId = `dg-arrow-${useId().replace(/:/g, '')}`;
  const containers = model.nodes.filter((node) => node.shape === 'container');
  const shapes = model.nodes.filter((node) => node.shape !== 'container');
  const renderNode = (node: DrawioSvgNode) => {
    const baselines = drawioLabelBaselines(node);
    const selected = node.id === selectedId;
    return (
      <g
        key={node.id}
        data-node-id={node.id}
        transform={`translate(${node.x},${node.y})`}
        onClick={
          onSelectNode
            ? (event) => {
                event.stopPropagation();
                onSelectNode(node.id);
              }
            : undefined
        }
        className={onSelectNode ? 'cursor-pointer' : undefined}
      >
        <title>{node.label || node.id}</title>
        <NodeShape node={node} selected={selected} />
        {node.lines.map((line, index) => (
          <text
            key={index}
            x={node.width / 2}
            y={baselines[index]}
            textAnchor="middle"
            className="fill-text-primary text-[12px]"
          >
            {line}
          </text>
        ))}
      </g>
    );
  };

  return (
    <svg
      role="img"
      aria-label={`${title}: draw.io diagram with ${model.nodes.length} shapes and ${model.edges.length} connectors`}
      width={model.width}
      height={model.height}
      viewBox={`0 0 ${model.width} ${model.height}`}
      className="block select-none"
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
          <path d="M0 0 8 4 0 8Z" fill="var(--color-text-tertiary)" />
        </marker>
      </defs>
      {containers.map(renderNode)}
      {model.edges.map((edge) => (
        <g key={edge.id}>
          <path
            d={drawioEdgePath(edge.points)}
            fill="none"
            stroke="var(--color-text-tertiary)"
            strokeWidth={1.2}
            strokeDasharray={edge.dashed ? '5 4' : undefined}
            markerEnd={edge.arrow ? `url(#${markerId})` : undefined}
          />
          {edge.label && (
            <text
              x={edge.labelX}
              y={edge.labelY + 4}
              textAnchor="middle"
              className="fill-text-secondary text-[11px]"
              style={{ paintOrder: 'stroke', stroke: 'var(--color-bg-primary)', strokeWidth: 3 }}
            >
              {edge.label}
            </text>
          )}
        </g>
      ))}
      {shapes.map(renderNode)}
    </svg>
  );
}
