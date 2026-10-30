import { useEffect, useRef } from 'react';
import {
  Check,
  Circle,
  CircleAlert,
  LoaderCircle,
  MessageSquarePlus,
  RotateCcw,
  Square,
  X,
} from 'lucide-react';
import {
  validationSummary,
  type ValidationStatus,
  type ValidationSurfaceData,
} from '../../../../../shared/surfaces/kinds/validation';
import type { SurfaceKindView, SurfaceViewProps } from '../../types';
import { Button } from '../../../ui';
import { ActionStatusLine, useSurfaceActions } from '../../shared-ui/useSurfaceActions';
import { LegacyValidationEvidence } from './LegacyValidationEvidence';

const statuses: Record<ValidationStatus, { label: string; className: string; icon: typeof Check }> =
  {
    unchecked: { label: 'Unchecked', className: 'text-text-tertiary', icon: Circle },
    running: { label: 'Running', className: 'text-info', icon: LoaderCircle },
    passed: { label: 'Passed', className: 'text-success', icon: Check },
    failed: { label: 'Failed', className: 'text-error', icon: X },
    blocked: { label: 'Blocked', className: 'text-warning', icon: CircleAlert },
  };

export function ValidationInline({
  intent,
  onAction,
  onComment,
  onOpenStage,
  presentation,
  readOnly,
}: SurfaceViewProps) {
  const data = intent.payload.data as ValidationSurfaceData;
  const { run, pending, status } = useSurfaceActions(onAction);
  const active = data.criteria.some((criterion) => criterion.result?.status === 'running');
  const hasFailures = data.criteria.some(
    (criterion) => criterion.result?.status === 'failed' || criterion.result?.status === 'blocked',
  );
  const stale = data.freshness !== 'current';
  // Refresh once on opening, without polling or rerunning checks.
  const refreshedId = useRef<string | null>(null);
  useEffect(() => {
    if (refreshedId.current === intent.id) return;
    refreshedId.current = intent.id;
    void run('refresh');
  }, [intent.id, run]);
  return (
    <section
      aria-label={`Validation: ${intent.payload.title}`}
      className={`min-w-0 space-y-4 ${presentation !== 'inline' ? 'mx-auto w-full max-w-4xl p-5' : ''}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h3 className="text-sm font-semibold text-text-primary">{validationSummary(data)}</h3>
          <p className="text-xs text-text-tertiary">
            {data.source.kind === 'work-item'
              ? `${data.source.workItemRef?.id} · ${data.source.workItemTitle ?? 'Work item criteria'}`
              : 'Based on your request'}{' '}
            · {data.repoName}
          </p>
        </div>
        {presentation === 'inline' && (
          <Button size="sm" variant="ghost" onClick={() => onOpenStage()}>
            Open evidence
          </Button>
        )}
      </div>
      {stale && (
        <p role="status" className="max-w-prose text-sm text-warning">
          {data.freshnessDetail ??
            'Evidence needs refreshing before it can establish the current result.'}
        </p>
      )}
      <ol aria-label="Validation criteria" className="divide-y divide-border-subtle">
        {data.criteria.map((criterion) => {
          const state = statuses[criterion.result?.status ?? 'unchecked'];
          const Icon = state.icon;
          return (
            <li key={criterion.id} className="min-w-0 py-3 first:pt-0">
              <div className="flex items-start gap-2.5">
                <Icon
                  size={16}
                  aria-hidden="true"
                  className={`mt-0.5 shrink-0 ${stale ? 'text-text-tertiary' : state.className} ${criterion.result?.status === 'running' ? 'motion-safe:animate-spin' : ''}`}
                />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <p className="max-w-prose break-words text-sm text-text-primary">
                      {criterion.text}
                    </p>
                    <span className={`text-xs ${stale ? 'text-warning' : state.className}`}>
                      {stale && criterion.result ? 'Stale evidence' : state.label}
                    </span>
                  </div>
                  <p className="max-w-prose break-words text-xs leading-5 text-text-secondary">
                    {criterion.instruction}
                    {criterion.basis === 'inferred' && (
                      <span className="mt-1 block text-text-tertiary">
                        Interpreted from context
                      </span>
                    )}
                  </p>
                  {criterion.result && (
                    <p className="break-words text-xs text-text-tertiary">
                      {criterion.result.summary} ·{' '}
                      {criterion.result.provenance === 'runner-observed'
                        ? 'Recorded by Mezair'
                        : 'Reported by agent'}
                    </p>
                  )}
                  <details className="text-xs text-text-secondary">
                    <summary className="w-fit cursor-pointer rounded-sm py-1 hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent">
                      {criterion.result?.evidence ? 'Show evidence' : 'How this will be checked'}
                    </summary>
                    {criterion.command && (
                      <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-bg-primary p-3 font-mono text-xs">
                        {criterion.command}
                      </pre>
                    )}
                    {criterion.result?.evidence ? (
                      <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-bg-primary p-3 font-mono text-xs">
                        {criterion.result.evidence}
                      </pre>
                    ) : (
                      <p className="max-w-prose py-2">
                        {criterion.method === 'manual'
                          ? 'This needs an observed human check. Tell the agent what you tried and what happened.'
                          : criterion.method === 'browser'
                            ? 'The agent will use its browser tools and attach the observed result.'
                            : 'No evidence recorded yet.'}
                      </p>
                    )}
                  </details>
                </div>
                <button
                  type="button"
                  aria-label={`Discuss criterion: ${criterion.text}`}
                  className="shrink-0 rounded-md p-1 text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
                  onClick={() =>
                    onComment({ type: 'row', targetId: criterion.id, label: criterion.text })
                  }
                >
                  <MessageSquarePlus size={14} />
                </button>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap gap-2">
        {!readOnly && !active && (
          <Button
            size="sm"
            disabled={pending !== null || stale}
            onClick={() => void run(hasFailures ? 'retry' : 'run')}
          >
            {hasFailures ? <RotateCcw size={14} /> : <Check size={14} />}
            {hasFailures ? 'Rerun failures' : 'Run validation'}
          </Button>
        )}
        {!readOnly && active && (
          <Button
            size="sm"
            variant="secondary"
            disabled={pending !== null}
            onClick={() => void run('cancel')}
          >
            <Square size={13} />
            Stop validation
          </Button>
        )}
        {!active && (
          <Button
            size="sm"
            variant="secondary"
            disabled={pending !== null}
            onClick={() => void run('revise')}
          >
            Adjust checks in chat
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={pending !== null || active}
          onClick={() => void run('refresh')}
        >
          Refresh evidence
        </Button>
        {!readOnly && (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending !== null || active}
            onClick={() => void run('save_workflow')}
          >
            Save as workflow
          </Button>
        )}
      </div>
      <ActionStatusLine status={status} />
      <details className="text-xs text-text-tertiary">
        <summary className="w-fit cursor-pointer rounded-sm py-1 focus-visible:outline-2 focus-visible:outline-accent">
          Criteria source and history
        </summary>
        <p className="mt-2 max-w-prose whitespace-pre-wrap break-words leading-5">
          {data.source.text ||
            'No explicit acceptance criteria. The plan interprets the request; clarify uncertain expectations in chat.'}
        </p>
        <p className="mt-2 break-all font-mono">
          Candidate {data.snapshot.head.slice(0, 12)} · Tree {data.snapshot.tree.slice(0, 12)}
        </p>
        <p className="mt-2 max-w-prose">
          Results describe these checks on this source. They do not record human acceptance of the
          change.
        </p>
        {data.history?.map((entry) => (
          <p key={entry.id} className="mt-2 max-w-prose">
            {entry.outcome} · {entry.recordedAt}
            <br />
            {entry.summary}
          </p>
        ))}
      </details>
      {data.legacyReviewId && <LegacyValidationEvidence reviewId={data.legacyReviewId} />}
    </section>
  );
}

export const validationSurfaceView: SurfaceKindView = {
  Inline: ValidationInline,
  Stage: ValidationInline,
};
