import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
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
import { ViewTabs } from '../library/ViewTabs';
import { RepoHealthPanel } from './RepoHealthPanel';
import { RepoSetupPanel } from './RepoSetupPanel';
import { HEALTH_HINT_LABELS, REPO_SECTIONS, resolveRepoSection } from './repo-sections';
import { repoDetailPath, type RepoDetailSection } from '../../utils/sidebar-navigation';

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
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const {
    repoId: routeRepoId,
    section: routeSection,
    tab: routeTab,
  } = useParams<{ repoId?: string; section?: string; tab?: string }>();
  const selectedRepoId = routeRepoId ?? searchParams.get('repo');
  const { section, tab, hint } = resolveRepoSection(routeSection, routeTab, searchParams);
  const selectionRequestId = useRef(0);
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
      window.mezair.repo.getSummary(selectedRepo.id),
      window.mezair.repo.getMapStatus(selectedRepo.id),
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

  const handleSelect = useCallback(async (repo: RepoInfo) => {
    const requestId = ++selectionRequestId.current;
    setSelectedRepo(repo);
    setSummary(null);
    setMapStatus(null);
    if (repoIsMapped(repo)) {
      try {
        const [nextSummary, nextMapStatus] = await Promise.all([
          window.mezair.repo.getSummary(repo.id),
          window.mezair.repo.getMapStatus(repo.id),
        ]);
        if (requestId !== selectionRequestId.current) return;
        setSummary(nextSummary);
        setMapStatus(nextMapStatus);
      } catch (err) {
        if (requestId === selectionRequestId.current) {
          console.error('Failed to load summary:', err);
        }
      }
    }
  }, []);

  const handleRepoSelection = (repo: RepoInfo) => {
    if (selectedRepoId === repo.id) return;
    // Keep the open section (or the redirect hint) when switching repos.
    if (section !== 'overview') {
      navigate(repoDetailPath(repo.id, section, tab));
      return;
    }
    if (hint) {
      navigate(repoDetailPath(repo.id, hint.section, hint.tab));
      return;
    }
    const next = new URLSearchParams(searchParams);
    next.set('repo', repo.id);
    setSearchParams(next);
  };

  const selectSection = (next: RepoDetailSection) => {
    if (!selectedRepo || next === section) return;
    navigate(repoDetailPath(selectedRepo.id, next, tab));
  };

  // Keep selection in the URL so Activity links, refreshes, and browser
  // back/forward all open the same repository detail.
  useEffect(() => {
    if (!selectedRepoId) {
      selectionRequestId.current += 1;
      if (selectedRepo) {
        setSelectedRepo(null);
        setSummary(null);
        setMapStatus(null);
      }
      return;
    }
    const repo = repos.find((item) => item.id === selectedRepoId);
    if (repo && selectedRepo?.id !== repo.id) void handleSelect(repo);
    if (!repo && selectedRepo?.id !== selectedRepoId && selectedRepo) {
      selectionRequestId.current += 1;
      setSelectedRepo(null);
      setSummary(null);
      setMapStatus(null);
    }
  }, [handleSelect, repos, selectedRepo, selectedRepoId]);

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
        const nextStatus = await window.mezair.repo.getMapStatus(repoId);
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
      const nextStatus = await window.mezair.repo.setMapRefreshMode(selectedRepo.id, refreshMode);
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
              onSelect={handleRepoSelection}
            />
          </div>

          {/* Right panel — repo detail: Overview | Health | Setup (spec §12). */}
          <div className="flex min-w-0 flex-1 flex-col">
            {selectedRepo ? (
              <>
                <div className="flex shrink-0 items-center gap-4 border-b border-border-subtle px-4">
                  <span
                    className="max-w-[40%] truncate py-2 text-sm font-semibold text-text-primary"
                    title={selectedRepo.path}
                  >
                    {selectedRepo.name}
                  </span>
                  <ViewTabs
                    tabs={REPO_SECTIONS}
                    value={section}
                    onChange={selectSection}
                    label={`${selectedRepo.name} sections`}
                    idPrefix="repo-section-tab"
                    size="sm"
                  />
                </div>
                <div
                  role="tabpanel"
                  aria-labelledby={`repo-section-tab-${section}`}
                  className="flex min-h-0 flex-1 flex-col"
                >
                  {section === 'health' ? (
                    <RepoHealthPanel key={selectedRepo.id} repo={selectedRepo} tab={tab} />
                  ) : section === 'setup' ? (
                    <RepoSetupPanel key={selectedRepo.id} repo={selectedRepo} />
                  ) : (
                    <div className="min-h-0 flex-1 overflow-auto p-4">
                      <RepoDetail
                        repo={selectedRepo}
                        summary={summary}
                        mapStatus={mapStatus}
                        onRefreshMap={() => void repoIndex.startIndex(selectedRepo.id)}
                        onMapRefreshModeChange={(mode) => void handleMapRefreshModeChange(mode)}
                      />
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto p-4">
                <EmptyState
                  icon={Code}
                  title={repos.length === 0 ? 'Add a repository' : 'Choose a repository'}
                  description={
                    repos.length === 0
                      ? 'Connect a local folder, clone a remote repo, or scaffold a fresh project — Mezair indexes it in the background.'
                      : hint?.section === 'setup'
                        ? 'Select a repository to set it up for agents: AGENTS.md, devcontainer, and environment checks.'
                        : hint?.section === 'health'
                          ? `Select a repository to see its ${HEALTH_HINT_LABELS[hint.tab ?? 'security']}.`
                          : 'Select a repository to inspect its structure, health, and setup.'
                  }
                />
              </div>
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
