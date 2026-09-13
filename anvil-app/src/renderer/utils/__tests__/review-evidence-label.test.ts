import { describe, expect, it } from 'vitest';
import type { ChangeReview, ReviewEvidenceLink } from '../../../shared/change-review-types';
import { reviewEvidenceLabel } from '../review-evidence-label';
const review = {
  criteria: [
    { id: 'old', items: [{ id: 'criterion', text: 'Original expectation' }] },
    { id: 'new', items: [{ id: 'criterion', text: 'Changed expectation' }] },
  ],
  findings: [{ id: 'finding', note: 'Address disappears' }],
  runs: [
    {
      id: 'run',
      startedAt: '2026-09-09T12:00:00Z',
      candidateCaptures: [{ id: 'capture', viewport: 'Desktop' }],
    },
  ],
  scenarioVersion: 'current',
  scenario: { name: 'Checkout' },
} as ChangeReview;
const link = (target: Partial<ReviewEvidenceLink>) => target as ReviewEvidenceLink;
describe('review evidence identity labels', () => {
  it('uses the linked criteria version rather than replacing its wording', () => {
    expect(
      reviewEvidenceLabel(review, link({ criterionId: 'criterion', criteriaVersion: 'old' })),
    ).toBe('Acceptance criterion · Original expectation');
  });
  it('identifies a finding and a capture by their actual observed context', () => {
    expect(reviewEvidenceLabel(review, link({ findingId: 'finding' }))).toBe(
      'Finding · Address disappears',
    );
    expect(reviewEvidenceLabel(review, link({ captureId: 'capture', runId: 'run' }))).toContain(
      'Capture and trace · Desktop · ',
    );
  });
  it('does not label a historical scenario with the current scenario name', () => {
    expect(reviewEvidenceLabel(review, link({ scenarioVersion: 'old' }))).toBe(
      'Replay scenario · Historical version old',
    );
    expect(reviewEvidenceLabel(review, link({ scenarioVersion: 'current' }))).toBe(
      'Replay scenario · Checkout',
    );
  });
  it('retains missing target identity explicitly', () => {
    expect(reviewEvidenceLabel(review, link({ findingId: 'missing' }))).toBe(
      'Finding · Unavailable finding missing',
    );
  });
});
