import type { ChangeReview, ReviewOrigin } from '../../shared/change-review-types';

export type ChangeReviewEntrySource = 'chat' | 'git' | 'pull-request';

export interface ChangeReviewRouteInput {
  repoId: string;
  source: ChangeReviewEntrySource;
  baseRef?: string;
  origin?: ReviewOrigin;
  threadId?: string;
  turnId?: string;
  changedFiles?: string[];
}

export function buildChangeReviewPath(input: ChangeReviewRouteInput): string {
  const params = new URLSearchParams({ repo: input.repoId, source: input.source });
  if (input.baseRef) params.set('baseRef', input.baseRef);
  if (input.origin?.git) params.set('baseRef', input.origin.git.baseRef);
  const chat = input.origin?.chat;
  const threadId = input.threadId ?? chat?.threadId;
  const turnId = input.turnId ?? chat?.turnId;
  if (threadId) params.set('thread', threadId);
  if (turnId) params.set('turn', turnId);
  for (const path of (input.changedFiles ?? chat?.changedFiles)?.slice(0, 100) ?? []) {
    if (path.length <= 500) params.append('file', path);
  }
  const pullRequest = input.origin?.pullRequest;
  if (pullRequest) {
    params.set('pullRequest', pullRequest.id);
    params.set('provider', pullRequest.provider);
    params.set('head', pullRequest.headSha);
    if (pullRequest.number !== undefined) params.set('number', String(pullRequest.number));
  }
  if (input.origin?.automationRunId) params.set('automationRun', input.origin.automationRunId);
  if (input.origin?.workflowRunId) params.set('workflowRun', input.origin.workflowRunId);
  if (input.origin?.executionPath) params.set('executionPath', input.origin.executionPath);
  return `/review?${params.toString()}`;
}

export function buildChangeReviewReturnPath(input: {
  repoId: string;
  source?: ChangeReviewEntrySource;
  origin?: ReviewOrigin;
  threadId?: string;
}): string | undefined {
  const pullRequest = input.origin?.pullRequest;
  if ((input.source === 'pull-request' || input.source === undefined) && pullRequest)
    return `/codereview/${encodeURIComponent(input.repoId)}?${new URLSearchParams({ pr: pullRequest.id, view: 'map' })}`;
  if (
    input.source === 'git' ||
    (input.source === undefined &&
      !input.origin?.automationRunId &&
      !input.origin?.workflowRunId &&
      !input.origin?.executionPath &&
      !input.origin?.pullRequest &&
      !input.origin?.chat)
  )
    return `/git?${new URLSearchParams({ repo: input.repoId, tab: 'changes' })}`;
  if (
    input.source === 'chat' ||
    (input.source === undefined && (input.threadId || input.origin?.chat))
  ) {
    const threadId = input.threadId ?? input.origin?.chat?.threadId;
    const params = threadId ? new URLSearchParams({ thread: threadId }) : undefined;
    return params ? `/chat?${params}` : '/chat';
  }
  return undefined;
}

export function readReviewOrigin(params: URLSearchParams): ReviewOrigin | undefined {
  const automationRunId = params.get('automationRun') || undefined;
  const workflowRunId = params.get('workflowRun') || undefined;
  const executionPath = params.get('executionPath') || undefined;
  const gitBaseRef = params.get('source') === 'git' ? params.get('baseRef') : null;
  const git = gitBaseRef ? { baseRef: gitBaseRef } : undefined;
  const pullRequestId = params.get('pullRequest');
  const provider = params.get('provider');
  const headSha = params.get('head');
  const numberValue = params.get('number');
  const number = numberValue ? Number(numberValue) : undefined;
  const threadId = params.get('thread');
  const turnId = params.get('turn');
  const changedFiles = params
    .getAll('file')
    .slice(0, 100)
    .filter((path) => path.length <= 500);
  const chat = threadId && turnId ? { threadId, turnId, changedFiles } : undefined;
  const pullRequest =
    pullRequestId && provider && headSha
      ? {
          id: pullRequestId,
          provider,
          headSha,
          ...(number !== undefined && Number.isInteger(number) && number > 0 ? { number } : {}),
        }
      : undefined;
  if (!automationRunId && !workflowRunId && !executionPath && !pullRequest && !chat && !git)
    return undefined;
  return { automationRunId, workflowRunId, executionPath, pullRequest, chat, git };
}

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
  if (
    origin?.chat &&
    (review.origin?.chat?.threadId !== origin.chat.threadId ||
      review.origin.chat.turnId !== origin.chat.turnId)
  )
    return false;
  if (origin?.git && review.origin?.git?.baseRef !== origin.git.baseRef) return false;
  if (context.reviewId) return review.id === context.reviewId;
  // An execution handoff can carry a Work Item; retain that review's identity.
  if (
    origin?.automationRunId ||
    origin?.workflowRunId ||
    origin?.pullRequest ||
    origin?.chat ||
    origin?.git
  )
    return true;
  return context.workItemId
    ? review.workItemRef?.id === context.workItemId &&
        review.workItemRef.connectionId === context.connectionId
    : !review.workItemRef;
}
