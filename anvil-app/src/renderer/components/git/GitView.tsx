import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  GitBranch,
  GitCommitHorizontal,
  Plus,
  Minus,
  RotateCw,
  ArrowUp,
  ArrowDown,
  Check,
  X,
  FileText,
  FilePlus,
  FileX,
  FileDiff,
  Loader2,
  Trash2,
  RefreshCw,
  AlertCircle,
} from 'lucide-react';
import type {
  GitStatusResult,
  GitFileChange,
  GitLogEntry,
  GitBranchInfo,
  GitDiffResult,
} from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { WorkspaceGitActions } from '../shared/WorkspaceGitActions';

type Tab = 'changes' | 'log' | 'branches';

export function GitView() {
  const { repos } = useWorkspace();
  const indexedRepos = useMemo(() => repos.filter((r) => r.status !== 'error'), [repos]);

  const [selectedRepoId, setSelectedRepoId] = useState('');
  const [tab, setTab] = useState<Tab>('changes');
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [log, setLog] = useState<GitLogEntry[]>([]);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Commit form
  const [commitMsg, setCommitMsg] = useState('');
  const [committing, setCommitting] = useState(false);

  // Diff viewer
  const [selectedDiff, setSelectedDiff] = useState<GitDiffResult | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  // Branch creation
  const [showNewBranch, setShowNewBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');

  // Push/pull
  const [syncing, setSyncing] = useState<'push' | 'pull' | 'fetch' | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  // Auto-select first repo
  useEffect(() => {
    if (!selectedRepoId && indexedRepos.length > 0) {
      setSelectedRepoId(indexedRepos[0].id);
    }
  }, [indexedRepos, selectedRepoId]);

  const refresh = useCallback(async () => {
    if (!selectedRepoId) return;
    setLoading(true);
    setError(null);
    try {
      const [s, l, b] = await Promise.all([
        window.anvil.git.status(selectedRepoId),
        window.anvil.git.log(selectedRepoId, 50),
        window.anvil.git.branches(selectedRepoId),
      ]);
      setStatus(s);
      setLog(l);
      setBranches(b);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [selectedRepoId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Auto-refresh every 5s
  useEffect(() => {
    if (!selectedRepoId) return;
    const interval = setInterval(() => {
      window.anvil.git
        .status(selectedRepoId)
        .then(setStatus)
        .catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
  }, [selectedRepoId]);

  const handleStage = async (paths: string[]) => {
    await window.anvil.git.stage(selectedRepoId, paths);
    refresh();
  };

  const handleUnstage = async (paths: string[]) => {
    await window.anvil.git.unstage(selectedRepoId, paths);
    refresh();
  };

  const handleDiscard = async (paths: string[]) => {
    await window.anvil.git.discard(selectedRepoId, paths);
    refresh();
    setSelectedDiff(null);
  };

  const handleCommit = async () => {
    if (!commitMsg.trim()) return;
    setCommitting(true);
    try {
      await window.anvil.git.commit(selectedRepoId, commitMsg.trim());
      setCommitMsg('');
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCommitting(false);
    }
  };

  const handleGenerateCommitMessage = async () => {
    if (!selectedRepoId) return;
    try {
      const message = await window.anvil.git.generateCommitMessage(selectedRepoId);
      setCommitMsg(message);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handlePush = async () => {
    setSyncing('push');
    setSyncMessage(null);
    try {
      const result = await window.anvil.git.push(
        selectedRepoId,
        undefined,
        undefined,
        !status?.tracking,
      );
      setSyncMessage(`Pushed: ${result}`);
      refresh();
    } catch (err) {
      setSyncMessage(`Push failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setSyncing(null);
    }
  };

  const handlePull = async () => {
    setSyncing('pull');
    setSyncMessage(null);
    try {
      const result = await window.anvil.git.pull(selectedRepoId);
      setSyncMessage(`Pulled: ${result}`);
      refresh();
    } catch (err) {
      setSyncMessage(`Pull failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      setSyncing(null);
    }
  };

  const handleFetch = async () => {
    setSyncing('fetch');
    try {
      await window.anvil.git.fetch(selectedRepoId);
      refresh();
    } catch {
      /* ignore */
    } finally {
      setSyncing(null);
    }
  };

  const handleViewDiff = async (file: GitFileChange) => {
    setDiffLoading(true);
    try {
      const diff = await window.anvil.git.diff(selectedRepoId, file.path, file.staged);
      setSelectedDiff(diff);
    } catch {
      /* ignore */
    } finally {
      setDiffLoading(false);
    }
  };

  const handleSwitchBranch = async (name: string) => {
    try {
      await window.anvil.git.switchBranch(selectedRepoId, name);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCreateBranch = async () => {
    if (!newBranchName.trim()) return;
    try {
      await window.anvil.git.createBranch(selectedRepoId, newBranchName.trim());
      setNewBranchName('');
      setShowNewBranch(false);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDeleteBranch = async (name: string) => {
    try {
      await window.anvil.git.deleteBranch(selectedRepoId, name);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const staged = useMemo(() => status?.files.filter((f) => f.staged) ?? [], [status]);
  const unstaged = useMemo(() => status?.files.filter((f) => !f.staged) ?? [], [status]);

  if (indexedRepos.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-text-secondary">
        Connect a repository first to use the Git client.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header: repo selector + branch + sync */}
      <div className="flex items-center gap-3 border-b border-border bg-bg-secondary px-4 py-2">
        <select
          value={selectedRepoId}
          onChange={(e) => setSelectedRepoId(e.target.value)}
          className="rounded-lg border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary"
        >
          {indexedRepos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>

        {status && (
          <div className="flex items-center gap-1.5 text-sm">
            <GitBranch size={14} className="text-accent" />
            <span className="font-medium text-text-primary">{status.branch}</span>
            {status.tracking && <span className="text-text-tertiary">{status.tracking}</span>}
          </div>
        )}

        {status && (status.ahead > 0 || status.behind > 0) && (
          <div className="flex items-center gap-2 text-xs">
            {status.ahead > 0 && (
              <span className="flex items-center gap-0.5 text-success">
                <ArrowUp size={12} />
                {status.ahead}
              </span>
            )}
            {status.behind > 0 && (
              <span className="flex items-center gap-0.5 text-warning">
                <ArrowDown size={12} />
                {status.behind}
              </span>
            )}
          </div>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          <WorkspaceGitActions
            repos={indexedRepos}
            selectedRepoId={selectedRepoId}
            compact
            onPullRequestCreated={(result) => {
              setSyncMessage(
                result.pullRequestUrl
                  ? `PR created: ${result.pullRequestUrl}`
                  : `PR created for ${result.repoName}`,
              );
              refresh();
            }}
            onError={setError}
          />
          <button
            onClick={handleFetch}
            disabled={!!syncing}
            className="rounded-md p-1.5 text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-30"
            title="Fetch"
          >
            <RefreshCw size={14} className={syncing === 'fetch' ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={handlePull}
            disabled={!!syncing}
            className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-30"
            title="Pull"
          >
            {syncing === 'pull' ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <ArrowDown size={12} />
            )}
            Pull
          </button>
          <button
            onClick={handlePush}
            disabled={!!syncing}
            className="flex items-center gap-1 rounded-md border border-accent/30 bg-accent/10 px-2 py-1 text-xs text-accent transition-colors hover:bg-accent/20 disabled:opacity-30"
            title="Push"
          >
            {syncing === 'push' ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <ArrowUp size={12} />
            )}
            Push
          </button>
          <button
            onClick={refresh}
            disabled={loading}
            className="rounded-md p-1.5 text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-30"
            title="Refresh"
          >
            <RotateCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {syncMessage && (
        <div className="border-b border-border-subtle bg-bg-primary px-4 py-1.5 text-xs text-text-secondary">
          {syncMessage}
          <button
            onClick={() => setSyncMessage(null)}
            className="ml-2 text-text-tertiary hover:text-text-primary"
          >
            <X size={10} />
          </button>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 border-b border-error/20 bg-error/5 px-4 py-2 text-xs text-error">
          <AlertCircle size={12} />
          {error}
          <button onClick={() => setError(null)} className="ml-auto">
            <X size={12} />
          </button>
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-border bg-bg-secondary">
        {(['changes', 'log', 'branches'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium capitalize transition-colors ${
              tab === t
                ? 'border-b-2 border-accent text-text-primary'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {t}
            {t === 'changes' && status && status.files.length > 0 && (
              <span className="ml-1.5 rounded-full bg-accent/20 px-1.5 py-0.5 text-xs text-accent">
                {status.files.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex flex-1 overflow-hidden">
        {tab === 'changes' && (
          <ChangesTab
            staged={staged}
            unstaged={unstaged}
            commitMsg={commitMsg}
            setCommitMsg={setCommitMsg}
            committing={committing}
            onCommit={handleCommit}
            onGenerateCommitMessage={handleGenerateCommitMessage}
            onStage={handleStage}
            onUnstage={handleUnstage}
            onDiscard={handleDiscard}
            onViewDiff={handleViewDiff}
            selectedDiff={selectedDiff}
            diffLoading={diffLoading}
            onCloseDiff={() => setSelectedDiff(null)}
          />
        )}
        {tab === 'log' && <LogTab log={log} />}
        {tab === 'branches' && (
          <BranchesTab
            branches={branches}
            onSwitch={handleSwitchBranch}
            onDelete={handleDeleteBranch}
            showNewBranch={showNewBranch}
            setShowNewBranch={setShowNewBranch}
            newBranchName={newBranchName}
            setNewBranchName={setNewBranchName}
            onCreateBranch={handleCreateBranch}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Changes Tab
// ---------------------------------------------------------------------------

function FileIcon({ status }: { status: GitFileChange['status'] }) {
  switch (status) {
    case 'added':
    case 'untracked':
      return <FilePlus size={14} className="text-success" />;
    case 'deleted':
      return <FileX size={14} className="text-error" />;
    case 'modified':
      return <FileDiff size={14} className="text-warning" />;
    case 'renamed':
    case 'copied':
      return <FileText size={14} className="text-info" />;
    case 'conflicted':
      return <AlertCircle size={14} className="text-error" />;
    default:
      return <FileText size={14} className="text-text-tertiary" />;
  }
}

interface ChangesTabProps {
  staged: GitFileChange[];
  unstaged: GitFileChange[];
  commitMsg: string;
  setCommitMsg: (v: string) => void;
  committing: boolean;
  onCommit: () => void;
  onGenerateCommitMessage: () => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onDiscard: (paths: string[]) => void;
  onViewDiff: (file: GitFileChange) => void;
  selectedDiff: GitDiffResult | null;
  diffLoading: boolean;
  onCloseDiff: () => void;
}

function ChangesTab({
  staged,
  unstaged,
  commitMsg,
  setCommitMsg,
  committing,
  onCommit,
  onGenerateCommitMessage,
  onStage,
  onUnstage,
  onDiscard,
  onViewDiff,
  selectedDiff,
  diffLoading,
  onCloseDiff,
}: ChangesTabProps) {
  return (
    <div className="flex flex-1 overflow-hidden">
      {/* File list side */}
      <div className="flex w-80 shrink-0 flex-col overflow-y-auto border-r border-border">
        {/* Staged */}
        <div className="border-b border-border-subtle">
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-text-tertiary">
              Staged ({staged.length})
            </span>
            {staged.length > 0 && (
              <button
                onClick={() => onUnstage(staged.map((f) => f.path))}
                className="text-xs text-text-secondary hover:text-text-primary"
                title="Unstage all"
              >
                <Minus size={12} />
              </button>
            )}
          </div>
          {staged.map((f) => (
            <FileRow
              key={`staged-${f.path}`}
              file={f}
              onAction={() => onUnstage([f.path])}
              actionIcon={<Minus size={12} />}
              actionTitle="Unstage"
              onClick={() => onViewDiff(f)}
            />
          ))}
          {staged.length === 0 && (
            <div className="px-3 pb-2 text-xs text-text-tertiary">No staged files</div>
          )}
        </div>

        {/* Unstaged */}
        <div className="flex-1">
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-text-tertiary">
              Changes ({unstaged.length})
            </span>
            {unstaged.length > 0 && (
              <button
                onClick={() => onStage(unstaged.map((f) => f.path))}
                className="text-xs text-text-secondary hover:text-text-primary"
                title="Stage all"
              >
                <Plus size={12} />
              </button>
            )}
          </div>
          {unstaged.map((f) => (
            <FileRow
              key={`unstaged-${f.path}`}
              file={f}
              onAction={() => onStage([f.path])}
              actionIcon={<Plus size={12} />}
              actionTitle="Stage"
              onClick={() => onViewDiff(f)}
              onDiscard={() => onDiscard([f.path])}
            />
          ))}
          {unstaged.length === 0 && (
            <div className="px-3 pb-2 text-xs text-text-tertiary">No changes</div>
          )}
        </div>

        {/* Commit box */}
        <div className="border-t border-border p-3">
          <textarea
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            placeholder="Commit message..."
            rows={3}
            className="w-full resize-none rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent/50 focus:outline-none"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                onCommit();
              }
            }}
          />
          <button
            onClick={onGenerateCommitMessage}
            disabled={staged.length === 0 && unstaged.length === 0}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-tertiary disabled:opacity-40"
          >
            <GitCommitHorizontal size={14} />
            Generate conventional message
          </button>
          <button
            onClick={onCommit}
            disabled={!commitMsg.trim() || staged.length === 0 || committing}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/80 disabled:opacity-40"
          >
            {committing ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            Commit ({staged.length} file{staged.length !== 1 ? 's' : ''})
          </button>
          <div className="mt-1 text-center text-[10px] text-text-tertiary">
            {navigator.platform.includes('Mac') ? '\u2318' : 'Ctrl'}+Enter to commit
          </div>
        </div>
      </div>

      {/* Diff viewer side */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {diffLoading && (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="animate-spin text-text-tertiary" />
          </div>
        )}
        {!diffLoading && selectedDiff && (
          <>
            <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-2">
              <FileText size={14} className="text-text-tertiary" />
              <span className="text-sm font-medium text-text-primary">{selectedDiff.filePath}</span>
              <button
                onClick={onCloseDiff}
                className="ml-auto text-text-tertiary hover:text-text-primary"
              >
                <X size={14} />
              </button>
            </div>
            <div className="flex-1 overflow-auto">
              <DiffDisplay diff={selectedDiff} />
            </div>
          </>
        )}
        {!diffLoading && !selectedDiff && (
          <div className="flex flex-1 items-center justify-center text-sm text-text-tertiary">
            Select a file to view its diff
          </div>
        )}
      </div>
    </div>
  );
}

function FileRow({
  file,
  onAction,
  actionIcon,
  actionTitle,
  onClick,
  onDiscard,
}: {
  file: GitFileChange;
  onAction: () => void;
  actionIcon: React.ReactNode;
  actionTitle: string;
  onClick: () => void;
  onDiscard?: () => void;
}) {
  return (
    <div className="group flex items-center gap-2 px-3 py-1 hover:bg-bg-tertiary">
      <button onClick={onClick} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <FileIcon status={file.status} />
        <span className="truncate text-sm text-text-primary">{file.path}</span>
      </button>
      <div className="flex shrink-0 items-center gap-1 opacity-0 group-hover:opacity-100">
        {onDiscard && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDiscard();
            }}
            className="rounded p-0.5 text-error/70 hover:bg-error/10 hover:text-error"
            title="Discard changes"
          >
            <Trash2 size={12} />
          </button>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onAction();
          }}
          className="rounded p-0.5 text-text-secondary hover:bg-bg-primary hover:text-text-primary"
          title={actionTitle}
        >
          {actionIcon}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diff Display — simple unified diff renderer
// ---------------------------------------------------------------------------

function DiffDisplay({ diff }: { diff: GitDiffResult }) {
  // If we have old/new content, show side-by-side style with coloured lines
  if (!diff.oldContent && !diff.newContent && !diff.hunks) {
    return (
      <div className="p-4 text-sm text-text-tertiary">
        No diff available (possibly a binary file)
      </div>
    );
  }

  // Parse unified diff hunks for display
  if (diff.hunks) {
    const lines = diff.hunks.split('\n');
    return (
      <pre className="p-4 text-xs leading-relaxed">
        {lines.map((line, i) => {
          let cls = 'text-text-secondary';
          let bg = '';
          if (line.startsWith('+') && !line.startsWith('+++')) {
            cls = 'text-success';
            bg = 'bg-success/5';
          } else if (line.startsWith('-') && !line.startsWith('---')) {
            cls = 'text-error';
            bg = 'bg-error/5';
          } else if (line.startsWith('@@')) {
            cls = 'text-accent';
            bg = 'bg-accent/5';
          } else if (line.startsWith('diff') || line.startsWith('index')) {
            cls = 'text-text-tertiary font-semibold';
          }
          return (
            <div key={i} className={`${cls} ${bg} px-2`}>
              {line}
            </div>
          );
        })}
      </pre>
    );
  }

  return <div className="p-4 text-sm text-text-tertiary">Diff content not available</div>;
}

// ---------------------------------------------------------------------------
// Log Tab
// ---------------------------------------------------------------------------

function LogTab({ log }: { log: GitLogEntry[] }) {
  return (
    <div className="flex-1 overflow-y-auto">
      {log.length === 0 ? (
        <div className="flex h-full items-center justify-center text-sm text-text-tertiary">
          No commits yet
        </div>
      ) : (
        <div className="divide-y divide-border-subtle">
          {log.map((entry) => (
            <div
              key={entry.hash}
              className="flex items-start gap-3 px-4 py-3 hover:bg-bg-tertiary/50"
            >
              <GitCommitHorizontal size={16} className="mt-0.5 shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-text-primary">
                    {entry.message}
                  </span>
                  {entry.refs && (
                    <span className="shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                      {entry.refs}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 flex items-center gap-3 text-xs text-text-tertiary">
                  <code className="font-mono">{entry.shortHash}</code>
                  <span>{entry.author}</span>
                  <span>{new Date(entry.date).toLocaleDateString()}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Branches Tab
// ---------------------------------------------------------------------------

function BranchesTab({
  branches,
  onSwitch,
  onDelete,
  showNewBranch,
  setShowNewBranch,
  newBranchName,
  setNewBranchName,
  onCreateBranch,
}: {
  branches: GitBranchInfo[];
  onSwitch: (name: string) => void;
  onDelete: (name: string) => void;
  showNewBranch: boolean;
  setShowNewBranch: (v: boolean) => void;
  newBranchName: string;
  setNewBranchName: (v: string) => void;
  onCreateBranch: () => void;
}) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="flex items-center justify-between border-b border-border-subtle px-4 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-text-tertiary">
          Branches ({branches.length})
        </span>
        <button
          onClick={() => setShowNewBranch(!showNewBranch)}
          className="flex items-center gap-1 rounded border border-accent/30 bg-accent/10 px-2 py-1 text-xs text-accent hover:bg-accent/20"
        >
          <Plus size={12} />
          New
        </button>
      </div>

      {showNewBranch && (
        <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-2">
          <input
            value={newBranchName}
            onChange={(e) => setNewBranchName(e.target.value)}
            placeholder="branch-name"
            className="flex-1 rounded border border-border bg-bg-primary px-2 py-1 text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent/50 focus:outline-none"
            onKeyDown={(e) => {
              if (e.key === 'Enter') onCreateBranch();
              if (e.key === 'Escape') setShowNewBranch(false);
            }}
            autoFocus
          />
          <button
            onClick={onCreateBranch}
            disabled={!newBranchName.trim()}
            className="rounded bg-accent px-2 py-1 text-xs text-white hover:bg-accent/80 disabled:opacity-40"
          >
            Create
          </button>
          <button
            onClick={() => setShowNewBranch(false)}
            className="text-text-tertiary hover:text-text-primary"
          >
            <X size={14} />
          </button>
        </div>
      )}

      <div className="divide-y divide-border-subtle">
        {branches.map((b) => (
          <div
            key={b.name}
            className={`group flex items-center gap-3 px-4 py-2.5 ${
              b.current ? 'bg-accent/5' : 'hover:bg-bg-tertiary/50'
            }`}
          >
            <GitBranch size={14} className={b.current ? 'text-accent' : 'text-text-tertiary'} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span
                  className={`text-sm ${b.current ? 'font-semibold text-accent' : 'text-text-primary'}`}
                >
                  {b.name}
                </span>
                {b.current && (
                  <span className="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-medium text-accent">
                    current
                  </span>
                )}
              </div>
              {b.tracking && <div className="text-xs text-text-tertiary">{b.tracking}</div>}
            </div>
            {!b.current && (
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100">
                <button
                  onClick={() => onSwitch(b.name)}
                  className="rounded px-2 py-0.5 text-xs text-text-secondary hover:bg-bg-primary hover:text-text-primary"
                >
                  Switch
                </button>
                <button
                  onClick={() => onDelete(b.name)}
                  className="rounded p-0.5 text-error/70 hover:bg-error/10 hover:text-error"
                  title="Delete branch"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
