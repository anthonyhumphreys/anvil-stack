import { getDb } from '../db/database.js';
import { captureReviewSnapshot, reviewGit } from './review-snapshot.service.js';

export function currentRepoTree(repoId: string): string | null {
  const repo = getDb().prepare('SELECT path FROM repos WHERE id = ?').get(repoId) as
    | { path: string }
    | undefined;
  if (!repo) return null;
  try {
    return captureReviewSnapshot(repo.path).tree;
  } catch {
    return null;
  }
}
export function bindAnalysisStart(
  table: 'code_reviews' | 'security_audits',
  id: string,
  repoId: string,
): void {
  getDb()
    .prepare(`UPDATE ${table} SET source_tree = ? WHERE id = ?`)
    .run(currentRepoTree(repoId), id);
}
export function validateAnalysisBinding(
  table: 'code_reviews' | 'security_audits',
  id: string,
): void {
  const row = getDb().prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as
    | { repo_id: string; source_tree?: string; scope_ref?: string; scope_type?: string }
    | undefined;
  if (!row) return;
  let valid = Boolean(row.source_tree) && currentRepoTree(row.repo_id) === row.source_tree;
  if (table === 'code_reviews') {
    try {
      const scope = JSON.parse(row.scope_ref ?? '{}');
      const ref =
        scope.toSha ??
        scope.pullRequest?.sourceCommitSha ??
        scope.compareBranch ??
        (row.scope_type === 'pull_request' ? undefined : 'HEAD');
      const repo = getDb().prepare('SELECT path FROM repos WHERE id = ?').get(row.repo_id) as {
        path: string;
      };
      // Diff reviews must identify the actual reviewed target, not just the local checkout.
      valid =
        valid &&
        (row.scope_type === 'full_codebase' ||
          (Boolean(ref) &&
            reviewGit(repo.path, ['rev-parse', '--verify', `${ref}^{tree}`]) === row.source_tree));
    } catch {
      valid = false;
    }
  }
  if (!valid) getDb().prepare(`UPDATE ${table} SET source_tree = NULL WHERE id = ?`).run(id);
}
