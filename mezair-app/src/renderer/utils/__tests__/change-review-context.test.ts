import { describe, expect, it } from 'vitest';
import type { ChangeReview } from '../../../shared/change-review-types';
import {
  buildChangeReviewPath,
  buildChangeReviewReturnPath,
  matchesReviewContext,
  readReviewOrigin,
} from '../change-review-context';
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
  it('round-trips a PR handoff with its exact head and returns to that PR', () => {
    const path = buildChangeReviewPath({
      repoId: 'repo one',
      source: 'pull-request',
      baseRef: 'main',
      origin: {
        pullRequest: { id: '7', provider: 'github', headSha: 'head', number: 7 },
      },
    });
    const params = new URLSearchParams(path.split('?')[1]);
    const origin = readReviewOrigin(params);
    expect(path).toContain('repo=repo+one');
    expect(origin?.pullRequest).toEqual({
      id: '7',
      provider: 'github',
      headSha: 'head',
      number: 7,
    });
    expect(matchesReviewContext(review, { repoId: 'repo', origin })).toBe(true);
    expect(
      buildChangeReviewReturnPath({ repoId: 'repo one', source: 'pull-request', origin }),
    ).toBe('/codereview/repo%20one?pr=7&view=map');
  });

  it('keeps chat returns attached to the originating thread', () => {
    const path = buildChangeReviewPath({
      repoId: 'repo',
      source: 'chat',
      threadId: 'thread 1',
      turnId: 'turn 4',
      changedFiles: ['src/App.tsx', 'src/review.ts'],
    });
    const params = new URLSearchParams(path.split('?')[1]);
    expect(params.get('thread')).toBe('thread 1');
    expect(readReviewOrigin(params)?.chat).toEqual({
      threadId: 'thread 1',
      turnId: 'turn 4',
      changedFiles: ['src/App.tsx', 'src/review.ts'],
    });
    expect(
      buildChangeReviewReturnPath({
        repoId: 'repo',
        source: 'chat',
        threadId: params.get('thread')!,
      }),
    ).toBe('/chat?thread=thread+1');
    expect(
      matchesReviewContext(
        {
          ...review,
          origin: { chat: { threadId: 'thread 1', turnId: 'turn 4', changedFiles: [] } },
        },
        { repoId: 'repo', origin: readReviewOrigin(params) },
      ),
    ).toBe(true);
    expect(buildChangeReviewReturnPath({ repoId: 'repo', origin: readReviewOrigin(params) })).toBe(
      '/chat?thread=thread+1',
    );
  });

  it('persists the Git entry source for later review-history links', () => {
    const path = buildChangeReviewPath({
      repoId: 'repo',
      source: 'git',
      baseRef: 'origin/main',
      origin: { git: { baseRef: 'origin/main' } },
    });
    const origin = readReviewOrigin(new URLSearchParams(path.split('?')[1]));
    expect(origin?.git).toEqual({ baseRef: 'origin/main' });
    expect(buildChangeReviewReturnPath({ repoId: 'repo', origin })).toBe(
      '/git?repo=repo&tab=changes',
    );
    expect(buildChangeReviewReturnPath({ repoId: 'repo' })).toBe('/git?repo=repo&tab=changes');
    expect(
      matchesReviewContext(
        { ...review, origin: { git: { baseRef: 'origin/main' } } },
        { repoId: 'repo', origin },
      ),
    ).toBe(true);
  });

  it('ignores incomplete PR route identity instead of creating a partial origin', () => {
    expect(readReviewOrigin(new URLSearchParams('pullRequest=7&provider=github'))).toBeUndefined();
  });

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
