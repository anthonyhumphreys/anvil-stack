import {
  Plus,
  Loader2,
  AlertCircle,
  CheckCircle,
  FolderGit2,
  ExternalLink,
  AlertTriangle,
  SquareTerminal,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { RepoInfo } from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { buildEditorUrl } from '../../utils/editor-link';

interface RepoListProps {
  repos: RepoInfo[];
  selectedRepoId: string | null;
  onSelect: (repo: RepoInfo) => void;
  onConnect: () => void;
  onIndex: (repoId: string) => void;
  onForceReindex: (repoId: string) => void;
  indexingRepoIds: Set<string>;
  indexProgressMap: Map<
    string,
    { message: string; percent: number; detail?: string; history: string[] }
  >;
}

export function RepoList({
  repos,
  selectedRepoId,
  onSelect,
  onConnect,
  onIndex,
  onForceReindex,
  indexingRepoIds,
  indexProgressMap,
}: RepoListProps) {
  const navigate = useNavigate();
  const { activeWorkspace } = useWorkspace();

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-text-primary">Connected Repos</h3>
        <button
          onClick={onConnect}
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:border-accent/40 hover:bg-bg-tertiary hover:text-text-primary"
        >
          <Plus size={14} />
          Connect Repo
        </button>
      </div>

      {repos.length === 0 && (
        <div className="rounded-lg border border-border-subtle bg-bg-secondary p-8 text-center">
          <FolderGit2 size={32} className="mx-auto mb-3 text-text-secondary" />
          <p className="text-base text-text-secondary">No repositories connected</p>
          <p className="mt-1 text-sm text-text-tertiary">
            Click "Connect Repo" to add a local Git repository
          </p>
        </div>
      )}

      <div className="space-y-2">
        {repos.map((repo) => (
          <RepoCard
            key={repo.id}
            repo={repo}
            selected={repo.id === selectedRepoId}
            onSelect={() => onSelect(repo)}
            onIndex={() => onIndex(repo.id)}
            onForceReindex={() => onForceReindex(repo.id)}
            isIndexing={indexingRepoIds.has(repo.id)}
            indexProgress={indexProgressMap.get(repo.id) ?? null}
            onOpenEditor={() =>
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
          />
        ))}
      </div>
    </div>
  );
}

function RepoCard({
  repo,
  selected,
  onSelect,
  onIndex,
  onForceReindex,
  isIndexing,
  indexProgress,
  onOpenEditor,
}: {
  repo: RepoInfo;
  selected: boolean;
  onSelect: () => void;
  onIndex: () => void;
  onForceReindex: () => void;
  isIndexing: boolean;
  indexProgress: { message: string; percent: number; detail?: string } | null;
  onOpenEditor: () => void;
}) {
  const statusIcon = {
    connected: <span className="h-2 w-2 rounded-full bg-text-secondary" />,
    indexing: <Loader2 size={12} className="animate-spin text-info" />,
    indexed: <CheckCircle size={12} className="text-success" />,
    error: <AlertCircle size={12} className="text-error" />,
  }[repo.status];

  const topLanguages = repo.languages.slice(0, 3);
  const indexWarning = repo.indexWarnings?.[0];
  const showDeepBadge = repo.indexMode === 'deep';
  const showIndexWarning = Boolean(indexWarning);

  return (
    <div
      onClick={onSelect}
      className={`cursor-pointer rounded-xl border p-4 transition-colors ${
        selected
          ? 'border-accent/35 bg-accent/10 shadow-[0_0_0_1px_var(--color-accent-glow)]'
          : 'border-border bg-bg-secondary hover:border-border hover:bg-bg-tertiary'
      }`}
    >
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {statusIcon}
            <span className="truncate text-base font-semibold text-text-primary">{repo.name}</span>
            {showDeepBadge && (
              <span className="rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-success">
                deep
              </span>
            )}
          </div>
          {showIndexWarning && (
            <div className="mt-2 flex items-start gap-1.5 text-sm text-warning">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span className="line-clamp-2">{indexWarning}</span>
            </div>
          )}
        </div>
        {repo.status === 'indexing' && !isIndexing && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onForceReindex();
            }}
            className="rounded-lg border border-warning/50 bg-warning/10 px-2.5 py-1.5 text-sm font-medium text-warning hover:bg-warning/20"
            aria-label="Force re-index stuck repository"
            title="This repo appears stuck. Click to reset and re-index."
          >
            Force Re-index
          </button>
        )}
        {(repo.status === 'connected' || repo.status === 'error') && !isIndexing && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onIndex();
            }}
            className="rounded-lg border border-accent bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
            aria-label="Index repository"
          >
            Index
          </button>
        )}
        {repo.status === 'indexed' && !isIndexing && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onIndex();
            }}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
            aria-label="Re-index repository"
          >
            Re-index
          </button>
        )}
      </div>

      <div className="mt-2 flex items-center gap-2">
        <p className="truncate text-sm text-text-secondary">{repo.path}</p>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onOpenEditor();
          }}
          className="shrink-0 rounded-md p-1 text-text-secondary transition-colors hover:bg-info/10 hover:text-info"
          title="Open in Editor"
          aria-label="Open in Editor"
        >
          <SquareTerminal size={14} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            window.anvil.repo.openInVSCode(repo.path);
          }}
          className="shrink-0 rounded-md p-1 text-text-secondary transition-colors hover:bg-accent/10 hover:text-accent"
          title="Open in VS Code"
          aria-label="Open in VS Code"
        >
          <ExternalLink size={14} />
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-text-secondary">
        <span>{repo.fileCount} files</span>
        <span>{repo.branchCount} branches</span>
        {topLanguages.map((lang) => (
          <span
            key={lang.language}
            className="rounded-md bg-bg-elevated px-2 py-1 text-sm text-text-secondary"
          >
            {lang.language} {lang.percentage}%
          </span>
        ))}
      </div>

      {isIndexing && indexProgress && (
        <div className="mt-3 rounded-md border border-info/20 bg-info/5 p-2">
          <div className="flex items-center gap-2 text-sm text-info">
            <Loader2 size={12} className="animate-spin" />
            <span>{indexProgress.message}</span>
            <span className="ml-auto text-sm tabular-nums text-text-secondary">
              {indexProgress.percent}%
            </span>
          </div>
          {indexProgress.detail && (
            <p className="mt-1 text-sm text-text-secondary">{indexProgress.detail}</p>
          )}
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg-elevated">
            <div
              className="h-full rounded-full bg-info transition-all duration-300"
              style={{ width: `${Math.max(4, indexProgress.percent)}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
