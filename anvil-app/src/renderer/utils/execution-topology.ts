import type { CodexEvent, CodexSession, CodexSubagentStatus } from '../../shared/types';
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
  latestMessage?: string;
  sessionId?: string;
  appThreadId?: string;
}

export interface ExecutionTopology {
  nodes: ExecutionTopologyNode[];
  delegatedCount: number;
  runningCount: number;
  startedAt?: string;
}

interface ExecutionTopologyInput {
  entries: ChatEntry[];
  sessions: CodexSession[];
  threadId: string | null;
  rootLabel: string;
  sessionStates?: Record<string, ExecutionTopologyNodeStatus>;
}

export function buildExecutionTopology({
  entries,
  sessions,
  threadId,
  rootLabel,
  sessionStates = {},
}: ExecutionTopologyInput): ExecutionTopology {
  const rootId = `thread:${threadId ?? 'new'}`;
  const nodes = new Map<string, ExecutionTopologyNode>();
  const protocolNodeIds = new Map<string, string>();
  const relevantSessions = sessions.filter((session) => {
    if (threadId && session.appThreadId && session.appThreadId !== threadId) return false;
    if (threadId && !session.appThreadId) return false;
    return true;
  });

  nodes.set(rootId, {
    id: rootId,
    label: rootLabel,
    detail: 'Chat thread',
    status: relevantSessions.some(
      (session) => (sessionStates[session.id] ?? sessionStatus(session.status)) === 'running',
    )
      ? 'running'
      : 'idle',
    kind: 'thread',
    prompt: [...entries].reverse().find((entry) => entry.kind === 'user')?.content,
  });

  for (const session of relevantSessions) {
    const nodeId = `session:${session.id}`;
    nodes.set(nodeId, {
      id: nodeId,
      parentId: rootId,
      label: formatSessionLabel(session.personaId),
      detail: session.kind ? `${session.kind} session` : 'Agent session',
      status: sessionStates[session.id] ?? sessionStatus(session.status),
      kind: 'session',
      sessionId: session.id,
      appThreadId: session.appThreadId,
    });
    if (session.providerThreadId) protocolNodeIds.set(session.providerThreadId, nodeId);
  }

  const fallbackSessionId =
    [...nodes.values()].find((node) => node.kind === 'session')?.id ?? rootId;

  for (const entry of entries) {
    if (entry.kind === 'user') {
      for (const node of nodes.values()) {
        if (node.kind === 'subagent' && (node.status === 'running' || node.status === 'waiting')) {
          node.status = 'idle';
          node.detail = 'Earlier turn · no current activity';
        }
      }
    }
    if (entry.kind !== 'event' || entry.event.type !== 'subagent_update') continue;
    const update = entry.event.subagent;
    if (!update) continue;

    const eventSessionId = entry.event.sessionId
      ? `session:${entry.event.sessionId}`
      : fallbackSessionId;
    const senderId = update.senderThreadId
      ? (protocolNodeIds.get(update.senderThreadId) ?? eventSessionId)
      : eventSessionId;
    const statusByThreadId = new Map(update.agents.map((agent) => [agent.threadId, agent.status]));
    const messageByThreadId = new Map(
      update.agents.map((agent) => [agent.threadId, agent.message]),
    );

    const receivers = new Set([
      ...update.receiverThreadIds,
      ...update.agents.map((agent) => agent.threadId),
      ...(update.agentThreadId ? [update.agentThreadId] : []),
    ]);
    for (const receiverThreadId of receivers) {
      const nodeId = protocolNodeIds.get(receiverThreadId) ?? `subagent:${receiverThreadId}`;
      const existing = nodes.get(nodeId);
      const label = formatAgentLabel(update.agentPath, receiverThreadId);
      nodes.set(nodeId, {
        id: nodeId,
        parentId: existing?.parentId ?? senderId,
        label: update.agentPath ? label : (existing?.label ?? label),
        detail: formatAgentDetail(update.activityKind, update.tool),
        status: statusByThreadId.has(receiverThreadId)
          ? subagentStatus(statusByThreadId.get(receiverThreadId), update.status)
          : update.activityKind === 'interrupted' ||
              (update.tool === 'closeAgent' && update.status === 'completed')
            ? 'stopped'
            : (existing?.status ??
              (update.tool === 'spawnAgent' || update.activityKind === 'started'
                ? 'running'
                : 'idle')),
        kind: 'subagent',
        prompt: existing?.prompt ?? update.prompt,
        model: update.model ?? existing?.model,
        reasoningEffort: update.reasoningEffort ?? existing?.reasoningEffort,
        latestMessage: messageByThreadId.get(receiverThreadId) ?? existing?.latestMessage,
      });
      protocolNodeIds.set(receiverThreadId, nodeId);
    }
  }

  // A remembered spawn event is not proof that an agent is still alive.
  for (const node of nodes.values()) {
    if (node.kind !== 'subagent' || !['running', 'waiting'].includes(node.status)) continue;
    let parent = node.parentId ? nodes.get(node.parentId) : undefined;
    const visited = new Set<string>();
    while (parent?.kind === 'subagent' && !visited.has(parent.id)) {
      visited.add(parent.id);
      parent = parent.parentId ? nodes.get(parent.parentId) : undefined;
    }
    if (!parent || parent.status !== 'running') {
      const terminal =
        parent?.status === 'completed' ||
        parent?.status === 'failed' ||
        parent?.status === 'stopped';
      node.status = terminal ? 'stopped' : 'idle';
      node.detail = terminal
        ? `Parent run ${parent!.status} · no final agent update`
        : 'No active run · last observed activity';
    }
  }

  const result = [...nodes.values()];
  return {
    nodes: result,
    delegatedCount: result.filter((node) => node.kind === 'subagent').length,
    runningCount: result.filter((node) => node.kind !== 'thread' && node.status === 'running')
      .length,
    startedAt: relevantSessions
      .map((session) => session.startedAt)
      .sort((left, right) => Date.parse(left) - Date.parse(right))[0],
  };
}

function formatSessionLabel(personaId: string): string {
  if (personaId === 'coder') return 'Main agent';
  return personaId.replaceAll('-', ' ');
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
      return 'stopped';
    case 'shutdown':
      return 'stopped';
    default:
      if (toolStatus === 'inProgress') return 'running';
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

/** Provider lifecycle beats a stale polling snapshot, including explicit interruption. */
export function applyExecutionLifecycle(
  states: Record<string, ExecutionTopologyNodeStatus>,
  event: CodexEvent & { sessionId?: string },
): Record<string, ExecutionTopologyNodeStatus> {
  if (!event.sessionId) return states;
  let status: ExecutionTopologyNodeStatus | undefined;
  if (event.type === 'turn_outcome') {
    status =
      event.turnOutcome === 'interrupted'
        ? 'stopped'
        : event.turnOutcome === 'failed'
          ? 'failed'
          : event.turnOutcome === 'completed'
            ? 'completed'
            : event.turnOutcome === 'inProgress'
              ? 'running'
              : undefined;
  } else if (event.type === 'status') {
    status =
      event.status === 'error'
        ? 'failed'
        : event.status === 'complete'
          ? states[event.sessionId] === 'stopped' || states[event.sessionId] === 'failed'
            ? states[event.sessionId]
            : 'completed'
          : event.status === 'thinking' || event.status === 'executing'
            ? 'running'
            : undefined;
  }
  return !status || states[event.sessionId] === status
    ? states
    : { ...states, [event.sessionId]: status };
}
