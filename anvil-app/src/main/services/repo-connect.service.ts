import type { RepoInfo } from '../../shared/types.js';
import { getDb } from '../db/database.js';
import { isGitRepo, getRepoMetadata } from './git.service.js';

export async function connectRepoPath(repoPath: string): Promise<RepoInfo> {
  if (!isGitRepo(repoPath)) {
    throw new Error(`Not a Git repository: ${repoPath}`);
  }

  const metadata = await getRepoMetadata(repoPath);
  const db = getDb();

  db.prepare(
    `
    INSERT OR REPLACE INTO repos (id, name, path, remote_url, default_branch, status, file_count, branch_count, last_commit_message, last_commit_date, updated_at)
    VALUES (?, ?, ?, ?, ?, 'connected', ?, ?, ?, ?, datetime('now'))
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

  return { ...metadata, status: 'connected' };
}
