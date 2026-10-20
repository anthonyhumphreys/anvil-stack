import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Archive,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  EyeOff,
  ListChecks,
  Loader2,
  MessageSquare,
  Pencil,
  Save,
  ShieldCheck,
  X,
} from 'lucide-react';
import type {
  AgentUIAnswerValue,
  AgentUIIntent,
  AgentUIPlanIntent,
  AgentUIPlanPatchOperation,
  AgentUIPlanStep,
  AgentUIQuestion,
  AgentUIQuestionIntent,
} from '../../../shared/agent-ui-intents';
import { SurfaceHost } from '../surfaces/SurfaceHost';
import { CHAT_PREFILL_EVENT } from './chat-prefill';
import { useChatRequest } from './useChatRequest';

export { CHAT_PREFILL_EVENT } from './chat-prefill';

/** `workbench` is the expanded, editable presentation (the sticky plan chip). */
export type AgentUIIntentMode = 'chat' | 'workbench';

export function AgentUIIntentSurface({
  intent,
  mode = 'chat',
}: {
  intent: AgentUIIntent;
  mode?: AgentUIIntentMode;
}) {
  if (intent.kind === 'surface') return <SurfaceHost intent={intent} />;
  return intent.kind === 'plan' ? (
    <PlanIntentSurface intent={intent} mode={mode} />
  ) : (
    <QuestionIntentSurface intent={intent} compact={mode === 'workbench'} />
  );
}

