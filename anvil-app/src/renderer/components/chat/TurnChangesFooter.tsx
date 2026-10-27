import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, FileDiff, ScanSearch } from 'lucide-react';
import type { RepoInfo } from '../../../shared/types';
import { isAbsoluteEditorPath } from '../../../shared/editor-file-link';
import { buildChangeReviewPath } from '../../utils/change-review-context';
import { buildEditorUrl } from '../../utils/editor-link';
import { useSurfaces } from '../surfaces/surfaces-context';
import { Button, cx } from '../ui';
import { DiffViewer } from './DiffViewer';
import { requestChatSend } from './chat-prefill';
import type { ChatTurnUsage, ChatTurnWorkItem } from './chat-turns';
import {
  buildTurnReviewPrompt,
  countTurnStatuses,
  firstChangedLine,
  formatTurnChangeSummary,
  repoRelativePath,
  resolveChangesRepoId,
  resolveTurnDeliveryRepo,
  sameTurnChangeSummary,
  summarizeTurnChanges,
  type TurnFileChange,
} from './chat-turn-changes';
import { TurnChangesActions } from './turn-changes/TurnChangesActions';
import { TurnChangesFileList } from './turn-changes/TurnChangesFileList';
import { TurnFileStatusGlyph } from './turn-changes/TurnFileStatusGlyph';

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
 * CH2 / spec §8.2 — per-turn Changes. Sits under a settled answer as one calm
 * line ("N files changed · +a −d" with status glyphs) and discloses on demand:
 * the file list with per-file stats and diffs, "Open in editor", "Open in
 * Changes", and the mutations (Undo turn, Commit, Open PR) behind confirms.
 * "Review these changes" sends a prompt that asks the agent for a Review surface.
 */
