/**
 * Local activation event contract and pure report calculations.
 *
 * These records stay in the desktop app's SQLite database. The report only
 * describes what Anvil observed; it cannot infer human presence, time spent
 * with the app closed, model usage, or the quality of an outcome.
 */

export const ACTIVATION_EVENT_NAMES = [
  'onboarding_started',
  'onboarding_step_completed',
  'chat_composer_enabled',
  'chat_blocked_shown',
  'change_summary_viewed',
  // Historical producer fired when any saved turn summary mounted, so it is
  // retained only to identify and report old, untrusted records.
  'diff_proposed',
  'change_applied',
  'pull_request_opened',
  'repo_index_tier_reached',
  'repo_enrich_completed',
] as const;

export type ActivationEventName = (typeof ACTIVATION_EVENT_NAMES)[number];
export type OnboardingStep = 'role' | 'agent' | 'sync' | 'workspace';
export type RepoIndexTier = 'mapped' | 'enriched';

export function isActivationEventName(value: unknown): value is ActivationEventName {
  return typeof value === 'string' && (ACTIVATION_EVENT_NAMES as readonly string[]).includes(value);
}

export type ActivationEventPayload = Record<string, unknown>;

/** Persisted event row, including nullable IDs on events written before v112. */
export interface ActivationEventRow {
  id: number;
  event: string;
  app_run_id?: string | null;
  journey_id?: string | null;
  payload: string | null;
  created_at: string;
}

export interface ActivationIndexObservation {
  tier: RepoIndexTier | null;
  durationMs: number | null;
  fileCount: number | null;
  recordedAt: string;
}

export interface ActivationJourneyReport {
  journeyId: string;
  startedAt: string;
  lastEventAt: string;
  appRunIds: string[];
  onboarding: {
    status: 'completed' | 'not_completed_in_observed_records';
    completedAt: string | null;
    completedSteps: OnboardingStep[];
    lastCompletedStep: OnboardingStep | null;
  };
  milestones: {
    composerEnabledAt: string | null;
    composerEnabledMs: number | null;
    firstChangeSummaryViewedAt: string | null;
    firstChangeSummaryViewedMs: number | null;
    firstChangeAppliedAt: string | null;
    firstChangeAppliedMs: number | null;
  };
  blockedShownCount: number;
  indexObservations: ActivationIndexObservation[];
  enrichment: { calls: number; skipped: number; observations: number };
  pullRequestOpenedCount: number;
  interpretation: {
    onboardingDropoff: 'possible' | 'not_observed';
    appInterruption: 'unknown';
    activeHuman: 'unknown';
    activeTime: 'not_recorded';
    modelUsage: 'not_recorded';
    outputQuality: 'not_recorded';
  };
}

export interface ActivationAppRunReport {
  appRunId: string;
  firstEventAt: string;
  lastEventAt: string;
  journeyIds: string[];
  eventCounts: Partial<Record<ActivationEventName, number>>;
  legacyDiffProposedEvents: number;
  indexObservations: ActivationIndexObservation[];
}

export interface ActivationTimingSummary {
  observed: number;
  medianMs: number | null;
}

export interface ActivationMeasurementReport {
  journeys: ActivationJourneyReport[];
  appRuns: ActivationAppRunReport[];
  totals: {
    startedJourneys: number;
    onboardingCompleted: number;
    possibleOnboardingDropoff: number;
    composerEnabled: ActivationTimingSummary;
    firstChangeSummaryViewed: ActivationTimingSummary;
    firstChangeApplied: ActivationTimingSummary;
    journeysWithBlockedComposer: number;
    indexObservations: number;
    enrichmentObservations: number;
    pullRequestsOpened: number;
    legacyDiffProposedEvents: number;
    eventsOutsideJourney: number;
    legacyUnscopedEvents: number;
  };
  coverage: {
    appInterruption: 'unknown';
    activeHuman: 'unknown';
    activeTime: 'not_recorded';
    modelUsage: 'not_recorded';
    outputQuality: 'not_recorded';
    pullRequestEvidence: 'explicit_pull_request_opened_event_only';
    newChangeGeneration: 'not_instrumented';
  };
}

