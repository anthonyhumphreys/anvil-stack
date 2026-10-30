import type { RepoInfo } from '../../shared/types.js';
import { getDb } from '../db/database.js';
import { isGitRepo, getRepoMetadata } from './git.service.js';

export async function connectRepoPath(repoPath: string): Promise<RepoInfo> {
  if (!isGitRepo(repoPath)) {
    throw new Error(`Not a Git repository: ${repoPath}`);
  }

  const metadata = await getRepoMetadata(repoPath);
  const db = getDb();

  // Upsert rather than INSERT OR REPLACE: REPLACE deletes the row, which
  // cascades repo_index_jobs/repository_map_graphs and violates the
  // module_summaries/repo_summaries FKs. Existing status/index_tier is kept.
  db.prepare(
    `
    INSERT INTO repos (id, name, path, remote_url, default_branch, status, file_count, branch_count, last_commit_message, last_commit_date, updated_at)
    VALUES (?, ?, ?, ?, ?, 'connected', ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      path = excluded.path,
      remote_url = excluded.remote_url,
      default_branch = excluded.default_branch,
      file_count = excluded.file_count,
      branch_count = excluded.branch_count,
      last_commit_message = excluded.last_commit_message,
      last_commit_date = excluded.last_commit_date,
      updated_at = excluded.updated_at
  `,
  ).run(
    metadata.id,
    metadata.name,
    metadata.path,
    metadata.remoteUrl ?? null,
    metadata.defaultBranch,
    metadata.fileCount,
    metadata.branchCount,
    metadata.lastCommitMessage ?? null,
    metadata.lastCommitDate ?? null,
  );

  const stored = db.prepare('SELECT status FROM repos WHERE id = ?').get(metadata.id) as
    | { status: RepoInfo['status'] }
    | undefined;
  return { ...metadata, status: stored?.status ?? 'connected' };
}
