import { useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  ListChecks,
  Loader2,
  MessageSquare,
} from 'lucide-react';
import type { AgentUIPlanIntent, AgentUIQuestionIntent } from '../../../shared/agent-ui-intents';
import type { ChatPlanSnapshot } from '../../../shared/types';
import type { WorkflowChatIntent } from '../../utils/workflow-chat-intent';
import { PlanIntentSurface, QuestionIntentSurface } from './AgentUIIntentSurface';

/**
 * Composer-level prompt overlays — extracted from ChatView (Phase 5 split).
 * Both render immediately above the composer and gate input while active.
 */

export interface PendingWorkflowAction {
  message: string;
  intent: WorkflowChatIntent;
  workspaceId: string;
  workspaceName: string;
  repoIds: string[];
  executionStrategyPrompt?: string;
  fastMode: boolean;
}

export function PendingQuestionPrompt({
  intent,
  additionalCount,
}: {
  intent: AgentUIQuestionIntent;
  additionalCount: number;
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="border-t border-warning/25 bg-warning/[0.035]">
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50"
        aria-expanded={expanded}
      >
        <MessageSquare size={14} className="shrink-0 text-warning" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold text-text-primary">
            {intent.payload.title ?? 'Agent needs your input'}
          </span>
          <span className="block truncate text-xs text-text-tertiary">
            {intent.payload.questions[0]?.question}
            {additionalCount > 0
              ? ` · ${additionalCount} more request${additionalCount === 1 ? '' : 's'}`
              : ''}
          </span>
        </span>
        <span className="rounded-md bg-warning/10 px-2 py-1 text-xs font-semibold text-warning">
          {expanded ? 'Hide' : 'Answer'}
        </span>
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      <div
        hidden={!expanded}
        className="max-h-[min(60vh,560px)] overflow-y-auto border-t border-warning/20 p-2"
      >
        <QuestionIntentSurface intent={intent} />
      </div>
    </div>
  );
}

/** Progress for the sticky plan chip: completed and total steps. */
export function planProgress(
  plan:
    { kind: 'intent'; intent: AgentUIPlanIntent } | { kind: 'snapshot'; plan: ChatPlanSnapshot },
): { done: number; total: number; title: string } {
  if (plan.kind === 'intent') {
    const steps = plan.intent.payload.steps;
    return {
      done: steps.filter((step) => step.status === 'done').length,
      total: steps.length,
      title: plan.intent.payload.title,
    };
  }
  return {
    done: plan.plan.steps.filter((step) => step.status === 'completed').length,
    total: plan.plan.steps.length,
    title: 'Implementation plan',
  };
}

/** Sticky "Plan x/y" chip above the composer; expands the active plan in place. */
export function PlanChip({
  intent,
  snapshot,
}: {
  intent?: AgentUIPlanIntent;
  snapshot?: ChatPlanSnapshot | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const source = intent
    ? ({ kind: 'intent', intent } as const)
    : snapshot
      ? ({ kind: 'snapshot', plan: snapshot } as const)
      : null;
  if (!source) return null;
  const { done, total, title } = planProgress(source);
  if (total === 0) return null;

  return (
    <div className="mx-auto w-full max-w-[1040px] px-4 pb-2 xl:px-6">
      <div className={expanded ? 'rounded-xl border border-border-subtle bg-bg-secondary' : ''}>
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
          className={`flex items-center gap-2 rounded-full border border-border-subtle px-2.5 py-1 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${expanded ? 'm-2' : ''}`}
        >
          <ListChecks size={13} aria-hidden="true" className="text-info" />
          <span className="max-w-64 truncate font-medium text-text-primary">{title}</span>
          <span className="tabular-nums">
            Plan {done}/{total}
          </span>
          {expanded ? (
            <ChevronDown size={12} aria-hidden="true" />
          ) : (
            <ChevronRight size={12} aria-hidden="true" />
          )}
        </button>
        {expanded && (
          <div className="max-h-[min(50vh,480px)] overflow-y-auto border-t border-border-subtle">
            {source.kind === 'intent' ? (
              <PlanIntentSurface intent={source.intent} mode="workbench" />
            ) : (
              <ol className="space-y-1.5 p-3">
                {source.plan.explanation && (
                  <li className="mb-2 max-w-[72ch] text-xs leading-5 text-text-secondary">
                    {source.plan.explanation}
                  </li>
                )}
                {source.plan.steps.map((step, index) => (
                  <li key={`${index}-${step.step}`} className="flex items-start gap-2 text-sm">
                    {step.status === 'completed' ? (
                      <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-success" />
                    ) : step.status === 'in_progress' ? (
                      <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin text-info" />
                    ) : (
                      <Circle size={14} className="mt-0.5 shrink-0 text-text-tertiary" />
                    )}
                    <span
                      className={
                        step.status === 'completed'
                          ? 'text-text-tertiary line-through'
                          : 'text-text-secondary'
                      }
                    >
                      {step.step}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function WorkflowActionConfirmation({
  pending,
  confirming,
  error,
  onConfirm,
  onKeepInChat,
}: {
  pending: PendingWorkflowAction;
  confirming: boolean;
  error?: string | null;
  onConfirm: () => void;
  onKeepInChat: () => void;
}) {
  const { intent } = pending;
  const title =
    intent.kind === 'run'
      ? `Run "${intent.template.name}"?`
      : intent.kind === 'draft'
        ? 'Open the workflow builder?'
        : 'Choose a workflow to run?';
  const detail =
    intent.kind === 'run'
      ? `This starts the saved workflow in ${pending.workspaceName}.`
      : intent.kind === 'draft'
        ? 'Anvil detected a request to create a workflow.'
        : 'Anvil detected a request to start a workflow.';
  const confirmLabel =
    intent.kind === 'run'
      ? 'Run workflow'
      : intent.kind === 'draft'
        ? 'Open builder'
        : 'Choose workflow';

  return (
    <div
      className="flex items-center gap-3 border-t border-accent/25 bg-accent/[0.045] px-4 py-3"
      role="region"
      aria-live="polite"
      aria-label="Confirm workflow action"
    >
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
        <ListChecks size={15} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-text-primary">{title}</p>
        <p className="mt-0.5 truncate text-xs text-text-tertiary">{detail}</p>
        {error && (
          <p role="alert" className="mt-1 text-xs text-error">
            {error}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={onKeepInChat}
        disabled={confirming}
        className="rounded-md px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
      >
        Keep in chat
      </button>
      <button
        type="button"
        onClick={onConfirm}
        disabled={confirming}
        className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-xs font-semibold text-accent-foreground hover:bg-accent/85 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {confirming && <Loader2 size={13} className="animate-spin" />}
        {confirmLabel}
      </button>
    </div>
  );
}
