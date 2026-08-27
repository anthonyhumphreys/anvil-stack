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
  const root = topology.nodes.find((node) => node.kind === 'thread');
  const coordinator = topology.nodes.find((node) => node.kind === 'session') ?? root;
  const delegates = useMemo(
    () => topology.nodes.filter((node) => node.kind === 'subagent'),
    [topology.nodes],
  );
  const selectedNode = delegates.find((node) => node.id === selectedNodeId);
  const completedCount = delegates.filter((node) => node.status === 'completed').length;
  const failedCount = delegates.filter((node) => node.status === 'failed').length;
  const workingDelegateCount = delegates.filter((node) => node.status === 'running').length;
  const elapsed = useElapsedTime(topology.startedAt, topology.runningCount > 0);

  useEffect(() => {
    if (selectedNodeId && !delegates.some((node) => node.id === selectedNodeId)) {
      setSelectedNodeId(null);
    }
  }, [delegates, selectedNodeId]);

  if (!root || !coordinator) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border-subtle">
        <div className="flex items-center justify-between gap-3 px-3 py-2.5">
          <div>
            <p className="text-xs font-medium text-text-secondary">Agent fan-out</p>
            <p className="mt-0.5 text-[11px] text-text-tertiary">
              {topology.runningCount > 0
                ? `${topology.runningCount} agent${topology.runningCount === 1 ? '' : 's'} working`
                : failedCount > 0
                  ? 'Run needs attention'
                  : completedCount > 0
                    ? 'Run complete'
                    : 'No agents working'}
            </p>
          </div>
          {delegates.length > 0 ? (
            <span className="shrink-0 rounded-full bg-bg-primary px-2 py-0.5 text-[10px] text-text-tertiary">
              {completedCount}/{delegates.length} complete
            </span>
          ) : (
            <span className="shrink-0 rounded-full bg-bg-primary px-2 py-0.5 text-[10px] text-text-tertiary">
              Solo run
            </span>
          )}
        </div>
        <div className="flex items-start gap-2 border-t border-border-subtle/70 px-3 py-2.5">
          <span className="shrink-0 pt-0.5 text-[11px] font-medium text-text-muted">Task</span>
          <p className="line-clamp-2 text-xs leading-relaxed text-text-primary">{root.label}</p>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <FanoutMap
          coordinator={coordinator}
          delegates={delegates}
          selectedNodeId={selectedNodeId}
          onSelect={setSelectedNodeId}
        />

        {delegates.length > 0 ? (
          <div className="border-t border-border-subtle" aria-label="Delegated agents">
            {delegates.map((node) => (
              <AgentRow
                key={node.id}
                node={node}
                selected={node.id === selectedNode?.id}
                onSelect={() =>
                  setSelectedNodeId((current) => (current === node.id ? null : node.id))
                }
                onOpenThread={onOpenThread}
                onStop={onStop}
              />
            ))}
          </div>
        ) : (
          <div className="border-t border-border-subtle px-6 py-7 text-center">
            <GitFork size={18} className="mx-auto text-text-muted" />
            <p className="mt-2 text-sm text-text-secondary">
              {coordinator.status === 'running'
                ? 'The main agent is handling this task.'
                : 'No delegated work in this run.'}
            </p>
            <p className="mt-1 text-xs text-text-tertiary">
              Specialists will appear here when the task fans out.
            </p>
          </div>
        )}
      </div>

      <RunFooter
        coordinator={coordinator}
        elapsed={elapsed}
        workingDelegateCount={workingDelegateCount}
        completedCount={completedCount}
        failedCount={failedCount}
        onStop={onStop}
      />
    </div>
  );
}

