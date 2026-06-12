import { useEffect, useMemo, useState } from 'react';
import {
  Clock,
  FolderOpen,
  GitBranch,
  GitCommit,
  GitPullRequest,
  Loader2,
  Search,
} from 'lucide-react';
import type {
  CodeReviewPullRequest,
  CodeReviewScopeRef,
  CodeReviewScopeType,
} from '../../../shared/types';
import {
  parsePullRequestIdInput,
  rankCodeReviewPullRequests,
} from '../../utils/code-review-pull-request-search';

interface GitCommitInfo {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  date: string;
}

interface Props {
  repoId: string;
  onScopeSelected: (scopeType: CodeReviewScopeType, scopeRef?: CodeReviewScopeRef) => void;
  onScopeDirty?: () => void;
  disabled: boolean;
}

const scopeOptions: Array<{
  type: CodeReviewScopeType;
  label: string;
  icon: typeof GitCommit;
  description: string;
}> = [
  {
    type: 'latest_commit',
    label: 'Latest Commit',
    icon: Clock,
    description: 'Review the most recent commit',
  },
  {
    type: 'commit_range',
    label: 'Commit Range',
    icon: GitCommit,
    description: 'Select a range of commits',
  },
  {
    type: 'branch_diff',
    label: 'Branch Diff',
    icon: GitBranch,
    description: 'Compare two branches',
  },
  {
    type: 'pull_request',
    label: 'Pull Request',
    icon: GitPullRequest,
    description: 'Review a pull request diff',
  },
  {
    type: 'full_codebase',
    label: 'Full Codebase',
    icon: FolderOpen,
    description: 'Review all tracked files',
  },
];

