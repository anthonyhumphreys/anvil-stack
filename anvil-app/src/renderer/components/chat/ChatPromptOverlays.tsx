import { useState } from 'react';
import { ChevronDown, ChevronRight, ListChecks, Loader2, MessageSquare } from 'lucide-react';
import type { AgentUIQuestionIntent } from '../../../shared/agent-ui-intents';
import type { WorkflowChatIntent } from '../../utils/workflow-chat-intent';
import { QuestionIntentSurface } from './AgentUIIntentSurface';

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

export function WorkflowActionConfirmation({
  pending,
  confirming,
  onConfirm,
  onKeepInChat,
}: {
  pending: PendingWorkflowAction;
  confirming: boolean;
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