function FanoutMap({
  coordinator,
  delegates,
  selectedNodeId,
  onSelect,
}: {
  coordinator: ExecutionTopologyNode;
  delegates: ExecutionTopologyNode[];
  selectedNodeId: string | null;
  onSelect: (nodeId: string) => void;
}) {
  const canvasWidth = Math.max(300, delegates.length * 74);

  return (
    <div className="overflow-x-auto px-2" aria-label="Agent topology">
      <div
        className="relative h-[142px] w-full"
        style={{ minWidth: `${canvasWidth}px` }}
        role="group"
        aria-label={
          delegates.length > 0
            ? `${coordinator.label} coordinating ${delegates.length} delegated agent${delegates.length === 1 ? '' : 's'}`
            : `${coordinator.label} working without delegated agents`
        }
      >
        {delegates.length > 0 && (
          <svg
            className="pointer-events-none absolute inset-x-0 top-6 h-[82px] w-full"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {delegates.map((node, index) => {
              const x = ((index + 0.5) / delegates.length) * 100;
              return (
                <path
                  key={node.id}
                  d={`M 50 12 C 50 45, ${x} 45, ${x} 82`}
                  fill="none"
                  stroke="var(--color-border)"
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
          </svg>
        )}

        <div className="absolute left-1/2 top-3 flex -translate-x-1/2 flex-col items-center">
          <div className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-bg-primary text-text-secondary">
            <StatusIcon status={coordinator.status} kind={coordinator.kind} />
          </div>
          <span className="mt-1 max-w-24 truncate text-[10px] font-medium text-text-secondary">
            {coordinator.label}
          </span>
        </div>

        {delegates.map((node, index) => {
          const left = ((index + 0.5) / delegates.length) * 100;
          const selected = selectedNodeId === node.id;
          return (
            <button
              key={node.id}
              type="button"
              onClick={() => onSelect(node.id)}
              className="absolute top-[88px] flex w-[70px] -translate-x-1/2 flex-col items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              style={{ left: `${left}%` }}
              aria-label={`${node.label}, ${statusLabel(node.status)}`}
              aria-pressed={selected}
            >
              <span
                className={`flex h-9 w-9 items-center justify-center rounded-full border bg-bg-secondary transition-colors ${
                  selected
                    ? 'border-accent text-accent'
                    : 'border-border text-text-secondary hover:border-text-muted hover:text-text-primary'
                }`}
              >
                <StatusIcon status={node.status} kind={node.kind} />
              </span>
              <span
                className={`mt-1 w-full truncate text-[10px] ${
                  selected ? 'font-medium text-text-primary' : 'text-text-tertiary'
                }`}
              >
                {node.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AgentRow({
  node,
  selected,
  onSelect,
  onOpenThread,
  onStop,
}: {
  node: ExecutionTopologyNode;
  selected: boolean;
  onSelect: () => void;
  onOpenThread?: (threadId: string) => void;
  onStop?: (sessionId: string) => void;
}) {
  return (
    <div className="border-b border-border-subtle last:border-b-0">
      <button
        type="button"
        onClick={onSelect}
        className={`flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-bg-tertiary/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 ${
          selected ? 'bg-bg-tertiary/65' : ''
        }`}
        aria-expanded={selected}
      >
        <StatusIcon status={node.status} kind={node.kind} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-text-primary">{node.label}</span>
          <span className="mt-0.5 block truncate text-[11px] text-text-tertiary">
            {node.prompt ?? node.detail}
          </span>
        </span>
        <span className={`shrink-0 text-[10px] ${statusTone(node.status)}`}>
          {statusLabel(node.status)}
        </span>
      </button>

      {selected && (
        <div className="bg-bg-primary/35 px-8 pb-3 pt-1">
          {node.prompt && (
            <div>
              <p className="text-[10px] font-medium text-text-muted">Task</p>
              <p className="mt-1 text-xs leading-relaxed text-text-secondary">{node.prompt}</p>
            </div>
          )}
          {node.latestMessage && (
            <div className={node.prompt ? 'mt-2.5' : ''}>
              <p className="text-[10px] font-medium text-text-muted">Latest update</p>
              <p className="mt-1 text-xs leading-relaxed text-text-secondary">
                {node.latestMessage}
              </p>
            </div>
          )}
          {(node.model || node.reasoningEffort) && (
            <p className="mt-2.5 font-mono text-[10px] text-text-muted">
              {[node.model, node.reasoningEffort].filter(Boolean).join(' · ')}
            </p>
          )}
          {(node.appThreadId || (node.sessionId && node.status === 'running')) && (
            <div className="mt-3 flex items-center gap-1.5">
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
          )}
        </div>
      )}
    </div>
  );
}

function RunFooter({
  coordinator,
  elapsed,
  workingDelegateCount,
  completedCount,
  failedCount,
  onStop,
}: {
  coordinator: ExecutionTopologyNode;
  elapsed: string | null;
  workingDelegateCount: number;
  completedCount: number;
  failedCount: number;
  onStop?: (sessionId: string) => void;
}) {
  const summary =
    workingDelegateCount > 0
      ? `${workingDelegateCount} specialist${workingDelegateCount === 1 ? '' : 's'} working`
      : coordinator.status === 'running'
        ? 'Main agent working'
        : failedCount > 0
          ? `${failedCount} agent${failedCount === 1 ? '' : 's'} failed`
          : completedCount > 0
            ? 'Specialists complete'
            : 'Run idle';

  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border-subtle bg-bg-primary/35 px-3 py-2.5">
      <p className="min-w-0 truncate text-[11px] text-text-tertiary" aria-live="polite">
        <span>{summary}</span>
        {elapsed && <span className="ml-2 font-mono text-text-muted">{elapsed}</span>}
      </p>
      {coordinator.sessionId && coordinator.status === 'running' && onStop && (
        <button
          type="button"
          onClick={() => onStop(coordinator.sessionId!)}
          className="shrink-0 rounded-full bg-text-primary px-3 py-1.5 text-xs font-medium text-bg-primary transition-colors hover:bg-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          <Square size={10} className="mr-1.5 inline fill-current" />
          Stop
        </button>
      )}
    </div>
  );
}

function useElapsedTime(startedAt: string | undefined, active: boolean): string | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!startedAt || !active) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [active, startedAt]);

  if (!startedAt || !active) return null;
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs)) return null;
  return formatElapsed(Math.max(0, Math.floor((now - startedAtMs) / 1_000)));
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds.toString().padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes.toString().padStart(2, '0')}m`;
}

function statusLabel(status: ExecutionTopologyNodeStatus): string {
  switch (status) {
    case 'running':
      return 'Working';
    case 'completed':
      return 'Complete';
    case 'failed':
      return 'Failed';
    case 'waiting':
      return 'Waiting';
    case 'stopped':
      return 'Stopped';
    case 'idle':
      return 'Ready';
  }
}

function statusTone(status: ExecutionTopologyNodeStatus): string {
  switch (status) {
    case 'running':
      return 'text-accent';
    case 'completed':
      return 'text-success';
    case 'failed':
      return 'text-error';
    case 'waiting':
    case 'stopped':
      return 'text-warning';
    case 'idle':
      return 'text-text-tertiary';
  }
}

function StatusIcon({
  status,
  kind,
}: {
  status: ExecutionTopologyNodeStatus;
  kind: ExecutionTopologyNode['kind'];
}) {
  const className = 'h-3.5 w-3.5 shrink-0';
  if (status === 'running') {
    return (
      <Loader2 className={`${className} animate-spin text-accent motion-reduce:animate-none`} />
    );
  }
  if (status === 'completed') return <CheckCircle2 className={`${className} text-success`} />;
  if (status === 'failed') return <OctagonX className={`${className} text-error`} />;
  if (status === 'waiting' || status === 'stopped') {
    return <PauseCircle className={`${className} text-warning`} />;
  }
  if (kind === 'thread') return <GitFork className={`${className} text-info`} />;
  if (kind === 'session') return <Bot className={`${className} text-text-secondary`} />;
  return <Circle className={`${className} text-text-muted`} />;
}
