import { describe, expect, it } from 'vitest';
import {
  buildActivationMeasurementReport,
  compareActivationJourneys,
  type ActivationEventRow,
} from '../activation-measurement.js';

function row(
  id: number,
  event: string,
  createdAt: string,
  payload: Record<string, unknown> | null = null,
  appRunId: string | null = 'run-a',
  journeyId: string | null = 'journey-a',
): ActivationEventRow {
  return {
    id,
    event,
    app_run_id: appRunId,
    journey_id: journeyId,
    payload: payload ? JSON.stringify(payload) : null,
    created_at: createdAt,
  };
}

describe('buildActivationMeasurementReport', () => {
  it('measures first-use milestones across app restarts and never infers completion', () => {
    const rows = [
      row(1, 'onboarding_started', '2026-10-19T09:00:00.000Z'),
      row(2, 'onboarding_step_completed', '2026-10-19T09:00:10.000Z', { step: 'role' }),
      row(3, 'chat_composer_enabled', '2026-10-19T09:02:00.000Z', null, 'run-b'),
      row(
        4,
        'change_summary_viewed',
        '2026-10-19T09:03:00.000Z',
        { summaryKey: 'a'.repeat(64), files: 2, additions: 4, deletions: 1 },
        'run-b',
      ),
      row(5, 'diff_proposed', '2026-10-19T09:03:10.000Z', { files: 4 }, 'run-b'),
      row(
        6,
        'repo_index_tier_reached',
        '2026-10-19T09:03:30.000Z',
        { tier: 'mapped', ms: 7200, fileCount: 100 },
        'run-b',
      ),
      row(7, 'change_applied', '2026-10-19T09:04:00.000Z', { fileCount: 2 }, 'run-b'),
      row(8, 'chat_composer_enabled', '2026-10-19T09:05:00.000Z', null, 'run-c', null),
      row(9, 'onboarding_started', '2026-10-19T09:06:00.000Z', null, 'run-c', null),
      row(10, 'onboarding_started', '2026-10-18T09:00:00.000Z', null, null, null),
    ];

    const report = buildActivationMeasurementReport(rows);
    const journey = report.journeys[0];

    expect(journey.journeyId).toBe('journey-a');
    expect(journey.appRunIds).toEqual(['run-a', 'run-b']);
    expect(journey.milestones).toEqual({
      composerEnabledAt: '2026-10-19T09:02:00.000Z',
      composerEnabledMs: 120_000,
      firstChangeSummaryViewedAt: '2026-10-19T09:03:00.000Z',
      firstChangeSummaryViewedMs: 180_000,
      firstChangeAppliedAt: '2026-10-19T09:04:00.000Z',
      firstChangeAppliedMs: 240_000,
    });
    expect(journey.onboarding.status).toBe('not_completed_in_observed_records');
    expect(journey.interpretation).toMatchObject({
      onboardingDropoff: 'possible',
      appInterruption: 'unknown',
      activeHuman: 'unknown',
      activeTime: 'not_recorded',
      modelUsage: 'not_recorded',
      outputQuality: 'not_recorded',
    });
    expect(report.totals).toMatchObject({
      startedJourneys: 1,
      onboardingCompleted: 0,
      possibleOnboardingDropoff: 1,
      eventsOutsideJourney: 2,
      legacyDiffProposedEvents: 1,
      legacyUnscopedEvents: 1,
    });
    expect(report.appRuns.find((run) => run.appRunId === 'run-b')?.indexObservations).toEqual([
      { tier: 'mapped', durationMs: 7200, fileCount: 100, recordedAt: '2026-10-19T09:03:30.000Z' },
    ]);
  });

  it('does not treat legacy diff_proposed records as actual generation or summary-view evidence', () => {
    const report = buildActivationMeasurementReport([
      row(1, 'onboarding_started', '2026-10-19T09:00:00.000Z'),
      row(2, 'diff_proposed', '2026-10-19T09:01:00.000Z', { files: 1 }),
    ]);

    expect(report.journeys[0].milestones.firstChangeSummaryViewedAt).toBeNull();
    expect(report.totals.firstChangeSummaryViewed).toEqual({ observed: 0, medianMs: null });
    expect(report.totals.legacyDiffProposedEvents).toBe(1);
    expect(report.coverage.newChangeGeneration).toBe('not_instrumented');
  });

  it('marks onboarding complete only after the workspace completion event', () => {
    const report = buildActivationMeasurementReport([
      row(1, 'onboarding_started', '2026-10-19T09:00:00.000Z'),
      row(2, 'onboarding_step_completed', '2026-10-19T09:00:10.000Z', { step: 'role' }),
      row(3, 'onboarding_step_completed', '2026-10-19T09:01:00.000Z', { step: 'workspace' }),
    ]);

    expect(report.journeys[0].onboarding).toEqual({
      status: 'completed',
      completedAt: '2026-10-19T09:01:00.000Z',
      completedSteps: ['role', 'workspace'],
      lastCompletedStep: 'workspace',
    });
  });

  it('compares only explicitly selected paired journeys', () => {
    const report = buildActivationMeasurementReport([
      row(1, 'onboarding_started', '2026-10-19T09:00:00.000Z'),
      row(2, 'chat_composer_enabled', '2026-10-19T09:00:30.000Z'),
      row(3, 'onboarding_started', '2026-10-19T10:00:00.000Z', null, 'run-b', 'journey-b'),
      row(4, 'chat_composer_enabled', '2026-10-19T10:01:00.000Z', null, 'run-b', 'journey-b'),
    ]);

    expect(compareActivationJourneys(report, 'journey-a', 'journey-b')?.timingDeltaMs).toEqual({
      composerEnabled: 30_000,
      firstChangeSummaryViewed: null,
      firstChangeApplied: null,
    });
    expect(compareActivationJourneys(report, 'missing', 'journey-b')).toBeNull();
  });
});
