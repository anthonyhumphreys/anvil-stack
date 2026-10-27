// Script-free share snapshot for the Diagram surface (§11.3).
// - Mermaid: main cannot render Mermaid, so the snapshot embeds the
//   renderer's pre-rendered SVG when the share options carry one
//   (`diagramSvg`, sanitised here) and always includes the source.
// - draw.io: the read-only geometry drawing (same model the renderer uses)
//   plus the XML source.
import {
  describeDiagramFormat,
  type DiagramSurfaceData,
} from '../../../../shared/surfaces/kinds/diagram.js';
import {
  buildDrawioSvgModel,
  drawioEdgePath,
  drawioLabelBaselines,
  drawioNodeOutline,
  parseDrawio,
  type DrawioSvgModel,
  type DrawioSvgNode,
} from '../../../../shared/surfaces/kinds/diagram/drawio.js';
import { sanitizeSvg } from '../../../services/share-bundle.service.js';
import type { ShareSnapshot, ShareSnapshotOptions } from '../../types.js';
import { SHARE_BASE_CSS, assertScriptFree, escapeHtml, wrapSnapshot } from '../data/share-kit.js';

/** Share options as they reach kind snapshots, plus the renderer's pre-rendered diagram. */
export type DiagramSnapshotOptions = Partial<ShareSnapshotOptions> & { diagramSvg?: string };

const MAX_SNAPSHOT_SOURCE = 200_000;

const DIAGRAM_CSS = `
.sv .dg-figure { margin: 0 0 16px; padding: 12px; border: 1px solid var(--color-border-subtle);
  border-radius: 8px; overflow: auto; }
.sv .dg-figure svg { margin: 0 auto; }
.sv .dg-caption { color: var(--color-text-tertiary); font-size: 12px; margin: 0 0 4px; }
.sv .dg-shape { fill: var(--color-bg-secondary); stroke: var(--color-border); stroke-width: 1; }
.sv .dg-container { fill: none; stroke: var(--color-border); stroke-dasharray: 4 3; }
.sv .dg-edge { fill: none; stroke: var(--color-text-tertiary); stroke-width: 1.2; }
.sv .dg-edge-dashed { stroke-dasharray: 5 4; }
.sv .dg-arrow { fill: var(--color-text-tertiary); }
.sv svg text.dg-label { fill: var(--color-text-primary); font-size: 12px; }
.sv svg text.dg-edge-label { fill: var(--color-text-secondary); font-size: 11px;
  paint-order: stroke; stroke: var(--color-bg-primary); stroke-width: 3px; }
`;

function nodeSvg(node: DrawioSvgNode): string {
  const outline = drawioNodeOutline(node);
  let shape = '';
  if (outline.kind === 'rect') {
    shape = `<rect class="${outline.dashed ? 'dg-container' : 'dg-shape'}" width="${node.width}" height="${node.height}" rx="${outline.rx}"/>`;
  } else if (outline.kind === 'ellipse') {
    shape = `<ellipse class="dg-shape" cx="${outline.cx}" cy="${outline.cy}" rx="${outline.rx}" ry="${outline.ry}"/>`;
  } else if (outline.kind === 'path') {
    shape = `<path class="dg-shape" d="${outline.d}"/>`;
  }
  const baselines = drawioLabelBaselines(node);
  const text = node.lines
    .map(
      (line, index) =>
        `<text class="dg-label" x="${node.width / 2}" y="${baselines[index]}" text-anchor="middle">${escapeHtml(line)}</text>`,
    )
    .join('');
  return `<g transform="translate(${node.x},${node.y})"><title>${escapeHtml(node.label || node.id)}</title>${shape}${text}</g>`;
}

