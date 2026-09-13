import { describe, expect, it } from 'vitest';
import type { ChangeReview } from '../../../shared/change-review-types';
import { matchesReviewContext } from '../change-review-context';
const review = {
  id: 'review',
  repoId: 'repo',
  workItemRef: { id: 'item', connectionId: 'connection', provider: 'linear' },
  origin: {
    automationRunId: 'automation',
    workflowRunId: 'workflow',
    pullRequest: { id: '7', provider: 'github', headSha: 'head' },
  },
} as ChangeReview;
describe('review route identity', () => {
  it('opens an exact review with its Work Item from PR evidence', () => {
    expect(matchesReviewContext(review, { repoId: 'repo', reviewId: 'review' })).toBe(true);
    expect(matchesReviewContext(review, { repoId: 'other', reviewId: 'review' })).toBe(false);
  });
  it('retains execution reviews even when attached to a Work Item', () => {
    expect(
      matchesReviewContext(review, { repoId: 'repo', origin: { automationRunId: 'automation' } }),
    ).toBe(true);
    expect(
      matchesReviewContext(review, { repoId: 'repo', origin: { automationRunId: 'another' } }),
    ).toBe(false);
    expect(
      matchesReviewContext(review, { repoId: 'repo', origin: { workflowRunId: 'another' } }),
    ).toBe(false);
  });
  it('does not select evidence from a different PR head or provider', () => {
    expect(
      matchesReviewContext(review, {
        repoId: 'repo',
        origin: { pullRequest: { id: '7', provider: 'github', headSha: 'new-head' } },
      }),
    ).toBe(false);
    expect(
      matchesReviewContext(review, {
        repoId: 'repo',
        origin: { pullRequest: { id: '7', provider: 'ado', headSha: 'head' } },
      }),
    ).toBe(false);
    expect(matchesReviewContext(review, { repoId: 'repo', origin: review.origin })).toBe(true);
  });
  it('preserves local versus provider-scoped review separation', () => {
    expect(matchesReviewContext(review, { repoId: 'repo' })).toBe(false);
    expect(
      matchesReviewContext(review, {
        repoId: 'repo',
        workItemId: 'item',
        connectionId: 'connection',
      }),
    ).toBe(true);
    expect(
      matchesReviewContext(review, { repoId: 'repo', workItemId: 'item', connectionId: 'other' }),
    ).toBe(false);
  });
});
