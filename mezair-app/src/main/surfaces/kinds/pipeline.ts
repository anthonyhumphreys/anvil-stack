// Pipeline surface handler (§8.4): cicd_analyze publishes the CI/CD graph;
// "ask agent to fix" sends the node, its upstream nodes, YAML and issues.
import type { MainSurfaceHandler, SurfaceActionContext } from '../types.js';
import type {
  JsonSchema,
  SurfaceActionRequest,
  SurfaceActionResult,
} from '../../../shared/surfaces/types.js';
import {
  issuesByNode,
  pipelineSurfaceKind,
  upstreamNodes,
  type PipelineSurfaceData,
} from '../../../shared/surfaces/kinds/pipeline.js';
import {
  assertRepoInScope,
  type AgentToolDefinition,
  type AgentToolSessionContext,
} from '../../agent-tools/dispatch.js';
import { deliverSurfaceFeedback, publishSurface } from '../core.js';
import { analyzeCicdPipelines } from '../../services/cicd.service.js';
import {
  actionError,
  actionOk,
  getRepoRecord,
  parseToolArgs,
  renderTemplate,
  requireTargets,
  surfaceToolResult,
} from './data/tool-kit.js';
import { rememberKeyedSurface } from './data/keyed-surfaces.js';
import { buildPipelineData } from './pipeline/build.js';
import { pipelineSnapshot } from './pipeline/snapshot.js';

const KIND = 'pipeline';

export function pipelineKey(repoId: string): string {
  return `pipeline:${repoId}`;
}

const analyzeInput: JsonSchema = {
  type: 'object',
  required: ['repoId'],
  properties: { repoId: { type: 'string', description: 'Repository id from this session.' } },
  additionalProperties: false,
};

const TOOLS: AgentToolDefinition[] = [
  {
    name: 'cicd_analyze',
    title: 'Analyse CI/CD pipelines',
    description:
      'Parse the repo’s GitHub Actions / Azure Pipelines YAML into a flow graph with validation issues and show it as a Pipeline surface. Returns a digest and surfaceId.',
    inputSchema: analyzeInput,
    feature: 'cicd',
  },
];

async function cicdAnalyzeTool(ctx: AgentToolSessionContext, args: Record<string, unknown>) {
  const input = parseToolArgs<{ repoId: string }>(analyzeInput, args);
  const repo = getRepoRecord(assertRepoInScope(ctx, input.repoId));
  const analysis = await analyzeCicdPipelines(repo.id, repo.name, repo.path);
  const data = buildPipelineData(analysis);
  const key = pipelineKey(repo.id);
  const intent = publishSurface<PipelineSurfaceData>(ctx, {
    surfaceKind: KIND,
    title: `Pipelines · ${repo.name}`,
    key,
    data,
  });
  rememberKeyedSurface(ctx, key, intent.id);
  return surfaceToolResult(intent);
}

export function describeNodeForAgent(data: PipelineSurfaceData, nodeId: string): string | null {
  const node = data.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return null;
  const upstream = upstreamNodes(data, nodeId);
  const issues = issuesByNode(data.issues).get(nodeId) ?? [];
  const fileIssues = data.issues.filter(
    (issue) => !issue.nodeId && issue.filePath === node.filePath,
  );
  const lines = [
    `- ${node.type} "${node.label}" (${node.status}) in ${node.filePath}${node.excerptStartLine ? `:${node.excerptStartLine}` : ''}`,
    `  node id: ${node.id}`,
  ];
  if (node.subtitle) lines.push(`  ${node.subtitle}`);
  if (upstream.length > 0) {
    lines.push(
      `  upstream: ${upstream.map((entry) => `${entry.type} "${entry.label}"`).join(', ')}`,
    );
  }
  for (const issue of [...issues, ...fileIssues].slice(0, 8)) {
    lines.push(`  [${issue.severity}] ${issue.message}`);
  }
  if (node.excerpt) {
    lines.push(
      '  YAML:',
      ...node.excerpt
        .split('\n')
        .slice(0, 20)
        .map((line) => `    ${line}`),
    );
  }
  return lines.join('\n');
}

async function executePipelineAction(
  ctx: SurfaceActionContext,
  request: SurfaceActionRequest,
): Promise<SurfaceActionResult> {
  if (request.action !== 'ask_fix_node') {
    return actionError(`Unknown pipeline action: ${request.action}`);
  }
  const data = ctx.intent.payload.data as PipelineSurfaceData;
  const [nodeId] = requireTargets(request.targetIds);
  const description = nodeId ? describeNodeForAgent(data, nodeId) : null;
  if (!description) return actionError('Select a pipeline node.');
  const semantics = pipelineSurfaceKind.actions.ask_fix_node.semantics;
  const template = semantics.type === 'agent-message' ? semantics.template : '{targets}';
  const message = [
    renderTemplate(template, { repoId: data.repoId, targets: description }),
    `(Pipeline surface ${ctx.intent.id}.)`,
    request.note ? `User note: ${request.note}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const delivered = await deliverSurfaceFeedback(ctx.intent.id, message);
  return delivered
    ? actionOk('Asked the agent to fix this node.')
    : actionError('No live agent session for this thread. Reopen the thread and try again.');
}

export const pipelineSurfaceHandler: MainSurfaceHandler = {
  kind: KIND,
  toolProvider: {
    id: 'surface:pipeline',
    tools: () => TOOLS,
    async call(ctx, name, args) {
      if (name === 'cicd_analyze') return cicdAnalyzeTool(ctx, args);
      return undefined;
    },
  },
  executeAction: executePipelineAction,
  share: {
    // Paths are already repo-relative (cicd.service); YAML excerpts stay, the
    // secret scan in the share pipeline runs over the bundle afterwards.
    redact: (data) => data,
    snapshot: (data, title) => pipelineSnapshot(data as PipelineSurfaceData, title),
  },
};
