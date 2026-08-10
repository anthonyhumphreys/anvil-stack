import { Bot, CheckCircle2, Circle, GitFork, Loader2, OctagonX, PauseCircle } from 'lucide-react';
import type {
  ExecutionTopology,
  ExecutionTopologyNode,
  ExecutionTopologyNodeStatus,
} from '../../utils/execution-topology';

interface ExecutionTopologyPanelProps {
  topology: ExecutionTopology;
}

export function ExecutionTopologyPanel({ topology }: ExecutionTopologyPanelProps) {
  const childrenByParent = new Map<string | undefined, ExecutionTopologyNode[]>();
  for (const node of topology.nodes) {
    const siblings = childrenByParent.get(node.parentId) ?? [];
    siblings.push(node);
    childrenByParent.set(node.parentId, siblings);
  }
  const root = topology.nodes.find((node) => node.kind === 'outcome');

  if (!root) return null;

  return (
    <div className="px-2 py-2">
      <div className="mb-3 flex items-center justify-between gap-3 px-1">
        <p className="text-xs leading-relaxed text-text-tertiary">
          Optional live topology for the current outcome. It stays inside Work and never interrupts
          the transcript.
        </p>
        <span className="shrink-0 rounded-full bg-bg-primary px-2 py-0.5 text-[10px] text-text-tertiary">
          {topology.delegatedCount} delegated
        </span>
      </div>
      <div className="rounded-lg border border-border-subtle bg-bg-primary/55 p-2">
        <TopologyBranch
          node={root}
          childrenByParent={childrenByParent}
          depth={0}
          visited={new Set()}
        />
      </div>
      {topology.delegatedCount === 0 && (
        <div className="px-3 py-5 text-center">
          <GitFork size={18} className="mx-auto text-text-muted" />
          <p className="mt-2 text-sm text-text-secondary">No delegation in this outcome yet.</p>
          <p className="mt-1 text-xs text-text-tertiary">
            Subagents appear here only when the selected strategy actually uses them.
          </p>
        </div>
      )}
    </div>
  );
}

function TopologyBranch({
  node,
  childrenByParent,
  depth,
  visited,
}: {
  node: ExecutionTopologyNode;
  childrenByParent: Map<string | undefined, ExecutionTopologyNode[]>;
  depth: number;
  visited: Set<string>;
}) {
  if (visited.has(node.id) || depth > 8) return null;
  const nextVisited = new Set(visited).add(node.id);
  const children = childrenByParent.get(node.id) ?? [];

  return (
    <div className={depth > 0 ? 'ml-4 border-l border-border-subtle pl-3' : ''}>
      <div className="mb-1.5 flex items-start gap-2 rounded-md px-2 py-2 hover:bg-bg-tertiary/45">
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
      </div>
      {children.map((child) => (
        <TopologyBranch
          key={child.id}
          node={child}
          childrenByParent={childrenByParent}
          depth={depth + 1}
          visited={nextVisited}
        />
      ))}
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
  if (kind === 'outcome') return <GitFork className={`${className} text-info`} />;
  if (kind === 'session') return <Bot className={`${className} text-text-secondary`} />;
  return <Circle className={`${className} text-text-muted`} />;
}
