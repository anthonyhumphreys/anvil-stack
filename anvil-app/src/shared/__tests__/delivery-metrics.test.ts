import { describe, expect, it } from 'vitest';
import type { ChangeReview, ReviewCapture, ReviewRun } from '../change-review-types.js';
import { deriveDeliveryMetrics, formatDeliveryMetricsMarkdown } from '../delivery-metrics.js';

const capture: ReviewCapture = {
  id: 'capture',
  viewport: 'desktop',
  image: 'image.png',
  trace: 'trace.zip',
  imageDigest: 'image-digest',
  traceDigest: 'trace-digest',
  outcome: 'passed',
  steps: [],
};
const snapshot = { head: 'head', tree: 'tree', capturedAt: '2026-09-09T10:00:00Z' };
function run(id: string, changes: Partial<ReviewRun> = {}): ReviewRun {
  return {
    id,
    candidate: snapshot,
    baseTree: 'base',
    criteriaVersion: 'criteria',
    scenarioVersion: 'scenario',
    startedAt: '2026-09-09T10:01:00Z',
    completedAt: '2026-09-09T10:02:00Z',
    provenance: 'runner-observed',
    outcome: 'passed',
    environment: 'test',
    base: [capture],
    candidateCaptures: [capture],
    log: '',
    ...changes,
  };
}
function review(runs: ReviewRun[] = []): ChangeReview {
  return {
    id: 'review',
    workspaceId: 'workspace',
    repoId: 'repo',
    title: 'Review',
    baseRef: 'main',
    baseCommit: 'base',
    candidate: snapshot,
    criteria: [],
    runs,
    findings: [],
    decisions: [],
    createdAt: '2026-09-09T10:00:00Z',
    updatedAt: '2026-09-09T10:03:00Z',
    freshness: 'current',
  };
}

describe('delivery measurements', () => {
  it('keeps unrecorded effort, cost and regression outcomes unknown', () => {
    const metrics = deriveDeliveryMetrics(review());
    expect(metrics.firstComparisonEvidence).toBeNull();
    expect(metrics.runCount).toBe(0);
    expect(metrics.replayCount).toBe(0);
    expect(metrics.activeHumanTimeMs).toBeNull();
    expect(metrics.interruptionCount).toBeNull();
    expect(metrics.attributedTokens).toBeNull();
    expect(metrics.attributedCostUsd).toBeNull();
    expect(metrics.regressionOutcome).toBe('unknown');
  });

  it('uses earliest completed paired evidence, including a useful failed comparison', () => {
    const metrics = deriveDeliveryMetrics(
      review([
        run('later', { completedAt: '2026-09-09T10:03:00Z' }),
        run('first', { outcome: 'failed' }),
        run('running', { outcome: 'running', completedAt: undefined }),
      ]),
    );
    expect(metrics.firstComparisonEvidence).toEqual({ runId: 'first', elapsedMs: 120000 });
    expect(metrics.runCount).toBe(3);
    expect(metrics.replayCount).toBe(2);
    expect(metrics.completedRunCount).toBe(2);
    expect(metrics.failedRunCount).toBe(1);
  });

  it.each([
    { candidateCaptures: [] },
    { base: [] },
    { candidateCaptures: [{ ...capture, traceDigest: '' }] },
    { candidateCaptures: [{ ...capture, viewport: 'mobile' }] },
    { outcome: 'inconclusive' as const },
    { completedAt: undefined },
    { completedAt: 'invalid' },
    { completedAt: '2026-09-09T09:00:00Z' },
    { startedAt: '2026-09-09T10:03:00Z' },
  ])('does not count incomplete or invalid evidence: %j', (changes) => {
    expect(
      deriveDeliveryMetrics(review([run('invalid', changes)])).firstComparisonEvidence,
    ).toBeNull();
  });

  it('labels historical measurements and unknown values in the export', () => {
    const value = review([run('first')]);
    value.freshness = 'stale';
    const markdown = formatDeliveryMetricsMarkdown(deriveDeliveryMetrics(value));
    expect(markdown).toContain('120000 ms from review creation');
    expect(markdown).toContain('historical evidence may now be stale');
    expect(markdown).toContain('Active human time / interruptions | Not recorded');
    expect(markdown).toContain('Post-merge regressions | Unknown');
  });
});
