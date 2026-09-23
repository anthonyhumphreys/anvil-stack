import { useEffect, useRef, useState } from 'react';
import { Bot, CheckCircle2, Target, X } from 'lucide-react';
import type { AgentRunSummary, ChatGoalSnapshot } from '../../../shared/types';
import type { ExecutionTopology } from '../../utils/execution-topology';
import { ExecutionTopologyPanel } from './ExecutionTopologyPanel';
import { formatGoalStatus } from './chat-view-utils';

/**
 * Right-rail "Activity" panel — extracted from ChatView (Phase 5 split).
 * Shows the live execution topology for the current thread plus recent agent
 * run history for the workspace, and hosts the goal popover control.
 */
export function AgentActivitySidebar({
  workspaceName,
  runs,
  topology,
  activeGoal,
  busy,
  goalOpen,
  onGoalOpenChange,
  onSetGoal,
  onCompleteGoal,
  onClose,
  onOpenThread,
  onStop,
  goalsSupported = true,
  agentLabel = 'The agent',
}: {
  workspaceName: string;
  runs: AgentRunSummary[];
  topology: ExecutionTopology;
  activeGoal: ChatGoalSnapshot | null;
  busy: boolean;
  goalOpen: boolean;
  onGoalOpenChange: (open: boolean) => void;
  onSetGoal: (objective: string, tokenBudget: string) => void;
  onCompleteGoal: () => void;
  onClose: () => void;
  onOpenThread: (threadId: string) => void;
  onStop: (sessionId: string) => void;
  /** H12 — goals are a Codex capability; ACP sessions disable the control. */
  goalsSupported?: boolean;
  /** H13 — provider display name for goal copy. */
  agentLabel?: string;
}) {
  const [section, setSection] = useState<'current' | 'history'>('current');
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  return (
    <div
      ref={panelRef}
      className="flex min-h-0 flex-1 flex-col focus:outline-none"
      role="region"
      aria-label="Agent activity"
      tabIndex={-1}
    >
      <div className="shrink-0 border-b border-border/60 px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Bot
                size={14}
                className={topology.runningCount > 0 ? 'text-accent' : 'text-text-tertiary'}
              />
              <h3 className="text-sm font-semibold text-text-primary">Activity</h3>
              {topology.runningCount > 0 && (
                <span className="rounded-full bg-accent/10 px-2 py-0.5 text-eyebrow font-medium text-accent">
                  {topology.runningCount} working
                </span>
              )}
            </div>
            <p className="mt-1 truncate text-xs text-text-tertiary">
              Current thread · {workspaceName}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            aria-label="Close activity"
          >
            <X size={14} />
          </button>
        </div>
        <div className="mt-3 flex items-center justify-between gap-2">
          <div className="flex gap-1 rounded-lg bg-bg-primary/60 p-0.5" role="tablist">
            {(['current', 'history'] as const).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={section === item}
                onClick={() => setSection(item)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors ${
                  section === item
                    ? 'bg-bg-tertiary text-text-primary'
                    : 'text-text-tertiary hover:text-text-primary'
                }`}
              >
                {item}
              </button>
            ))}
          </div>
          <GoalControl
            activeGoal={activeGoal}
            busy={busy}
            open={goalOpen}
            onOpenChange={onGoalOpenChange}
            onSetGoal={onSetGoal}
            onCompleteGoal={onCompleteGoal}
            supported={goalsSupported}
            agentLabel={agentLabel}
          />
        </div>
      </div>
      {section === 'current' ? (
        <ExecutionTopologyPanel topology={topology} onOpenThread={onOpenThread} onStop={onStop} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto py-2">
          <p className="px-3 pb-2 text-xs text-text-tertiary">Recent in {workspaceName}</p>
          {runs.length === 0 ? (
            <p className="px-2 py-4 text-center text-sm text-text-tertiary">
              No run history captured yet.
            </p>
          ) : (
            runs.map((run) => (
              <div
                key={run.id}
                className="mb-1 border-b border-border-subtle px-3 py-2.5 last:border-b-0"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-text-primary">
                      {run.title}
                    </div>
                    <div className="mt-0.5 text-xs text-text-tertiary">
                      {formatAgentRunSource(run.source)} · {formatTimestamp(run.startedAt)}
                    </div>
                  </div>
                  <span className={`shrink-0 text-xs ${statusTone(run.status)}`}>{run.status}</span>
                </div>
                {run.summary && (
                  <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-text-secondary">
                    {run.summary}
                  </p>
                )}
                <div className="mt-2 flex items-center gap-2 text-xs text-text-tertiary">
                  <span>{run.changedFileCount} files</span>
                  <span>{run.evidenceCount} evidence</span>
                  {run.threadId && (
                    <button
                      type="button"
                      onClick={() => {
                        onOpenThread(run.threadId!);
                        onClose();
                      }}
                      className="ml-auto font-medium text-accent hover:underline"
                    >
                      Open thread
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function formatAgentRunSource(source: AgentRunSummary['source']): string {
  switch (source) {
    case 'automation':
      return 'Automation';
    case 'code_review':
      return 'Code review';
    case 'chat':
    default:
      return 'Chat';
  }
}

function statusTone(status: AgentRunSummary['status']): string {
  switch (status) {
    case 'completed':
      return 'text-success';
    case 'failed':
      return 'text-error';
    case 'running':
    case 'queued':
      return 'text-accent';
    default:
      return 'text-text-tertiary';
  }
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function GoalControl({
  activeGoal,
  busy,
  open,
  onOpenChange,
  onSetGoal,
  onCompleteGoal,
  supported = true,
  agentLabel = 'The agent',
}: {
  activeGoal: ChatGoalSnapshot | null;
  busy: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSetGoal: (objective: string, tokenBudget: string) => void;
  onCompleteGoal: () => void;
  supported?: boolean;
  agentLabel?: string;
}) {
  const [objective, setObjective] = useState('');
  const [tokenBudget, setTokenBudget] = useState('');
  const hasActiveGoal = !!activeGoal && activeGoal.status !== 'complete';

  useEffect(() => {
    if (!open) return;
    setObjective(activeGoal?.status === 'complete' ? '' : (activeGoal?.objective ?? ''));
    setTokenBudget(activeGoal?.tokenBudget ? String(activeGoal.tokenBudget) : '');
  }, [activeGoal, open]);

  const canSubmit = objective.trim().length > 0 && !busy;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        disabled={!supported}
        className={`flex max-w-[260px] items-center gap-1.5 rounded-xl border px-3 py-1.5 text-sm transition-colors ${
          !supported
            ? 'cursor-not-allowed border-border-subtle text-text-muted opacity-60'
            : hasActiveGoal
              ? 'border-success/30 bg-success/10 text-success hover:bg-bg-tertiary'
              : 'border-border text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
        }`}
        title={
          !supported
            ? `${agentLabel} does not support goals`
            : activeGoal
              ? activeGoal.objective
              : 'Set goal'
        }
        aria-expanded={open}
        aria-label={activeGoal ? `Active goal: ${activeGoal.objective}` : 'Set goal'}
      >
        <Target size={13} className="shrink-0" />
        <span className="min-w-0 truncate">{activeGoal ? activeGoal.objective : 'Set goal'}</span>
        {activeGoal && (
          <span className="shrink-0 rounded-full bg-bg-primary/70 px-1.5 py-0.5 text-eyebrow uppercase tracking-normal text-text-tertiary">
            {formatGoalStatus(activeGoal.status)}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-bg-elevated p-3 shadow-2xl ring-1 ring-overlay">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-text-primary">
                {activeGoal ? 'Update goal' : 'Set goal'}
              </p>
              <p className="mt-0.5 text-xs text-text-tertiary">
                Stored on this thread when {agentLabel} confirms the goal update.
              </p>
            </div>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-lg p-1 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
              aria-label="Close goal popover"
            >
              <X size={14} />
            </button>
          </div>

          <label className="mt-3 block text-xs font-medium text-text-secondary" htmlFor="goal-text">
            Goal
          </label>
          <textarea
            id="goal-text"
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
            className="mt-1 min-h-24 w-full resize-y rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm leading-relaxed text-text-primary outline-none transition-colors placeholder:text-text-tertiary focus:border-accent"
            placeholder="Finish the refactor and verify the tests pass"
            disabled={busy}
          />

          <label
            className="mt-3 block text-xs font-medium text-text-secondary"
            htmlFor="goal-token-budget"
          >
            Token budget
          </label>
          <input
            id="goal-token-budget"
            value={tokenBudget}
            onChange={(event) => setTokenBudget(event.target.value)}
            className="mt-1 w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none transition-colors placeholder:text-text-tertiary focus:border-accent"
            inputMode="numeric"
            pattern="[0-9]*"
            placeholder="Optional"
            disabled={busy}
          />

          {activeGoal && (
            <div className="mt-3 rounded-xl border border-border/70 bg-bg-secondary/70 px-3 py-2 text-xs text-text-tertiary">
              {activeGoal.tokensUsed.toLocaleString()} tokens
              {activeGoal.tokenBudget ? ` / ${activeGoal.tokenBudget.toLocaleString()}` : ''} used
            </div>
          )}

          <div className="mt-3 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={onCompleteGoal}
              disabled={!hasActiveGoal || busy}
              className="flex items-center gap-1.5 rounded-xl border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              <CheckCircle2 size={13} />
              Complete
            </button>
            <button
              type="button"
              onClick={() => onSetGoal(objective, tokenBudget)}
              disabled={!canSubmit}
              className="flex items-center gap-1.5 rounded-xl bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Target size={13} />
              {activeGoal ? 'Update' : 'Set'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
