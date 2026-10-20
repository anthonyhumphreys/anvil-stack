// Script-free share snapshot for the Pipeline surface: a static SVG graph
// (shared layered layout) plus the validation issues table.
import {
  compactPipelineGraph,
  issuesByNode,
  type PipelineNodeStatus,
  type PipelineSurfaceData,
} from '../../../../shared/surfaces/kinds/pipeline.js';
import { edgePath, layoutDag } from '../../../../shared/surfaces/kinds/pipeline/layout.js';
import type { ShareSnapshot } from '../../types.js';
import {
  SHARE_BASE_CSS,
  assertScriptFree,
  escapeHtml,
  htmlTable,
  wrapSnapshot,
} from '../data/share-kit.js';

const FULL_GRAPH_MAX_NODES = 80;

const STATUS: Record<PipelineNodeStatus, { glyph: string; color: string; label: string }> = {
  configured: { glyph: '✓', color: 'var(--color-success)', label: 'Configured' },
  warning: { glyph: '▲', color: 'var(--color-warning)', label: 'Warning' },
  error: { glyph: '✕', color: 'var(--color-error)', label: 'Error' },
};

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function pipelineSvg(data: PipelineSurfaceData): string {
  const view = compactPipelineGraph(data, data.nodes.length <= FULL_GRAPH_MAX_NODES);
  const layout = layoutDag(view.nodes, view.edges);
  const byId = new Map(view.nodes.map((node) => [node.id, node]));
  const issues = issuesByNode(data.issues);
  const edges = layout.edges
    .map(
      (edge) =>
        `<path d="${edgePath(edge)}" fill="none" stroke="var(--color-border)" stroke-width="1"${edge.back ? ' stroke-dasharray="4 3"' : ''}/>`,
    )
    .join('');
  const nodes = layout.nodes
    .map((placed) => {
      const node = byId.get(placed.id)!;
      const status = STATUS[node.status];
      const issueCount = issues.get(node.id)?.length ?? 0;
      const steps = view.hiddenSteps.get(node.id);
      const subtitle = [
        node.type,
        steps ? `${steps} steps` : '',
        issueCount ? `${issueCount} issues` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      return `<g transform="translate(${placed.x},${placed.y})"><title>${escapeHtml(`${node.label} (${node.type}, ${status.label})`)}</title><rect width="${placed.width}" height="${placed.height}" rx="8" fill="var(--color-bg-secondary)" stroke="${node.status === 'configured' ? 'var(--color-border)' : status.color}" stroke-width="1"/><text x="10" y="18" style="fill:${status.color}">${status.glyph}</text><text x="24" y="18" style="fill:var(--color-text-primary);font-weight:500">${escapeHtml(truncate(node.label, 22))}</text><text x="10" y="34">${escapeHtml(truncate(subtitle, 30))}</text></g>`;
    })
    .join('');
  const description = `Pipeline graph with ${view.nodes.length} nodes and ${view.edges.length} edges.`;
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}"><title>Pipeline graph</title><desc>${escapeHtml(description)}</desc>${edges}${nodes}</svg>`;
}

export function pipelineSnapshot(data: PipelineSurfaceData, title: string): ShareSnapshot {
  const nodeLabel = new Map(data.nodes.map((node) => [node.id, node.label]));
  const issueTable =
    data.issues.length > 0
      ? htmlTable(
          [
            {
              label: 'Severity',
              cell: (issue) =>
                `<span class="sev-${issue.severity === 'error' ? 'high' : issue.severity === 'warning' ? 'medium' : 'info'}">${escapeHtml(issue.severity)}</span>`,
            },
            { label: 'File', cell: (issue) => `<code>${escapeHtml(issue.filePath)}</code>` },
            {
              label: 'Node',
              cell: (issue) => escapeHtml(issue.nodeId ? (nodeLabel.get(issue.nodeId) ?? '') : ''),
            },
            { label: 'Issue', cell: (issue) => escapeHtml(issue.message) },
          ],
          data.issues,
        )
      : '<p class="muted">No validation issues.</p>';
  const files = htmlTable(
    [
      { label: 'File', cell: (file) => `<code>${escapeHtml(file.path)}</code>` },
      { label: 'Provider', cell: (file) => escapeHtml(file.provider) },
      { label: 'Role', cell: (file) => escapeHtml(file.role) },
      {
        label: 'Valid',
        cell: (file) => (file.valid ? '✓ Valid' : `✕ ${escapeHtml(file.error ?? 'Invalid')}`),
      },
    ],
    data.files,
  );
  const meta = `${data.repoName ?? data.repoId} · ${data.files.length} files · ${data.issues.length} issues`;
  const graph =
    data.nodes.length > 0 ? pipelineSvg(data) : '<p class="muted">No pipeline nodes.</p>';
  const html = wrapSnapshot(title, meta, `${graph}${issueTable}${files}`);
  assertScriptFree(html);
  return { html, css: SHARE_BASE_CSS };
}
