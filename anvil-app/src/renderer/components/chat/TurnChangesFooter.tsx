import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ExternalLink, FileDiff, GitCommitHorizontal, GitPullRequest } from 'lucide-react';
import type { RepoInfo } from '../../../shared/types';
import { Button, PromptDialog } from '../ui';
import { DiffViewer } from './DiffViewer';
import type { ChatTurnUsage, ChatTurnWorkItem } from './chat-turns';
import {
  formatTurnChangeSummary,
  repoRelativePath,
  resolveChangesRepoId,
  summarizeTurnChanges,
} from './chat-turn-changes';

/**
 * Shared file/diff review grid — the same layout `ActivityGroupMessage` uses
 * (file list on the left, `DiffViewer` on the right) so "Review" behaves
 * identically wherever it appears (CH2).
 */
export function FileEditReviewGrid({
  edits,
  agentLabel = 'The agent',
  selectedFilePath,
  onSelectFile,
}: {
  edits: Array<{ filePath: string; diff: string }>;
  agentLabel?: string;
  selectedFilePath?: string;
  onSelectFile?: (filePath: string) => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const requestedIndex = selectedFilePath
    ? edits.findIndex((edit) => edit.filePath === selectedFilePath)
    : -1;
  const activeIndex = requestedIndex >= 0 ? requestedIndex : selectedIndex;
  const selected = edits[Math.min(activeIndex, Math.max(edits.length - 1, 0))];
  if (!selected) return null;

  return (
    <div className="grid min-h-0 grid-cols-[220px_minmax(0,1fr)] border-t border-border-subtle">
      <div className="max-h-96 overflow-auto border-r border-border-subtle bg-bg-secondary/40 p-2">
        {edits.map((edit, index) => (
          <button
            key={`${edit.filePath}-${index}`}
            type="button"
            onClick={() => {
              setSelectedIndex(index);
              onSelectFile?.(edit.filePath);
            }}
            className={`mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors ${
              index === Math.min(activeIndex, edits.length - 1)
                ? 'bg-info/10 text-info'
                : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
            }`}
            aria-pressed={index === activeIndex}
            title={edit.filePath}
          >
            <FileDiff size={12} className="shrink-0" />
            <span className="min-w-0 truncate">{edit.filePath}</span>
          </button>
        ))}
      </div>
      <div className="max-h-96 overflow-auto">
        {selected.diff.trim() ? (
          <DiffViewer filePath={selected.filePath} diff={selected.diff} />
        ) : (
          <p className="px-4 py-3 text-xs text-text-tertiary">
            Change applied, but {agentLabel} did not provide a renderable patch for this file.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * CH2 — per-turn changes footer. Sits under a completed answer with the
 * aggregate "N files changed · +X −Y" line, an inline review grid, and the
 * commit / open-PR / change-review escape hatches.
 */
export function TurnChangesFooter({
  workItems,
  repos,
  preferredRepoId,
  reviewRequest,
}: {
  workItems: ChatTurnWorkItem[];
  repos: RepoInfo[];
  preferredRepoId?: string | null;
  reviewRequest?: { requestId: number; filePath: string };
}) {
  const navigate = useNavigate();
  const [reviewOpen, setReviewOpen] = useState(false);
  const [selectedFilePath, setSelectedFilePath] = useState<string>();
  const [commitPromptOpen, setCommitPromptOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState('');
  const [actionBusy, setActionBusy] = useState<'commit' | 'pr' | null>(null);
  const [actionResult, setActionResult] = useState<{
    kind: 'success' | 'error';
    text: string;
    url?: string;
  } | null>(null);
  const appliedReviewRequestRef = useRef<number | null>(null);
  const reviewGridRef = useRef<HTMLDivElement>(null);

  const summary = useMemo(() => summarizeTurnChanges(workItems), [workItems]);
  useEffect(() => {
    if (!reviewRequest || appliedReviewRequestRef.current === reviewRequest.requestId) return;
    appliedReviewRequestRef.current = reviewRequest.requestId;
    const fileIndex =
      summary?.files.findIndex((file) => file.filePath === reviewRequest.filePath) ?? -1;
    if (fileIndex >= 0) setSelectedFilePath(reviewRequest.filePath);
    setReviewOpen(true);
    window.requestAnimationFrame(() => {
      reviewGridRef.current?.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        block: 'nearest',
      });
    });
  }, [reviewRequest, summary]);
  // §7 funnel — a rendered change summary means the agent produced a diff.
  const diffProposedTrackedRef = useRef(false);
  useEffect(() => {
    if (!summary || diffProposedTrackedRef.current) return;
    diffProposedTrackedRef.current = true;
    void window.anvil.metrics
      .track('diff_proposed', {
        files: summary.files.length,
        additions: summary.additions,
        deletions: summary.deletions,
      })
      .catch(() => {});
  }, [summary]);
  const agentLabel = workItems.find(
    (item): item is Extract<ChatTurnWorkItem, { kind: 'event' }> =>
      item.kind === 'event' && Boolean(item.event.agentLabel),
  )?.event.agentLabel;
  const repoId = useMemo(
    () =>
      summary
        ? resolveChangesRepoId(
            summary.files.map((file) => file.filePath),
            repos,
            preferredRepoId,
          )
        : null,
    [preferredRepoId, repos, summary],
  );

  if (!summary) return null;

  const stageablePaths = () => {
    const repo = repos.find((item) => item.id === repoId);
    if (!repo) return [];
    return summary.files
      .map((file) => repoRelativePath(file.filePath, repo.path))
      .filter((path): path is string => Boolean(path));
  };

  const openCommitPrompt = () => {
    setActionResult(null);
    setCommitMessage('');
    setCommitPromptOpen(true);
    if (repoId) {
      void window.anvil.git
        .generateCommitMessage(repoId)
        .then((message) => setCommitMessage(message))
        .catch(() => undefined);
    }
  };

  const runCommit = async (message: string) => {
    setCommitPromptOpen(false);
    if (!repoId) {
      setActionResult({ kind: 'error', text: 'No repository is attached to these changes.' });
      return;
    }
    setActionBusy('commit');
    setActionResult(null);
    try {
      const paths = stageablePaths();
      if (paths.length > 0) await window.anvil.git.stage(repoId, paths);
      const hash = await window.anvil.git.commit(repoId, message);
      void window.anvil.metrics
        .track('change_applied', { fileCount: summary.files.length, via: 'commit' })
        .catch(() => {});
      setActionResult({ kind: 'success', text: `Committed ${hash.slice(0, 8)}` });
    } catch (err) {
      setActionResult({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Commit failed',
      });
    } finally {
      setActionBusy(null);
    }
  };

  const runOpenPr = async () => {
    if (!repoId) {
      setActionResult({ kind: 'error', text: 'No repository is attached to these changes.' });
      return;
    }
    setActionBusy('pr');
    setActionResult(null);
    try {
      const result = await window.anvil.git.createPullRequest(repoId);
      void window.anvil.metrics
        .track('change_applied', { fileCount: summary.files.length, via: 'pr' })
        .catch(() => {});
      if (result.pullRequestUrl) {
        window.open(result.pullRequestUrl, '_blank', 'noopener');
        setActionResult({
          kind: 'success',
          text: `Pull request opened on ${result.branch}`,
          url: result.pullRequestUrl,
        });
      } else {
        setActionResult({
          kind: 'success',
          text: `Committed ${result.commitHash?.slice(0, 8) ?? 'changes'} — no PR provider is configured for ${result.repoName}.`,
        });
      }
    } catch (err) {
      setActionResult({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Open PR failed',
      });
    } finally {
      setActionBusy(null);
    }
  };

  return (
    <div className="message-bubble flex justify-start" data-testid="turn-changes-footer">
      <div className="w-full overflow-hidden rounded-lg border border-border-subtle bg-bg-secondary/45">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
          <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-text-secondary">
            <FileDiff size={12} className="shrink-0 text-info" aria-hidden="true" />
            {formatTurnChangeSummary(summary)}
          </span>
          <span className="ml-auto flex flex-wrap items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setReviewOpen((open) => !open)}
              aria-expanded={reviewOpen}
            >
              {reviewOpen ? 'Hide review' : 'Review'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                navigate(repoId ? `/review?repo=${encodeURIComponent(repoId)}` : '/review')
              }
            >
              Open in Change Review
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={openCommitPrompt}
              disabled={!repoId || actionBusy !== null}
            >
              <GitCommitHorizontal size={12} />
              Commit…
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void runOpenPr()}
              disabled={!repoId || actionBusy !== null}
            >
              <GitPullRequest size={12} />
              {actionBusy === 'pr' ? 'Opening…' : 'Open PR'}
            </Button>
          </span>
        </div>

        {actionResult && (
          <p
            className={`border-t border-border-subtle px-3 py-2 text-xs ${
              actionResult.kind === 'success' ? 'text-success' : 'text-error'
            }`}
            role="status"
          >
            {actionResult.text}
            {actionResult.url && (
              <a
                href={actionResult.url}
                target="_blank"
                rel="noreferrer"
                className="ml-1.5 inline-flex items-center gap-0.5 text-info hover:underline"
              >
                Open <ExternalLink size={10} />
              </a>
            )}
          </p>
        )}

        {reviewOpen && (
          <div ref={reviewGridRef}>
            <FileEditReviewGrid
              edits={summary.files.map((file) => ({ filePath: file.filePath, diff: file.diff }))}
              agentLabel={agentLabel ?? undefined}
              selectedFilePath={selectedFilePath}
              onSelectFile={setSelectedFilePath}
            />
          </div>
        )}
      </div>

      <PromptDialog
        open={commitPromptOpen}
        title="Commit these changes"
        description="Stages the files changed in this turn and creates a commit."
        label="Commit message"
        defaultValue={commitMessage}
        placeholder="Describe the change"
        confirmLabel={actionBusy === 'commit' ? 'Committing…' : 'Commit'}
        onSubmit={(message) => void runCommit(message)}
        onCancel={() => setCommitPromptOpen(false)}
      />
    </div>
  );
}

/**
 * H5 — quiet per-turn usage footer: model, token totals, context-window fill,
 * and cost (observed for ACP, priced for Codex). Unknown values are simply
 * omitted so a partial stream never shows nonsense.
 */
export function TurnUsageFooter({ usage }: { usage: ChatTurnUsage }) {
  const parts: string[] = [];
  if (usage.inputTokens > 0 || usage.outputTokens > 0) {
    parts.push(`${formatTurnTokenCount(usage.inputTokens)} in`);
    parts.push(`${formatTurnTokenCount(usage.outputTokens)} out`);
    if (usage.cachedInputTokens > 0) {
      parts.push(`${formatTurnTokenCount(usage.cachedInputTokens)} cached`);
    }
  }
  if (usage.contextUsed !== undefined && usage.contextSize !== undefined && usage.contextSize > 0) {
    parts.push(`${Math.round((usage.contextUsed / usage.contextSize) * 100)}% context`);
  }
  if (usage.costUsd !== undefined && usage.costUsd > 0) {
    parts.push(formatTurnCost(usage.costUsd));
  }
  if (!usage.model && parts.length === 0) return null;

  return (
    <div className="message-bubble flex justify-start" data-testid="turn-usage-footer">
      <p className="px-1 text-eyebrow text-text-muted">
        {[usage.model, ...parts].filter(Boolean).join(' · ')}
      </p>
    </div>
  );
}

function formatTurnTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(Math.round(tokens));
}

function formatTurnCost(costUsd: number): string {
  if (costUsd < 0.01) return `$${costUsd.toFixed(4)}`;
  return `$${costUsd.toFixed(2)}`;
}
