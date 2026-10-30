// Pipeline surface (§8.4): CI/CD flow graph from cicd.service analysis.
import type { JsonSchema, SurfaceKindDefinition } from '../types.js';

export type PipelineProvider = 'github-actions' | 'azure-pipelines';
export type PipelineNodeType = 'workflow' | 'stage' | 'job' | 'step' | 'gate' | 'template';
export type PipelineNodeStatus = 'configured' | 'warning' | 'error';
export type PipelineIssueSeverity = 'error' | 'warning' | 'info';

export interface PipelineFileSummary {
  path: string;
  provider: PipelineProvider;
  role: 'entrypoint' | 'template' | 'reusable-workflow';
  name: string;
  valid: boolean;
  error?: string;
}

export interface PipelineNode {
  id: string;
  type: PipelineNodeType;
  label: string;
  subtitle?: string;
  status: PipelineNodeStatus;
  filePath: string;
  provider?: PipelineProvider;
  /** Short YAML excerpt around the node's definition (≤ ~40 lines). */
  excerpt?: string;
  excerptStartLine?: number;
}

export interface PipelineEdge {
  from: string;
  to: string;
  label?: string;
}

export interface PipelineIssue {
  id: string;
  severity: PipelineIssueSeverity;
  filePath: string;
  message: string;
  nodeId?: string;
}

export interface PipelineSurfaceData {
  repoId: string;
  repoName?: string;
  generatedAt: string;
  providers: PipelineProvider[];
  files: PipelineFileSummary[];
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  issues: PipelineIssue[];
  /** Set when the analysis was trimmed to fit the payload budget. */
  truncated?: { nodes: number; edges: number };
}

export type PipelineActionId = 'ask_fix_node';

export const PIPELINE_MAX_NODES = 600;
export const PIPELINE_MAX_EDGES = 2000;

const PROVIDERS = ['github-actions', 'azure-pipelines'] as const;
export const PIPELINE_NODE_TYPES: readonly PipelineNodeType[] = [
  'workflow',
  'stage',
  'job',
  'step',
  'gate',
  'template',
];

