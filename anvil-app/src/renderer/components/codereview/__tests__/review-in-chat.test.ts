import { describe, expect, it } from 'vitest';
import {
  buildReviewInChatPrompt,
  describeReviewInChatScope,
  reviewContextArgs,
  reviewInChatPath,
  reviewInChatScopeFromCodeReview,
} from '../review-in-chat';

describe('review in chat launchers', () => {
  it('asks for review_context on the working tree and the Review surface', () => {
    const prompt = buildReviewInChatPrompt({
      type: 'working-tree',
      repoId: 'repo-1',
      repoName: 'anvil-app',
    });

    expect(prompt).toContain('Review my uncommitted changes (working tree) in anvil-app.');
    expect(prompt).toContain('review_context with {"repoId":"repo-1","scope":"working-tree"}');
    expect(prompt).toContain('review_publish');
    expect(prompt).toContain('Review surface');
  });

  it('normalises pull request ids and includes the title', () => {
    const scope = {
      type: 'pull-request' as const,
      repoId: 'repo-1',
      pullRequestId: ' #42 ',
      title: 'Move token refresh to the gateway',
    };

    expect(reviewContextArgs(scope)).toEqual({
      repoId: 'repo-1',
      scope: 'pull-request',
      pullRequestId: '42',
    });
    expect(describeReviewInChatScope(scope)).toBe('PR #42 "Move token refresh to the gateway"');
    expect(buildReviewInChatPrompt(scope)).toContain(
      '{"repoId":"repo-1","scope":"pull-request","pullRequestId":"42"}',
    );
  });

  it('defaults commit-range heads to HEAD and shortens full SHAs in prose only', () => {
    const base = 'a'.repeat(40);
    const head = 'b'.repeat(40);
    const scope = { type: 'commit-range' as const, repoId: 'repo-1', baseRef: base, headRef: head };

    expect(reviewContextArgs(scope)).toEqual({
      repoId: 'repo-1',
      scope: 'commit-range',
      baseRef: base,
      headRef: head,
    });
    expect(describeReviewInChatScope(scope)).toBe('aaaaaaa..bbbbbbb');
    expect(
      reviewContextArgs({ type: 'commit-range', repoId: 'repo-1', baseRef: 'main' }),
    ).toMatchObject({ baseRef: 'main', headRef: 'HEAD' });
  });

  it('builds a prefill-only /chat?prompt= path', () => {
    const path = reviewInChatPath({ type: 'working-tree', repoId: 'repo 1' });
    expect(path.startsWith('/chat?prompt=')).toBe(true);
    const prompt = new URLSearchParams(path.slice('/chat?'.length)).get('prompt');
    expect(prompt).toBe(buildReviewInChatPrompt({ type: 'working-tree', repoId: 'repo 1' }));
  });

  it('maps legacy code review scopes onto Review surface scopes', () => {
    expect(reviewInChatScopeFromCodeReview('r', 'latest_commit')).toEqual({
      type: 'commit-range',
      repoId: 'r',
      repoName: undefined,
      baseRef: 'HEAD~1',
      headRef: 'HEAD',
      label: 'the latest commit',
    });
    expect(
      reviewInChatScopeFromCodeReview('r', 'commit_range', { fromSha: 'abc', toSha: 'def' }),
    ).toMatchObject({ type: 'commit-range', baseRef: 'abc', headRef: 'def' });
    expect(reviewInChatScopeFromCodeReview('r', 'commit_range', { fromSha: 'abc' })).toBeNull();
    expect(
      reviewInChatScopeFromCodeReview('r', 'branch_diff', {
        baseBranch: 'main',
        compareBranch: 'feature/x',
      }),
    ).toMatchObject({
      type: 'commit-range',
      baseRef: 'main',
      headRef: 'feature/x',
      label: 'feature/x against main',
    });
    expect(
      reviewInChatScopeFromCodeReview(
        'r',
        'pull_request',
        { pullRequest: { id: '#7', title: 'Fix' } },
        'repo',
      ),
    ).toEqual({
      type: 'pull-request',
      repoId: 'r',
      repoName: 'repo',
      pullRequestId: '7',
      title: 'Fix',
    });
    expect(reviewInChatScopeFromCodeReview('r', 'pull_request', {})).toBeNull();
    expect(reviewInChatScopeFromCodeReview('r', 'full_codebase')).toBeNull();
  });
});
