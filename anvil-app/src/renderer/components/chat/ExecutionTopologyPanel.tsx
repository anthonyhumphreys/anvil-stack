import { useEffect, useMemo, useState } from 'react';
import {
  Bot,
  CheckCircle2,
  Circle,
  ExternalLink,
  GitFork,
  Loader2,
  OctagonX,
  PauseCircle,
  Square,
} from 'lucide-react';
import type {
  ExecutionTopology,
  ExecutionTopologyNode,
  ExecutionTopologyNodeStatus,
} from '../../utils/execution-topology';

interface ExecutionTopologyPanelProps {
  topology: ExecutionTopology;
  onOpenThread?: (threadId: string) => void;
  onStop?: (sessionId: string) => void;
}

export function ExecutionTopologyPanel({
  topology,
  onOpenThread,
  onStop,
}: ExecutionTopologyPanelProps) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const childrenByParent = useMemo(() => {
    const result = new Map<string | undefined, ExecutionTopologyNode[]>();
    for (const node of topology.nodes) {
      const siblings = result.get(node.parentId) ?? [];
      siblings.push(node);
      result.set(node.parentId, siblings);
    }
    return result;
  }, [topology.nodes]);
  const root = topology.nodes.find((node) => node.kind === 'thread');
  const selectedNode =
    topology.nodes.find((node) => node.id === selectedNodeId) ??
    topology.nodes.find((node) => node.status === 'running' && node.kind === 'subagent') ??
    topology.nodes.find((node) => node.kind === 'session') ??
    root;

  useEffect(() => {
    if (selectedNodeId && !topology.nodes.some((node) => node.id === selectedNodeId)) {
      setSelectedNodeId(null);
    }
  }, [selectedNodeId, topology.nodes]);

  if (!root) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-3 py-2.5">
        <div>
          <p className="text-xs font-medium text-text-secondary">Current work</p>
          <p className="mt-0.5 text-[11px] text-text-tertiary">
            {topology.runningCount > 0
              ? `${topology.runningCount} agent${topology.runningCount === 1 ? '' : 's'} working`
              : 'No agents working'}
          </p>
        </div>
        {topology.delegatedCount > 0 && (
          <span className="shrink-0 rounded-full bg-bg-primary px-2 py-0.5 text-[10px] text-text-tertiary">
            {topology.delegatedCount} delegated
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <TopologyBranch
          node={root}
          childrenByParent={childrenByParent}
          depth={0}
          visited={new Set()}
          selectedNodeId={selectedNode?.id ?? null}
          onSelect={setSelectedNodeId}
        />
        {topology.delegatedCount === 0 && topology.runningCount === 0 && (
          <div className="px-3 py-6 text-center">
            <GitFork size={18} className="mx-auto text-text-muted" />
            <p className="mt-2 text-sm text-text-secondary">
              No agents are working in this thread.
            </p>
            <p className="mt-1 text-xs text-text-tertiary">
              Agent activity will appear here when work starts.
            </p>
          </div>
        )}
      </div>
      {selectedNode && selectedNode.kind !== 'thread' && (
        <AgentDetails node={selectedNode} onOpenThread={onOpenThread} onStop={onStop} />
      )}
    </div>
  );
}

function TopologyBranch({
  node,
  childrenByParent,
  depth,
  visited,
  selectedNodeId,
  onSelect,
}: {
  node: ExecutionTopologyNode;
  childrenByParent: Map<string | undefined, ExecutionTopologyNode[]>;
  depth: number;
  visited: Set<string>;
  selectedNodeId: string | null;
  onSelect: (nodeId: string) => void;
}) {
  if (visited.has(node.id) || depth > 8) return null;
  const nextVisited = new Set(visited).add(node.id);
  const children = childrenByParent.get(node.id) ?? [];

  return (
    <div className={depth > 0 ? 'ml-4 border-l border-border-subtle pl-3' : ''}>
      <button
        type="button"
        onClick={() => onSelect(node.id)}
        className={`mb-1.5 flex w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-bg-tertiary/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
          selectedNodeId === node.id ? 'bg-bg-tertiary/70' : ''
        }`}
        aria-pressed={selectedNodeId === node.id}
      >
        <StatusIcon status={node.status} kind={node.kind} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-text-primary">{node.label}</span>
            <span className="shrink-0 text-[10px] capitalize text-text-tertiary">
              {node.status}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-text-tertiary">{node.detail}</p>
          {node.prompt && (
            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-text-secondary">
              {node.prompt}
            </p>
          )}
          {(node.model || node.reasoningEffort) && (
            <p className="mt-1 font-mono text-[10px] text-text-muted">
              {[node.model, node.reasoningEffort].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
      </button>
      {children.map((child) => (
        <TopologyBranch
          key={child.id}
          node={child}
          childrenByParent={childrenByParent}
          depth={depth + 1}
          visited={nextVisited}
          selectedNodeId={selectedNodeId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

function AgentDetails({
  node,
  onOpenThread,
  onStop,
}: {
  node: ExecutionTopologyNode;
  onOpenThread?: (threadId: string) => void;
  onStop?: (sessionId: string) => void;
}) {
  return (
    <div className="shrink-0 border-t border-border-subtle bg-bg-primary/35 px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-text-primary">{node.label}</p>
          <p className="mt-0.5 text-xs capitalize text-text-tertiary">{node.status}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {node.appThreadId && onOpenThread && (
            <button
              type="button"
              onClick={() => onOpenThread(node.appThreadId!)}
              className="rounded-md border border-border px-2 py-1 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
            >
              <ExternalLink size={11} className="mr-1 inline" />
              Thread
            </button>
          )}
          {node.sessionId && node.status === 'running' && onStop && (
            <button
              type="button"
              onClick={() => onStop(node.sessionId!)}
              className="rounded-md border border-border px-2 py-1 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
            >
              <Square size={10} className="mr-1 inline fill-current" />
              Stop
            </button>
          )}
        </div>
      </div>
      <dl className="mt-3 space-y-2 text-xs">
        {node.prompt && (
          <div>
            <dt className="font-medium text-text-muted">Task</dt>
            <dd className="mt-0.5 line-clamp-3 leading-relaxed text-text-secondary">
              {node.prompt}
            </dd>
          </div>
        )}
        {node.latestMessage && (
          <div>
            <dt className="font-medium text-text-muted">Latest update</dt>
            <dd className="mt-0.5 line-clamp-3 leading-relaxed text-text-secondary">
              {node.latestMessage}
            </dd>
          </div>
        )}
      </dl>
      {(node.model || node.reasoningEffort) && (
        <p className="mt-3 font-mono text-[10px] text-text-muted">
          {[node.model, node.reasoningEffort].filter(Boolean).join(' · ')}
        </p>
      )}
    </div>
  );
}

function StatusIcon({
  status,
  kind,
}: {
  status: ExecutionTopologyNodeStatus;
  kind: ExecutionTopologyNode['kind'];
}) {
  const className = 'mt-0.5 h-3.5 w-3.5 shrink-0';
  if (status === 'running') return <Loader2 className={`${className} animate-spin text-accent`} />;
  if (status === 'completed') return <CheckCircle2 className={`${className} text-success`} />;
  if (status === 'failed') return <OctagonX className={`${className} text-error`} />;
  if (status === 'waiting' || status === 'stopped') {
    return <PauseCircle className={`${className} text-warning`} />;
  }
  if (kind === 'thread') return <GitFork className={`${className} text-info`} />;
  if (kind === 'session') return <Bot className={`${className} text-text-secondary`} />;
  return <Circle className={`${className} text-text-muted`} />;
}
