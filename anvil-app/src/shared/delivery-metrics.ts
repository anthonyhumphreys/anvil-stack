import type { ChangeReview, ReviewCapture } from './change-review-types.js';

/** Recorded review history only. Wall time is never treated as human attention. */
export interface DeliveryMetrics {
  scope: 'change-review-history';
  reviewId: string;
  firstComparisonEvidence: { runId: string; elapsedMs: number } | null;
  runCount: number;
  replayCount: number;
  completedRunCount: number;
  failedRunCount: number;
  findingCount: number;
  repairHandoffCount: number;
  humanDecisionCount: number;
  activeHumanTimeMs: number | null;
  interruptionCount: null;
  attributedTokens: null;
  attributedCostUsd: null;
  regressionOutcome: 'unknown';
  limitations: string[];
}

function hasCaptureRecord(capture: ReviewCapture): boolean {
  return Boolean(capture.image && capture.trace && capture.imageDigest && capture.traceDigest);
}

export function deriveDeliveryMetrics(review: ChangeReview): DeliveryMetrics {
  const createdAt = Date.parse(review.createdAt);
  const evidenceRuns = review.runs
    .filter((run) => {
      const startedAt = Date.parse(run.startedAt);
      const completedAt = Date.parse(run.completedAt ?? '');
      return (
        (run.outcome === 'passed' || run.outcome === 'failed') &&
        Number.isFinite(createdAt) &&
        Number.isFinite(startedAt) &&
        Number.isFinite(completedAt) &&
        startedAt >= createdAt &&
        completedAt >= startedAt &&
        run.base.length > 0 &&
        run.candidateCaptures.length > 0 &&
        run.base.every(hasCaptureRecord) &&
        run.candidateCaptures.every(hasCaptureRecord) &&
        run.base.every((base) =>
          run.candidateCaptures.some((candidate) => candidate.viewport === base.viewport),
        ) &&
        run.candidateCaptures.every((candidate) =>
          run.base.some((base) => base.viewport === candidate.viewport),
        )
      );
    })
    .sort((a, b) => Date.parse(a.completedAt!) - Date.parse(b.completedAt!));
  const first = evidenceRuns[0];
  return {
    scope: 'change-review-history',
    reviewId: review.id,
    firstComparisonEvidence: first
      ? { runId: first.id, elapsedMs: Date.parse(first.completedAt!) - createdAt }
      : null,
    runCount: review.runs.length,
    replayCount: Math.max(0, review.runs.length - 1),
    completedRunCount: review.runs.filter((run) => run.outcome !== 'running' && run.completedAt)
      .length,
    failedRunCount: review.runs.filter((run) => run.outcome === 'failed').length,
    findingCount: review.findings.length,
    repairHandoffCount: review.findings.filter((finding) => finding.repair).length,
    humanDecisionCount: review.decisions.length,
    activeHumanTimeMs: review.attentionSessions?.length
      ? review.attentionSessions.reduce((total, session) => total + session.activeMs, 0)
      : null,
    interruptionCount: null,
    attributedTokens: null,
    attributedCostUsd: null,
    regressionOutcome: 'unknown',
    limitations: [
      'Elapsed time starts when this Change Review was created, not when implementation began.',
      'First comparison evidence means a completed run with paired image and trace records. Files are not revalidated by this metric; historical evidence may now be stale.',
      'Replays count additional runs, not wasted work. Repair handoffs count findings with a recorded handoff, not every repair attempt.',
      'Active human time estimates foreground review interaction in five-second intervals, stopping after 30 seconds without input. Reading without input, background time, gaps and other tools are excluded. Interruptions are not recorded.',
      'Token usage and cost are unavailable without attributable usage records for this delivery journey.',
      'Post-merge regressions are unknown. Passing a scenario does not establish regression outcomes.',
    ],
  };
}

export function formatDeliveryMetricsMarkdown(metrics: DeliveryMetrics): string {
  const evidence = metrics.firstComparisonEvidence;
  return [
    '## Delivery measurements',
    '',
    '| Measure | Recorded value |',
    '| --- | --- |',
    `| Time to first recorded comparison evidence | ${evidence ? `${evidence.elapsedMs} ms from review creation` : 'Unavailable'} |`,
    `| Scenario runs / additional replays | ${metrics.runCount} / ${metrics.replayCount} |`,
    `| Completed / failed runs | ${metrics.completedRunCount} / ${metrics.failedRunCount} |`,
    `| Findings / recorded repair handoffs | ${metrics.findingCount} / ${metrics.repairHandoffCount} |`,
    `| Human review decisions | ${metrics.humanDecisionCount} |`,
    `| Foreground interaction estimate / interruptions | ${metrics.activeHumanTimeMs === null ? 'Not recorded' : `${metrics.activeHumanTimeMs} ms foreground interaction / interruptions not recorded`} |`,
    '| Attributed tokens / cost | Unavailable |',
    '| Post-merge regressions | Unknown |',
    '',
    ...metrics.limitations.map((limitation) => `- ${limitation}`),
  ].join('\n');
}
