import type {
  WorkflowAgentProfile,
  WorkflowNode,
  WorkflowOrchestration,
  WorkflowRun,
  WorkflowTemplateInput,
  WorkflowTeamStrategy,
} from './types';
import { DEFAULT_CODEX_MODEL } from './codex-models';

export const TEAM_STRATEGIES: Array<{
  id: WorkflowTeamStrategy;
  name: string;
  description: string;
}> = [
  { id: 'manual', name: 'Single agent', description: 'Run the configured agent directly.' },
  {
    id: 'map-reduce',
    name: 'Map / reduce',
    description: 'Each specialist works on a share. The coordinator integrates their handoffs.',
  },
  {
    id: 'review',
    name: 'Independent review',
    description:
      'Specialists inspect the same inputs independently. The coordinator reconciles findings.',
  },
  {
    id: 'debate',
    name: 'Debate',
    description: 'Specialists propose alternatives, then the coordinator evaluates tradeoffs.',
  },
  {
    id: 'autonomous',
    name: 'Autonomous delegation',
    description:
      'The agent chooses tasks and specialists from your approved pool, within run limits.',
  },
];

export const DEFAULT_ORCHESTRATION: WorkflowOrchestration = {
  maxConcurrency: 1,
  maxNodes: 64,
  maxDepth: 3,
  maxAttempts: 3,
  timeoutMinutes: 30,
  handoffChars: 12000,
  profiles: [],
};

export function orchestrationConfig(value?: WorkflowOrchestration): WorkflowOrchestration {
  return { ...DEFAULT_ORCHESTRATION, ...value, profiles: value?.profiles ?? [] };
}

export function validateOrchestration(value?: WorkflowOrchestration): void {
  const config = orchestrationConfig(value);
  for (const [key, min, max] of [
    ['maxConcurrency', 1, 16],
    ['maxNodes', 1, 256],
    ['maxDepth', 0, 6],
    ['maxAttempts', 1, 10],
    ['timeoutMinutes', 1, 1440],
    ['handoffChars', 1000, 100000],
  ] as const) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) {
      throw new Error(`${key} must be an integer between ${min} and ${max}.`);
    }
  }
  if (!Array.isArray(config.profiles) || config.profiles.length > 32)
    throw new Error('Use at most 32 specialist profiles.');
  const ids = new Set<string>();
  for (const profile of config.profiles) {
    if (!profile.id?.trim() || ids.has(profile.id))
      throw new Error('Specialist profile ids must be unique.');
    ids.add(profile.id);
    if (!profile.name?.trim() || !profile.model?.trim() || !profile.personaId?.trim())
      throw new Error('Every specialist needs a name, persona, and model.');
    if (!['codex', 'cursor', 'openai', 'azure'].includes(profile.provider))
      throw new Error('Unknown specialist provider.');
    if (
      !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(
        profile.reasoningEffort,
      )
    )
      throw new Error('Unknown specialist reasoning level.');
    if (
      !Array.isArray(profile.capabilities) ||
      profile.capabilities.some((capability) => typeof capability !== 'string')
    )
      throw new Error('Capabilities must be strings.');
  }
}

export interface DelegatedTask {
  profileId: string;
  name: string;
  prompt: string;
}

/** Only a deliberate final protocol block can request graph changes. */
export function parseDelegation(output: string): DelegatedTask[] | null {
  const match = output.match(/```anvil-delegate\s*\n([\s\S]*?)\n```\s*$/);
  if (!match) return null;
  const parsed: unknown = JSON.parse(match[1]);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('tasks' in parsed) ||
    !Array.isArray(parsed.tasks) ||
    !parsed.tasks.length ||
    parsed.tasks.length > 16
  )
    throw new Error('Delegation requires between 1 and 16 tasks.');
  return parsed.tasks.map((task: unknown) => {
    if (
      !task ||
      typeof task !== 'object' ||
      !('profileId' in task) ||
      !('name' in task) ||
      !('prompt' in task) ||
      typeof task.profileId !== 'string' ||
      typeof task.name !== 'string' ||
      typeof task.prompt !== 'string' ||
      !task.name.trim() ||
      !task.prompt.trim() ||
      task.prompt.length > 24000
    )
      throw new Error(
        'Each delegated task needs a profileId, name, and instruction of at most 24000 characters.',
      );
    return {
      profileId: task.profileId,
      name: task.name.trim().slice(0, 160),
      prompt: task.prompt.trim(),
    };
  });
}

export function readyWorkflowNodes(run: WorkflowRun): WorkflowNode[] {
  const states = new Map(run.nodeRuns.map((state) => [state.nodeId, state.status]));
  return run.nodes.filter(
    (node) =>
      states.get(node.id) === 'queued' &&
      run.edges
        .filter((edge) => edge.target === node.id)
        .every((edge) => states.get(edge.source) === 'completed'),
  );
}

