import { execFileSync } from 'node:child_process';

/** Remote work starts from commits, never an implicit copy of the coordinator's files. */
export function assertWorkflowSourceSnapshot(
  repositories: Array<{ repositoryId: string; commit: string; path: string | undefined }>,
): void {
  for (const repository of repositories) {
    const remedy =
      'Commit the files you want to send and start a new run, or keep this step local.';
    if (!repository.path)
      throw new Error(
        `Remote step has no source checkout for ${repository.repositoryId}. ${remedy}`,
      );
    let head: string;
    let status: string;
    try {
      const options = {
        cwd: repository.path,
        encoding: 'utf8' as const,
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      };
      head = execFileSync('git', ['rev-parse', 'HEAD'], options).trim();
      status = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], options);
    } catch {
      throw new Error(
        `Could not verify the source checkout for ${repository.repositoryId}. ${remedy}`,
      );
    }
    if (head !== repository.commit || status.trim())
      throw new Error(
        `Remote step uses the run's saved commit, but ${repository.repositoryId} has changed locally. ${remedy}`,
      );
  }
}
