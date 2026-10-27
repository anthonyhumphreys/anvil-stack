import { useState } from 'react';
import type { CodeReviewFinding } from '../../../shared/types';
import {
  ChevronDown,
  ChevronRight,
  TicketPlus,
  EyeOff,
  ExternalLink,
  FileCode,
  Loader2,
  MessageSquarePlus,
  SquareTerminal,
  Wrench,
} from 'lucide-react';

interface Props {
  finding: CodeReviewFinding;
  selected: boolean;
  onToggleSelect: () => void;
  onDismiss: () => void;
  onFix: () => void;
  generatingFixPrompt?: boolean;
  onInspect?: () => void;
  onCreateWorkItem: () => void;
  canPostToPullRequest?: boolean;
  postingToPullRequest?: boolean;
  onPostToPullRequest?: () => void;
}

const severityColors: Record<string, string> = {
  critical: 'border-error/35 bg-error/15 text-error',
  major: 'border-warning/35 bg-warning/15 text-warning',
  minor: 'border-warning/25 bg-warning/10 text-warning',
  suggestion: 'border-info/35 bg-info/15 text-info',
  nitpick: 'border-border bg-bg-elevated text-text-secondary',
};

export function CodeReviewFindingCard({
  finding,
  selected,
  onToggleSelect,
  onDismiss,
  onFix,
  generatingFixPrompt = false,
  onInspect,
  onCreateWorkItem,
  canPostToPullRequest = false,
  postingToPullRequest = false,
  onPostToPullRequest,
}: Props) {
  const [expanded, setExpanded] = useState(false);

  const location = finding.filePath
    ? finding.lineStart
      ? `${finding.filePath}:${finding.lineStart}${finding.lineEnd && finding.lineEnd !== finding.lineStart ? '-' + finding.lineEnd : ''}`
      : finding.filePath
    : undefined;

  return (
    <div
      className={`rounded-lg border bg-bg-secondary transition-colors ${
        finding.dismissed ? 'opacity-50 border-border-subtle' : 'border-border'
      } ${selected ? 'ring-1 ring-accent' : ''}`}
    >
      {/* Header row */}
      <div className="flex items-center gap-2 px-3 py-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          className="rounded"
          disabled={finding.dismissed}
          aria-label={`Select finding: ${finding.description.split('\n')[0].substring(0, 60)}`}
        />
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex flex-1 items-center gap-2 text-left"
          aria-label={expanded ? 'Collapse finding details' : 'Expand finding details'}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span
            className={`inline-block rounded border px-1.5 py-0.5 text-xs font-bold uppercase ${
              severityColors[finding.severity] || severityColors.nitpick
            }`}
          >
            {finding.severity}
          </span>
          <span className="flex-1 text-base text-text-primary">
            {finding.description.split('\n')[0].substring(0, 120)}
          </span>
          <span className="rounded bg-bg-elevated px-2 py-1 text-sm text-text-tertiary">
            {finding.category}
          </span>
        </button>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-border-subtle px-4 py-3">
          <p className="mb-3 whitespace-pre-line text-sm text-text-secondary">
            {finding.description}
          </p>

          {location && (
            <div className="mb-3 flex items-center gap-1.5">
              <FileCode size={12} className="text-text-tertiary" />
              {onInspect ? (
                <button
                  onClick={onInspect}
                  className="rounded bg-bg-elevated px-2 py-1 font-mono text-sm text-text-secondary transition-colors hover:bg-info/10 hover:text-info"
                >
                  {location}
                </button>
              ) : (
                <span className="rounded bg-bg-elevated px-2 py-1 font-mono text-sm text-text-secondary">
                  {location}
                </span>
              )}
            </div>
          )}

          {finding.suggestion && (
            <div className="mb-3">
              <p className="mb-1 text-sm font-medium text-text-tertiary">Suggestion</p>
              <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-bg-elevated p-3 font-mono text-sm text-text-secondary">
                {finding.suggestion}
              </pre>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 pt-2">
            {!finding.dismissed && onInspect && (
              <button
                onClick={onInspect}
                className="flex items-center gap-1 rounded-md bg-info/10 px-2.5 py-1 text-sm text-info transition-colors hover:bg-info/20 disabled:cursor-not-allowed disabled:opacity-40"
                aria-label="Open finding location in editor"
              >
                <SquareTerminal size={12} />
                Inspect
              </button>
            )}
            {!finding.dismissed && (
              <button
                onClick={onFix}
                disabled={generatingFixPrompt}
                className="flex items-center gap-1 rounded-md bg-success/10 px-2.5 py-1 text-sm text-success transition-colors hover:bg-success/20 disabled:opacity-60"
                aria-label="Generate fix prompt for finding"
              >
                {generatingFixPrompt ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Wrench size={12} />
                )}
                {generatingFixPrompt ? 'Generating...' : 'Fix'}
              </button>
            )}
            {canPostToPullRequest &&
              !finding.dismissed &&
              !finding.pullRequestComment &&
              onPostToPullRequest && (
                <button
                  onClick={onPostToPullRequest}
                  disabled={postingToPullRequest}
                  className="flex items-center gap-1 rounded-md bg-info/10 px-2.5 py-1 text-sm text-info transition-colors hover:bg-info/20 disabled:opacity-60"
                  aria-label="Post finding to pull request"
                >
                  {postingToPullRequest ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <MessageSquarePlus size={12} />
                  )}
                  {postingToPullRequest ? 'Posting...' : 'Post to PR'}
                </button>
              )}
            {finding.pullRequestComment &&
              (finding.pullRequestComment.url ? (
                <a
                  href={finding.pullRequestComment.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 rounded-md bg-success/10 px-2.5 py-1 text-sm text-success transition-colors hover:bg-success/20"
                >
                  <ExternalLink size={12} />
                  View PR Comment
                </a>
              ) : (
                <span className="flex items-center gap-1 text-sm text-success">
                  <ExternalLink size={12} />
                  Posted to PR
                </span>
              ))}
            {!finding.workItemId && !finding.dismissed && (
              <button
                onClick={onCreateWorkItem}
                className="flex items-center gap-1 rounded-md bg-accent/10 px-2.5 py-1 text-sm text-accent transition-colors hover:bg-accent/20"
                aria-label="Create work item from finding"
              >
                <TicketPlus size={12} />
                Create Work Item
              </button>
            )}
            {finding.workItemId && (
              <span className="flex items-center gap-1 text-sm text-success">
                <ExternalLink size={12} />
                {finding.workItemId}
              </span>
            )}
            {!finding.dismissed && (
              <button
                onClick={onDismiss}
                className="flex items-center gap-1 rounded-md px-2.5 py-1 text-sm text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-secondary"
                aria-label="Dismiss finding"
              >
                <EyeOff size={12} />
                Dismiss
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