export function specialistNode(
  profile: WorkflowAgentProfile,
  id: string,
  name: string,
  prompt: string,
): WorkflowNode {
  return {
    id,
    name,
    prompt,
    personaId: profile.personaId,
    provider: profile.provider,
    model: profile.model,
    reasoningEffort: profile.reasoningEffort,
    executionStrategy: 'focused',
    position: { x: 0, y: 0 },
  };
}

export function createOrchestrationPreset(
  kind: 'delivery' | 'review' | 'research',
  profiles: WorkflowAgentProfile[],
): WorkflowTemplateInput {
  const pool = profiles.length
    ? profiles
    : [
        {
          id: 'specialist',
          name: 'Specialist',
          personaId: 'coder',
          provider: 'codex' as const,
          model: DEFAULT_CODEX_MODEL,
          reasoningEffort: 'high' as const,
          capabilities: ['implementation', 'review'],
        },
      ];
  const coordinator = pool[0];
  const node = (id: string, name: string, prompt: string, x: number): WorkflowNode => ({
    ...specialistNode(coordinator, id, name, prompt),
    position: { x, y: 140 },
  });
  const nodes =
    kind === 'delivery'
      ? [
          {
            ...node(
              'plan',
              'Plan and delegate',
              'Inspect the request and repository. Delegate bounded implementation tasks to suitable specialists. Reconcile their outputs and describe the integrated changes, unresolved conflicts, and verification needed.',
              0,
            ),
            teamStrategy: 'autonomous' as const,
          },
          {
            ...node(
              'review',
              'Independent review',
              'Inspect the actual combined changes against the request. Identify defects and missing verification, with file references. Do not claim checks ran unless you ran or inspected them.',
              430,
            ),
            teamStrategy: 'review' as const,
            teamProfileIds: pool.map((p) => p.id),
          },
          {
            ...node(
              'repair',
              'Repair and verify',
              'Address the review findings. Delegate specialist repairs if needed. Run relevant checks against the resulting combined changes and report exact outcomes and limitations.',
              860,
            ),
            teamStrategy: 'autonomous' as const,
          },
          {
            ...node(
              'accept',
              'Human acceptance',
              'Inspect the implementation, review findings, and verification before accepting this run.',
              1290,
            ),
            kind: 'human' as const,
          },
        ]
      : kind === 'review'
        ? [
            {
              ...node(
                'review',
                'Review committee',
                'Independently review the requested change. Reconcile findings by severity, explain disagreement, and report evidence and missing checks.',
                0,
              ),
              teamStrategy: 'review' as const,
              teamProfileIds: pool.map((p) => p.id),
            },
            {
              ...node(
                'accept',
                'Review decision',
                'Review the findings and decide whether to accept this review result.',
                430,
              ),
              kind: 'human' as const,
            },
          ]
        : [
            {
              ...node(
                'research',
                'Explore alternatives',
                'Develop alternatives for the request. Compare feasibility, implementation cost, risks, and evidence. Explain disagreements and recommend a direction.',
                0,
              ),
              teamStrategy: 'debate' as const,
              teamProfileIds: pool.map((p) => p.id),
            },
          ];
  return {
    name:
      kind === 'delivery'
        ? 'Agent delivery team'
        : kind === 'review'
          ? 'Independent review committee'
          : 'Architecture debate',
    description: 'Configurable specialists, bounded delegation, and inspectable handoffs.',
    nodes,
    edges: nodes
      .slice(1)
      .map((n, index) => ({ id: `edge-${index}`, source: nodes[index].id, target: n.id })),
    orchestration: { ...DEFAULT_ORCHESTRATION, profiles: pool },
  };
}

/** Stable dependency columns keep runtime-generated nodes visible and non-overlapping. */
export function layoutWorkflowGraph(
  nodes: WorkflowNode[],
  edges: Array<{ source: string; target: string }>,
): Map<string, { x: number; y: number }> {
  const depths = new Map<string, number>();
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const node of nodes) {
      if (depths.has(node.id)) continue;
      const incoming = edges.filter((edge) => edge.target === node.id);
      if (incoming.every((edge) => depths.has(edge.source))) {
        depths.set(node.id, Math.max(-1, ...incoming.map((edge) => depths.get(edge.source)!)) + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const rows = new Map<number, number>();
  return new Map(
    nodes.map((node) => {
      const column = depths.get(node.id) ?? 0;
      const row = rows.get(column) ?? 0;
      rows.set(column, row + 1);
      return [node.id, { x: column * 340, y: row * 210 }];
    }),
  );
}