export function CodeReviewScopeSelector({
  repoId,
  onScopeSelected,
  onScopeDirty,
  disabled,
}: Props) {
  const [selectedScope, setSelectedScope] = useState<CodeReviewScopeType>('latest_commit');
  const [commits, setCommits] = useState<GitCommitInfo[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [fromSha, setFromSha] = useState('');
  const [toSha, setToSha] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [compareBranch, setCompareBranch] = useState('');
  const [pullRequests, setPullRequests] = useState<CodeReviewPullRequest[]>([]);
  const [hasLoadedPullRequests, setHasLoadedPullRequests] = useState(false);
  const [loadingPullRequests, setLoadingPullRequests] = useState(false);
  const [pullRequestError, setPullRequestError] = useState<string | null>(null);
  const [pullRequestQuery, setPullRequestQuery] = useState('');
  const [selectedPullRequestId, setSelectedPullRequestId] = useState<string | null>(null);

  useEffect(() => {
    setCommits([]);
    setBranches([]);
    setFromSha('');
    setToSha('');
    setBaseBranch('');
    setCompareBranch('');
    setPullRequests([]);
    setHasLoadedPullRequests(false);
    setLoadingPullRequests(false);
    setPullRequestError(null);
    setPullRequestQuery('');
    setSelectedPullRequestId(null);
  }, [repoId]);

  useEffect(() => {
    let cancelled = false;

    if (!window.anvil.codereview) {
      return () => {
        cancelled = true;
      };
    }

    if (selectedScope === 'commit_range') {
      window.anvil.codereview.listCommits(repoId).then((result) => {
        if (!cancelled) setCommits(result);
      });
    }

    if (selectedScope === 'branch_diff') {
      window.anvil.codereview.listBranches(repoId).then((result) => {
        if (!cancelled) setBranches(result);
      });
    }

    if (selectedScope === 'pull_request' && !hasLoadedPullRequests) {
      setLoadingPullRequests(true);
      setPullRequestError(null);
      window.anvil.codereview
        .listPullRequests(repoId)
        .then((result) => {
          if (cancelled) return;
          setPullRequests(result);
        })
        .catch((error) => {
          if (cancelled) return;
          setPullRequestError(
            error instanceof Error ? error.message : 'Unable to load pull requests.',
          );
        })
        .finally(() => {
          if (cancelled) return;
          setHasLoadedPullRequests(true);
          setLoadingPullRequests(false);
        });
    }

    return () => {
      cancelled = true;
    };
  }, [hasLoadedPullRequests, repoId, selectedScope]);

  const manualPullRequestId = parsePullRequestIdInput(pullRequestQuery);
  const fallbackPullRequest =
    manualPullRequestId != null
      ? (pullRequests.find((pullRequest) => pullRequest.id === manualPullRequestId) ?? null)
      : null;
  const selectedPullRequest =
    (selectedPullRequestId
      ? (pullRequests.find((pullRequest) => pullRequest.id === selectedPullRequestId) ?? null)
      : null) ?? fallbackPullRequest;

  const filteredPullRequests = useMemo(
    () =>
      rankCodeReviewPullRequests(pullRequests, pullRequestQuery).slice(
        0,
        pullRequestQuery.trim() ? 8 : 12,
      ),
    [pullRequestQuery, pullRequests],
  );

  const markDirty = () => {
    onScopeDirty?.();
  };

  const handleConfirm = () => {
    switch (selectedScope) {
      case 'latest_commit':
        onScopeSelected('latest_commit');
        break;
      case 'commit_range':
        onScopeSelected('commit_range', { fromSha, toSha });
        break;
      case 'branch_diff':
        onScopeSelected('branch_diff', { baseBranch, compareBranch });
        break;
      case 'pull_request': {
        const pullRequestId = selectedPullRequest?.id ?? manualPullRequestId;
        if (!pullRequestId) return;

        onScopeSelected('pull_request', {
          pullRequest: selectedPullRequest
            ? {
                id: selectedPullRequest.id,
                title: selectedPullRequest.title,
                url: selectedPullRequest.url,
                sourceBranch: selectedPullRequest.sourceBranch,
                targetBranch: selectedPullRequest.targetBranch,
                provider: selectedPullRequest.provider,
              }
            : { id: pullRequestId },
        });
        break;
      }
      case 'full_codebase':
        onScopeSelected('full_codebase');
        break;
    }
  };

  const isReady = (): boolean => {
    if (disabled) return false;

    switch (selectedScope) {
      case 'latest_commit':
      case 'full_codebase':
        return true;
      case 'commit_range':
        return !!fromSha && !!toSha;
      case 'branch_diff':
        return !!baseBranch && !!compareBranch;
      case 'pull_request':
        return Boolean(selectedPullRequest?.id ?? manualPullRequestId);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        {scopeOptions.map(({ type, label, icon: Icon, description }) => (
          <button
            key={type}
            onClick={() => {
              markDirty();
              setSelectedScope(type);
            }}
            disabled={disabled}
            className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors ${
              selectedScope === type
                ? 'border-accent/35 bg-accent/10 text-text-primary shadow-[0_0_0_1px_var(--color-accent-glow)]'
                : 'border-transparent bg-bg-tertiary text-text-secondary hover:border-border hover:bg-bg-elevated'
            } disabled:opacity-50`}
            title={description}
          >
            <Icon size={16} />
            <span>{label}</span>
          </button>
        ))}
      </div>

      {selectedScope === 'commit_range' && (
        <div className="space-y-2">
          <div>
            <label className="mb-1 block text-sm text-text-tertiary">From</label>
            <select
              value={fromSha}
              onChange={(event) => {
                markDirty();
                setFromSha(event.target.value);
              }}
              className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary"
            >
              <option value="">Select commit...</option>
              {commits.map((commit) => (
                <option key={commit.sha} value={commit.sha}>
                  {commit.shortSha} — {commit.message.substring(0, 40)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm text-text-tertiary">To</label>
            <select
              value={toSha}
              onChange={(event) => {
                markDirty();
                setToSha(event.target.value);
              }}
              className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary"
            >
              <option value="">Select commit...</option>
              {commits.map((commit) => (
                <option key={commit.sha} value={commit.sha}>
                  {commit.shortSha} — {commit.message.substring(0, 40)}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {selectedScope === 'branch_diff' && (
        <div className="space-y-2">
          <div>
            <label className="mb-1 block text-sm text-text-tertiary">Base branch</label>
            <select
              value={baseBranch}
              onChange={(event) => {
                markDirty();
                setBaseBranch(event.target.value);
              }}
              className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary"
            >
              <option value="">Select branch...</option>
              {branches.map((branch) => (
                <option key={branch} value={branch}>
                  {branch}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm text-text-tertiary">Compare branch</label>
            <select
              value={compareBranch}
              onChange={(event) => {
                markDirty();
                setCompareBranch(event.target.value);
              }}
              className="w-full rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary"
            >
              <option value="">Select branch...</option>
              {branches.map((branch) => (
                <option key={branch} value={branch}>
                  {branch}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {selectedScope === 'pull_request' && (
        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-bg-tertiary/70">
            <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
              <Search size={14} className="shrink-0 text-text-tertiary" />
              <input
                value={pullRequestQuery}
                onChange={(event) => {
                  markDirty();
                  setSelectedPullRequestId(null);
                  setPullRequestQuery(event.target.value);
                }}
                placeholder="Paste PR ID or search title, author, branch..."
                className="w-full bg-transparent text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none"
              />
            </div>

            <div className="px-3 py-2 text-xs text-text-tertiary">
              {loadingPullRequests
                ? 'Loading recent pull requests...'
                : `Loaded ${pullRequests.length} recent pull request${pullRequests.length === 1 ? '' : 's'} for this repo.`}
            </div>
          </div>

          {pullRequestError && (
            <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              {pullRequestError}
            </div>
          )}

          {manualPullRequestId && !selectedPullRequest && (
            <div className="rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-text-primary">
              Use PR #{manualPullRequestId}
            </div>
          )}

          <div className="rounded-lg border border-border bg-bg-secondary">
            <div className="border-b border-border-subtle px-3 py-2 text-xs font-medium uppercase tracking-wide text-text-tertiary">
              Recent Pull Requests
            </div>

            {loadingPullRequests ? (
              <div className="flex items-center gap-2 px-3 py-4 text-sm text-text-secondary">
                <Loader2 size={14} className="animate-spin text-accent" />
                <span>Discovering pull requests...</span>
              </div>
            ) : filteredPullRequests.length > 0 ? (
              <div className="max-h-72 space-y-2 overflow-auto p-2">
                {filteredPullRequests.map((pullRequest) => {
                  const isSelected =
                    pullRequest.id === selectedPullRequestId ||
                    (!selectedPullRequestId && manualPullRequestId === pullRequest.id);

                  return (
                    <button
                      key={pullRequest.id}
                      onClick={() => {
                        markDirty();
                        setSelectedPullRequestId(pullRequest.id);
                      }}
                      type="button"
                      className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
                        isSelected
                          ? 'border-accent/40 bg-accent/10 text-text-primary'
                          : 'border-border-subtle bg-bg-primary text-text-secondary hover:border-border hover:bg-bg-tertiary'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-text-primary">
                            #{pullRequest.id} {pullRequest.title}
                          </div>
                          <div className="mt-1 truncate text-xs text-text-tertiary">
                            {pullRequest.author ? `${pullRequest.author} • ` : ''}
                            {pullRequest.sourceBranch} → {pullRequest.targetBranch}
                          </div>
                        </div>
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                            pullRequest.state === 'open'
                              ? 'bg-success/15 text-success'
                              : pullRequest.state === 'merged'
                                ? 'bg-accent/15 text-accent'
                                : 'bg-bg-elevated text-text-secondary'
                          }`}
                        >
                          {pullRequest.isDraft ? 'Draft' : pullRequest.state}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="px-3 py-4 text-sm text-text-secondary">
                {pullRequestQuery.trim()
                  ? 'No pull requests match your search yet.'
                  : 'No pull requests were discovered for this repository.'}
              </div>
            )}
          </div>
        </div>
      )}

      <button
        onClick={handleConfirm}
        disabled={!isReady()}
        className="w-full rounded-md bg-accent px-3 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        Confirm Scope
      </button>
    </div>
  );
}