export function PlanIntentSurface({
  intent: incomingIntent,
  mode = 'workbench',
}: {
  intent: AgentUIPlanIntent;
  mode?: AgentUIIntentMode;
}) {
  const [intent, setIntent] = useState(incomingIntent);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(incomingIntent.payload.title);
  const [description, setDescription] = useState(incomingIntent.payload.description ?? '');
  const [stepTitles, setStepTitles] = useState<Record<string, string>>(() =>
    Object.fromEntries(incomingIntent.payload.steps.map((step) => [step.id, step.title])),
  );
  const {
    pending: submitting,
    error,
    run,
  } = useChatRequest('Could not update your plan. Try again.');

  useEffect(() => {
    setIntent(incomingIntent);
    if (!editing) {
      setTitle(incomingIntent.payload.title);
      setDescription(incomingIntent.payload.description ?? '');
      setStepTitles(
        Object.fromEntries(incomingIntent.payload.steps.map((step) => [step.id, step.title])),
      );
    }
  }, [editing, incomingIntent]);

  const completed = intent.payload.steps.filter((step) => step.status === 'done').length;
  const progress = intent.payload.steps.length
    ? Math.round((completed / intent.payload.steps.length) * 100)
    : 0;
  const phases = useMemo(
    () => [
      ...intent.payload.phases,
      ...(intent.payload.steps.some((step) => !step.phaseId)
        ? [{ id: '__unphased', title: intent.payload.phases.length ? 'Other steps' : 'Steps' }]
        : []),
    ],
    [intent.payload.phases, intent.payload.steps],
  );

  const updatePresentation = async (patch: { collapsed?: boolean; hidden?: boolean }) => {
    await run(async () => {
      const updated = await window.anvil.chat.updateAgentUIIntentPresentation(intent.id, patch);
      if (updated.kind === 'plan') setIntent(updated);
    });
  };

  const restore = async () => {
    await run(async () => {
      const updated = await window.anvil.chat.restoreAgentUIIntent(intent.id);
      if (updated.kind === 'plan') setIntent(updated);
    });
  };

  const applyOperations = async (operations: AgentUIPlanPatchOperation[]) => {
    await run(async () => {
      const updated = await window.anvil.chat.patchAgentUIPlan(intent.id, {
        planId: intent.payload.planId,
        baseRevision: intent.revision,
        operationId: crypto.randomUUID(),
        actor: 'user',
        operations,
      });
      setIntent(updated);
      setEditing(false);
    });
  };

  const saveEdits = () => {
    const operations: AgentUIPlanPatchOperation[] = [
      { type: 'set_plan_metadata', title, description },
      ...intent.payload.steps.flatMap((step): AgentUIPlanPatchOperation[] => {
        const nextTitle = stepTitles[step.id]?.trim();
        return nextTitle && nextTitle !== step.title
          ? [{ type: 'update_step', stepId: step.id, changes: { title: nextTitle } }]
          : [];
      }),
    ];
    void applyOperations(operations);
  };

  const askAboutStep = (step: AgentUIPlanStep) => {
    window.dispatchEvent(
      new CustomEvent(CHAT_PREFILL_EVENT, {
        detail: { text: `Tell me more about the plan step “${step.title}”.` },
      }),
    );
  };

  if (intent.presentation.hidden || intent.lifecycle === 'dismissed') {
    return (
      <div className="flex items-center gap-2 border-y border-border-subtle px-3 py-2.5 text-xs text-text-secondary">
        <EyeOff size={13} className="text-text-tertiary" />
        <span className="min-w-0 flex-1 truncate">{intent.payload.title}</span>
        <button
          type="button"
          onClick={() =>
            void (intent.lifecycle === 'dismissed'
              ? restore()
              : updatePresentation({ hidden: false }))
          }
          className="rounded-md px-2 py-1 font-medium text-accent hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          Restore
        </button>
      </div>
    );
  }

  return (
    <section
      id={`agent-ui-intent-${intent.id}`}
      className={
        mode === 'chat'
          ? 'overflow-hidden rounded-xl border border-info/25 bg-info/5'
          : 'border-y border-border-subtle bg-bg-primary/25'
      }
      aria-label={intent.payload.title}
    >
      <div className="flex items-start gap-2.5 px-3 py-3">
        <ListChecks size={14} className="mt-0.5 shrink-0 text-info" />
        <button
          type="button"
          onClick={() => void updatePresentation({ collapsed: !intent.presentation.collapsed })}
          className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          aria-expanded={!intent.presentation.collapsed}
        >
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-text-primary">
              {intent.payload.title}
            </span>
            <span className="shrink-0 rounded-full bg-info/10 px-2 py-0.5 text-eyebrow font-medium text-info">
              {formatPlanLifecycle(intent.payload.lifecycle)}
            </span>
          </span>
          <span className="mt-1 flex items-center gap-2 text-xs text-text-tertiary">
            <span>
              {completed}/{intent.payload.steps.length} complete
            </span>
            <span className="h-1.5 min-w-16 max-w-32 flex-1 overflow-hidden rounded-full bg-border-subtle">
              <span className="block h-full bg-info" style={{ width: `${progress}%` }} />
            </span>
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          {mode === 'workbench' && !editing && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="rounded-md p-1.5 text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              title="Edit plan"
              aria-label="Edit plan"
            >
              <Pencil size={13} />
            </button>
          )}
          {mode === 'workbench' && (
            <button
              type="button"
              onClick={() => void updatePresentation({ hidden: true })}
              className="rounded-md p-1.5 text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              title="Hide plan"
              aria-label="Hide plan"
            >
              <EyeOff size={13} />
            </button>
          )}
          {mode === 'workbench' && intent.payload.lifecycle === 'completed' && (
            <button
              type="button"
              onClick={() => void applyOperations([{ type: 'archive_plan' }])}
              className="rounded-md p-1.5 text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              title="Archive completed plan"
              aria-label="Archive completed plan"
            >
              <Archive size={13} />
            </button>
          )}
          <button
            type="button"
            onClick={() => void updatePresentation({ collapsed: !intent.presentation.collapsed })}
            className="rounded-md p-1.5 text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            title={intent.presentation.collapsed ? 'Expand plan' : 'Collapse plan'}
            aria-label={intent.presentation.collapsed ? 'Expand plan' : 'Collapse plan'}
          >
            {intent.presentation.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
      </div>

      {!intent.presentation.collapsed && (
        <div className="border-t border-border-subtle px-3 py-3">
          {editing ? (
            <div className="space-y-2">
              <label className="block">
                <span className="sr-only">Plan title</span>
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm font-medium text-text-primary outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
                />
              </label>
              <label className="block">
                <span className="sr-only">Plan description</span>
                <textarea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  rows={2}
                  placeholder="Add plan context"
                  className="w-full resize-y rounded-lg border border-border bg-bg-primary px-3 py-2 text-xs leading-5 text-text-primary outline-none placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
                />
              </label>
            </div>
          ) : (
            intent.payload.description && (
              <p className="mb-3 max-w-[72ch] text-xs leading-5 text-text-secondary">
                {intent.payload.description}
              </p>
            )
          )}

          <div className="space-y-3">
            {phases.map((phase) => {
              const phaseSteps = intent.payload.steps.filter((step) =>
                phase.id === '__unphased' ? !step.phaseId : step.phaseId === phase.id,
              );
              if (phaseSteps.length === 0) return null;
              return (
                <div key={phase.id}>
                  {(intent.payload.phases.length > 0 || phase.id !== '__unphased') && (
                    <p className="mb-1.5 text-xs font-semibold text-text-secondary">
                      {phase.title}
                    </p>
                  )}
                  <ol className="space-y-1">
                    {phaseSteps.map((step) => (
                      <li
                        key={step.id}
                        className="group flex min-w-0 items-start gap-2 rounded-lg px-1 py-1.5 hover:bg-bg-tertiary/45"
                      >
                        <PlanStepIcon status={step.status} />
                        <div className="min-w-0 flex-1">
                          {editing ? (
                            <input
                              value={stepTitles[step.id] ?? ''}
                              onChange={(event) =>
                                setStepTitles((previous) => ({
                                  ...previous,
                                  [step.id]: event.target.value,
                                }))
                              }
                              className="w-full rounded-md border border-border bg-bg-primary px-2 py-1 text-sm text-text-primary outline-none focus:border-accent"
                            />
                          ) : (
                            <p
                              className={`text-sm leading-5 ${step.status === 'done' ? 'text-text-tertiary line-through' : 'text-text-secondary'}`}
                            >
                              {step.title}
                            </p>
                          )}
                          {!editing && step.owner && (
                            <p className="mt-0.5 text-xs text-text-tertiary">Owner: {step.owner}</p>
                          )}
                          {!editing && step.notes && (
                            <p className="mt-0.5 text-xs leading-5 text-text-tertiary">
                              {step.notes}
                            </p>
                          )}
                        </div>
                        {!editing && mode === 'workbench' && (
                          <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                            {step.status !== 'done' && (
                              <button
                                type="button"
                                onClick={() =>
                                  void applyOperations([
                                    { type: 'set_step_status', stepId: step.id, status: 'done' },
                                  ])
                                }
                                className="rounded-md px-2 py-1 text-xs font-medium text-success hover:bg-success/10 focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                              >
                                Complete
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => askAboutStep(step)}
                              className="rounded-md px-2 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                            >
                              Ask agent
                            </button>
                          </div>
                        )}
                      </li>
                    ))}
                  </ol>
                </div>
              );
            })}
          </div>

          {error && <p className="mt-3 text-xs text-error">{error}</p>}
          {editing && (
            <div className="mt-3 flex justify-end gap-2 border-t border-border-subtle pt-3">
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="rounded-md px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-tertiary"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveEdits}
                disabled={submitting || !title.trim()}
                className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground hover:bg-accent/85 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {submitting ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                Save plan
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function QuestionIntentSurface({
  intent,
  compact = false,
}: {
  intent: AgentUIQuestionIntent;
  compact?: boolean;
}) {
  return <QuestionForm key={intent.id} intent={intent} compact={compact} />;
}

const questionSubmitShortcut =
  typeof navigator !== 'undefined' && /Mac/.test(navigator.platform) ? '⌘ Enter' : 'Ctrl Enter';

function QuestionForm({
  intent: incomingIntent,
  compact = false,
}: {
  intent: AgentUIQuestionIntent;
  compact?: boolean;
}) {
  const [intent, setIntent] = useState(incomingIntent);
  const [answers, setAnswers] = useState<Record<string, AgentUIAnswerValue>>(() =>
    Object.fromEntries(
      incomingIntent.payload.questions.flatMap((question) =>
        question.defaultValue === undefined ? [] : [[question.id, question.defaultValue]],
      ),
    ),
  );
  const {
    pending: submitting,
    error,
    run,
    clearError,
  } = useChatRequest('Could not send your answer. Try again.');
  const [activeIndex, setActiveIndex] = useState(0);
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      incomingIntent.payload.questions.flatMap((question) =>
        typeof question.defaultValue === 'string' &&
        !question.options?.some((option) => option.value === question.defaultValue)
          ? [[question.id, question.defaultValue]]
          : [],
      ),
    ),
  );
  const [customSelections, setCustomSelections] = useState<Record<string, boolean>>({});
  const questionRef = useRef<HTMLDivElement>(null);
  const formId = useId();

  useEffect(() => setIntent(incomingIntent), [incomingIntent]);

  const complete = intent.payload.questions.every(
    (question) => !question.required || hasQuestionAnswer(answers[question.id]),
  );
  const canCancel = intent.payload.questions.every((question) => question.allowCancel);
  const canSkip = intent.payload.questions.every((question) => !question.required);
  const questions = intent.payload.questions;
  const singleApproval = questions.length === 1 && questions[0].kind === 'approval';
  const activeQuestion = questions[Math.min(activeIndex, questions.length - 1)];
  const isLast = activeIndex >= questions.length - 1;
  const canContinue =
    activeQuestion && (!activeQuestion.required || hasQuestionAnswer(answers[activeQuestion.id]));

  const navigate = (index: number) => {
    setActiveIndex(index);
    clearError();
    questionRef.current?.focus();
  };

  const submit = async (action: 'submit' | 'skip' | 'cancel', submittedAnswers = answers) => {
    await run(async () => {
      const resolved = await window.anvil.chat.resolveAgentUIQuestion(intent.id, {
        intentId: intent.id,
        action,
        answers: submittedAnswers,
        answeredAt: new Date().toISOString(),
      });
      setIntent(resolved);
    });
  };

  if (intent.lifecycle === 'resolved' || intent.lifecycle === 'dismissed') {
    const receipt = intent.payload.response;
    return (
      <div role="status" className="space-y-3 rounded-lg border border-border-subtle px-4 py-3">
        <div className="flex items-center gap-2 text-xs font-medium text-text-secondary">
          <CheckCircle2 size={14} className="shrink-0" />
          {intent.lifecycle === 'resolved'
            ? 'Answer sent'
            : receipt?.action === 'skip'
              ? 'Skipped'
              : 'Cancelled'}
        </div>
        {intent.lifecycle === 'resolved' && receipt && (
          <dl className="space-y-3">
            {questions.map((question) => (
              <div key={question.id}>
                <dt className="break-words text-xs leading-5 text-text-secondary">
                  {question.question}
                </dt>
                <dd className="mt-0.5 whitespace-pre-wrap break-words text-sm leading-5 text-text-primary">
                  {formatQuestionAnswer(question, receipt.answers[question.id])}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    );
  }

  if (intent.lifecycle === 'expired') {
    return (
      <div
        role="status"
        className="flex items-center gap-2 rounded-lg border border-border-subtle px-4 py-3"
      >
        <MessageSquare size={14} className="shrink-0 text-text-tertiary" />
        <p className="text-xs text-text-secondary">
          This question is no longer waiting for an answer.
        </p>
      </div>
    );
  }

  return (
    <form
      id={formId}
      aria-label={intent.payload.title ?? 'Agent questions'}
      aria-busy={submitting}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
          event.preventDefault();
          if (!singleApproval && !submitting && canContinue) {
            if (!isLast) navigate(activeIndex + 1);
            else if (complete) void submit('submit');
          }
          return;
        }
        const target = event.target as HTMLElement;
        if (
          submitting ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          target.isContentEditable ||
          target.tagName === 'TEXTAREA' ||
          (target instanceof HTMLInputElement &&
            target.type !== 'radio' &&
            target.type !== 'checkbox') ||
          !/^[1-9]$/.test(event.key) ||
          !activeQuestion
        )
          return;
        const option = activeQuestion.options?.[Number(event.key) - 1];
        if (!option) return;
        event.preventDefault();
        setCustomSelections((previous) => ({ ...previous, [activeQuestion.id]: false }));
        setAnswers((previous) => {
          const value = previous[activeQuestion.id];
          const values = Array.isArray(value) ? value : [];
          return {
            ...previous,
            [activeQuestion.id]:
              activeQuestion.kind === 'multiple_choice'
                ? values.includes(option.value)
                  ? values.filter((item) => item !== option.value)
                  : [...values, option.value]
                : option.value,
          };
        });
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (singleApproval || submitting || !canContinue) return;
        if (!isLast) navigate(activeIndex + 1);
        else if (complete) void submit('submit');
      }}
      className={
        compact
          ? 'flex max-h-[min(50vh,480px)] flex-col bg-transparent'
          : 'overflow-hidden rounded-xl border border-border bg-bg-secondary'
      }
    >
      {!compact && (
        <div className="flex items-center gap-2.5 border-b border-border-subtle px-4 py-3">
          <MessageSquare size={15} className="shrink-0 text-text-secondary" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-text-primary">
              {intent.payload.title ?? 'A question for you'}
            </p>
          </div>
        </div>
      )}

      {questions.length > 1 && (
        <nav
          aria-label="Questions"
          className="flex flex-wrap items-center gap-1 border-b border-border-subtle px-4 py-2"
        >
          <span className="mr-auto text-xs text-text-secondary">
            Question {activeIndex + 1} of {questions.length}
          </span>
          {questions.map((question, index) => (
            <button
              key={question.id}
              type="button"
              aria-current={index === activeIndex ? 'step' : undefined}
              aria-label={`Question ${index + 1}${hasQuestionAnswer(answers[question.id]) ? ', answered' : ''}`}
              disabled={submitting}
              onClick={() => navigate(index)}
              className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40 ${index === activeIndex ? 'bg-bg-tertiary font-semibold text-text-primary' : 'text-text-secondary hover:bg-bg-tertiary'}`}
            >
              {hasQuestionAnswer(answers[question.id]) && <CheckCircle2 size={12} />}
              {index + 1}
            </button>
          ))}
        </nav>
      )}
      <div
        ref={questionRef}
        tabIndex={-1}
        className={`space-y-3 p-4 outline-none ${compact ? 'min-h-0 overflow-y-auto' : ''}`}
        aria-live="polite"
      >
        {activeQuestion && (
          <QuestionField
            key={activeQuestion.id}
            question={activeQuestion}
            disabled={submitting}
            showApprovalChoices={!singleApproval}
            value={answers[activeQuestion.id]}
            customAnswer={customAnswers[activeQuestion.id] ?? ''}
            customSelected={
              customSelections[activeQuestion.id] ??
              (typeof answers[activeQuestion.id] === 'string' &&
                !(activeQuestion.options ?? []).some(
                  (option) => option.value === answers[activeQuestion.id],
                ))
            }
            onCustomChange={(value) => {
              setCustomSelections((previous) => ({ ...previous, [activeQuestion.id]: true }));
              setCustomAnswers((previous) => ({ ...previous, [activeQuestion.id]: value }));
              setAnswers((previous) => ({ ...previous, [activeQuestion.id]: value }));
            }}
            onChange={(value) => {
              setCustomSelections((previous) => ({ ...previous, [activeQuestion.id]: false }));
              setAnswers((previous) => ({ ...previous, [activeQuestion.id]: value }));
            }}
          />
        )}
        {!singleApproval && isLast && !complete && (
          <p className="text-xs text-text-secondary">
            Answer each required question before sending.
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-error">
            {error}
          </p>
        )}
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border-subtle px-4 py-2.5">
        {singleApproval ? (
          <>
            <button
              type="button"
              onClick={() => void submit('submit', { [questions[0].id]: false })}
              disabled={submitting}
              className="rounded-md px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40"
            >
              Reject
            </button>
            <button
              type="button"
              onClick={() => void submit('submit', { [questions[0].id]: true })}
              disabled={submitting}
              className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-xs font-semibold text-accent-foreground hover:bg-accent/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-secondary disabled:opacity-40"
            >
              {submitting && (
                <Loader2 size={13} className="animate-spin motion-reduce:animate-none" />
              )}
              {submitting ? 'Sending…' : 'Approve'}
            </button>
          </>
        ) : (
          <>
            <span className="mr-auto text-xs text-text-tertiary">{questionSubmitShortcut}</span>
            {activeIndex > 0 && (
              <button
                type="button"
                onClick={() => navigate(activeIndex - 1)}
                disabled={submitting}
                className="rounded-md px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg-tertiary focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40"
              >
                Back
              </button>
            )}
            {canCancel && (
              <button
                type="button"
                onClick={() => void submit('cancel')}
                disabled={submitting}
                className="rounded-md px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 disabled:opacity-40"
              >
                Cancel
              </button>
            )}
            {canSkip && (
              <button
                type="button"
                onClick={() => void submit('skip')}
                disabled={submitting}
                className="rounded-md px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 disabled:opacity-40"
              >
                Skip
              </button>
            )}
            <button
              type="submit"
              disabled={!canContinue || (isLast && !complete) || submitting}
              className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-xs font-semibold text-accent-foreground hover:bg-accent/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-secondary disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting && (
                <Loader2 size={13} className="animate-spin motion-reduce:animate-none" />
              )}
              {submitting ? 'Sending…' : isLast ? 'Send answer' : 'Next'}
            </button>
          </>
        )}
      </div>
    </form>
  );
}

function QuestionField({
  question,
  value,
  onChange,
  disabled,
  customAnswer,
  customSelected,
  onCustomChange,
  showApprovalChoices = true,
}: {
  question: AgentUIQuestion;
  customAnswer: string;
  customSelected: boolean;
  onCustomChange: (value: string) => void;
  value: AgentUIAnswerValue | undefined;
  onChange: (value: AgentUIAnswerValue) => void;
  disabled: boolean;
  showApprovalChoices?: boolean;
}) {
  const fieldId = useId();
  const isCustom = customSelected;
  return (
    <fieldset disabled={disabled} aria-labelledby={`${fieldId}-label`}>
      <legend
        id={`${fieldId}-label`}
        className="max-w-[72ch] break-words text-sm font-semibold leading-6 text-text-primary"
      >
        {question.question}
        {!question.required && (
          <span className="ml-1 font-normal text-text-tertiary">Optional</span>
        )}
      </legend>
      {question.context && (
        <p className="mt-1 max-w-[72ch] whitespace-pre-wrap break-words text-xs leading-5 text-text-secondary">
          {question.context}
        </p>
      )}

      {(question.kind === 'single_choice' || question.kind === 'multiple_choice') && (
        <div className="mt-3 space-y-2">
          {(question.options ?? []).map((option, index) => {
            const selected =
              question.kind === 'multiple_choice'
                ? Array.isArray(value) && value.includes(option.value)
                : !isCustom && value === option.value;
            return (
              <label
                key={option.id}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors focus-within:ring-2 focus-within:ring-accent ${selected ? 'border-accent/60 bg-accent/10' : 'border-border-subtle hover:border-border hover:bg-bg-tertiary/55'}`}
              >
                <input
                  type={question.kind === 'multiple_choice' ? 'checkbox' : 'radio'}
                  name={fieldId}
                  checked={selected}
                  onChange={() => {
                    if (question.kind === 'multiple_choice') {
                      const values = Array.isArray(value) ? value : [];
                      onChange(
                        selected
                          ? values.filter((candidate) => candidate !== option.value)
                          : [...values, option.value],
                      );
                    } else {
                      onChange(option.value);
                    }
                  }}
                  className="mt-1 accent-accent"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-text-primary">
                    <span className="break-words">{option.label}</span>
                    {option.recommended && (
                      <span className="text-xs font-normal text-text-secondary">Recommended</span>
                    )}
                  </span>
                  {option.description && (
                    <span className="mt-0.5 block break-words text-xs leading-5 text-text-secondary">
                      {option.description}
                    </span>
                  )}
                  {option.consequences && (
                    <span className="mt-1 block text-xs leading-5 text-warning">
                      Trade-off: {option.consequences}
                    </span>
                  )}
                </span>
                <span aria-hidden="true" className="mt-0.5 text-xs text-text-tertiary">
                  {index + 1}
                </span>
              </label>
            );
          })}
        </div>
      )}

      {question.kind === 'single_choice' && question.allowOther && (
        <div
          className={`mt-2 rounded-lg border px-3 py-2.5 focus-within:ring-2 focus-within:ring-accent ${isCustom ? 'border-accent/60 bg-accent/10' : 'border-border-subtle hover:bg-bg-tertiary/55'}`}
        >
          <label className="flex cursor-pointer items-center gap-3 text-sm font-medium text-text-primary">
            <input
              type="radio"
              name={fieldId}
              checked={isCustom}
              onChange={() => onCustomChange(customAnswer)}
              className="accent-accent"
            />
            Your own answer
          </label>
          {isCustom && (
            <input
              type={question.sensitive ? 'password' : 'text'}
              aria-label="Your own answer"
              value={typeof value === 'string' ? value : customAnswer}
              onChange={(event) => onCustomChange(event.target.value)}
              autoComplete="off"
              placeholder="Tell us what you have in mind…"
              className="mt-2 w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
            />
          )}
        </div>
      )}

      {(question.kind === 'yes_no' || (question.kind === 'approval' && showApprovalChoices)) && (
        <div className="mt-3 flex flex-wrap gap-2">
          <BooleanChoice
            selected={value === true}
            onClick={() => onChange(true)}
            positive
            approval={question.kind === 'approval'}
            label={question.kind === 'approval' ? 'Approve' : 'Yes'}
          />
          <BooleanChoice
            selected={value === false}
            onClick={() => onChange(false)}
            positive={false}
            label={question.kind === 'approval' ? 'Reject' : 'No'}
          />
        </div>
      )}

      {question.kind === 'free_text' &&
        (question.sensitive ? (
          <input
            type="password"
            aria-label={question.question}
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => onChange(event.target.value)}
            placeholder="Enter a sensitive value"
            autoComplete="off"
            className="mt-3 w-full rounded-lg border border-border bg-bg-primary px-3 py-2.5 text-sm leading-5 text-text-primary outline-none placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        ) : (
          <textarea
            aria-label={question.question}
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => onChange(event.target.value)}
            rows={3}
            placeholder="Type your answer"
            className="mt-3 w-full resize-y rounded-lg border border-border bg-bg-primary px-3 py-2.5 text-sm leading-5 text-text-primary outline-none placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        ))}
    </fieldset>
  );
}

function BooleanChoice({
  selected,
  onClick,
  positive,
  label,
  approval = false,
}: {
  approval?: boolean;
  selected: boolean;
  onClick: () => void;
  positive: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 ${selected ? 'border-accent/60 bg-accent/10 text-text-primary' : 'border-border text-text-secondary hover:bg-bg-tertiary'}`}
    >
      {positive ? (
        approval ? (
          <ShieldCheck size={14} />
        ) : (
          <CheckCircle2 size={14} />
        )
      ) : (
        <X size={14} />
      )}
      {label}
    </button>
  );
}

function PlanStepIcon({ status }: { status: AgentUIPlanStep['status'] }) {
  if (status === 'done') return <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-success" />;
  if (status === 'in_progress')
    return <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin text-info" />;
  if (status === 'blocked')
    return <AlertCircle size={14} className="mt-0.5 shrink-0 text-warning" />;
  return <Circle size={14} className="mt-0.5 shrink-0 text-text-tertiary" />;
}

export function hasQuestionAnswer(value: AgentUIAnswerValue | undefined): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === 'boolean';
}

function formatPlanLifecycle(value: AgentUIPlanIntent['payload']['lifecycle']): string {
  if (value === 'completed') return 'Complete';
  if (value === 'archived') return 'Archived';
  return 'In progress';
}

export function formatQuestionAnswer(
  question: AgentUIQuestion,
  value: AgentUIAnswerValue | undefined,
): string {
  if (!hasQuestionAnswer(value)) return 'Not answered';
  if (question.sensitive) return 'Private answer';
  const labelFor = (answer: string) =>
    question.options?.find((option) => option.value === answer)?.label ?? answer;
  if (Array.isArray(value)) return value.map(labelFor).join(', ');
  if (typeof value === 'boolean')
    return question.kind === 'approval' ? (value ? 'Approved' : 'Rejected') : value ? 'Yes' : 'No';
  return typeof value === 'string' ? labelFor(value) : 'Not answered';
}
