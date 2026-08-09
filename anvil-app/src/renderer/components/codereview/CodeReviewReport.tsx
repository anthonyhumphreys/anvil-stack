import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type {
  CodeReview,
  CodeReviewFinding,
  CodeReviewScopeRef,
  CodeReviewScopeType,
  RepoSummary,
  RepositoryChangeSummary,
  RepositoryMapGraph,
} from '../../../shared/types';
import { CodeReviewSummary } from './CodeReviewSummary';
import { CodeReviewFindingCard } from './CodeReviewFindingCard';
import {
  Download,
  Filter,
  CheckSquare,
  ClipboardCopy,
  Wrench,
  Loader2,
  X,
  MessageSquarePlus,
  Send,
  Sparkles,
} from 'lucide-react';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { buildEditorUrl } from '../../utils/editor-link';
import { copyTextToClipboard } from '../../utils/clipboard';
import { WorkspaceGitActions } from '../shared/WorkspaceGitActions';
import { RepositoryMap } from '../repos/RepositoryMap';

interface Props {
  review: CodeReview;
  onVisualisePullRequest?: (pullRequestId: string) => void;
}

export function CodeReviewReport({ review, onVisualisePullRequest }: Props) {
  const navigate = useNavigate();
  const { activeWorkspace, repos } = useWorkspace();
  const [findings, setFindings] = useState<CodeReviewFinding[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [severityFilter, setSeverityFilter] = useState<string | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [postingFindingIds, setPostingFindingIds] = useState<Set<string>>(new Set());
  const [postingReview, setPostingReview] = useState(false);
  const [activeFixFinding, setActiveFixFinding] = useState<CodeReviewFinding | null>(null);
  const [fixPromptTitle, setFixPromptTitle] = useState('');
  const [generatedFixPrompt, setGeneratedFixPrompt] = useState('');
  const [generatingFixFindingId, setGeneratingFixFindingId] = useState<string | null>(null);
  const [copiedFixPrompt, setCopiedFixPrompt] = useState(false);
  const [repoSummary, setRepoSummary] = useState<RepoSummary | null>(null);
  const [changeSummary, setChangeSummary] = useState<RepositoryChangeSummary | null>(null);
  const [mapGraph, setMapGraph] = useState<RepositoryMapGraph | null>(null);
  const [changeMapError, setChangeMapError] = useState<string | null>(null);
  const [loadingChangeMap, setLoadingChangeMap] = useState(false);

  useEffect(() => {
    window.anvil.codereview.getFindings(review.id).then(setFindings);
    setSelectedIds(new Set());
    setActionError(null);
    setPostingFindingIds(new Set());
    setPostingReview(false);
    setActiveFixFinding(null);
    setFixPromptTitle('');
    setGeneratedFixPrompt('');
    setGeneratingFixFindingId(null);
    setCopiedFixPrompt(false);
  }, [review.id]);

  useEffect(() => {
    let cancelled = false;
    if (review.scopeType !== 'pull_request') {
      setRepoSummary(null);
      setChangeSummary(null);
      setMapGraph(null);
      setChangeMapError(null);
      setLoadingChangeMap(false);
      return () => {
        cancelled = true;
      };
    }

    setRepoSummary(null);
    setChangeSummary(null);
    setMapGraph(null);
    setLoadingChangeMap(true);
    setChangeMapError(null);
    Promise.all([
      window.anvil.repo.getSummary(review.repoId),
      window.anvil.repo.getMapGraph(review.repoId),
      window.anvil.codereview.getChangeSummary(review.id),
    ])
      .then(([nextRepoSummary, nextMapGraph, nextChangeSummary]) => {
        if (cancelled) return;
        setRepoSummary(nextRepoSummary);
        setMapGraph(nextMapGraph);
        setChangeSummary(nextChangeSummary);
      })
      .catch((error) => {
        if (cancelled) return;
        setChangeMapError(
          error instanceof Error ? error.message : 'Unable to build the pull request change map.',
        );
      })
      .finally(() => {
        if (!cancelled) setLoadingChangeMap(false);
      });

    return () => {
      cancelled = true;
    };
  }, [review.id, review.repoId, review.scopeType]);

  const handleDismiss = useCallback(async (findingId: string) => {
    await window.anvil.codereview.dismissFinding(findingId);
    setFindings((prev) => prev.map((f) => (f.id === findingId ? { ...f, dismissed: true } : f)));
  }, []);

  const handleCreateWorkItem = useCallback(async (findingId: string) => {
    const wiId = await window.anvil.codereview.createWorkItem(findingId);
    setFindings((prev) => prev.map((f) => (f.id === findingId ? { ...f, workItemId: wiId } : f)));
  }, []);

  const handlePostToPullRequest = useCallback(async (findingId: string) => {
    setActionError(null);
    setPostingFindingIds((prev) => new Set(prev).add(findingId));

    try {
      const comment = await window.anvil.codereview.postFindingToPullRequest(findingId);
      setFindings((prev) =>
        prev.map((f) => (f.id === findingId ? { ...f, pullRequestComment: comment } : f)),
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to post finding to the PR.');
    } finally {
      setPostingFindingIds((prev) => {
        const next = new Set(prev);
        next.delete(findingId);
        return next;
      });
    }
  }, []);

  const handlePostReviewToPullRequest = useCallback(async () => {
    setActionError(null);
    setPostingReview(true);

    try {
      await window.anvil.codereview.postReviewToPullRequest(review.id);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to post review to the PR.');
    } finally {
      setPostingReview(false);
    }
  }, [review.id]);

  const handleBulkCreateWorkItems = useCallback(async () => {
    const ids = [...selectedIds];
    const wiIds = await window.anvil.codereview.createWorkItemsBulk(ids);
    setFindings((prev) =>
      prev.map((f) => {
        const idx = ids.indexOf(f.id);
        if (idx >= 0) return { ...f, workItemId: wiIds[idx] };
        return f;
      }),
    );
    setSelectedIds(new Set());
  }, [selectedIds]);

  const handleExport = useCallback(async () => {
    await window.anvil.codereview.exportReport(review.id);
  }, [review.id]);

  const handleGenerateFixPrompt = useCallback(async (finding: CodeReviewFinding) => {
    setActionError(null);
    setActiveFixFinding(finding);
    setFixPromptTitle('Fix Prompt');
    setGeneratedFixPrompt('');
    setCopiedFixPrompt(false);
    setGeneratingFixFindingId(finding.id);

    try {
      const prompt = await window.anvil.codereview.generateFixPrompt(finding.id);
      setGeneratedFixPrompt(prompt);
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : 'Failed to generate a fix prompt for this finding.',
      );
      setActiveFixFinding(null);
    } finally {
      setGeneratingFixFindingId(null);
    }
  }, []);

  const handleGenerateBulkFixPrompt = useCallback(async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;

    setActionError(null);
    setActiveFixFinding(null);
    setFixPromptTitle(`Fix ${ids.length} Findings`);
    setGeneratedFixPrompt('');
    setCopiedFixPrompt(false);
    setGeneratingFixFindingId('bulk');

    try {
      const prompt = await window.anvil.codereview.generateBulkFixPrompt(ids);
      setGeneratedFixPrompt(prompt);
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : 'Failed to generate a fix prompt for the selected findings.',
      );
      setFixPromptTitle('');
    } finally {
      setGeneratingFixFindingId(null);
    }
  }, [selectedIds]);

  const handleCopyFixPrompt = useCallback(() => {
    void copyTextToClipboard(generatedFixPrompt);
    setCopiedFixPrompt(true);
    setTimeout(() => setCopiedFixPrompt(false), 2000);
  }, [generatedFixPrompt]);

  const handleSendFixPromptToChat = useCallback(() => {
    const prompt = generatedFixPrompt.trim();
    if (!prompt) return;
    navigate(`/chat?prompt=${encodeURIComponent(prompt)}`);
  }, [generatedFixPrompt, navigate]);

  const handleInspect = useCallback(
    (finding: CodeReviewFinding) => {
      if (!finding.filePath) return;
      navigate(
        buildEditorUrl({
          workspaceId: activeWorkspace?.id,
          repoId: review.repoId,
          relativePath: finding.filePath,
          line: finding.lineStart,
          source: 'codereview',
          title: finding.lineStart ? `${finding.filePath}:${finding.lineStart}` : finding.filePath,
        }),
      );
    },
    [activeWorkspace?.id, navigate, review.repoId],
  );

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Filter findings
  let visibleFindings = findings.filter((f) => showDismissed || !f.dismissed);
  if (severityFilter) {
    visibleFindings = visibleFindings.filter((f) => f.severity === severityFilter);
  }

  const toggleSelectAll = () => {
    if (selectedIds.size === visibleFindings.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(visibleFindings.map((f) => f.id)));
    }
  };

  // Group by category
  const grouped = new Map<string, CodeReviewFinding[]>();
  for (const f of visibleFindings) {
    if (!grouped.has(f.category)) grouped.set(f.category, []);
    grouped.get(f.category)!.push(f);
  }

  const severityOrder = ['critical', 'major', 'minor', 'suggestion', 'nitpick'];
  const sortedCategories = [...grouped.entries()].sort((a, b) => {
    const aMax = Math.min(...a[1].map((f) => severityOrder.indexOf(f.severity)));
    const bMax = Math.min(...b[1].map((f) => severityOrder.indexOf(f.severity)));
    return aMax - bMax;
  });

  const modeLabel = review.mode === 'quick_glance' ? 'Quick Glance' : 'Senior Dev Review';
  const scopeLabel = formatScopeLabel(review.scopeType, review.scopeRef);
  const canPostToPullRequest =
    review.scopeType === 'pull_request' && Boolean(review.scopeRef?.pullRequest?.id);
  const changeMapCommitMismatch = Boolean(
    mapGraph &&
    changeSummary?.currentCommitSha &&
    mapGraph.indexedCommitSha !== changeSummary.currentCommitSha,
  );

  return (
    <div className="flex min-h-full">
      <div className="min-w-0 flex-1 p-6">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold text-text-primary">Code Review</h2>
            <p className="text-xs text-text-secondary">
              {new Date(review.startedAt).toLocaleString()} — {modeLabel} — {scopeLabel}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <WorkspaceGitActions repos={repos} compact onError={setActionError} />
            {review.scopeRef?.pullRequest?.id && onVisualisePullRequest && (
              <button
                type="button"
                onClick={() => onVisualisePullRequest(review.scopeRef!.pullRequest!.id)}
                className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-white transition-colors hover:bg-accent/85"
              >
                <Sparkles size={14} /> Visualise PR
              </button>
            )}
            {canPostToPullRequest && (
              <button
                onClick={handlePostReviewToPullRequest}
                disabled={postingReview}
                className="flex items-center gap-1.5 rounded-md border border-accent/30 bg-accent/10 px-3 py-1.5 text-sm text-accent transition-colors hover:bg-accent/20 disabled:opacity-40"
              >
                {postingReview ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Send size={14} />
                )}
                Post review
              </button>
            )}
            <button
              onClick={handleExport}
              className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary"
            >
              <Download size={14} />
              Export
            </button>
          </div>
        </div>

        {review.scopeType === 'pull_request' && (
          <section className="mb-5">
            {loadingChangeMap ? (
              <ChangeMapSkeleton />
            ) : changeMapCommitMismatch && mapGraph && changeSummary?.currentCommitSha ? (
              <div className="rounded-xl border border-warning/35 bg-warning/10 px-4 py-3">
                <p className="text-sm font-medium text-text-primary">Change map needs a refresh</p>
                <p className="mt-1 text-xs leading-5 text-text-secondary">
                  This map was indexed at {shortCommit(mapGraph.indexedCommitSha)}, but the pull
                  request currently points to {shortCommit(changeSummary.currentCommitSha)}. Check
                  out the pull request branch and refresh its repository map before using
                  source-level overlays.
                </p>
                <button
                  type="button"
                  onClick={() => navigate('/repos')}
                  className="mt-3 rounded-md border border-warning/40 px-2.5 py-1.5 text-xs font-medium text-warning hover:bg-warning/10"
                >
                  Open Repositories
                </button>
              </div>
            ) : repoSummary && changeSummary ? (
              <RepositoryMap
                key={review.id}
                repoId={review.repoId}
                repositoryName={
                  repos.find((repo) => repo.id === review.repoId)?.name ?? 'Repository'
                }
                modules={repoSummary.modules}
                graph={mapGraph}
                changedFiles={changeSummary.files}
                compact
                changeMode
              />
            ) : (
              <div className="rounded-xl border border-border bg-bg-secondary px-4 py-3">
                <p className="text-sm font-medium text-text-primary">Change map unavailable</p>
                <p className="mt-1 text-xs text-text-secondary">
                  {changeMapError ??
                    'Index this repository to map pull request files to code areas.'}
                </p>
              </div>
            )}
          </section>
        )}

        {/* Summary */}
        <CodeReviewSummary findings={findings} summary={review.summary} />

        {review.verification && (
          <div className="mt-4 rounded-lg border border-border bg-bg-secondary p-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-base font-semibold text-text-primary">Verification</h3>
              <span className="rounded-full border border-border px-2 py-1 text-xs text-text-secondary">
                {review.verification.status.replace(/_/g, ' ')}
              </span>
            </div>
            {review.verification.summary && (
              <p className="text-sm text-text-secondary">{review.verification.summary}</p>
            )}
            {review.verification.steps.length > 0 && (
              <div className="mt-3 space-y-2">
                {review.verification.steps.map((step) => (
                  <div
                    key={`${step.label}:${step.command}`}
                    className="rounded-md border border-border-subtle bg-bg-primary px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <div className="text-sm font-medium text-text-primary">{step.label}</div>
                        <div className="mt-0.5 font-mono text-xs text-text-secondary">
                          {step.command}
                        </div>
                      </div>
                      <span className="text-xs text-text-secondary">
                        {step.status}
                        {step.exitCode !== undefined ? ` · exit ${step.exitCode}` : ''}
                      </span>
                    </div>
                    {step.outputSnippet && (
                      <pre className="mt-2 overflow-x-auto rounded bg-bg-secondary p-2 text-xs text-text-secondary">
                        <code>{step.outputSnippet}</code>
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            )}
            {review.verification.worktreeKept && review.verification.worktreePath && (
              <p className="mt-3 text-xs text-text-tertiary">
                Disposable review worktree retained at {review.verification.worktreePath}.
              </p>
            )}
          </div>
        )}

        {actionError && (
          <div className="mt-4 rounded-md border border-error bg-error/10 p-3 text-sm text-error">
            {actionError}
          </div>
        )}

        {/* Filters */}
        <div className="my-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Filter size={14} className="text-text-tertiary" />
            {severityOrder.map((sev) => (
              <button
                key={sev}
                onClick={() => setSeverityFilter(severityFilter === sev ? null : sev)}
                className={`rounded-md px-2 py-0.5 text-xs font-medium capitalize transition-colors ${
                  severityFilter === sev
                    ? 'bg-accent text-white'
                    : 'bg-bg-elevated text-text-secondary hover:bg-bg-tertiary'
                }`}
              >
                {sev}
              </button>
            ))}
            <label className="ml-3 flex items-center gap-1.5 text-sm text-text-secondary">
              <input
                type="checkbox"
                checked={showDismissed}
                onChange={(e) => setShowDismissed(e.target.checked)}
                className="rounded"
              />
              Show dismissed
            </label>
          </div>
        </div>

        {/* Bulk actions bar */}
        {selectedIds.size > 0 && (
          <div className="mb-4 flex items-center gap-3 rounded-lg border border-accent/30 bg-accent/15 px-4 py-2">
            <button
              onClick={toggleSelectAll}
              className="flex items-center gap-1 text-sm font-medium text-white"
            >
              <CheckSquare size={14} />
              {selectedIds.size === visibleFindings.length ? 'Deselect all' : 'Select all'}
            </button>
            <span className="text-sm text-text-secondary">{selectedIds.size} selected</span>
            <button
              onClick={handleBulkCreateWorkItems}
              className="ml-auto rounded-md border border-border bg-bg-primary px-3 py-1 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-tertiary"
            >
              Create Work Items
            </button>
            <button
              onClick={handleGenerateBulkFixPrompt}
              disabled={generatingFixFindingId === 'bulk'}
              className="rounded-md bg-accent px-3 py-1 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {generatingFixFindingId === 'bulk' ? 'Generating...' : 'Fix selected'}
            </button>
          </div>
        )}

        {/* Findings by category */}
        {sortedCategories.map(([category, catFindings]) => (
          <div key={category} className="mb-6">
            <h3 className="mb-2 text-base font-semibold text-text-primary">{category}</h3>
            <div className="space-y-2">
              {catFindings.map((finding) => (
                <CodeReviewFindingCard
                  key={finding.id}
                  finding={finding}
                  selected={selectedIds.has(finding.id)}
                  onToggleSelect={() => toggleSelect(finding.id)}
                  onDismiss={() => handleDismiss(finding.id)}
                  onFix={() => handleGenerateFixPrompt(finding)}
                  generatingFixPrompt={generatingFixFindingId === finding.id}
                  onInspect={finding.filePath ? () => handleInspect(finding) : undefined}
                  onCreateWorkItem={() => handleCreateWorkItem(finding.id)}
                  canPostToPullRequest={canPostToPullRequest}
                  postingToPullRequest={postingFindingIds.has(finding.id)}
                  onPostToPullRequest={() => handlePostToPullRequest(finding.id)}
                />
              ))}
            </div>
          </div>
        ))}

        {visibleFindings.length === 0 && (
          <div className="rounded-lg border border-border-subtle bg-bg-secondary p-8 text-center">
            <p className="text-sm text-text-secondary">
              {findings.length === 0
                ? 'No findings in this review.'
                : 'No findings match the current filters.'}
            </p>
          </div>
        )}
      </div>

      {fixPromptTitle && (
        <aside className="w-[420px] shrink-0 border-l border-border bg-bg-secondary">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <div className="flex items-center gap-2">
              <Wrench size={14} className="text-success" />
              <span className="text-sm font-medium text-text-primary">{fixPromptTitle}</span>
            </div>
            <div className="flex items-center gap-1">
              {generatedFixPrompt && !generatingFixFindingId && (
                <>
                  <button
                    onClick={handleSendFixPromptToChat}
                    aria-label="Send fix prompt to Chat"
                    className="flex items-center gap-1 rounded px-2 py-1 text-sm text-text-secondary hover:text-text-primary"
                  >
                    <MessageSquarePlus size={10} />
                    Chat
                  </button>
                  <button
                    onClick={handleCopyFixPrompt}
                    aria-label={copiedFixPrompt ? 'Copied to clipboard' : 'Copy to clipboard'}
                    className="flex items-center gap-1 rounded px-2 py-1 text-sm text-text-secondary hover:text-text-primary"
                  >
                    <ClipboardCopy size={10} />
                    {copiedFixPrompt ? 'Copied!' : 'Copy'}
                  </button>
                </>
              )}
              <button
                onClick={() => {
                  setActiveFixFinding(null);
                  setFixPromptTitle('');
                  setGeneratedFixPrompt('');
                  setCopiedFixPrompt(false);
                }}
                aria-label="Close fix prompt panel"
                className="rounded p-1 text-text-tertiary hover:text-text-primary"
              >
                <X size={14} />
              </button>
            </div>
          </div>

          <div className="border-b border-border px-3 py-2">
            <p className="text-xs text-text-secondary">
              {activeFixFinding
                ? activeFixFinding.filePath
                  ? activeFixFinding.lineStart
                    ? `${activeFixFinding.filePath}:${activeFixFinding.lineStart}`
                    : activeFixFinding.filePath
                  : 'Repository-level finding'
                : `${selectedIds.size} selected findings`}
            </p>
            {activeFixFinding && (
              <p className="mt-1 line-clamp-3 text-sm text-text-primary">
                {activeFixFinding.description}
              </p>
            )}
          </div>

          <div className="overflow-auto px-3 pb-3 pt-3">
            {generatingFixFindingId ? (
              <div className="flex h-48 items-center justify-center">
                <div className="text-center">
                  <Loader2 size={20} className="mx-auto mb-2 animate-spin text-accent" />
                  <p className="text-sm text-text-secondary">Generating with AI...</p>
                </div>
              </div>
            ) : (
              <pre className="whitespace-pre-wrap rounded-md border border-border bg-bg-primary p-3 text-sm text-text-primary">
                {generatedFixPrompt}
              </pre>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}

function ChangeMapSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-bg-secondary">
      <div className="border-b border-border px-4 py-3">
        <div className="h-4 w-28 animate-pulse rounded bg-bg-elevated" />
        <div className="mt-2 h-3 w-48 animate-pulse rounded bg-bg-elevated" />
      </div>
      <div className="flex h-[390px] items-center justify-center gap-16 px-8">
        <div className="h-28 w-56 animate-pulse rounded-xl bg-bg-elevated" />
        <div className="space-y-5">
          <div className="h-24 w-56 animate-pulse rounded-xl bg-bg-elevated" />
          <div className="h-24 w-56 animate-pulse rounded-xl bg-bg-elevated" />
        </div>
      </div>
    </div>
  );
}

function formatScopeLabel(scopeType: CodeReviewScopeType, scopeRef?: CodeReviewScopeRef): string {
  if (scopeType === 'pull_request' && scopeRef?.pullRequest) {
    const id = scopeRef.pullRequest.id;
    const title = scopeRef.pullRequest.title?.trim();
    return title ? `PR #${id} — ${title}` : `PR #${id}`;
  }

  return scopeType.replace(/_/g, ' ');
}

function shortCommit(commitSha?: string): string {
  return commitSha ? commitSha.slice(0, 7) : 'an unknown commit';
}