export const pipelineSurfaceSchema: JsonSchema = {
  type: 'object',
  required: ['repoId', 'generatedAt', 'providers', 'files', 'nodes', 'edges', 'issues'],
  properties: {
    repoId: { type: 'string', minLength: 1, maxLength: 200 },
    repoName: { type: 'string', maxLength: 300 },
    generatedAt: { type: 'string' },
    providers: { type: 'array', maxItems: 4, items: { type: 'string', enum: PROVIDERS } },
    files: {
      type: 'array',
      maxItems: 200,
      items: {
        type: 'object',
        required: ['path', 'provider', 'role', 'name', 'valid'],
        properties: {
          path: { type: 'string', maxLength: 1000 },
          provider: { type: 'string', enum: PROVIDERS },
          role: { type: 'string', enum: ['entrypoint', 'template', 'reusable-workflow'] },
          name: { type: 'string', maxLength: 300 },
          valid: { type: 'boolean' },
          error: { type: 'string', maxLength: 2000 },
        },
        additionalProperties: false,
      },
    },
    nodes: {
      type: 'array',
      maxItems: PIPELINE_MAX_NODES,
      items: {
        type: 'object',
        required: ['id', 'type', 'label', 'status', 'filePath'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 1000 },
          type: { type: 'string', enum: PIPELINE_NODE_TYPES },
          label: { type: 'string', maxLength: 300 },
          subtitle: { type: 'string', maxLength: 500 },
          status: { type: 'string', enum: ['configured', 'warning', 'error'] },
          filePath: { type: 'string', maxLength: 1000 },
          provider: { type: 'string', enum: PROVIDERS },
          excerpt: { type: 'string', maxLength: 4000 },
          excerptStartLine: { type: 'integer', minimum: 1 },
        },
        additionalProperties: false,
      },
    },
    edges: {
      type: 'array',
      maxItems: PIPELINE_MAX_EDGES,
      items: {
        type: 'object',
        required: ['from', 'to'],
        properties: {
          from: { type: 'string', maxLength: 1000 },
          to: { type: 'string', maxLength: 1000 },
          label: { type: 'string', maxLength: 100 },
        },
        additionalProperties: false,
      },
    },
    issues: {
      type: 'array',
      maxItems: 1000,
      items: {
        type: 'object',
        required: ['id', 'severity', 'filePath', 'message'],
        properties: {
          id: { type: 'string', maxLength: 1000 },
          severity: { type: 'string', enum: ['error', 'warning', 'info'] },
          filePath: { type: 'string', maxLength: 1000 },
          message: { type: 'string', maxLength: 2000 },
          nodeId: { type: 'string', maxLength: 1000 },
        },
        additionalProperties: false,
      },
    },
    truncated: {
      type: 'object',
      required: ['nodes', 'edges'],
      properties: { nodes: { type: 'integer' }, edges: { type: 'integer' } },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

export function issuesByNode(issues: readonly PipelineIssue[]): Map<string, PipelineIssue[]> {
  const map = new Map<string, PipelineIssue[]>();
  for (const issue of issues) {
    if (!issue.nodeId) continue;
    const list = map.get(issue.nodeId) ?? [];
    list.push(issue);
    map.set(issue.nodeId, list);
  }
  return map;
}

export interface PipelineGraphView {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  /** Hidden step count per visible parent node id. */
  hiddenSteps: Map<string, number>;
}

/**
 * Compact view for inline rendering: hides leaf steps and records how many
 * steps each parent has, so the graph stays readable.
 */
export function compactPipelineGraph(
  data: Pick<PipelineSurfaceData, 'nodes' | 'edges'>,
  includeSteps: boolean,
): PipelineGraphView {
  if (includeSteps) return { nodes: data.nodes, edges: data.edges, hiddenSteps: new Map() };
  const stepIds = new Set(data.nodes.filter((node) => node.type === 'step').map((node) => node.id));
  const hiddenSteps = new Map<string, number>();
  for (const edge of data.edges) {
    if (stepIds.has(edge.to) && !stepIds.has(edge.from)) {
      hiddenSteps.set(edge.from, (hiddenSteps.get(edge.from) ?? 0) + 1);
    }
  }
  return {
    nodes: data.nodes.filter((node) => !stepIds.has(node.id)),
    edges: data.edges.filter((edge) => !stepIds.has(edge.from) && !stepIds.has(edge.to)),
    hiddenSteps,
  };
}

export function upstreamNodes(
  data: Pick<PipelineSurfaceData, 'nodes' | 'edges'>,
  nodeId: string,
): PipelineNode[] {
  const byId = new Map(data.nodes.map((node) => [node.id, node]));
  return data.edges
    .filter((edge) => edge.to === nodeId)
    .map((edge) => byId.get(edge.from))
    .filter((node): node is PipelineNode => Boolean(node));
}

export function digestPipeline(data: PipelineSurfaceData): string {
  const counts = new Map<PipelineNodeType, number>();
  for (const node of data.nodes) counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
  const countText = PIPELINE_NODE_TYPES.filter((type) => counts.get(type))
    .map((type) => `${counts.get(type)} ${type}${counts.get(type) === 1 ? '' : 's'}`)
    .join(', ');
  const errors = data.issues.filter((issue) => issue.severity === 'error');
  const warnings = data.issues.filter((issue) => issue.severity === 'warning');
  const lines = [
    `Pipelines for ${data.repoName ?? data.repoId}: ${data.files.length} files` +
      (data.providers.length ? ` (${data.providers.join(', ')})` : '') +
      (countText ? ` · ${countText}` : ''),
  ];
  if (data.files.length === 0) lines.push('No CI/CD pipeline files found.');
  lines.push(`Validation: ${errors.length} errors, ${warnings.length} warnings`);
  for (const issue of [...errors, ...warnings].slice(0, 6)) {
    lines.push(
      `- [${issue.severity}] ${issue.filePath}${issue.nodeId ? ` (node ${issue.nodeId})` : ''}: ${issue.message}`,
    );
  }
  if (data.truncated) {
    lines.push(
      `Graph trimmed: ${data.truncated.nodes} nodes / ${data.truncated.edges} edges omitted.`,
    );
  }
  return lines.join('\n');
}

export const pipelineSurfaceKind: SurfaceKindDefinition<PipelineSurfaceData> = {
  kind: 'pipeline',
  label: 'Pipeline',
  schema: pipelineSurfaceSchema,
  actions: {
    ask_fix_node: {
      label: 'Ask agent to fix',
      semantics: {
        type: 'agent-message',
        template: 'Please fix this CI/CD pipeline node in repo {repoId}:\n{targets}',
      },
      shortcut: 'f',
      targets: 'one',
    },
  },
  anchors: ['surface', 'node'],
  digest: digestPipeline,
  feature: 'cicd',
  wide: true,
  shareable: true,
};
