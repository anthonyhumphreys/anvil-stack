// Maps cicd.service's CicdPipelineAnalysis onto the Pipeline surface payload,
// adding a short YAML excerpt per node so the stage can show it.
import type { CicdPipelineAnalysis, CicdFlowNode } from '../../../../shared/types.js';
import {
  PIPELINE_MAX_EDGES,
  PIPELINE_MAX_NODES,
  type PipelineNode,
  type PipelineSurfaceData,
} from '../../../../shared/surfaces/kinds/pipeline.js';

const EXCERPT_MAX_LINES = 30;
const EXCERPT_MAX_CHARS = 3600;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Excerpt starting at the node's definition and following its indented block. */
export function excerptFor(
  content: string,
  node: Pick<CicdFlowNode, 'type' | 'label'>,
): { excerpt: string; startLine: number } | undefined {
  if (!content) return undefined;
  const lines = content.split(/\r?\n/);
  let start = -1;
  if (node.type === 'workflow' || node.type === 'template') {
    start = 0;
  } else if (node.label) {
    const label = escapeRegex(node.label.trim());
    const patterns = [
      new RegExp(
        `^\\s*-?\\s*(?:name|job|stage|deployment|displayName|template)\\s*:\\s*['"]?${label}['"]?\\s*$`,
      ),
      new RegExp(`^\\s*['"]?${label}['"]?\\s*:\\s*$`),
      new RegExp(`^\\s*-?\\s*(?:uses|run|script|task|environment)\\s*:\\s*['"]?${label}`),
      new RegExp(label),
    ];
    for (const pattern of patterns) {
      start = lines.findIndex((line) => pattern.test(line));
      if (start >= 0) break;
    }
  }
  if (start < 0) return undefined;
  // A `name:`/`displayName:` property inside a mapping: start at its parent key.
  if (/^\s*(?:name|displayName)\s*:/.test(lines[start]) && start > 0) {
    const indent = indentOf(lines[start]);
    for (let index = start - 1; index >= 0; index -= 1) {
      if (lines[index].trim() !== '' && indentOf(lines[index]) < indent) {
        start = index;
        break;
      }
    }
  }
  // Step definitions start at the list dash; include the block below it.
  const baseIndent = indentOf(lines[start]);
  const isListItem = lines[start].trimStart().startsWith('-');
  let end = start + 1;
  if (node.type !== 'workflow' && node.type !== 'template') {
    while (end < lines.length && end - start < EXCERPT_MAX_LINES) {
      const line = lines[end];
      if (line.trim() === '') {
        end += 1;
        continue;
      }
      const indent = indentOf(line);
      if (
        indent < baseIndent ||
        (indent === baseIndent && (isListItem || !line.trimStart().startsWith('-')))
      )
        break;
      end += 1;
    }
  } else {
    end = Math.min(lines.length, EXCERPT_MAX_LINES);
  }
  const excerpt = lines
    .slice(start, Math.min(end, start + EXCERPT_MAX_LINES))
    .join('\n')
    .replace(/\s+$/, '')
    .slice(0, EXCERPT_MAX_CHARS);
  return excerpt ? { excerpt, startLine: start + 1 } : undefined;
}

export function buildPipelineData(analysis: CicdPipelineAnalysis): PipelineSurfaceData {
  const contentByPath = new Map(analysis.files.map((file) => [file.path, file.content]));
  const nodes: PipelineNode[] = analysis.nodes.slice(0, PIPELINE_MAX_NODES).map((node) => {
    const excerpt = excerptFor(contentByPath.get(node.filePath) ?? '', node);
    return {
      id: node.id,
      type: node.type,
      label: node.label.slice(0, 300),
      ...(node.subtitle ? { subtitle: node.subtitle.slice(0, 500) } : {}),
      status: node.status,
      filePath: node.filePath,
      provider: node.provider,
      ...(excerpt ? { excerpt: excerpt.excerpt, excerptStartLine: excerpt.startLine } : {}),
    };
  });
  const kept = new Set(nodes.map((node) => node.id));
  const allEdges = analysis.edges.filter((edge) => kept.has(edge.from) && kept.has(edge.to));
  const edges = allEdges.slice(0, PIPELINE_MAX_EDGES).map((edge) => ({
    from: edge.from,
    to: edge.to,
    ...(edge.label ? { label: edge.label.slice(0, 100) } : {}),
  }));
  const droppedNodes = analysis.nodes.length - nodes.length;
  const droppedEdges = analysis.edges.length - edges.length;
  return {
    repoId: analysis.repoId,
    repoName: analysis.repoName,
    generatedAt: analysis.generatedAt,
    providers: analysis.summary.providers,
    files: analysis.files.slice(0, 200).map((file) => ({
      path: file.path,
      provider: file.provider,
      role: file.role,
      name: file.name.slice(0, 300),
      valid: file.valid,
      ...(file.error ? { error: file.error.slice(0, 2000) } : {}),
    })),
    nodes,
    edges,
    issues: analysis.findings.slice(0, 1000).map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      filePath: finding.filePath,
      message: finding.message.slice(0, 2000),
      ...(finding.nodeId && kept.has(finding.nodeId) ? { nodeId: finding.nodeId } : {}),
    })),
    ...(droppedNodes > 0 || droppedEdges > 0
      ? { truncated: { nodes: droppedNodes, edges: Math.max(0, droppedEdges) } }
      : {}),
  };
}
