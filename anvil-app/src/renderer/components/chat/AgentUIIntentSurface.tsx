import { useEffect, useMemo, useState } from 'react';
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

export const CHAT_PREFILL_EVENT = 'anvil:chat-prefill';

export function AgentUIIntentSurface({
  intent,
  mode = 'chat',
}: {
  intent: AgentUIIntent;
  mode?: 'chat' | 'canvas';
}) {
  return intent.kind === 'plan' ? (
    <PlanIntentSurface intent={intent} mode={mode} />
  ) : (
    <QuestionIntentSurface intent={intent} compact={mode === 'canvas'} />
  );
}

export function PlanIntentSurface({
  intent: incomingIntent,
  mode = 'canvas',
}: {
  intent: AgentUIPlanIntent;
  mode?: 'chat' | 'canvas';
}) {
  const [intent, setIntent] = useState(incomingIntent);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(incomingIntent.payload.title);
  const [description, setDescription] = useState(incomingIntent.payload.description ?? '');
  const [stepTitles, setStepTitles] = useState<Record<string, string>>(() =>
    Object.fromEntries(incomingIntent.payload.steps.map((step) => [step.id, step.title])),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    setError(null);
    try {
      const updated = await window.anvil.chat.updateAgentUIIntentPresentation(intent.id, patch);
      if (updated.kind === 'plan') setIntent(updated);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not update the plan display.');
    }
  };

  const restore = async () => {
    setError(null);
    try {
      const updated = await window.anvil.chat.restoreAgentUIIntent(intent.id);
      if (updated.kind === 'plan') setIntent(updated);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not restore the plan.');
    }
  };

  const applyOperations = async (operations: AgentUIPlanPatchOperation[]) => {
    setSubmitting(true);
    setError(null);
    try {
      const updated = await window.anvil.chat.patchAgentUIPlan(intent.id, {
        planId: intent.payload.planId,
        baseRevision: intent.revision,
        operationId: crypto.randomUUID(),
        actor: 'user',
        operations,
      });
      setIntent(updated);
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not update the plan.');
    } finally {
      setSubmitting(false);
    }
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
            <span className="shrink-0 rounded-full bg-info/10 px-2 py-0.5 text-[11px] font-medium text-info">
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
          {mode === 'canvas' && !editing && (
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
          {mode === 'canvas' && (
            <button
              type="button"
              onClick={() => void updatePresentation({ hidden: true })}
              className="rounded-md p-1.5 text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              title="Hide plan from Canvas"
              aria-label="Hide plan from Canvas"
            >
              <EyeOff size={13} />
            </button>
          )}
          {mode === 'canvas' && intent.payload.lifecycle === 'completed' && (
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
                            <p className="mt-0.5 text-[11px] text-text-tertiary">
                              Owner: {step.owner}
                            </p>
                          )}
                          {!editing && step.notes && (
                            <p className="mt-0.5 text-xs leading-5 text-text-tertiary">
                              {step.notes}
                            </p>
                          )}
                        </div>
                        {!editing && mode === 'canvas' && (
                          <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                            {step.status !== 'done' && (
                              <button
                                type="button"
                                onClick={() =>
                                  void applyOperations([
                                    { type: 'set_step_status', stepId: step.id, status: 'done' },
                                  ])
                                }
                                className="rounded-md px-2 py-1 text-[11px] font-medium text-success hover:bg-success/10 focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                              >
                                Complete
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => askAboutStep(step)}
                              className="rounded-md px-2 py-1 text-[11px] font-medium text-text-secondary hover:bg-bg-tertiary focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
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
                className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent/85 disabled:cursor-not-allowed disabled:opacity-40"
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setIntent(incomingIntent), [incomingIntent]);

  const complete = intent.payload.questions.every(
    (question) => !question.required || hasQuestionAnswer(answers[question.id]),
  );
  const canCancel = intent.payload.questions.every((question) => question.allowCancel);
  const canSkip = intent.payload.questions.every((question) => !question.required);

  const submit = async (action: 'submit' | 'skip' | 'cancel') => {
    setSubmitting(true);
    setError(null);
    try {
      const resolved = await window.anvil.chat.resolveAgentUIQuestion(intent.id, {
        intentId: intent.id,
        action,
        answers,
        answeredAt: new Date().toISOString(),
      });
      setIntent(resolved);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not send the answer.');
    } finally {
      setSubmitting(false);
    }
  };

  if (intent.lifecycle === 'resolved' || intent.lifecycle === 'dismissed') {
    return (
      <div className="flex items-center gap-2 border-y border-success/20 bg-success/[0.035] px-3 py-3">
        <CheckCircle2 size={14} className="shrink-0 text-success" />
        <p className="text-xs font-semibold text-text-primary">
          {intent.lifecycle === 'resolved' ? 'Answer sent' : 'Question dismissed'}
        </p>
      </div>
    );
  }

  if (intent.lifecycle === 'expired') {
    return (
      <div className="flex items-center gap-2 border-y border-warning/20 bg-warning/[0.035] px-3 py-3">
        <AlertCircle size={14} className="shrink-0 text-warning" />
        <p className="text-xs text-text-secondary">
          This question expired when its provider session ended.
        </p>
      </div>
    );
  }

  return (
    <form
      id={`agent-ui-intent-${intent.id}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (complete) void submit('submit');
      }}
      className={`overflow-hidden rounded-xl border border-warning/35 bg-bg-secondary ${compact ? 'mx-3 my-2' : ''}`}
    >
      <div className="flex items-center gap-3 border-b border-border-subtle px-4 py-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-warning/10 text-warning">
          <MessageSquare size={14} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-text-primary">
            {intent.payload.title ?? 'Agent needs your input'}
          </p>
          <p className="mt-0.5 text-xs text-text-tertiary">
            Answer here to resume the waiting agent.
          </p>
        </div>
      </div>

      <div className="space-y-5 p-4">
        {intent.payload.questions.map((question) => (
          <QuestionField
            key={question.id}
            question={question}
            value={answers[question.id]}
            onChange={(value) => setAnswers((previous) => ({ ...previous, [question.id]: value }))}
          />
        ))}
        {error && <p className="text-xs text-error">{error}</p>}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border-subtle px-4 py-3">
        {canCancel && (
          <button
            type="button"
            onClick={() => void submit('cancel')}
            disabled={submitting}
            className="rounded-md px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg-tertiary disabled:opacity-40"
          >
            Cancel
          </button>
        )}
        {canSkip && (
          <button
            type="button"
            onClick={() => void submit('skip')}
            disabled={submitting}
            className="rounded-md px-3 py-2 text-xs font-medium text-text-secondary hover:bg-bg-tertiary disabled:opacity-40"
          >
            Skip
          </button>
        )}
        <button
          type="submit"
          disabled={!complete || submitting}
          className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-xs font-semibold text-white hover:bg-accent/85 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting && <Loader2 size={13} className="animate-spin" />}
          Send answer
        </button>
      </div>
    </form>
  );
}

function QuestionField({
  question,
  value,
  onChange,
}: {
  question: AgentUIQuestion;
  value: AgentUIAnswerValue | undefined;
  onChange: (value: AgentUIAnswerValue) => void;
}) {
  return (
    <fieldset>
      <legend className="max-w-[72ch] text-sm font-semibold leading-6 text-text-primary">
        {question.question}
        {!question.required && (
          <span className="ml-1 font-normal text-text-tertiary">Optional</span>
        )}
      </legend>
      {question.context && (
        <p className="mt-1 max-w-[72ch] text-xs leading-5 text-text-tertiary">{question.context}</p>
      )}

      {(question.kind === 'single_choice' || question.kind === 'multiple_choice') && (
        <div className="mt-3 space-y-2">
          {(question.options ?? []).map((option) => {
            const selected =
              question.kind === 'multiple_choice'
                ? Array.isArray(value) && value.includes(option.value)
                : value === option.value;
            return (
              <label
                key={option.id}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors ${selected ? 'border-accent/60 bg-accent/10' : 'border-border-subtle hover:border-border hover:bg-bg-tertiary/55'}`}
              >
                <input
                  type={question.kind === 'multiple_choice' ? 'checkbox' : 'radio'}
                  name={question.id}
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
                    {option.label}
                    {option.recommended && (
                      <span className="rounded-full bg-info/10 px-2 py-0.5 text-[11px] font-medium text-info">
                        Recommended
                      </span>
                    )}
                  </span>
                  {option.description && (
                    <span className="mt-0.5 block text-xs leading-5 text-text-tertiary">
                      {option.description}
                    </span>
                  )}
                  {option.consequences && (
                    <span className="mt-1 block text-xs leading-5 text-warning">
                      Trade-off: {option.consequences}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      )}

      {(question.kind === 'yes_no' || question.kind === 'approval') && (
        <div className="mt-3 flex flex-wrap gap-2">
          <BooleanChoice
            selected={value === true}
            onClick={() => onChange(true)}
            positive
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
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => onChange(event.target.value)}
            placeholder="Enter a sensitive value"
            autoComplete="off"
            className="mt-3 w-full rounded-lg border border-border bg-bg-primary px-3 py-2.5 text-sm leading-5 text-text-primary outline-none placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        ) : (
          <textarea
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
}: {
  selected: boolean;
  onClick: () => void;
  positive: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${selected ? (positive ? 'border-success/60 bg-success/10 text-success' : 'border-error/60 bg-error/10 text-error') : 'border-border text-text-secondary hover:bg-bg-tertiary'}`}
    >
      {positive ? <ShieldCheck size={14} /> : <X size={14} />}
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
