import { randomUUID } from 'node:crypto';
import type {
  CodeReview,
  CodeReviewStatus,
  CodeReviewFinding,
  CodeReviewFindingSeverity,
  CodeReviewMode,
  CodeReviewPullRequestComment,
  CodeReviewScopeRef,
  CodeReviewScopeType,
  CodeReviewVerification,
} from '../../shared/types.js';
import { getDb } from '../db/database.js';

// ---------------------------------------------------------------------------
// Internal row types (snake_case columns from SQLite)
// ---------------------------------------------------------------------------

interface CodeReviewRow {
  id: string;
  repo_id: string;
  mode: string;
  scope_type: string;
  scope_ref: string | null;
  status: string;
  summary: string | null;
  rubric_used: string | null;
  verification_status: string | null;
  verification_summary: string | null;
  verification_steps_json: string | null;
  verification_target_ref: string | null;
  verification_worktree_path: string | null;
  verification_worktree_kept: number | null;
  started_at: string;
  completed_at: string | null;
}

interface CodeReviewFindingRow {
  id: string;
  review_id: string;
  severity: string;
  category: string;
  file_path: string | null;
  line_start: number | null;
  line_end: number | null;
  description: string;
  suggestion: string | null;
  work_item_id: string | null;
  pr_comment_id: string | null;
  pr_comment_url: string | null;
  pr_commented_at: string | null;
  dismissed: number;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function mapReview(row: CodeReviewRow): CodeReview {
  return {
    id: row.id,
    repoId: row.repo_id,
    mode: row.mode as CodeReviewMode,
    scopeType: row.scope_type as CodeReviewScopeType,
    scopeRef: safeParseJson(row.scope_ref, undefined),
    status: row.status as CodeReviewStatus,
    summary: row.summary ?? undefined,
    rubricUsed: row.rubric_used ?? undefined,
    verification: mapVerification(row),
    startedAt: row.started_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function mapVerification(row: CodeReviewRow): CodeReviewVerification | undefined {
  const status = row.verification_status;
  const summary = row.verification_summary ?? undefined;
  const steps = safeParseJson(row.verification_steps_json, [] as CodeReviewVerification['steps']);
  const targetRef = row.verification_target_ref ?? undefined;
  const worktreePath = row.verification_worktree_path ?? undefined;
  const worktreeKept = row.verification_worktree_kept === 1;

  if (
    (!status || status === 'not_run') &&
    !summary &&
    steps.length === 0 &&
    !targetRef &&
    !worktreePath &&
    !worktreeKept
  ) {
    return undefined;
  }

  return {
    status: (status ?? 'not_run') as CodeReviewVerification['status'],
    summary,
    targetRef,
    worktreePath,
    worktreeKept,
    steps,
  };
}

function mapFinding(row: CodeReviewFindingRow): CodeReviewFinding {
  return {
    id: row.id,
    reviewId: row.review_id,
    severity: row.severity as CodeReviewFindingSeverity,
    category: row.category,
    filePath: row.file_path ?? undefined,
    lineStart: row.line_start ?? undefined,
    lineEnd: row.line_end ?? undefined,
    description: row.description,
    suggestion: row.suggestion ?? undefined,
    workItemId: row.work_item_id ?? undefined,
    pullRequestComment: mapPullRequestComment(row),
    dismissed: row.dismissed === 1,
  };
}

function mapPullRequestComment(
  row: Pick<CodeReviewFindingRow, 'pr_comment_id' | 'pr_comment_url' | 'pr_commented_at'>,
): CodeReviewPullRequestComment | undefined {
  if (!row.pr_commented_at) {
    return undefined;
  }

  return {
    id: row.pr_comment_id ?? undefined,
    url: row.pr_comment_url ?? undefined,
    postedAt: row.pr_commented_at,
  };
}

function safeParseJson<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Review operations
// ---------------------------------------------------------------------------

export interface CreateReviewInput {
  repoId: string;
  mode: CodeReviewMode;
  scopeType: CodeReviewScopeType;
  scopeRef?: CodeReviewScopeRef;
  rubricUsed?: string;
}

export function createReview(input: CreateReviewInput): string {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO code_reviews
     (id, repo_id, mode, scope_type, scope_ref, status, rubric_used, started_at)
     VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`,
  ).run(
    id,
    input.repoId,
    input.mode,
    input.scopeType,
    input.scopeRef ? JSON.stringify(input.scopeRef) : null,
    input.rubricUsed ?? null,
    now,
  );
  return id;
}

export function getReview(id: string): CodeReview | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM code_reviews WHERE id = ?').get(id) as
    | CodeReviewRow
    | undefined;
  return row ? mapReview(row) : null;
}

export function getRunningReview(
  repoId: string,
  isReviewActive: (reviewId: string) => boolean = () => false,
): CodeReview | null {
  const db = getDb();

  const staleThreshold = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const staleRows = db
    .prepare(
      `SELECT id FROM code_reviews
       WHERE repo_id = ? AND status = 'running' AND started_at < ?`,
    )
    .all(repoId, staleThreshold) as Array<{ id: string }>;

  const now = new Date().toISOString();
  for (const row of staleRows) {
    if (isReviewActive(row.id)) continue;

    db.prepare(
      `UPDATE code_reviews
       SET status = 'failed',
           summary = 'Review timed out',
           completed_at = ?
       WHERE id = ?`,
    ).run(now, row.id);
  }

  const row = db
    .prepare(
      `SELECT * FROM code_reviews WHERE repo_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1`,
    )
    .get(repoId) as CodeReviewRow | undefined;
  return row ? mapReview(row) : null;
}

export function listReviews(repoId: string): CodeReview[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM code_reviews WHERE repo_id = ? ORDER BY started_at DESC`)
    .all(repoId) as CodeReviewRow[];
  return rows.map(mapReview);
}

export function updateReviewStatus(id: string, status: CodeReviewStatus, summary?: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  if (summary !== undefined) {
    db.prepare(
      `UPDATE code_reviews SET status = ?, summary = ?, completed_at = ? WHERE id = ?`,
    ).run(status, summary, now, id);
  } else {
    db.prepare(`UPDATE code_reviews SET status = ?, completed_at = ? WHERE id = ?`).run(
      status,
      now,
      id,
    );
  }
}

export function updateReviewScopeRef(id: string, scopeRef: CodeReviewScopeRef): void {
  const db = getDb();
  db.prepare('UPDATE code_reviews SET scope_ref = ? WHERE id = ?').run(
    JSON.stringify(scopeRef),
    id,
  );
}

export function updateReviewVerification(id: string, verification: CodeReviewVerification): void {
  const db = getDb();
  db.prepare(
    `UPDATE code_reviews
     SET verification_status = ?,
         verification_summary = ?,
         verification_steps_json = ?,
         verification_target_ref = ?,
         verification_worktree_path = ?,
         verification_worktree_kept = ?
     WHERE id = ?`,
  ).run(
    verification.status,
    verification.summary ?? null,
    JSON.stringify(verification.steps),
    verification.targetRef ?? null,
    verification.worktreePath ?? null,
    verification.worktreeKept ? 1 : 0,
    id,
  );
}

// ---------------------------------------------------------------------------
// Finding operations
// ---------------------------------------------------------------------------

export interface CreateFindingInput {
  reviewId: string;
  severity: CodeReviewFindingSeverity;
  category: string;
  filePath?: string;
  lineStart?: number;
  lineEnd?: number;
  description: string;
  suggestion?: string;
}

export function createFinding(input: CreateFindingInput): string {
  const db = getDb();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO code_review_findings
     (id, review_id, severity, category, file_path, line_start, line_end, description, suggestion)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.reviewId,
    input.severity,
    input.category,
    input.filePath ?? null,
    input.lineStart ?? null,
    input.lineEnd ?? null,
    input.description,
    input.suggestion ?? null,
  );
  return id;
}

export function getFindings(reviewId: string): CodeReviewFinding[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM code_review_findings WHERE review_id = ?
       ORDER BY CASE severity
         WHEN 'critical' THEN 0
         WHEN 'major' THEN 1
         WHEN 'minor' THEN 2
         WHEN 'suggestion' THEN 3
         WHEN 'nitpick' THEN 4
         ELSE 5
       END`,
    )
    .all(reviewId) as CodeReviewFindingRow[];
  return rows.map(mapFinding);
}

export function getFinding(id: string): CodeReviewFinding | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM code_review_findings WHERE id = ?').get(id) as
    | CodeReviewFindingRow
    | undefined;
  return row ? mapFinding(row) : null;
}

export function dismissFinding(id: string): void {
  const db = getDb();
  db.prepare('UPDATE code_review_findings SET dismissed = 1 WHERE id = ?').run(id);
}

export function linkFindingToWorkItem(findingId: string, workItemId: string): void {
  const db = getDb();
  db.prepare('UPDATE code_review_findings SET work_item_id = ? WHERE id = ?').run(
    workItemId,
    findingId,
  );
}

export function linkFindingToPullRequestComment(
  findingId: string,
  comment: CodeReviewPullRequestComment,
): void {
  const db = getDb();
  db.prepare(
    'UPDATE code_review_findings SET pr_comment_id = ?, pr_comment_url = ?, pr_commented_at = ? WHERE id = ?',
  ).run(comment.id ?? null, comment.url ?? null, comment.postedAt, findingId);
}