export interface ActivationJourneyComparison {
  left: ActivationJourneyReport;
  right: ActivationJourneyReport;
  timingDeltaMs: {
    composerEnabled: number | null;
    firstChangeSummaryViewed: number | null;
    firstChangeApplied: number | null;
  };
}

const STEP_ORDER: readonly OnboardingStep[] = ['role', 'agent', 'sync', 'workspace'];

function parsePayload(serialized: string | null): ActivationEventPayload {
  if (!serialized) return {};
  try {
    const value: unknown = JSON.parse(serialized);
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as ActivationEventPayload)
      : {};
  } catch {
    return {};
  }
}

function numberField(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function eventName(value: string): ActivationEventName | null {
  return isActivationEventName(value) ? value : null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function elapsedMs(start: string, end: string): number | null {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs
    ? endMs - startMs
    : null;
}

function isOnboardingStep(value: unknown): value is OnboardingStep {
  return typeof value === 'string' && (STEP_ORDER as readonly string[]).includes(value);
}

function indexObservation(
  event: ActivationEventRow,
  payload: ActivationEventPayload,
): ActivationIndexObservation {
  const tier = payload.tier === 'mapped' || payload.tier === 'enriched' ? payload.tier : null;
  return {
    tier,
    durationMs: numberField(payload.ms),
    fileCount: numberField(payload.fileCount),
    recordedAt: event.created_at,
  };
}

function firstEventTime(events: ActivationEventRow[], name: ActivationEventName): string | null {
  return events.find((event) => event.event === name)?.created_at ?? null;
}

function summaryKeyForEvent(event: ActivationEventRow): string | null {
  if (event.event !== 'change_summary_viewed') return null;
  const summaryKey = parsePayload(event.payload).summaryKey;
  return typeof summaryKey === 'string' && /^[a-f0-9]{64}$/.test(summaryKey) ? summaryKey : null;
}

function summarizeJourney(
  journeyId: string,
  events: ActivationEventRow[],
): ActivationJourneyReport {
  const ordered = [...events].sort((a, b) => a.id - b.id);
  const startEvent = ordered.find((event) => event.event === 'onboarding_started') ?? ordered[0];
  const startedAt = startEvent.created_at;
  const stepEvents = ordered.filter((event) => event.event === 'onboarding_step_completed');
  const completedSteps: OnboardingStep[] = [];
  let lastCompletedStep: OnboardingStep | null = null;

  for (const event of stepEvents) {
    const step = parsePayload(event.payload).step;
    if (!isOnboardingStep(step)) continue;
    if (!completedSteps.includes(step)) completedSteps.push(step);
    lastCompletedStep = step;
  }

  const workspaceCompletion = stepEvents.find(
    (event) => parsePayload(event.payload).step === 'workspace',
  );
  const composerEnabledAt = firstEventTime(ordered, 'chat_composer_enabled');
  // Legacy diff_proposed rows are deliberately excluded: the old producer
  // fired for saved history and had no stable summary identity.
  const firstChangeSummaryViewedAt =
    ordered.find((event) => summaryKeyForEvent(event) !== null)?.created_at ?? null;
  const firstChangeAppliedAt = firstEventTime(ordered, 'change_applied');
  const lastEventAt = ordered[ordered.length - 1].created_at;
  const appRunIds = Array.from(
    new Set(ordered.map((event) => event.app_run_id).filter((value): value is string => !!value)),
  );
  const enrichEvents = ordered.filter((event) => event.event === 'repo_enrich_completed');
  const enrichment = enrichEvents.reduce(
    (result, event) => {
      const payload = parsePayload(event.payload);
      result.calls += numberField(payload.calls) ?? 0;
      result.skipped += numberField(payload.skipped) ?? 0;
      return result;
    },
    { calls: 0, skipped: 0, observations: enrichEvents.length },
  );

  return {
    journeyId,
    startedAt,
    lastEventAt,
    appRunIds,
    onboarding: {
      status: workspaceCompletion ? 'completed' : 'not_completed_in_observed_records',
      completedAt: workspaceCompletion?.created_at ?? null,
      completedSteps,
      lastCompletedStep,
    },
    milestones: {
      composerEnabledAt,
      composerEnabledMs: composerEnabledAt ? elapsedMs(startedAt, composerEnabledAt) : null,
      firstChangeSummaryViewedAt,
      firstChangeSummaryViewedMs: firstChangeSummaryViewedAt
        ? elapsedMs(startedAt, firstChangeSummaryViewedAt)
        : null,
      firstChangeAppliedAt,
      firstChangeAppliedMs: firstChangeAppliedAt
        ? elapsedMs(startedAt, firstChangeAppliedAt)
        : null,
    },
    blockedShownCount: ordered.filter((event) => event.event === 'chat_blocked_shown').length,
    indexObservations: ordered
      .filter((event) => event.event === 'repo_index_tier_reached')
      .map((event) => indexObservation(event, parsePayload(event.payload))),
    enrichment,
    pullRequestOpenedCount: ordered.filter((event) => event.event === 'pull_request_opened').length,
    interpretation: {
      onboardingDropoff: workspaceCompletion ? 'not_observed' : 'possible',
      appInterruption: 'unknown',
      activeHuman: 'unknown',
      activeTime: 'not_recorded',
      modelUsage: 'not_recorded',
      outputQuality: 'not_recorded',
    },
  };
}

/** Build a privacy-safe summary from rows returned by the local activation table. */
export function buildActivationMeasurementReport(
  rows: readonly ActivationEventRow[],
): ActivationMeasurementReport {
  const validRows = rows.filter((row) => eventName(row.event) !== null);
  const byJourney = new Map<string, ActivationEventRow[]>();
  const byAppRun = new Map<string, ActivationEventRow[]>();

  for (const row of validRows) {
    if (row.journey_id) {
      const journeyRows = byJourney.get(row.journey_id) ?? [];
      journeyRows.push(row);
      byJourney.set(row.journey_id, journeyRows);
    }
    if (row.app_run_id) {
      const appRunRows = byAppRun.get(row.app_run_id) ?? [];
      appRunRows.push(row);
      byAppRun.set(row.app_run_id, appRunRows);
    }
  }

  const journeys = Array.from(byJourney, ([journeyId, journeyRows]) =>
    summarizeJourney(journeyId, journeyRows),
  ).sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  const appRuns = Array.from(byAppRun, ([appRunId, appRunRows]) => {
    const ordered = [...appRunRows].sort((a, b) => a.id - b.id);
    const eventCounts: Partial<Record<ActivationEventName, number>> = {};
    let legacyDiffProposedEvents = 0;
    for (const row of ordered) {
      const name = eventName(row.event);
      if (name === 'diff_proposed') legacyDiffProposedEvents += 1;
      else if (name) eventCounts[name] = (eventCounts[name] ?? 0) + 1;
    }
    return {
      appRunId,
      firstEventAt: ordered[0].created_at,
      lastEventAt: ordered[ordered.length - 1].created_at,
      journeyIds: Array.from(
        new Set(
          ordered.map((event) => event.journey_id).filter((value): value is string => !!value),
        ),
      ),
      eventCounts,
      legacyDiffProposedEvents,
      indexObservations: ordered
        .filter((event) => event.event === 'repo_index_tier_reached')
        .map((event) => indexObservation(event, parsePayload(event.payload))),
    } satisfies ActivationAppRunReport;
  }).sort((a, b) => a.firstEventAt.localeCompare(b.firstEventAt));

  const timingSummary = (
    key: 'composerEnabledMs' | 'firstChangeSummaryViewedMs' | 'firstChangeAppliedMs',
  ) => {
    const values = journeys
      .map((journey) => journey.milestones[key])
      .filter((value): value is number => value !== null);
    return { observed: values.length, medianMs: median(values) };
  };

  return {
    journeys,
    appRuns,
    totals: {
      startedJourneys: journeys.length,
      onboardingCompleted: journeys.filter((journey) => journey.onboarding.status === 'completed')
        .length,
      possibleOnboardingDropoff: journeys.filter(
        (journey) => journey.interpretation.onboardingDropoff === 'possible',
      ).length,
      composerEnabled: timingSummary('composerEnabledMs'),
      firstChangeSummaryViewed: timingSummary('firstChangeSummaryViewedMs'),
      firstChangeApplied: timingSummary('firstChangeAppliedMs'),
      journeysWithBlockedComposer: journeys.filter((journey) => journey.blockedShownCount > 0)
        .length,
      indexObservations: validRows.filter((event) => event.event === 'repo_index_tier_reached')
        .length,
      enrichmentObservations: validRows.filter((event) => event.event === 'repo_enrich_completed')
        .length,
      pullRequestsOpened: validRows.filter((event) => event.event === 'pull_request_opened').length,
      legacyDiffProposedEvents: validRows.filter((event) => event.event === 'diff_proposed').length,
      eventsOutsideJourney: validRows.filter((event) => !event.journey_id && !!event.app_run_id)
        .length,
      legacyUnscopedEvents: rows.filter((event) => !event.app_run_id && !event.journey_id).length,
    },
    coverage: {
      appInterruption: 'unknown',
      activeHuman: 'unknown',
      activeTime: 'not_recorded',
      modelUsage: 'not_recorded',
      outputQuality: 'not_recorded',
      pullRequestEvidence: 'explicit_pull_request_opened_event_only',
      newChangeGeneration: 'not_instrumented',
    },
  };
}

/** Compare two explicitly selected journeys. Delta is right minus left. */
export function compareActivationJourneys(
  report: ActivationMeasurementReport,
  leftJourneyId: string,
  rightJourneyId: string,
): ActivationJourneyComparison | null {
  const left = report.journeys.find((journey) => journey.journeyId === leftJourneyId);
  const right = report.journeys.find((journey) => journey.journeyId === rightJourneyId);
  if (!left || !right) return null;

  const delta = (leftValue: number | null, rightValue: number | null): number | null =>
    leftValue === null || rightValue === null ? null : rightValue - leftValue;

  return {
    left,
    right,
    timingDeltaMs: {
      composerEnabled: delta(left.milestones.composerEnabledMs, right.milestones.composerEnabledMs),
      firstChangeSummaryViewed: delta(
        left.milestones.firstChangeSummaryViewedMs,
        right.milestones.firstChangeSummaryViewedMs,
      ),
      firstChangeApplied: delta(
        left.milestones.firstChangeAppliedMs,
        right.milestones.firstChangeAppliedMs,
      ),
    },
  };
}

function copyCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function copyDuration(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Keep only fields needed by the report. This drops prompts, diffs, errors and paths. */
export function sanitizeActivationEventPayload(
  event: ActivationEventName,
  value: unknown,
): ActivationEventPayload | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const payload: ActivationEventPayload = {};
  const setCount = (key: string) => {
    const count = copyCount(input[key]);
    if (count !== null) payload[key] = count;
  };

  switch (event) {
    case 'onboarding_started':
    case 'chat_composer_enabled':
    case 'chat_blocked_shown':
    case 'pull_request_opened':
      break;
    case 'change_summary_viewed':
      if (typeof input.summaryKey === 'string' && /^[a-f0-9]{64}$/.test(input.summaryKey)) {
        payload.summaryKey = input.summaryKey;
      }
      setCount('files');
      setCount('additions');
      setCount('deletions');
      break;
    case 'onboarding_step_completed':
      if (isOnboardingStep(input.step)) payload.step = input.step;
      if (input.choice === 'sync' || input.choice === 'local' || input.choice === 'later') {
        payload.choice = input.choice;
      }
      break;
    case 'diff_proposed':
      setCount('files');
      setCount('additions');
      setCount('deletions');
      break;
    case 'change_applied':
      setCount('fileCount');
      break;
    case 'repo_index_tier_reached':
      if (input.tier === 'mapped' || input.tier === 'enriched') payload.tier = input.tier;
      if (input.ms === null) payload.ms = null;
      else {
        const duration = copyDuration(input.ms);
        if (duration !== null) payload.ms = duration;
      }
      if (input.fileCount === null) payload.fileCount = null;
      else setCount('fileCount');
      break;
    case 'repo_enrich_completed':
      setCount('calls');
      setCount('skipped');
      break;
  }

  return Object.keys(payload).length > 0 ? payload : undefined;
}
