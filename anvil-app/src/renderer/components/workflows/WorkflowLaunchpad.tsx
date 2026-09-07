import { useState } from 'react';
import { ArrowRight, Check, GitFork, Layers, ShieldCheck } from 'lucide-react';

export type WorkflowStarter = 'delivery' | 'review' | 'research';

const STARTERS = [
  {
    id: 'delivery',
    name: 'Deliver a change',
    detail: 'Build, review, and verify.',
    icon: GitFork,
    stages: ['Plan & delegate', 'Review', 'Repair & verify', 'Accept'],
  },
  {
    id: 'review',
    name: 'Review work',
    detail: 'Independent eyes on a change.',
    icon: ShieldCheck,
    stages: ['Specialist reviews', 'Reconcile findings', 'Accept'],
  },
  {
    id: 'research',
    name: 'Explore options',
    detail: 'Compare approaches before building.',
    icon: Layers,
    stages: ['Independent proposals', 'Compare tradeoffs', 'Recommend'],
  },
] as const;

export function WorkflowLaunchpad({
  objective,
  onObjectiveChange,
  onPrepare,
  onCustom,
  ready,
  loading,
  onRetry,
  profileCount,
  providerSummary,
  workspaceName,
}: {
  objective: string;
  onObjectiveChange: (value: string) => void;
  onPrepare: (kind: WorkflowStarter) => void;
  onCustom: () => void;
  ready: boolean;
  loading: boolean;
  onRetry: () => void;
  profileCount: number;
  providerSummary: string;
  workspaceName?: string;
}) {
  const [starter, setStarter] = useState<WorkflowStarter>('delivery');
  const selected = STARTERS.find((item) => item.id === starter)!;
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="m-auto w-full max-w-3xl px-8 py-12">
        <h2 className="text-2xl font-semibold tracking-tight text-text-primary">
          What should your agents do?
        </h2>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-text-secondary">
          Start with an outcome. Preview the flow and adjust the team before anything runs.
        </p>
        <form
          className="mt-8"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready && objective.trim()) onPrepare(starter);
          }}
        >
          <label
            htmlFor="workflow-outcome"
            className="mb-2 block text-sm font-medium text-text-primary"
          >
            Outcome
          </label>
          <textarea
            id="workflow-outcome"
            value={objective}
            onChange={(event) => onObjectiveChange(event.target.value)}
            rows={4}
            placeholder="What needs to change, and how will you know it's done?"
            className="w-full resize-y rounded-xl border border-border bg-bg-secondary px-4 py-3 text-sm leading-relaxed text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/15"
          />
          <fieldset className="mt-7">
            <legend className="mb-3 text-sm font-medium text-text-primary">Choose a flow</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {STARTERS.map((item) => (
                <label
                  key={item.id}
                  className={`relative flex cursor-pointer flex-col gap-3 rounded-xl border p-4 transition-colors focus-within:ring-2 focus-within:ring-accent/40 ${starter === item.id ? 'border-accent/60 bg-accent/5' : 'border-border bg-bg-secondary hover:bg-bg-tertiary'}`}
                >
                  <input
                    type="radio"
                    name="workflow-starter"
                    value={item.id}
                    checked={starter === item.id}
                    onChange={() => setStarter(item.id)}
                    className="sr-only"
                  />
                  <span className="flex items-center justify-between">
                    <item.icon
                      size={18}
                      className={starter === item.id ? 'text-accent' : 'text-text-tertiary'}
                    />
                    {starter === item.id && <Check size={14} className="text-accent" />}
                  </span>
                  <span>
                    <span className="block text-sm font-medium text-text-primary">{item.name}</span>
                    <span className="mt-1 block text-xs leading-relaxed text-text-secondary">
                      {item.detail}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="mt-6 border-y border-border-subtle py-5" aria-live="polite">
            <ol
              className="flex flex-wrap items-center gap-x-3 gap-y-3"
              aria-label={`${selected.name} stages`}
            >
              {selected.stages.map((stage, index) => (
                <li key={stage} className="flex items-center gap-3 text-xs text-text-secondary">
                  {index > 0 && (
                    <ArrowRight size={12} className="text-text-muted" aria-hidden="true" />
                  )}
                  <span className="flex items-center gap-2">
                    <span className="grid h-5 w-5 place-items-center rounded-full bg-bg-tertiary text-text-tertiary">
                      {index + 1}
                    </span>
                    {stage}
                  </span>
                </li>
              ))}
            </ol>
            <p className="mt-4 text-xs leading-relaxed text-text-tertiary">
              {profileCount} configurable {profileCount === 1 ? 'specialist' : 'specialists'} ·{' '}
              {providerSummary} · 30-minute run limit
            </p>
          </div>
          <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
            <div className="text-xs text-text-tertiary">
              {workspaceName ? (
                <>
                  In <span className="font-medium text-text-secondary">{workspaceName}</span>
                </>
              ) : (
                'Choose a workspace before running.'
              )}
              <span className="mt-1 block">No agents start during preview.</span>
            </div>
            <button
              type="submit"
              disabled={!ready || !objective.trim()}
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-5 py-3 text-sm font-semibold text-bg-primary transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40"
            >
              {ready
                ? 'Preview workflow'
                : loading
                  ? 'Loading configuration…'
                  : 'Configuration unavailable'}
              <ArrowRight size={16} />
            </button>
          </div>
        </form>
        {!ready && !loading && (
          <button
            onClick={onRetry}
            className="mt-3 text-sm text-accent underline underline-offset-4"
          >
            Retry loading configuration
          </button>
        )}
        <button
          onClick={onCustom}
          disabled={!ready}
          className="mt-8 text-xs text-text-tertiary underline decoration-border underline-offset-4 transition hover:text-text-primary focus-visible:outline focus-visible:outline-accent disabled:opacity-40"
        >
          Build a custom graph instead
        </button>
      </div>
    </div>
  );
}