export function TurnChangesFooter({
  workItems,
  repos,
  preferredRepoId,
  threadId,
  turnId,
  reviewRequest,
  readOnly: readOnlyProp,
  laterTurnEditedPaths,
}: {
  workItems: ChatTurnWorkItem[];
  repos: RepoInfo[];
  preferredRepoId?: string | null;
  threadId?: string;
  turnId: string;
  reviewRequest?: { requestId: number; filePath: string };
  /** Forces read-only (mutations hidden); otherwise read from the thread's surfaces context. */
  readOnly?: boolean;
  /**
   * Paths edited by later turns in the same thread. Blocks Undo for those
   * files and tells the review prompt whether this is the latest editing turn.
   * Undefined when the caller doesn't know.
   */
  laterTurnEditedPaths?: readonly string[];
}) {
  const navigate = useNavigate();
  const { readOnly: surfacesReadOnly } = useSurfaces();
  const readOnly = readOnlyProp ?? surfacesReadOnly;
  const panelId = useId();
  const [expanded, setExpanded] = useState(false);
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const appliedReviewRequestRef = useRef<number | null>(null);
  const fileTogglesRef = useRef(new Map<string, HTMLButtonElement>());

  const computedSummary = useMemo(() => summarizeTurnChanges(workItems), [workItems]);
  // Work items are rebuilt on every transcript render; keep one stable summary.
  const [summary, setSummary] = useState(computedSummary);
  if (!sameTurnChangeSummary(summary, computedSummary)) setSummary(computedSummary);
  const statusCounts = useMemo(
    () => (summary ? countTurnStatuses(summary.files) : null),
    [summary],
  );
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
  const repo = repos.find((item) => item.id === repoId) ?? null;
  const deliveryScope = useMemo(
    () =>
      resolveTurnDeliveryRepo(
        summary?.files.map((file) => file.filePath) ?? [],
        repos,
        preferredRepoId,
      ),
    [preferredRepoId, repos, summary],
  );
  const deliveryRepo = repos.find((item) => item.id === deliveryScope.repoId) ?? null;

  useEffect(() => {
    if (!reviewRequest || appliedReviewRequestRef.current === reviewRequest.requestId) return;
    appliedReviewRequestRef.current = reviewRequest.requestId;
    const known = summary?.files.some((file) => file.filePath === reviewRequest.filePath);
    setExpanded(true);
    if (known) {
      setExpandedPaths((current) => new Set(current).add(reviewRequest.filePath));
    }
    window.requestAnimationFrame(() => {
      const target = known ? fileTogglesRef.current.get(reviewRequest.filePath) : undefined;
      const element = target ?? document.getElementById(panelId);
      element?.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        block: 'nearest',
      });
      target?.focus({ preventScroll: true });
    });
  }, [panelId, reviewRequest, summary]);

  // The settled turn summary is shown in its collapsed row as well as expanded.
  const changeSummaryViewedTrackedRef = useRef(false);
  useEffect(() => {
    if (!summary || changeSummaryViewedTrackedRef.current) return;
    changeSummaryViewedTrackedRef.current = true;
    void window.anvil.metrics
      .track('change_summary_viewed', {
        threadId: threadId ?? null,
        turnId,
        files: summary.files.length,
        additions: summary.additions,
        deletions: summary.deletions,
      })
      .catch(() => {});
  }, [summary, threadId, turnId]);

  const agentLabel = workItems.find(
    (item): item is Extract<ChatTurnWorkItem, { kind: 'event' }> =>
      item.kind === 'event' && Boolean(item.event.agentLabel),
  )?.event.agentLabel;

  if (!summary || !statusCounts) return null;

  const displayPath = (file: TurnFileChange) =>
    (repo ? repoRelativePath(file.filePath, repo.path) : null) ?? file.filePath;

  const toggleFile = (filePath: string) =>
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });

  // The editor falls back to the active workspace; no workspace id is needed here.
  const openInEditor = (file: TurnFileChange) => {
    const relative = repo ? repoRelativePath(file.filePath, repo.path) : null;
    const isAbsolute = isAbsoluteEditorPath(file.filePath);
    navigate(
      buildEditorUrl({
        repoId: relative ? repo?.id : undefined,
        repoName: relative ? repo?.name : undefined,
        relativePath: relative ?? (isAbsolute ? undefined : file.filePath),
        absolutePath: isAbsolute ? file.filePath : undefined,
        line: firstChangedLine(file.diff),
        source: 'chat',
        title: displayPath(file),
      }),
    );
  };

  const openInChanges =
    repoId && threadId
      ? () =>
          navigate(
            buildChangeReviewPath({
              repoId,
              source: 'chat',
              threadId,
              turnId,
              changedFiles: summary.files.map((file) => file.filePath),
            }),
          )
      : undefined;

  const reviewTheseChanges = () =>
    requestChatSend(
      buildTurnReviewPrompt({
        repoId,
        paths: summary.files.map(displayPath),
        isLatestEditingTurn:
          laterTurnEditedPaths === undefined ? undefined : laterTurnEditedPaths.length === 0,
      }),
    );

  const statuses = (['added', 'modified', 'deleted'] as const).filter(
    (status) => statusCounts[status] > 0,
  );

  return (
    <div className="message-bubble flex justify-start" data-testid="turn-changes-footer">
      <div className="w-full min-w-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={panelId}
            onClick={() => setExpanded((open) => !open)}
            className="-ml-1 flex min-w-0 items-center gap-1.5 rounded-md px-1 py-1 text-xs font-medium text-text-secondary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            <ChevronRight
              size={12}
              aria-hidden="true"
              className={cx(
                'shrink-0 text-text-tertiary motion-safe:transition-transform',
                expanded && 'rotate-90',
              )}
            />
            <FileDiff size={12} className="shrink-0 text-text-tertiary" aria-hidden="true" />
            <span className="tabular-nums">{formatTurnChangeSummary(summary)}</span>
          </button>
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {statuses.map((status) => (
              <TurnFileStatusGlyph
                key={status}
                status={status}
                count={statusCounts[status]}
                showLabel
              />
            ))}
          </span>
          <span className="ml-auto">
            <Button variant="ghost" size="sm" onClick={reviewTheseChanges}>
              <ScanSearch size={12} aria-hidden="true" />
              Review these changes
            </Button>
          </span>
        </div>

        {/* Kept mounted while collapsed so action results and undo state survive. */}
        <div
          id={panelId}
          hidden={!expanded}
          className="mt-1.5 overflow-hidden rounded-lg border border-border-subtle"
        >
          <TurnChangesFileList
            files={summary.files}
            displayPath={displayPath}
            expandedPaths={expandedPaths}
            onToggleFile={toggleFile}
            onOpenInEditor={openInEditor}
            agentLabel={agentLabel ?? undefined}
            toggleRef={(filePath, element) => {
              if (element) fileTogglesRef.current.set(filePath, element);
              else fileTogglesRef.current.delete(filePath);
            }}
          />
          <TurnChangesActions
            summary={summary}
            repo={deliveryRepo}
            scopeError={deliveryScope.reason}
            readOnly={readOnly}
            laterTurnEditedPaths={laterTurnEditedPaths}
            checkUndo={expanded}
            onOpenInChanges={openInChanges}
          />
        </div>
      </div>
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
