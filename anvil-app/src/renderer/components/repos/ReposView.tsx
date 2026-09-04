import { useCallback, useEffect, useState } from 'react';
import { Code } from 'lucide-react';
import type {
  RepoIndexProgress,
  RepoInfo,
  RepoMapRefreshMode,
  RepoMapStatus,
  RepoSummary,
} from '../../../shared/types';
import { RepoList } from './RepoList';
import { RepoDetail } from './RepoDetail';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { RepoScanner } from '../shared/RepoScanner';
import { EmptyState, InlineNotice, ViewHeader } from '../layout/ViewScaffold';

interface IndexProgressState {
  message: string;
  percent: number;
  detail?: string;
  history: string[];
}

export function ReposView() {
  const { repos, addRepos, refreshWorkspaces } = useWorkspace();
  const [selectedRepo, setSelectedRepo] = useState<RepoInfo | null>(null);
  const [summary, setSummary] = useState<RepoSummary | null>(null);
  const [mapStatus, setMapStatus] = useState<RepoMapStatus | null>(null);
  const [indexingRepoIds, setIndexingRepoIds] = useState<Set<string>>(new Set());
  const [indexProgressMap, setIndexProgressMap] = useState<Map<string, IndexProgressState>>(
    new Map(),
  );
  const [error, setError] = useState<string | null>(null);
  const [showConnectModal, setShowConnectModal] = useState(false);
  const [selectedScanPaths, setSelectedScanPaths] = useState<Set<string>>(new Set());
  const [connecting, setConnecting] = useState(false);

  // Listen for indexing progress
  useEffect(() => {
    const cleanup = window.anvil.repo.onIndexProgress((data) => {
      setIndexProgressMap((prev) => updateIndexProgress(prev, data));
      if (data.stage === 'complete' || data.stage === 'error') {
        void refreshWorkspaces();
        if (data.repoId === selectedRepo?.id && data.stage === 'complete') {
          void Promise.all([
            window.anvil.repo.getSummary(data.repoId),
            window.anvil.repo.getMapStatus(data.repoId),
          ]).then(([nextSummary, nextMapStatus]) => {
            setSummary(nextSummary);
            setMapStatus(nextMapStatus);
            setSelectedRepo((prev) =>
              prev?.id === data.repoId ? { ...prev, status: 'indexed' } : prev,
            );
          });
        }
      }
    });
    return cleanup;
  }, [refreshWorkspaces, selectedRepo?.id]);

  // Poll for status updates when a repo is indexing (e.g. user navigated away and back)
  useEffect(() => {
    const indexingRepo = repos.find((r) => r.status === 'indexing' && !indexingRepoIds.has(r.id));
    if (!indexingRepo) return; // skip if we're already tracking it locally

    const interval = setInterval(async () => {
      try {
        const status = await window.anvil.repo.getStatus(indexingRepo.id);
        if (status !== 'indexing') {
          clearInterval(interval);
          await refreshWorkspaces();
          // If this was the selected repo, reload its summary
          if (selectedRepo?.id === indexingRepo.id && status === 'indexed') {
            const [nextSummary, nextMapStatus] = await Promise.all([
              window.anvil.repo.getSummary(indexingRepo.id),
              window.anvil.repo.getMapStatus(indexingRepo.id),
            ]);
            setSummary(nextSummary);
            setMapStatus(nextMapStatus);
            setSelectedRepo((prev) => (prev ? { ...prev, status } : prev));
          }
        }
      } catch {
        // ignore polling errors
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [repos, indexingRepoIds, selectedRepo?.id, refreshWorkspaces]);

  const handleConnectSelected = async () => {
    if (selectedScanPaths.size === 0) return;
    setConnecting(true);
    setError(null);
    try {
      const repoIds: string[] = [];
      for (const p of selectedScanPaths) {
        const repo = await window.anvil.repo.connect(p);
        repoIds.push(repo.id);
      }
      await addRepos(repoIds);
      await refreshWorkspaces();
      setShowConnectModal(false);
      setSelectedScanPaths(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect repos');
    } finally {
      setConnecting(false);
    }
  };

  const handleForceReindex = async (repoId: string) => {
    try {
      setError(null);
      await window.anvil.repo.resetStatus(repoId);
      await refreshWorkspaces();
      await handleIndex(repoId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset repo status');
    }
  };

  const handleIndex = useCallback(
    async (repoId: string) => {
      let completed = false;

      try {
        setError(null);
        setIndexingRepoIds((prev) => new Set(prev).add(repoId));
        setIndexProgressMap((prev) => {
          const next = new Map(prev);
          next.set(repoId, {
            message: 'Starting indexing...',
            percent: 0,
            history: ['Starting indexing...'],
          });
          return next;
        });
        setSelectedRepo((prev) => (prev?.id === repoId ? { ...prev, status: 'indexing' } : prev));

        await window.anvil.repo.index(repoId);
        completed = true;
        await refreshWorkspaces();

        // Reload summary if this is the selected repo
        if (selectedRepo?.id === repoId) {
          const [nextSummary, nextMapStatus] = await Promise.all([
            window.anvil.repo.getSummary(repoId),
            window.anvil.repo.getMapStatus(repoId),
          ]);
          setSummary(nextSummary);
          setMapStatus(nextMapStatus);
          setSelectedRepo((prev) => (prev?.id === repoId ? { ...prev, status: 'indexed' } : prev));
        }
      } catch (err) {
        setSelectedRepo((prev) => (prev?.id === repoId ? { ...prev, status: 'error' } : prev));
        setError(err instanceof Error ? err.message : 'Indexing failed');
      } finally {
        setIndexingRepoIds((prev) => {
          const next = new Set(prev);
          next.delete(repoId);
          return next;
        });
        if (completed) {
          setIndexProgressMap((prev) => {
            const next = new Map(prev);
            next.delete(repoId);
            return next;
          });
        }
        await refreshWorkspaces();
      }
    },
    [refreshWorkspaces, selectedRepo?.id],
  );

  const handleSelect = async (repo: RepoInfo) => {
    // Refresh status in case it changed while we were away
    try {
      const currentStatus = await window.anvil.repo.getStatus(repo.id);
      repo = { ...repo, status: currentStatus };
    } catch {
      // use stale status
    }

    setSelectedRepo(repo);
    setSummary(null);
    setMapStatus(null);
    if (repo.status === 'indexed') {
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

  useEffect(() => {
    if (!selectedRepo) return;

    const workspaceRepo = repos.find((repo) => repo.id === selectedRepo.id);
    if (!workspaceRepo) {
      setSelectedRepo(null);
      setSummary(null);
      setMapStatus(null);
      return;
    }
    if (workspaceRepo.status === selectedRepo.status && workspaceRepo.name === selectedRepo.name) {
      return;
    }

    setSelectedRepo((prev) => (prev ? { ...prev, ...workspaceRepo } : prev));

    if (workspaceRepo.status === 'indexed') {
      void Promise.all([
        window.anvil.repo.getSummary(workspaceRepo.id),
        window.anvil.repo.getMapStatus(workspaceRepo.id),
      ])
        .then(([nextSummary, nextMapStatus]) => {
          setSummary(nextSummary);
          setMapStatus(nextMapStatus);
        })
        .catch((err) => {
          console.error('Failed to refresh summary:', err);
        });
      return;
    }

    setSummary(null);
    setMapStatus(null);
  }, [repos, selectedRepo]);

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

  const selectedIndexProgress = selectedRepo
    ? (indexProgressMap.get(selectedRepo.id) ?? null)
    : null;
  const selectedRepoIsIndexing = selectedRepo
    ? indexingRepoIds.has(selectedRepo.id) || selectedRepo.status === 'indexing'
    : false;

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
            <button
              type="button"
              onClick={() => setShowConnectModal(true)}
              className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent/90"
            >
              Connect repository
            </button>
          }
        />
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
              onSelect={handleSelect}
              onIndex={handleIndex}
              onForceReindex={handleForceReindex}
              indexingRepoIds={indexingRepoIds}
              indexProgressMap={indexProgressMap}
            />
          </div>

          {/* Right panel — repo detail */}
          <div className="min-w-0 flex-1 overflow-auto p-4">
            {selectedRepo ? (
              <RepoDetail
                repo={selectedRepo}
                summary={summary}
                isIndexing={selectedRepoIsIndexing}
                indexProgress={selectedIndexProgress}
                mapStatus={mapStatus}
                onRefreshMap={() => void handleIndex(selectedRepo.id)}
                onMapRefreshModeChange={(mode) => void handleMapRefreshModeChange(mode)}
              />
            ) : (
              <EmptyState
                icon={Code}
                title={repos.length === 0 ? 'Connect a repository' : 'Choose a repository'}
                description={
                  repos.length === 0
                    ? 'Connect a local Git repository to index its code.'
                    : 'Select a repository to inspect its structure and index.'
                }
              />
            )}
          </div>
        </div>
      </div>

      {showConnectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-xl rounded-xl border border-border bg-bg-secondary p-6 shadow-2xl">
            <h2 className="text-lg font-semibold text-text-primary">Connect repositories</h2>
            <p className="mt-1 text-sm text-text-secondary">
              Select a folder to scan for Git repositories.
            </p>
            <div className="mt-4">
              <RepoScanner onSelectionChange={setSelectedScanPaths} />
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowConnectModal(false);
                  setSelectedScanPaths(new Set());
                }}
                className="rounded-md border border-border px-4 py-2 text-sm text-text-secondary hover:bg-bg-tertiary"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConnectSelected}
                disabled={selectedScanPaths.size === 0 || connecting}
                className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
              >
                {connecting
                  ? 'Connecting...'
                  : `Connect ${selectedScanPaths.size} ${selectedScanPaths.size === 1 ? 'repository' : 'repositories'}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function updateIndexProgress(
  previous: Map<string, IndexProgressState>,
  data: RepoIndexProgress,
): Map<string, IndexProgressState> {
  const next = new Map(previous);
  const current = next.get(data.repoId);
  const historyEntry = data.detail ? `${data.message} ${data.detail}` : data.message;
  const previousHistory = current?.history ?? [];
  const history =
    previousHistory[previousHistory.length - 1] === historyEntry
      ? previousHistory
      : [...previousHistory, historyEntry].slice(-6);

  next.set(data.repoId, {
    message: data.message,
    percent: data.percent,
    detail: data.detail,
    history,
  });

  return next;
}
