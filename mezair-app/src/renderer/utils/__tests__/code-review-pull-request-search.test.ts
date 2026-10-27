import { describe, expect, it } from 'vitest';
import type { CodeReviewPullRequest } from '../../../shared/types';
import {
  parsePullRequestIdInput,
  rankCodeReviewPullRequests,
} from '../code-review-pull-request-search';

const pullRequests: CodeReviewPullRequest[] = [
  {
    id: '412',
    title: 'Improve login flow for SSO users',
    provider: 'github',
    state: 'open',
    isDraft: false,
    author: 'alice',
    sourceBranch: 'feature/sso-login',
    targetBranch: 'main',
    updatedAt: '2026-04-22T10:00:00.000Z',
    url: 'https://example.test/pr/412',
  },
  {
    id: '87',
    title: 'Refine API retry policy',
    provider: 'github',
    state: 'merged',
    isDraft: false,
    author: 'bob',
    sourceBranch: 'bugfix/api-retries',
    targetBranch: 'release',
    updatedAt: '2026-04-24T08:30:00.000Z',
    url: 'https://example.test/pr/87',
  },
  {
    id: '103',
    title: 'Docs cleanup for onboarding',
    provider: 'ado',
    state: 'closed',
    isDraft: true,
    author: 'carol',
    sourceBranch: 'docs/onboarding-refresh',
    targetBranch: 'main',
    updatedAt: '2026-04-20T15:15:00.000Z',
    url: 'https://example.test/pr/103',
  },
];

describe('parsePullRequestIdInput', () => {
  it('extracts numeric PR ids with or without a leading hash', () => {
    expect(parsePullRequestIdInput('412')).toBe('412');
    expect(parsePullRequestIdInput('#412')).toBe('412');
    expect(parsePullRequestIdInput('  #87  ')).toBe('87');
  });

  it('returns null for non-numeric input', () => {
    expect(parsePullRequestIdInput('login flow')).toBeNull();
    expect(parsePullRequestIdInput('PR-87')).toBeNull();
  });
});

describe('rankCodeReviewPullRequests', () => {
  it('sorts by most recently updated when the query is empty', () => {
    expect(
      rankCodeReviewPullRequests(pullRequests, '').map((pullRequest) => pullRequest.id),
    ).toEqual(['87', '412', '103']);
  });

  it('prioritises exact PR id matches', () => {
    expect(rankCodeReviewPullRequests(pullRequests, '#412')[0]?.id).toBe('412');
  });

  it('supports fuzzy title matching', () => {
    expect(rankCodeReviewPullRequests(pullRequests, 'lgin')[0]?.id).toBe('412');
  });

  it('matches author and branch terms across the searchable fields', () => {
    expect(rankCodeReviewPullRequests(pullRequests, 'bob release')[0]?.id).toBe('87');
  });
});
