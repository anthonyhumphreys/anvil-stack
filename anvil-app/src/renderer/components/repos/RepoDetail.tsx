import type {
  RepoInfo,
  RepoMapRefreshMode,
  RepositoryMapGraph,
  RepoMapStatus,
  RepoSummary,
} from '../../../shared/types';
import { useEffect, useState } from 'react';
import { RepositoryMap } from './RepositoryMap';
import { ModuleSummaryCard } from './ModuleSummary';
import {
  GitBranch,
  Clock,
  FileCode,
  Tag,
  Shield,
  GitFork,
  ExternalLink,
  AlertTriangle,
  RefreshCw,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { buildEditorUrl } from '../../utils/editor-link';

interface RepoDetailProps {
  repo: RepoInfo;
  summary: RepoSummary | null;
  isIndexing: boolean;
  indexProgress: {
    message: string;
    percent: number;
    detail?: string;
    history: string[];
  } | null;
  mapStatus: RepoMapStatus | null;
  onRefreshMap: () => void;
  onMapRefreshModeChange: (mode: RepoMapRefreshMode) => void;
}

export function RepoDetail({
  repo,
  summary,
  isIndexing,
  indexProgress,
  mapStatus,
  onRefreshMap,
  onMapRefreshModeChange,
}: RepoDetailProps) {
  const navigate = useNavigate();
  const { activeWorkspace } = useWorkspace();
  const indexMode = summary?.indexMode ?? repo.indexMode;
  const indexWarnings = summary?.indexWarnings ?? repo.indexWarnings ?? [];
  const showDeepBadge = indexMode === 'deep';
  const showIndexWarnings = indexWarnings.length > 0;
  const [mapGraph, setMapGraph] = useState<RepositoryMapGraph | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMapGraph(null);
    window.anvil.repo
      .getMapGraph(repo.id)
      .then((graph) => {
        if (!cancelled) setMapGraph(graph);
      })
      .catch((error) => {
        if (!cancelled) {
          setMapGraph(null);
          console.error('Failed to load repository map graph:', error);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [mapStatus?.generatedAt, repo.id]);

  if (!summary && !isIndexing) {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center px-6 text-center">
        <FileCode size={24} className="text-text-muted" />
        <h2 className="mt-3 text-sm font-semibold text-text-primary">Index {repo.name}</h2>
        <p className="mt-1 max-w-sm text-sm text-text-tertiary">
          Map its structure, symbols, and dependencies.
        </p>
        <button
          type="button"
          onClick={onRefreshMap}
          className="mt-4 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90"
        >
          Index repository
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {(isIndexing || (repo.status === 'error' && indexProgress)) && (
        <IndexingProgressPanel
          title={isIndexing ? 'Indexing repository...' : 'Last indexing attempt failed'}
          progress={indexProgress}
        />
      )}

      {/* Header */}
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-text-primary">{repo.name}</h2>
        <p className="mt-1 truncate font-mono text-xs text-text-tertiary" title={repo.path}>
          {repo.path}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-text-secondary">
          <span className="flex items-center gap-1">
            <FileCode size={14} /> {repo.fileCount} files
          </span>
          <span className="flex items-center gap-1">
            <GitBranch size={14} /> {repo.branchCount} branches
          </span>
          {repo.lastCommitDate && (
            <span className="flex items-center gap-1">
              <Clock size={14} /> Last commit: {new Date(repo.lastCommitDate).toLocaleDateString()}
            </span>
          )}
          {showDeepBadge && (
            <span className="rounded-full bg-success/15 px-2 py-0.5 text-sm font-medium text-success">
              Deep index
            </span>
          )}
        </div>

        {/* Framework badges */}
        {summary?.frameworks.length ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {summary.frameworks.map((fw) => (
              <span
                key={fw}
                className="flex items-center gap-1 rounded-md bg-bg-elevated px-2.5 py-1 text-sm text-text-secondary"
              >
                <Tag size={12} className="text-accent" />
                {fw}
              </span>
            ))}
          </div>
        ) : null}

        {/* Quick actions */}
        <div className="mt-3 flex gap-2">
          <button
            onClick={() =>
              navigate(
                buildEditorUrl({
                  workspaceId: activeWorkspace?.id,
                  repoId: repo.id,
                  repoName: repo.name,
                  source: 'repos',
                  title: `${repo.name} repository`,
                }),
              )
            }
            className="flex items-center gap-2 rounded-lg border border-info/30 bg-info/10 px-3.5 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-info/15"
          >
            <FileCode size={16} className="text-info" />
            Open in editor
          </button>
          <button
            onClick={() => window.anvil.repo.openInVSCode(repo.path)}
            className="flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/10 px-3.5 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-accent/15"
          >
            <ExternalLink size={16} className="text-accent" />
            Open in VS Code
          </button>
          <button
            onClick={() => navigate(`/security/${repo.id}`)}
            className="flex items-center gap-2 rounded-lg border border-error/30 bg-error/10 px-3.5 py-2 text-sm font-medium text-text-primary transition-colors hover:bg-error/15"
          >
            <Shield size={16} className="text-error" />
            Security audit
          </button>
          <button
            onClick={() => navigate(`/diagrams/${repo.id}`)}
            className="flex items-center gap-2 rounded-lg border border-border px-3.5 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
          >
            <GitFork size={15} /> Diagrams
          </button>
        </div>
      </div>

      {!summary ? (
        <div className="rounded-lg border border-border-subtle bg-bg-secondary p-8 text-center">
          <p className="text-sm text-text-secondary">
            {isIndexing
              ? 'Indexing is in progress. Progress details will appear here shortly.'
              : 'No repository summary is available yet.'}
          </p>
        </div>
      ) : (
        <>
          {showIndexWarnings && (
            <section className="rounded-lg border border-warning/30 bg-warning/10 p-4">
              <div className="flex items-start gap-3">
                <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />
                <div>
                  <h3 className="text-sm font-semibold text-text-primary">Indexing note</h3>
                  <div className="mt-2 space-y-1 text-sm text-text-secondary">
                    {indexWarnings.map((warning) => (
                      <p key={warning}>{warning}</p>
                    ))}
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* Overview */}
          <section className="border-b border-border-subtle pb-5">
            <h3 className="mb-2 text-sm font-semibold text-text-primary">Overview</h3>
            <p className="whitespace-pre-line text-base leading-relaxed text-text-secondary">
              {summary.overview}
            </p>
          </section>

          {/* Repository map */}
          <section>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-text-primary">Architecture</h3>
                <p className="mt-0.5 text-xs text-text-tertiary">
                  {mapStatus?.stale
                    ? 'A newer commit is available than the map below.'
                    : mapStatus?.generatedAt
                      ? `Mapped ${formatRelativeDate(mapStatus.generatedAt)}`
                      : 'Built from the latest repository index.'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <div
                  className="flex rounded-lg border border-border bg-bg-primary p-0.5"
                  role="group"
                  aria-label="Repository map refresh policy"
                >
                  <button
                    type="button"
                    onClick={() => onMapRefreshModeChange('manual')}
                    aria-pressed={mapStatus?.refreshMode !== 'on_commit'}
                    title="Refresh this repository map only when you ask"
                    className={`rounded-md px-2.5 py-1.5 text-xs transition-colors ${
                      mapStatus?.refreshMode !== 'on_commit'
                        ? 'bg-bg-elevated text-text-primary'
                        : 'text-text-tertiary hover:text-text-primary'
                    }`}
                  >
                    Manual
                  </button>
                  <button
                    type="button"
                    onClick={() => onMapRefreshModeChange('on_commit')}
                    aria-pressed={mapStatus?.refreshMode === 'on_commit'}
                    title="Automatically re-index this repository when its HEAD commit changes"
                    className={`rounded-md px-2.5 py-1.5 text-xs transition-colors ${
                      mapStatus?.refreshMode === 'on_commit'
                        ? 'bg-bg-elevated text-text-primary'
                        : 'text-text-tertiary hover:text-text-primary'
                    }`}
                  >
                    On commit
                  </button>
                </div>
                <button
                  type="button"
                  onClick={onRefreshMap}
                  disabled={isIndexing}
                  className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:cursor-wait disabled:opacity-50"
                >
                  <RefreshCw size={13} className={isIndexing ? 'animate-spin' : ''} />
                  {isIndexing ? 'Refreshing' : 'Refresh map'}
                </button>
              </div>
            </div>
            <RepositoryMap
              key={repo.id}
              repoId={repo.id}
              repositoryName={repo.name}
              modules={summary.modules}
              graph={mapGraph}
            />
          </section>

          {/* Detected Patterns */}
          {summary.patterns.length > 0 && (
            <section>
              <h3 className="mb-2 text-sm font-semibold text-text-primary">Detected patterns</h3>
              <div className="flex flex-wrap gap-1.5">
                {summary.patterns.map((p) => (
                  <span
                    key={p}
                    className="rounded-md bg-bg-elevated px-2.5 py-1 text-sm text-text-secondary"
                  >
                    {p}
                  </span>
                ))}
              </div>
            </section>
          )}

          {/* Modules */}
          <section>
            <h3 className="mb-2 text-base font-semibold text-text-primary">
              Modules{' '}
              <span className="font-normal text-text-tertiary">{summary.modules.length}</span>
            </h3>
            <div className="space-y-1.5">
              {summary.modules.map((mod) => (
                <ModuleSummaryCard key={mod.path} module={mod} />
              ))}
            </div>
          </section>

          {/* Entry Points */}
          {summary.entryPoints.length > 0 && (
            <section>
              <h3 className="mb-2 text-base font-semibold text-text-primary">Key entry points</h3>
              <div className="space-y-0.5">
                {summary.entryPoints.map((ep) => (
                  <p key={ep} className="font-mono text-sm text-text-secondary">
                    {ep}
                  </p>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function formatRelativeDate(value: string): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return 'from the last index';
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(value).toLocaleDateString();
}

function IndexingProgressPanel({
  title,
  progress,
}: {
  title: string;
  progress: {
    message: string;
    percent: number;
    detail?: string;
    history: string[];
  } | null;
}) {
  return (
    <section className="rounded-lg border border-info/20 bg-info/5 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-text-primary">{title}</h3>
          <p className="mt-1 text-sm text-text-secondary">
            {progress?.message ?? 'Waiting for indexing progress updates...'}
          </p>
        </div>
        <span className="text-sm tabular-nums text-text-secondary">{progress?.percent ?? 0}%</span>
      </div>

      {progress?.detail && <p className="mt-2 text-sm text-text-secondary">{progress.detail}</p>}

      <div className="mt-3 h-2 overflow-hidden rounded-full bg-bg-elevated">
        <div
          className="h-full rounded-full bg-info transition-all duration-300"
          style={{ width: `${Math.max(4, progress?.percent ?? 0)}%` }}
        />
      </div>

      {progress && progress.history.length > 0 && (
        <div className="mt-4">
          <h4 className="text-sm font-semibold uppercase tracking-wide text-text-tertiary">
            Recent activity
          </h4>
          <div className="mt-2 space-y-1 text-sm text-text-secondary">
            {progress.history.map((entry) => (
              <p key={entry}>{entry}</p>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
