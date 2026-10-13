// "Review in chat" launchers (docs/plans/inline-artifacts-and-canvas-tools.md §8.1, §12).
// The PR Review and Changes screens stay as queues; reviewing opens chat with a
// prefilled (never auto-sent) prompt that asks the agent to call review_context
// for the scope and publish a Review surface.

import type { CodeReviewScopeRef, CodeReviewScopeType } from '../../../shared/types';
import { chatPromptPath } from '../../utils/sidebar-navigation';

export type ReviewInChatScope =
  | { type: 'working-tree'; repoId: string; repoName?: string }
  | {
      type: 'pull-request';
      repoId: string;
      repoName?: string;
      pullRequestId: string;
      title?: string;
    }
  | {
      type: 'commit-range';
      repoId: string;
      repoName?: string;
      baseRef: string;
      headRef?: string;
      /** Human description, e.g. "the latest commit". Defaults to `base..head`. */
      label?: string;
    };

const FULL_SHA = /^[0-9a-f]{40}$/i;

function shortRef(ref: string): string {
  return FULL_SHA.test(ref) ? ref.slice(0, 7) : ref;
}

function normalizePullRequestId(id: string): string {
  return id.trim().replace(/^#/, '');
}

/** Arguments for the `review_context` agent tool (src/main/surfaces/kinds/review.ts). */
export function reviewContextArgs(scope: ReviewInChatScope): Record<string, string> {
  switch (scope.type) {
    case 'working-tree':
      return { repoId: scope.repoId, scope: 'working-tree' };
    case 'pull-request':
      return {
        repoId: scope.repoId,
        scope: 'pull-request',
        pullRequestId: normalizePullRequestId(scope.pullRequestId),
      };
    case 'commit-range':
      return {
        repoId: scope.repoId,
        scope: 'commit-range',
        baseRef: scope.baseRef,
        headRef: scope.headRef || 'HEAD',
      };
  }
}

export function describeReviewInChatScope(scope: ReviewInChatScope): string {
  switch (scope.type) {
    case 'working-tree':
      return 'my uncommitted changes (working tree)';
    case 'pull-request': {
      const title = scope.title?.trim();
      return `PR #${normalizePullRequestId(scope.pullRequestId)}${title ? ` "${title}"` : ''}`;
    }
    case 'commit-range':
      return (
        scope.label?.trim() || `${shortRef(scope.baseRef)}..${shortRef(scope.headRef || 'HEAD')}`
      );
  }
}

/** The prefilled chat prompt. The user reviews and sends it; nothing is sent automatically. */
export function buildReviewInChatPrompt(scope: ReviewInChatScope): string {
  const repo = scope.repoName?.trim();
  return [
    `Review ${describeReviewInChatScope(scope)}${repo ? ` in ${repo}` : ''}.`,
    `Call review_context with ${JSON.stringify(reviewContextArgs(scope))}, then publish the review with review_publish so it opens as a Review surface in this thread.`,
    'Prioritise correctness, regressions, missing tests and security risks. Pin every finding to a changed line.',
  ].join('\n\n');
}

export function reviewInChatPath(scope: ReviewInChatScope): string {
  return chatPromptPath(buildReviewInChatPrompt(scope));
}

/**
 * Maps a legacy Code Review scope onto a Review surface scope. Full-codebase
 * reviews have no diff, so they have no Review surface scope (null).
 */
export function reviewInChatScopeFromCodeReview(
  repoId: string,
  scopeType: CodeReviewScopeType,
  scopeRef?: CodeReviewScopeRef,
  repoName?: string,
): ReviewInChatScope | null {
  switch (scopeType) {
    case 'latest_commit':
      return {
        type: 'commit-range',
        repoId,
        repoName,
        baseRef: 'HEAD~1',
        headRef: 'HEAD',
        label: 'the latest commit',
      };
    case 'commit_range':
      if (!scopeRef?.fromSha || !scopeRef.toSha) return null;
      return {
        type: 'commit-range',
        repoId,
        repoName,
        baseRef: scopeRef.fromSha,
        headRef: scopeRef.toSha,
      };
    case 'branch_diff':
      if (!scopeRef?.baseBranch || !scopeRef.compareBranch) return null;
      return {
        type: 'commit-range',
        repoId,
        repoName,
        baseRef: scopeRef.baseBranch,
        headRef: scopeRef.compareBranch,
        label: `${scopeRef.compareBranch} against ${scopeRef.baseBranch}`,
      };
    case 'pull_request': {
      const id = scopeRef?.pullRequest?.id ? normalizePullRequestId(scopeRef.pullRequest.id) : '';
      if (!id) return null;
      return {
        type: 'pull-request',
        repoId,
        repoName,
        pullRequestId: id,
        title: scopeRef?.pullRequest?.title,
      };
    }
    case 'full_codebase':
      return null;
  }
}
