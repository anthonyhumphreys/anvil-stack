import type { CodeReviewPullRequest } from '../../shared/types';

export function parsePullRequestIdInput(value: string): string | null {
  const normalized = value.trim();
  const match = normalized.match(/^#?(\d+)$/);
  return match?.[1] ?? null;
}

export function rankCodeReviewPullRequests(
  pullRequests: CodeReviewPullRequest[],
  query: string,
): CodeReviewPullRequest[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [...pullRequests].sort(compareByUpdatedAt);
  }

  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);

  return pullRequests
    .map((pullRequest) => ({
      pullRequest,
      score: scorePullRequest(pullRequest, normalizedQuery, tokens),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || compareByUpdatedAt(a.pullRequest, b.pullRequest))
    .map((entry) => entry.pullRequest);
}

function scorePullRequest(
  pullRequest: CodeReviewPullRequest,
  query: string,
  tokens: string[],
): number {
  const idText = pullRequest.id.toLowerCase();
  const title = pullRequest.title.toLowerCase();
  const author = (pullRequest.author ?? '').toLowerCase();
  const sourceBranch = pullRequest.sourceBranch.toLowerCase();
  const targetBranch = pullRequest.targetBranch.toLowerCase();
  const searchableText = [idText, title, author, sourceBranch, targetBranch].join(' ');

  let score = 0;
  const numericQuery = parsePullRequestIdInput(query);

  if (numericQuery) {
    if (idText === numericQuery) score += 1_000;
    else if (idText.startsWith(numericQuery)) score += 700;
  }

  score += scoreField(title, query, 550);
  score += scoreField(author, query, 180);
  score += scoreField(sourceBranch, query, 220);
  score += scoreField(targetBranch, query, 150);

  if (tokens.every((token) => searchableText.includes(token))) {
    score += 140 + tokens.length * 25;
  }

  score += fuzzySubsequenceScore(title, query, 120);
  score += fuzzySubsequenceScore(searchableText, query, 60);

  return score;
}

function scoreField(field: string, query: string, baseScore: number): number {
  if (!field) return 0;
  if (field === query) return baseScore;
  if (field.startsWith(query)) return baseScore - 40;

  const includesIndex = field.indexOf(query);
  if (includesIndex >= 0) {
    return Math.max(40, baseScore - 80 - includesIndex * 2);
  }

  return 0;
}

function fuzzySubsequenceScore(field: string, query: string, baseScore: number): number {
  if (!field || !query) return 0;

  let cursor = 0;
  let firstMatch = -1;

  for (const char of query) {
    const index = field.indexOf(char, cursor);
    if (index < 0) return 0;
    if (firstMatch < 0) firstMatch = index;
    cursor = index + 1;
  }

  const spreadPenalty = cursor - firstMatch - query.length;
  return Math.max(10, baseScore - spreadPenalty * 4 - firstMatch);
}

function compareByUpdatedAt(a: CodeReviewPullRequest, b: CodeReviewPullRequest): number {
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}
