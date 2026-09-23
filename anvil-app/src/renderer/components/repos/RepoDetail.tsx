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
  GitFork,
  ExternalLink,
  AlertTriangle,
  RefreshCw,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Square,
  SquareTerminal,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useWorkspace, repoIsMapped } from '../../contexts/WorkspaceContext';
import { useRepoIndex } from '../../contexts/RepoIndexContext';
import { buildEditorUrl } from '../../utils/editor-link';
import { Button, IconButton, Menu, MenuItem, MenuSeparator, cx } from '../ui';
import { RemoveRepoDialog } from './RemoveRepoDialog';
import { RepoReadinessChecklist } from './RepoReadinessChecklist';

interface RepoDetailProps {
  repo: RepoInfo;
  summary: RepoSummary | null;
  mapStatus: RepoMapStatus | null;
  onRefreshMap: () => void;
  onMapRefreshModeChange: (mode: RepoMapRefreshMode) => void;
}

export function RepoDetail({
  repo,
  summary,
  mapStatus,
  onRefreshMap,
  onMapRefreshModeChange,
}: RepoDetailProps) {
  const navigate = useNavigate();
  const { activeWorkspace } = useWorkspace();
  const repoIndex = useRepoIndex();
  const indexMode = summary?.indexMode ?? repo.indexMode;
  const indexWarnings = summary?.indexWarnings ?? repo.indexWarnings ?? [];
  const showDeepBadge = indexMode === 'deep';
  const showIndexWarnings = indexWarnings.length > 0;
  const [mapGraph, setMapGraph] = useState<RepositoryMapGraph | null>(null);
  const [showRemove, setShowRemove] = useState(false);

  // Index state from RepoIndexContext (1.3) — no props needed.
  const activeJob = repoIndex.activeJobForRepo(repo.id);
  const lastError = repoIndex.lastErrorForRepo(repo.id);
  const progress = repoIndex.progressByRepoId.get(repo.id) ?? null;
  const isIndexing = activeJob !== null;
  const mapped = repoIsMapped(repo);
  const enriched = repo.indexTier === 'enriched' || repo.status === 'indexed';

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

  const openEditor = () =>
    navigate(
      buildEditorUrl({
        workspaceId: activeWorkspace?.id,
        repoId: repo.id,
        repoName: repo.name,
        source: 'repos',
        title: `${repo.name} repository`,
      }),
    );

  // RM3: repo-scoped Chat entry. Uses the existing `?prompt=` prefill the
  // ChatView already consumes. TODO(chat-agent): a `?repos=<id>` param that
  // pins the thread's repo scope would complete this — flag for integration.
  const askInChat = () =>
    navigate(
      `/chat?prompt=${encodeURIComponent(`Using the ${repo.name} repository (${repo.path}): `)}`,
    );

  if (!summary && !isIndexing) {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center px-6 text-center">
        <FileCode size={24} className="text-text-muted" />
        <h2 className="mt-3 text-sm font-semibold text-text-primary">Index {repo.name}</h2>
        <p className="mt-1 max-w-sm text-sm text-text-tertiary">
          Map its structure, symbols, and dependencies. Summaries run afterwards in the background.
        </p>
        {lastError && (
          <p className="mt-3 max-w-sm text-sm text-error">Last attempt failed: {lastError.error}</p>
        )}
        <div className="mt-4 flex items-center gap-2">
          <Button variant="primary" size="sm" onClick={onRefreshMap}>
            {lastError ? 'Retry indexing' : 'Index repository'}
          </Button>
          <Button variant="secondary" size="sm" onClick={askInChat}>
            <MessageSquare size={14} aria-hidden="true" /> Ask in Chat
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {isIndexing && (
        <IndexingProgressPanel
          title={activeJob.tier === 'enriched' ? 'Summarising repository…' : 'Mapping repository…'}
          message={progress?.message ?? activeJob.message}
          detail={progress?.detail}
          percent={progress?.percent ?? activeJob.progress}
          onStop={() => void repoIndex.cancelIndex(repo.id)}
        />
      )}
      {!isIndexing && lastError && (
        <section className="rounded-lg border border-error/25 bg-error/5 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-error" aria-hidden="true" />
              <div>
                <h3 className="text-sm font-semibold text-text-primary">
                  Last indexing attempt failed
                </h3>
                <p className="mt-1 text-sm text-text-secondary">{lastError.error}</p>
              </div>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void repoIndex.retryIndex(repo.id)}
            >
              Retry
            </Button>
          </div>
        </section>
      )}

      {/* Header */}
      <div>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-xl font-semibold tracking-tight text-text-primary">{repo.name}</h2>
            <p className="mt-1 truncate font-mono text-xs text-text-tertiary" title={repo.path}>
              {repo.path}
            </p>
          </div>

          {/* X1: overflow menu — matches the repo card menu */}
          <Menu
            label={`${repo.name} actions`}
            trigger={(props) => (
              <IconButton {...props} icon={MoreHorizontal} label={`${repo.name} actions`} />
            )}
          >
            <MenuItem icon={<SquareTerminal size={14} />} onSelect={openEditor}>
              Open in editor
            </MenuItem>
            <MenuItem
              icon={<ExternalLink size={14} />}
              onSelect={() => void window.anvil.repo.openInVSCode(repo.path)}
            >
              Open in VS Code
            </MenuItem>
            <MenuItem icon={<RefreshCw size={14} />} disabled={isIndexing} onSelect={onRefreshMap}>
              Re-index
            </MenuItem>
            {isIndexing && (
              <MenuItem
                icon={<Square size={14} />}
                onSelect={() => void repoIndex.cancelIndex(repo.id)}
              >
                Stop indexing
              </MenuItem>
            )}
            <MenuSeparator />
            <MenuItem destructive onSelect={() => setShowRemove(true)}>
              Remove from workspace…
            </MenuItem>
          </Menu>
        </div>

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

        {/* RM3: primary Ask in Chat + neutral secondary actions.
            The misleading red "Security audit" affordance is gone. */}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="primary" size="sm" onClick={askInChat}>
            <MessageSquare size={14} aria-hidden="true" />
            Ask in Chat
          </Button>
          <Button variant="secondary" size="sm" onClick={openEditor}>
            <FileCode size={14} aria-hidden="true" />
            Open in editor
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void window.anvil.repo.openInVSCode(repo.path)}
          >
            <ExternalLink size={14} aria-hidden="true" />
            Open in VS Code
          </Button>
          <Button variant="secondary" size="sm" onClick={() => navigate(`/diagrams/${repo.id}`)}>
            <GitFork size={14} aria-hidden="true" />
            Diagrams
          </Button>
        </div>
      </div>

      {/* OB2: per-repo readiness checklist (AGENTS.md, devcontainer, env). */}
      {mapped && <RepoReadinessChecklist repo={repo} />}

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
                    title="When the HEAD commit changes, refresh the structure map and queue incremental enrichment"
                    className={`rounded-md px-2.5 py-1.5 text-xs transition-colors ${
                      mapStatus?.refreshMode === 'on_commit'
                        ? 'bg-bg-elevated text-text-primary'
                        : 'text-text-tertiary hover:text-text-primary'
                    }`}
                  >
                    On commit
                  </button>
                </div>
                {/* RM4: tier-aware labels. `repo:index` is a full refresh —
                    mapped + enriched — so the label and caption stay honest. */}
                <button
                  type="button"
                  onClick={onRefreshMap}
                  disabled={isIndexing}
                  title={
                    enriched
                      ? `Rebuilds the structure map and re-summarises ${summary.modules.length} modules — typically a few minutes`
                      : 'Rebuilds the structure map and refreshes summaries'
                  }
                  className={cx(
                    'flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs text-text-secondary transition-colors',
                    'hover:bg-bg-tertiary hover:text-text-primary disabled:cursor-wait disabled:opacity-50',
                  )}
                >
                  <RefreshCw size={13} className={isIndexing ? 'animate-spin' : ''} />
                  {isIndexing ? 'Refreshing' : enriched ? 'Re-summarise' : 'Refresh structure'}
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

      <RemoveRepoDialog repo={repo} open={showRemove} onClose={() => setShowRemove(false)} />
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
  message,
  detail,
  percent,
  onStop,
}: {
  title: string;
  message: string;
  detail?: string;
  percent: number;
  onStop: () => void;
}) {
  return (
    <section className="rounded-lg border border-info/20 bg-info/5 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Loader2 size={15} className="shrink-0 animate-spin text-info" aria-hidden="true" />
          <div>
            <h3 className="text-base font-semibold text-text-primary">{title}</h3>
            <p className="mt-1 text-sm text-text-secondary">{message}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm tabular-nums text-text-secondary">{percent}%</span>
          <Button variant="secondary" size="sm" onClick={onStop}>
            <Square size={12} aria-hidden="true" /> Stop
          </Button>
        </div>
      </div>

      {detail && <p className="mt-2 text-sm text-text-secondary">{detail}</p>}

      <div className="mt-3 h-2 overflow-hidden rounded-full bg-bg-elevated">
        <div
          className="h-full rounded-full bg-info transition-all duration-300"
          style={{ width: `${Math.max(4, percent)}%` }}
        />
      </div>
    </section>
  );
}
