import type { ChangeReview, ReviewOrigin } from '../../shared/change-review-types';

/** Route context must never substitute another checkout's review. */
export function matchesReviewContext(
  review: ChangeReview,
  context: {
    repoId: string;
    reviewId?: string;
    origin?: ReviewOrigin;
    workItemId?: string;
    connectionId?: string;
  },
): boolean {
  if (review.repoId !== context.repoId) return false;
  const { origin } = context;
  if (origin?.automationRunId && review.origin?.automationRunId !== origin.automationRunId)
    return false;
  if (origin?.workflowRunId && review.origin?.workflowRunId !== origin.workflowRunId) return false;
  if (
    origin?.pullRequest &&
    (review.origin?.pullRequest?.id !== origin.pullRequest.id ||
      review.origin.pullRequest.provider !== origin.pullRequest.provider ||
      review.origin.pullRequest.headSha !== origin.pullRequest.headSha)
  )
    return false;
  if (context.reviewId) return review.id === context.reviewId;
  // An execution handoff can carry a Work Item; retain that review's identity.
  if (origin?.automationRunId || origin?.workflowRunId || origin?.pullRequest) return true;
  return context.workItemId
    ? review.workItemRef?.id === context.workItemId &&
        review.workItemRef.connectionId === context.connectionId
    : !review.workItemRef;
}
