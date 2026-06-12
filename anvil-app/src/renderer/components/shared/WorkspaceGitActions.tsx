import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileDiff, GitPullRequest, Loader2 } from 'lucide-react';
import type {
  GitPullRequestCreateResult,
  GitWorkspaceStatus,
  RepoInfo,
} from '../../../shared/types';

interface WorkspaceGitActionsProps {
  repos: RepoInfo[];
  selectedRepoId?: string;
  onPullRequestCreated?: (result: GitPullRequestCreateResult) => void;
  onError?: (message: string) => void;
  compact?: boolean;
}

export function WorkspaceGitActions({
  repos,
  selectedRepoId,
  onPullRequestCreated,
  onError,
  compact = false,
}: WorkspaceGitActionsProps) {
  const repoIds = useMemo(
    () => repos.filter((repo) => repo.status !== 'error').map((repo) => repo.id),
    [repos],
  );
  const [status, setStatus] = useState<GitWorkspaceStatus>({ repos: [], totalFiles: 0 });
  const [loading, setLoading] = useState(false);
  const [creatingPr, setCreatingPr] = useState(false);

  const refresh = useCallback(async () => {
    if (repoIds.length === 0) {
      setStatus({ repos: [], totalFiles: 0 });
      return;
    }

    try {
      const next = await window.anvil.git.workspaceStatus(repoIds);
      setStatus(next);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : 'Failed to read workspace git status.');
    }
  }, [onError, repoIds]);

  useEffect(() => {
    setLoading(true);
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  useEffect(() => {
    const interval = window.setInterval(refresh, 5000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const targetRepo =
    (selectedRepoId ? status.repos.find((repo) => repo.repoId === selectedRepoId) : null) ??
    status.repos[0];

  const handleCreatePr = async () => {
    if (!targetRepo) return;
    setCreatingPr(true);
    try {
      const result = await window.anvil.git.createPullRequest(targetRepo.repoId);
      onPullRequestCreated?.(result);
      await refresh();
    } catch (error) {
      onError?.(error instanceof Error ? error.message : 'Failed to create pull request.');
    } finally {
      setCreatingPr(false);
    }
  };

  if (repoIds.length === 0) return null;

  const dirtyRepoLabel =
    status.repos.length === 0
      ? 'No workspace changes'
      : status.repos.length === 1
        ? `${status.repos[0].fileCount} changed file${status.repos[0].fileCount === 1 ? '' : 's'} in ${status.repos[0].repoName}`
        : `${status.totalFiles} changed files across ${status.repos.length} repos`;

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={refresh}
        className={`relative inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors ${
          status.totalFiles > 0
            ? 'border-warning/30 bg-warning/10 text-warning hover:bg-warning/15'
            : 'border-border text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary'
        }`}
        title={dirtyRepoLabel}
      >
        {loading ? <Loader2 size={13} className="animate-spin" /> : <FileDiff size={13} />}
        {!compact && <span>Diff</span>}
        {status.totalFiles > 0 && (
          <span className="rounded-full bg-bg-primary px-1.5 text-[10px] text-text-primary">
            {status.totalFiles}
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={handleCreatePr}
        disabled={!targetRepo || creatingPr}
        className="inline-flex items-center gap-1.5 rounded-md border border-accent/30 bg-accent/10 px-2 py-1 text-xs font-medium text-accent transition-colors hover:bg-accent/20 disabled:opacity-40"
        title={
          targetRepo
            ? `Commit, push, and open a PR for ${targetRepo.repoName}`
            : 'No workspace changes to turn into a PR'
        }
      >
        {creatingPr ? <Loader2 size={13} className="animate-spin" /> : <GitPullRequest size={13} />}
        {!compact && <span>{creatingPr ? 'Opening...' : 'PR'}</span>}
      </button>
    </div>
  );
}
