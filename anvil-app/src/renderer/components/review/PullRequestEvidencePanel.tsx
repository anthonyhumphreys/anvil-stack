import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowUpRight, Link2, RefreshCw } from 'lucide-react';
import type {
  ChangeReview,
  ReviewEvidenceSource,
  ReviewEvidenceTarget,
} from '../../../shared/change-review-types';
import { reviewEvidenceLabel } from '../../utils/review-evidence-label';
import type { PullRequestVisualisation } from '../../../shared/types';

const control =
  'w-full rounded-md border border-border bg-bg-primary px-2 py-2 text-xs focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50';
const action =
  'inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-xs text-text-secondary hover:bg-bg-tertiary focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50';

export function PullRequestEvidencePanel({
  workspaceId,
  visualisation,
  chapterId,
  riskId,
}: {
  workspaceId: string;
  visualisation: PullRequestVisualisation;
  chapterId: string | null;
  riskId?: string;
}) {
  const navigate = useNavigate();
  const [reviews, setReviews] = useState<ChangeReview[]>([]);
  const [reviewId, setReviewId] = useState('');
  const [sourceKind, setSourceKind] = useState<'chapter' | 'risk'>('chapter');
  const [target, setTarget] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setReviews([]);
    setLoadFailed(false);
    setError('');
    window.anvil.changeReview
      .list(workspaceId)
      .then((values) => {
        if (cancelled) return;
        setReviews(values.filter((r) => r.repoId === visualisation.repoId));
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(String(reason));
          setLoadFailed(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, visualisation.repoId, revision]);
  const review = reviews.find((r) => r.id === reviewId) ?? reviews[0];
  const sourceId = sourceKind === 'risk' && riskId ? riskId : chapterId;
  const source: ReviewEvidenceSource | undefined = sourceId
    ? {
        visualisationId: visualisation.id,
        headSha: visualisation.headSha,
        kind: sourceKind === 'risk' && riskId ? 'risk' : 'chapter',
        id: sourceId,
      }
    : undefined;
  const links = reviews.flatMap((r) =>
    (r.evidenceLinks ?? [])
      .filter(
        (link) =>
          link.source.visualisationId === visualisation.id &&
          link.source.kind === source?.kind &&
          link.source.id === source?.id,
      )
      .map((link) => ({ review: r, link })),
  );
  const options: { label: string; target: ReviewEvidenceTarget }[] = review
    ? [
        ...(review.criteria.at(-1)?.items ?? []).map((c) => ({
          label: `Criterion · ${c.text}`,
          target: { criterionId: c.id },
        })),
        ...(review.scenarioVersion
          ? [
              {
                label: `Scenario · ${review.scenario?.name ?? 'Saved scenario'}`,
                target: { scenarioVersion: review.scenarioVersion },
              },
            ]
          : []),
        ...review.runs.flatMap((run) =>
          run.candidateCaptures.map((capture) => ({
            label: `Capture · ${capture.viewport} · ${run.outcome} · ${new Date(run.startedAt).toLocaleString()}`,
            target: { runId: run.id, captureId: capture.id, scenarioVersion: run.scenarioVersion },
          })),
        ),
        ...review.findings.map((finding) => ({
          label: `Finding · ${finding.note}`,
          target: { findingId: finding.id, runId: finding.runId, captureId: finding.captureId },
        })),
      ]
    : [];
  async function save() {
    if (!review || !source) return;
    const selected = options.find((option) => JSON.stringify(option.target) === target);
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      await window.anvil.changeReview.linkEvidence(review.id, { source, ...selected.target });
      setRevision((v) => v + 1);
      setTarget('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="space-y-3 border-b border-border-subtle p-4"
      aria-label="Observed review evidence"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-text-primary">Observed review evidence</h3>
        <button
          className={action}
          aria-label="Refresh observed evidence"
          disabled={loading || busy}
          onClick={() => setRevision((v) => v + 1)}
        >
          <RefreshCw size={13} />
        </button>
      </div>
      <p className="text-xs leading-5 text-text-secondary">
        Connect this {source?.kind ?? 'chapter'} to a saved review. Mapping records relevance;
        acceptance stays with the reviewer.
      </p>
      {error ? (
        <p role="alert" className="text-xs leading-5 text-error">
          {error}
        </p>
      ) : null}
      {loading ? (
        <p role="status" className="text-xs text-text-secondary">
          Loading saved evidence…
        </p>
      ) : loadFailed ? (
        <div className="space-y-2">
          <p className="text-xs leading-5 text-warning">
            Evidence unavailable · saved mappings could not be loaded.
          </p>
          <button className={action} onClick={() => setRevision((v) => v + 1)}>
            Retry loading evidence
          </button>
        </div>
      ) : (
        <>
          {riskId ? (
            <select
              aria-label="Evidence source"
              className={control}
              value={sourceKind}
              onChange={(e) => setSourceKind(e.target.value as 'chapter' | 'risk')}
            >
              <option value="chapter">Selected chapter</option>
              <option value="risk">Selected risk</option>
            </select>
          ) : null}
          {links.length ? (
            <ul className="divide-y divide-border-subtle">
              {links.map(({ review: r, link }) => {
                const fresh =
                  link.source.headSha !== visualisation.headSha ? 'stale' : link.freshness;
                const label = reviewEvidenceLabel(r, link);
                const params = new URLSearchParams({ repo: r.repoId, review: r.id });
                if (link.runId) params.set('run', link.runId);
                if (link.captureId) params.set('capture', link.captureId);
                if (link.findingId) params.set('finding', link.findingId);
                if (link.criterionId) params.set('criterion', link.criterionId);
                if (link.scenarioVersion && !link.captureId)
                  params.set('scenario', link.scenarioVersion);
                return (
                  <li key={link.id} className="space-y-1 py-3">
                    <Link
                      to={`/review?${params}`}
                      title={`${r.title} · ${label}`}
                      aria-label={`${r.title} · ${label}`}
                      className="flex items-center gap-2 rounded-sm text-xs font-medium text-accent hover:underline focus-visible:outline-2 focus-visible:outline-accent"
                    >
                      <span className="min-w-0 flex-1 line-clamp-2">{label}</span>
                      <ArrowUpRight size={13} className="shrink-0" />
                    </Link>
                    <p className="truncate text-xs text-text-secondary" title={r.title}>
                      {r.title}
                    </p>
                    <p
                      className={`text-xs ${fresh === 'current' ? 'text-text-secondary' : 'text-warning'}`}
                    >
                      {fresh === 'current'
                        ? 'Current mapping'
                        : fresh === 'stale'
                          ? 'Stale evidence'
                          : 'Freshness unknown'}{' '}
                      · human-linked
                    </p>
                    {link.freshnessDetail ? (
                      <p className="text-xs leading-5 text-text-tertiary">{link.freshnessDetail}</p>
                    ) : null}
                    <button
                      aria-label={`Remove mapping: ${r.title} · ${label}`}
                      className="rounded-sm text-xs text-text-tertiary hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          await window.anvil.changeReview.unlinkEvidence(r.id, link.id);
                          setRevision((v) => v + 1);
                        } catch (reason) {
                          setError(String(reason));
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Remove mapping
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-xs leading-5 text-warning">
              Unmapped · no observed evidence linked to this {source?.kind ?? 'chapter'}.
            </p>
          )}
          {review ? (
            <details>
              <summary className="cursor-pointer rounded-sm text-xs font-medium text-text-primary focus-visible:outline-2 focus-visible:outline-accent">
                Map review evidence
              </summary>
              <div className="mt-3 space-y-3">
                <label className="block space-y-1 text-xs text-text-secondary">
                  Review
                  <select
                    className={control}
                    value={review.id}
                    onChange={(e) => {
                      setReviewId(e.target.value);
                      setTarget('');
                    }}
                  >
                    {reviews.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.title} · {r.candidate.tree.slice(0, 8)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block space-y-1 text-xs text-text-secondary">
                  Evidence
                  <select
                    className={control}
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                  >
                    <option value="">Choose a criterion, scenario, capture or finding</option>
                    {options.map((option) => (
                      <option
                        key={JSON.stringify(option.target)}
                        value={JSON.stringify(option.target)}
                      >
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className={action}
                  disabled={busy || !target || !source}
                  onClick={() => void save()}
                >
                  <Link2 size={13} />
                  {busy ? 'Saving…' : 'Save mapping'}
                </button>
              </div>
            </details>
          ) : (
            <button
              className={action}
              onClick={() =>
                navigate(
                  `/review?${new URLSearchParams({ repo: visualisation.repoId, baseRef: visualisation.pullRequest.targetBranch, pullRequest: visualisation.pullRequest.id, provider: visualisation.pullRequest.provider, head: visualisation.headSha })}`,
                )
              }
            >
              Create a change review
              <ArrowUpRight size={13} />
            </button>
          )}
        </>
      )}
    </section>
  );
}
