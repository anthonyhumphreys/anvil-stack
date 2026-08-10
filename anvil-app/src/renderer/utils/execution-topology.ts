import type { CodexSession, CodexSubagentStatus } from '../../shared/types';
import type { ChatEntry } from '../contexts/ChatContext';

export type ExecutionTopologyNodeStatus =
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'idle';

export interface ExecutionTopologyNode {
  id: string;
  parentId?: string;
  label: string;
  detail: string;
  status: ExecutionTopologyNodeStatus;
  kind: 'thread' | 'session' | 'subagent';
  prompt?: string;
  model?: string;
  reasoningEffort?: string;
}

export interface ExecutionTopology {
  nodes: ExecutionTopologyNode[];
  delegatedCount: number;
}

interface ExecutionTopologyInput {
  entries: ChatEntry[];
  sessions: CodexSession[];
  threadId: string | null;
  rootLabel: string;
}

export function buildExecutionTopology({
  entries,
  sessions,
  threadId,
  rootLabel,
}: ExecutionTopologyInput): ExecutionTopology {
  const rootId = `thread:${threadId ?? 'new'}`;
  const nodes = new Map<string, ExecutionTopologyNode>();
  const protocolNodeIds = new Map<string, string>();

  nodes.set(rootId, {
    id: rootId,
    label: rootLabel,
    detail: 'Chat thread',
    status: sessions.some((session) => session.status === 'busy' || session.status === 'starting')
      ? 'running'
      : 'idle',
    kind: 'thread',
  });

  for (const session of sessions) {
    if (threadId && session.appThreadId && session.appThreadId !== threadId) continue;
    if (threadId && !session.appThreadId) continue;

    const nodeId = `session:${session.id}`;
    nodes.set(nodeId, {
      id: nodeId,
      parentId: rootId,
      label: session.personaId,
      detail: session.kind ? `${session.kind} session` : 'Agent session',
      status: sessionStatus(session.status),
      kind: 'session',
    });
    if (session.providerThreadId) protocolNodeIds.set(session.providerThreadId, nodeId);
  }

  const fallbackSessionId =
    [...nodes.values()].find((node) => node.kind === 'session')?.id ?? rootId;

  for (const entry of entries) {
    if (entry.kind !== 'event' || entry.event.type !== 'subagent_update') continue;
    const update = entry.event.subagent;
    if (!update) continue;

    const senderId = update.senderThreadId
      ? (protocolNodeIds.get(update.senderThreadId) ?? fallbackSessionId)
      : fallbackSessionId;
    const statusByThreadId = new Map(update.agents.map((agent) => [agent.threadId, agent.status]));

    for (const receiverThreadId of update.receiverThreadIds) {
      const nodeId = protocolNodeIds.get(receiverThreadId) ?? `subagent:${receiverThreadId}`;
      const existing = nodes.get(nodeId);
      const label = formatAgentLabel(update.agentPath, receiverThreadId);
      nodes.set(nodeId, {
        id: nodeId,
        parentId: existing?.parentId ?? senderId,
        label: existing?.label ?? label,
        detail: formatAgentDetail(update.activityKind, update.tool),
        status: subagentStatus(statusByThreadId.get(receiverThreadId), update.status),
        kind: 'subagent',
        prompt: update.prompt ?? existing?.prompt,
        model: update.model ?? existing?.model,
        reasoningEffort: update.reasoningEffort ?? existing?.reasoningEffort,
      });
      protocolNodeIds.set(receiverThreadId, nodeId);
    }

    if (update.agentThreadId && !protocolNodeIds.has(update.agentThreadId)) {
      const nodeId = `subagent:${update.agentThreadId}`;
      nodes.set(nodeId, {
        id: nodeId,
        parentId: senderId,
        label: formatAgentLabel(update.agentPath, update.agentThreadId),
        detail: formatAgentDetail(update.activityKind, update.tool),
        status: subagentStatus(statusByThreadId.get(update.agentThreadId), update.status),
        kind: 'subagent',
        prompt: update.prompt,
        model: update.model,
        reasoningEffort: update.reasoningEffort,
      });
      protocolNodeIds.set(update.agentThreadId, nodeId);
    }
  }

  const result = [...nodes.values()];
  return {
    nodes: result,
    delegatedCount: result.filter((node) => node.kind === 'subagent').length,
  };
}

function sessionStatus(status: CodexSession['status']): ExecutionTopologyNodeStatus {
  switch (status) {
    case 'starting':
    case 'busy':
      return 'running';
    case 'error':
      return 'failed';
    case 'ready':
    default:
      return 'idle';
  }
}

function subagentStatus(
  status: CodexSubagentStatus | undefined,
  toolStatus: 'inProgress' | 'completed' | 'failed' | undefined,
): ExecutionTopologyNodeStatus {
  if (toolStatus === 'failed') return 'failed';
  if (toolStatus === 'inProgress') return 'running';
  switch (status) {
    case 'pendingInit':
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'errored':
    case 'notFound':
      return 'failed';
    case 'interrupted':
      return 'waiting';
    case 'shutdown':
      return 'stopped';
    default:
      return toolStatus === 'completed' ? 'completed' : 'idle';
  }
}

function formatAgentLabel(agentPath: string | undefined, threadId: string): string {
  const pathLabel = agentPath?.split('/').filter(Boolean).pop();
  if (pathLabel) return pathLabel.replaceAll('_', ' ');
  return `Agent ${threadId.slice(0, 6)}`;
}

function formatAgentDetail(
  activityKind: 'started' | 'interacted' | 'interrupted' | undefined,
  tool: 'spawnAgent' | 'sendInput' | 'resumeAgent' | 'wait' | 'closeAgent' | undefined,
): string {
  if (activityKind === 'started' || tool === 'spawnAgent') return 'Delegated task';
  if (activityKind === 'interrupted') return 'Interrupted';
  if (tool === 'sendInput') return 'Received follow-up';
  if (tool === 'resumeAgent') return 'Resumed';
  if (tool === 'wait') return 'Coordinating';
  if (tool === 'closeAgent') return 'Closed';
  return 'Subagent';
}
