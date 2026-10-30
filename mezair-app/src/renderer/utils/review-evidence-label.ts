import type { ChangeReview, ReviewEvidenceLink } from '../../shared/change-review-types';

export function reviewEvidenceLabel(review: ChangeReview, link: ReviewEvidenceLink): string {
  if (link.findingId) {
    const finding = review.findings.find((item) => item.id === link.findingId);
    return `Finding · ${finding?.note ?? `Unavailable finding ${link.findingId}`}`;
  }
  if (link.captureId) {
    const run = review.runs.find((item) => item.id === link.runId);
    const capture = run?.candidateCaptures.find((item) => item.id === link.captureId);
    return capture && run
      ? `Capture and trace · ${capture.viewport} · ${new Date(run.startedAt).toLocaleString()}`
      : `Capture and trace · Unavailable capture ${link.captureId}`;
  }
  if (link.criterionId) {
    const criterion = review.criteria
      .find((version) => version.id === link.criteriaVersion)
      ?.items.find((item) => item.id === link.criterionId);
    return `Acceptance criterion · ${criterion?.text ?? `Unavailable criterion ${link.criterionId}`}`;
  }
  return link.scenarioVersion === review.scenarioVersion
    ? `Replay scenario · ${review.scenario?.name ?? 'Saved scenario'}`
    : `Replay scenario · Historical version ${link.scenarioVersion ?? 'unknown'}`;
}