export function drawioModelSvg(model: DrawioSvgModel, title: string): string {
  const edges = model.edges
    .map((edge) => {
      const path = `<path class="dg-edge${edge.dashed ? ' dg-edge-dashed' : ''}" d="${drawioEdgePath(edge.points)}"${edge.arrow ? ' marker-end="url(#dg-arrow)"' : ''}/>`;
      const label = edge.label
        ? `<text class="dg-edge-label" x="${edge.labelX}" y="${edge.labelY + 4}" text-anchor="middle">${escapeHtml(edge.label)}</text>`
        : '';
      return `${path}${label}`;
    })
    .join('');
  const containers = model.nodes.filter((node) => node.shape === 'container').map(nodeSvg);
  const nodes = model.nodes.filter((node) => node.shape !== 'container').map(nodeSvg);
  const description = `draw.io diagram with ${model.nodes.length} shapes and ${model.edges.length} connectors.`;
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" viewBox="0 0 ${model.width} ${model.height}" width="${model.width}" height="${model.height}"><title>${escapeHtml(title)}</title><desc>${escapeHtml(description)}</desc><defs><marker id="dg-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="dg-arrow" d="M0 0 8 4 0 8Z"/></marker></defs>${containers.join('')}${edges}${nodes.join('')}</svg>`;
}

function sourceBlock(source: string, summary: string, open: boolean): string {
  const clipped =
    source.length > MAX_SNAPSHOT_SOURCE
      ? `${source.slice(0, MAX_SNAPSHOT_SOURCE)}\n… (${source.length - MAX_SNAPSHOT_SOURCE} more characters not included)`
      : source;
  return `<details${open ? ' open' : ''}><summary>${escapeHtml(summary)}</summary><pre><code>${escapeHtml(clipped)}</code></pre></details>`;
}

export function diagramSnapshot(
  data: DiagramSurfaceData,
  title: string,
  options: DiagramSnapshotOptions = {},
): ShareSnapshot {
  const flavour = describeDiagramFormat(data);
  const nodeCount = data.nodes?.length ?? 0;
  const meta = [flavour, nodeCount ? `${nodeCount} nodes` : '', data.savedPath ?? '']
    .filter(Boolean)
    .join(' · ');
  const parts: string[] = [];
  if (data.description) parts.push(`<p>${escapeHtml(data.description)}</p>`);

  if (data.format === 'mermaid') {
    const svg = options.diagramSvg ? sanitizeSvg(options.diagramSvg) : null;
    if (svg) {
      parts.push(
        `<figure class="dg-figure" role="img" aria-label="${escapeHtml(title)}">${svg}</figure>`,
        sourceBlock(data.source, 'Mermaid source', false),
      );
    } else {
      parts.push(
        '<p class="dg-caption">Mermaid source. No rendered image was available when this was shared; paste it into any Mermaid viewer to draw it.</p>',
        sourceBlock(data.source, 'Mermaid source', true),
      );
    }
  } else {
    const parsed = parseDrawio(data.source);
    const model = parsed.compressed ? null : buildDrawioSvgModel(parsed);
    if (model && model.nodes.length > 0) {
      const pages = parsed.pageCount > 1 ? ` First of ${parsed.pageCount} pages shown.` : '';
      parts.push(
        `<p class="dg-caption">Simplified drawing of the draw.io diagram (shapes, labels and connectors).${escapeHtml(pages)} Open the XML in draw.io for full fidelity.</p>`,
        `<figure class="dg-figure">${drawioModelSvg(model, title)}</figure>`,
        sourceBlock(data.source, 'draw.io XML', false),
      );
    } else {
      parts.push(
        '<p class="dg-caption">draw.io XML. Save it as a .drawio file and open it in draw.io to view the diagram.</p>',
        sourceBlock(data.source, 'draw.io XML', true),
      );
    }
  }

  const html = wrapSnapshot(title, meta, parts.join(''));
  assertScriptFree(html);
  return { html, css: `${SHARE_BASE_CSS}${DIAGRAM_CSS}` };
}

/** Drops fields that only make sense inside the sharer's workspace. */
export function redactDiagram(data: DiagramSurfaceData): DiagramSurfaceData {
  // The repo id is a local identifier; savedPath is already repo-relative.
  const { repoId: _repoId, ...rest } = data;
  void _repoId;
  return rest;
}
