import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Copy,
  ExternalLink,
  GitBranch,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Square,
  SquareTerminal,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { GitWorkspaceStatus, RepoInfo } from '../../../shared/types';
import { useWorkspace, repoIsMapped } from '../../contexts/WorkspaceContext';
import { useRepoIndex } from '../../contexts/RepoIndexContext';
import { buildEditorUrl } from '../../utils/editor-link';
import { IconButton, Menu, MenuItem, MenuSeparator, cx } from '../ui';
import { RemoveRepoDialog } from './RemoveRepoDialog';

interface RepoListProps {
  repos: RepoInfo[];
  selectedRepoId: string | null;
  onSelect: (repo: RepoInfo) => void;
}

/**
 * Workspace repo list (RM7 decluttered): tier dot, name, branch + dirty
 * state, path, metrics — actions live in a `…` overflow menu (X1) instead of
 * per-row primary buttons.
 */
export function RepoList({ repos, selectedRepoId, onSelect }: RepoListProps) {
  const navigate = useNavigate();
  const { activeWorkspace } = useWorkspace();
  const [removingRepo, setRemovingRepo] = useState<RepoInfo | null>(null);
  const [gitStatus, setGitStatus] = useState<GitWorkspaceStatus | null>(null);

  // RM6: one batched git status call for branch + dirty state per card.
  useEffect(() => {
    if (repos.length === 0) {
      setGitStatus(null);
      return;
    }
    let cancelled = false;
    window.anvil.git
      .workspaceStatus(repos.map((repo) => repo.id))
      .then((status) => {
        if (!cancelled) setGitStatus(status);
      })
      .catch(() => {
        if (!cancelled) setGitStatus(null);
      });
    const interval = window.setInterval(() => {
      window.anvil.git
        .workspaceStatus(repos.map((repo) => repo.id))
        .then((status) => {
          if (!cancelled) setGitStatus(status);
        })
        .catch(() => undefined);
    }, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [repos]);

  return (
    <div>
      <div className="flex items-center justify-between px-2 pb-2">
        <h2 className="text-sm font-semibold text-text-primary">Repositories</h2>
        <span className="text-xs tabular-nums text-text-tertiary">{repos.length}</span>
      </div>

      {repos.length === 0 && (
        <p className="px-1 text-sm leading-relaxed text-text-tertiary">
          No repositories are connected to this workspace.
        </p>
      )}

      <div className="space-y-1">
        {repos.map((repo) => {
          const git = gitStatus?.repos.find((entry) => entry.repoId === repo.id);
          return (
            <RepoCard
              key={repo.id}
              repo={repo}
              selected={repo.id === selectedRepoId}
              branch={git?.branch ?? null}
              dirty={(git?.fileCount ?? 0) > 0}
              onSelect={() => onSelect(repo)}
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
              onRemove={() => setRemovingRepo(repo)}
            />
          );
        })}
      </div>

      <RemoveRepoDialog
        repo={removingRepo}
        open={removingRepo !== null}
        onClose={() => setRemovingRepo(null)}
      />
    </div>
  );
}

function RepoCard({
  repo,
  selected,
  branch,
  dirty,
  onSelect,
  onOpenEditor,
  onRemove,
}: {
  repo: RepoInfo;
  selected: boolean;
  branch: string | null;
  dirty: boolean;
  onSelect: () => void;
  onOpenEditor: () => void;
  onRemove: () => void;
}) {
  const repoIndex = useRepoIndex();
  const activeJob = repoIndex.activeJobForRepo(repo.id);
  const lastError = repoIndex.lastErrorForRepo(repo.id);
  const progress = repoIndex.progressByRepoId.get(repo.id) ?? null;
  const [copied, setCopied] = useState(false);

  const mapped = repoIsMapped(repo);
  const tierLabel = activeJob
    ? activeJob.tier === 'enriched'
      ? 'Summarising'
      : 'Mapping'
    : lastError
      ? 'Index failed'
      : mapped
        ? repo.indexTier === 'enriched' || repo.status === 'indexed'
          ? 'Enriched'
          : 'Mapped'
        : 'Connected';

  const topLanguages = repo.languages.slice(0, 3);
  const indexWarning = repo.indexWarnings?.[0];

  const copyError = async () => {
    if (!lastError) return;
    const text = `Repo: ${repo.name} (${repo.path})\nJob: ${lastError.id} (${lastError.tier}, ${lastError.reason})\nError: ${lastError.error ?? 'unknown'}`;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
      role="button"
      tabIndex={0}
      className={cx(
        'group/repo cursor-pointer rounded-lg border px-3 py-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
        selected
          ? 'border-accent/35 bg-accent/10'
          : 'border-transparent hover:border-border-subtle hover:bg-bg-tertiary/70',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <TierDot repo={repo} running={activeJob !== null} failed={lastError !== null} />
            <span className="truncate text-sm font-semibold text-text-primary">{repo.name}</span>
            <span className="text-eyebrow uppercase text-text-tertiary">{tierLabel}</span>
          </div>
          {indexWarning && (
            <div className="mt-2 flex items-start gap-1.5 text-sm text-warning">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span className="line-clamp-2">{indexWarning}</span>
            </div>
          )}
        </div>

        {/* X1/J7: overflow menu — keyboard reachable, visible on row focus/hover */}
        <span onClick={(event) => event.stopPropagation()}>
          <Menu
            label={`${repo.name} actions`}
            trigger={(props) => (
              <IconButton
                {...props}
                icon={MoreHorizontal}
                label={`${repo.name} actions`}
                className="opacity-0 transition-opacity focus-visible:opacity-100 group-focus-within/repo:opacity-100 group-hover/repo:opacity-100"
              />
            )}
          >
            <MenuItem icon={<SquareTerminal size={14} />} onSelect={onOpenEditor}>
              Open in editor
            </MenuItem>
            <MenuItem
              icon={<ExternalLink size={14} />}
              onSelect={() => void window.anvil.repo.openInVSCode(repo.path)}
            >
              Open in VS Code
            </MenuItem>
            <MenuItem
              icon={<RefreshCw size={14} />}
              disabled={activeJob !== null}
              onSelect={() => void repoIndex.startIndex(repo.id)}
            >
              {mapped ? 'Re-index' : 'Index'}
            </MenuItem>
            {activeJob && (
              <MenuItem
                icon={<Square size={14} />}
                onSelect={() => void repoIndex.cancelIndex(repo.id)}
              >
                Stop indexing
              </MenuItem>
            )}
            <MenuSeparator />
            <MenuItem destructive onSelect={onRemove}>
              Remove from workspace…
            </MenuItem>
          </Menu>
        </span>
      </div>

      <div className="mt-1.5 flex items-center gap-2 text-xs text-text-tertiary">
        {branch && (
          <span className="flex items-center gap-1">
            <GitBranch size={11} aria-hidden="true" />
            <span className="max-w-32 truncate">{branch}</span>
            {dirty && (
              <span
                className="h-1.5 w-1.5 rounded-full bg-warning"
                title="Uncommitted changes"
                aria-label="Uncommitted changes"
              />
            )}
          </span>
        )}
        <span className="truncate">{repo.path}</span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-text-tertiary">
        <span>{repo.fileCount} files</span>
        <span>{repo.branchCount} branches</span>
        {topLanguages.map((lang) => (
          <span
            key={lang.language}
            className="rounded-md bg-bg-elevated px-1.5 py-0.5 text-xs text-text-secondary"
          >
            {lang.language} {lang.percentage}%
          </span>
        ))}
      </div>

      {/* Active job progress (R8: kept compact; full history in the strip) */}
      {activeJob && (
        <div className="mt-3 rounded-md border border-info/20 bg-info/5 p-2">
          <div className="flex items-center gap-2 text-sm text-info">
            <Loader2 size={12} className="animate-spin" aria-hidden="true" />
            <span className="truncate">{progress?.message ?? activeJob.message}</span>
            <span className="ml-auto shrink-0 text-sm tabular-nums text-text-secondary">
              {progress?.percent ?? activeJob.progress}%
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg-elevated">
            <div
              className="h-full rounded-full bg-info transition-all duration-300"
              style={{ width: `${Math.max(4, progress?.percent ?? activeJob.progress)}%` }}
            />
          </div>
        </div>
      )}

      {/* RM5: persisted last-job error with Retry + Copy details */}
      {lastError && !activeJob && (
        <div className="mt-3 rounded-md border border-error/25 bg-error/5 p-2">
          <div className="flex items-start gap-1.5 text-xs text-error">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span className="line-clamp-2 min-w-0 flex-1">{lastError.error}</span>
          </div>
          <div className="mt-1.5 flex items-center gap-1">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                void repoIndex.retryIndex(repo.id);
              }}
              className="rounded-md border border-border px-2 py-1 text-xs text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                void copyError();
              }}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-tertiary hover:text-text-primary"
            >
              <Copy size={11} aria-hidden="true" />
              {copied ? 'Copied' : 'Copy details'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function TierDot({ repo, running, failed }: { repo: RepoInfo; running: boolean; failed: boolean }) {
  if (running) {
    return <Loader2 size={12} className="shrink-0 animate-spin text-info" aria-hidden="true" />;
  }
  const colour = failed
    ? 'bg-error'
    : repo.indexTier === 'enriched' || repo.status === 'indexed'
      ? 'bg-success'
      : repo.indexTier === 'mapped'
        ? 'bg-info'
        : 'bg-text-tertiary/50';
  return <span className={cx('h-2 w-2 shrink-0 rounded-full', colour)} aria-hidden="true" />;
}
