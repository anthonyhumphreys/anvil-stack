import { useEffect, useState } from 'react';
import { Code, Plus } from 'lucide-react';
import type {
  RepoInfo,
  RepoMapRefreshMode,
  RepoMapStatus,
  RepoSummary,
} from '../../../shared/types';
import { RepoList } from './RepoList';
import { RepoDetail } from './RepoDetail';
import { useWorkspace, repoIsMapped } from '../../contexts/WorkspaceContext';
import { useRepoIndex } from '../../contexts/RepoIndexContext';
import { AddRepositoriesDialog } from '../shared/AddRepositoriesDialog';
import { WorkspaceReadinessStrip } from '../workspace/WorkspaceReadinessStrip';
import { Button } from '../ui';
import { EmptyState, InlineNotice, ViewHeader } from '../layout/ViewScaffold';

/**
 * Repository management surface — mounted under `/workspace` (as the
 * repositories section) and kept on `/repos` for compatibility (WS2).
 *
 * Indexing state comes from `RepoIndexContext` (1.3): no local polling, no
 * `indexingRepoIds`, no `indexProgressMap`, no Force Re-index.
 */
export function ReposView() {
  const { repos, refreshWorkspaces } = useWorkspace();
  const repoIndex = useRepoIndex();
  const [selectedRepo, setSelectedRepo] = useState<RepoInfo | null>(null);
  const [summary, setSummary] = useState<RepoSummary | null>(null);
  const [mapStatus, setMapStatus] = useState<RepoMapStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false);

  // Refresh summary/mapStatus when a job for the selected repo settles.
  useEffect(() => {
    if (!selectedRepo || !repoIsMapped(selectedRepo)) return;
    let cancelled = false;
    void Promise.all([
      window.anvil.repo.getSummary(selectedRepo.id),
      window.anvil.repo.getMapStatus(selectedRepo.id),
    ])
      .then(([nextSummary, nextMapStatus]) => {
        if (cancelled) return;
        setSummary(nextSummary);
        setMapStatus(nextMapStatus);
      })
      .catch((err) => {
        if (!cancelled) console.error('Failed to refresh summary:', err);
      });
    return () => {
      cancelled = true;
    };
    // settledJobsVersion bumps when a job reaches a terminal state.
  }, [repoIndex.settledJobsVersion, selectedRepo]);

  const handleSelect = async (repo: RepoInfo) => {
    setSelectedRepo(repo);
    setSummary(null);
    setMapStatus(null);
    if (repoIsMapped(repo)) {
      try {
        const [nextSummary, nextMapStatus] = await Promise.all([
          window.anvil.repo.getSummary(repo.id),
          window.anvil.repo.getMapStatus(repo.id),
        ]);
        setSummary(nextSummary);
        setMapStatus(nextMapStatus);
      } catch (err) {
        console.error('Failed to load summary:', err);
      }
    }
  };

  // Drop the detail panel when the selected repo leaves the workspace, and
  // keep it in sync with refreshed RepoInfo (e.g. indexTier updates).
  useEffect(() => {
    if (!selectedRepo) return;

    const workspaceRepo = repos.find((repo) => repo.id === selectedRepo.id);
    if (!workspaceRepo) {
      setSelectedRepo(null);
      setSummary(null);
      setMapStatus(null);
      return;
    }
    if (
      workspaceRepo.status === selectedRepo.status &&
      workspaceRepo.name === selectedRepo.name &&
      workspaceRepo.indexTier === selectedRepo.indexTier
    ) {
      return;
    }

    setSelectedRepo((prev) => (prev ? { ...prev, ...workspaceRepo } : prev));

    if (!repoIsMapped(workspaceRepo)) {
      setSummary(null);
      setMapStatus(null);
    }
  }, [repos, selectedRepo]);

  // On-commit map freshness check — re-polls mapStatus while the detail panel
  // shows an on_commit policy so the "changes since map" hint stays current.
  useEffect(() => {
    const repoId = selectedRepo?.id;
    if (!repoId || mapStatus?.refreshMode !== 'on_commit') return;

    let cancelled = false;
    const checkForCommit = async () => {
      try {
        const nextStatus = await window.anvil.repo.getMapStatus(repoId);
        if (cancelled) return;
        setMapStatus(nextStatus);
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to check repository map freshness:', err);
        }
      }
    };

    void checkForCommit();
    const interval = window.setInterval(checkForCommit, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [mapStatus?.refreshMode, selectedRepo?.id]);

  const handleMapRefreshModeChange = async (refreshMode: RepoMapRefreshMode) => {
    if (!selectedRepo) return;
    try {
      setError(null);
      const nextStatus = await window.anvil.repo.setMapRefreshMode(selectedRepo.id, refreshMode);
      setMapStatus(nextStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update the map refresh policy');
    }
  };

  return (
    <>
      <div className="flex h-full min-h-0 flex-col">
        <ViewHeader
          icon={Code}
          title="Repositories"
          meta={
            <span className="rounded-md bg-bg-tertiary px-2 py-0.5 text-xs tabular-nums text-text-tertiary">
              {repos.length}
            </span>
          }
          actions={
            <Button variant="primary" size="sm" onClick={() => setShowAddDialog(true)}>
              <Plus size={14} aria-hidden="true" />
              Add repositories
            </Button>
          }
        />

        {/* 1.4: persistent readiness strip — tier dots, combined progress,
            Stop/Retry, expandable history. Mounted under the header. */}
        <WorkspaceReadinessStrip />

        <div className="flex min-h-0 flex-1">
          {/* Left panel — repo list */}
          <div className="w-72 shrink-0 overflow-auto border-r border-border-subtle bg-bg-secondary/35 p-3">
            {error && (
              <InlineNotice tone="error" className="mb-3">
                {error}
              </InlineNotice>
            )}

            <RepoList
              repos={repos}
              selectedRepoId={selectedRepo?.id ?? null}
              onSelect={(repo) => void handleSelect(repo)}
            />
          </div>

          {/* Right panel — repo detail */}
          <div className="min-w-0 flex-1 overflow-auto p-4">
            {selectedRepo ? (
              <RepoDetail
                repo={selectedRepo}
                summary={summary}
                mapStatus={mapStatus}
                onRefreshMap={() => void repoIndex.startIndex(selectedRepo.id)}
                onMapRefreshModeChange={(mode) => void handleMapRefreshModeChange(mode)}
              />
            ) : (
              <EmptyState
                icon={Code}
                title={repos.length === 0 ? 'Add a repository' : 'Choose a repository'}
                description={
                  repos.length === 0
                    ? 'Connect a local folder, clone a remote repo, or scaffold a fresh project — Anvil indexes it in the background.'
                    : 'Select a repository to inspect its structure and index.'
                }
              />
            )}
          </div>
        </div>
      </div>

      <AddRepositoriesDialog
        open={showAddDialog}
        onClose={() => setShowAddDialog(false)}
        onReposAdded={() => void refreshWorkspaces()}
      />
    </>
  );
}
