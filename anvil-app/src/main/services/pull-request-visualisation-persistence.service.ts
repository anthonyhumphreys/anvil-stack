import { randomUUID } from 'node:crypto';
import type { CodeReviewPullRequest, PullRequestVisualisation } from '../../shared/types.js';
import { getDb } from '../db/database.js';

interface PullRequestVisualisationRow {
  id: string;
  repo_id: string;
  review_id: string | null;
  head_sha: string;
  status: string;
  pull_request_json: string;
  summary: string | null;
  intent: string | null;
  data_json: string;
  error: string | null;
  created_at: string;
  generated_at: string | null;
}

type VisualisationData = Pick<
  PullRequestVisualisation,
  'chapters' | 'nodes' | 'edges' | 'risks' | 'evidence'
>;

const EMPTY_DATA: VisualisationData = {
  chapters: [],
  nodes: [],
  edges: [],
  risks: [],
  evidence: [],
};

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapRow(row: PullRequestVisualisationRow): PullRequestVisualisation {
  const data = { ...EMPTY_DATA, ...parseJson<Partial<VisualisationData>>(row.data_json, {}) };
  return {
    id: row.id,
    repoId: row.repo_id,
    reviewId: row.review_id ?? undefined,
    pullRequest: parseJson<CodeReviewPullRequest>(row.pull_request_json, {
      id: 'unknown',
      title: 'Pull request',
      provider: 'github',
      state: 'open',
      isDraft: false,
      sourceBranch: 'unknown',
      targetBranch: 'unknown',
      updatedAt: row.created_at,
    }),
    headSha: row.head_sha,
    status: row.status as PullRequestVisualisation['status'],
    summary: row.summary ?? undefined,
    intent: row.intent ?? undefined,
    ...data,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    generatedAt: row.generated_at ?? undefined,
  };
}

export function getLatestPullRequestVisualisation(
  repoId: string,
  pullRequestId: string,
): PullRequestVisualisation | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM pull_request_visualisations
       WHERE repo_id = ? AND pull_request_id = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(repoId, pullRequestId) as PullRequestVisualisationRow | undefined;
  return row ? mapRow(row) : null;
}

export function beginPullRequestVisualisation(input: {
  repoId: string;
  reviewId?: string;
  pullRequest: CodeReviewPullRequest;
  headSha: string;
}): PullRequestVisualisation {
  const db = getDb();
  const existing = db
    .prepare(
      `SELECT id, created_at FROM pull_request_visualisations
       WHERE repo_id = ? AND provider = ? AND pull_request_id = ? AND head_sha = ?`,
    )
    .get(input.repoId, input.pullRequest.provider, input.pullRequest.id, input.headSha) as
    | { id: string; created_at: string }
    | undefined;
  const id = existing?.id ?? randomUUID();
  const createdAt = existing?.created_at ?? new Date().toISOString();

  db.prepare(
    `INSERT INTO pull_request_visualisations
      (id, repo_id, review_id, provider, pull_request_id, head_sha, status,
       pull_request_json, data_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'generating', ?, '{}', ?)
     ON CONFLICT(repo_id, provider, pull_request_id, head_sha) DO UPDATE SET
       review_id = COALESCE(excluded.review_id, review_id),
       status = 'generating',
       pull_request_json = excluded.pull_request_json,
       summary = NULL,
       intent = NULL,
       data_json = '{}',
       error = NULL,
       generated_at = NULL`,
  ).run(
    id,
    input.repoId,
    input.reviewId ?? null,
    input.pullRequest.provider,
    input.pullRequest.id,
    input.headSha,
    JSON.stringify(input.pullRequest),
    createdAt,
  );

  return getLatestPullRequestVisualisation(input.repoId, input.pullRequest.id)!;
}

export function completePullRequestVisualisation(
  id: string,
  output: Pick<
    PullRequestVisualisation,
    'summary' | 'intent' | 'chapters' | 'nodes' | 'edges' | 'risks' | 'evidence'
  >,
): void {
  getDb()
    .prepare(
      `UPDATE pull_request_visualisations
       SET status = 'ready', summary = ?, intent = ?, data_json = ?, error = NULL,
           generated_at = ?
       WHERE id = ?`,
    )
    .run(
      output.summary ?? null,
      output.intent ?? null,
      JSON.stringify({
        chapters: output.chapters,
        nodes: output.nodes,
        edges: output.edges,
        risks: output.risks,
        evidence: output.evidence,
      }),
      new Date().toISOString(),
      id,
    );
}

export function failPullRequestVisualisation(id: string, error: string): void {
  getDb()
    .prepare(
      `UPDATE pull_request_visualisations
       SET status = 'failed', error = ?, generated_at = ? WHERE id = ?`,
    )
    .run(error, new Date().toISOString(), id);
}
