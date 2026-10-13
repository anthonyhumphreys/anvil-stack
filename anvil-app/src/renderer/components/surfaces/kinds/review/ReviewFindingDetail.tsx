import { useMemo } from 'react';
import {
  Check,
  CheckCheck,
  ExternalLink,
  GitPullRequest,
  Hourglass,
  ListTodo,
  MessageSquarePlus,
  RotateCcw,
  Wrench,
  X,
} from 'lucide-react';
import { parseUnifiedDiff } from '../../../../../shared/surfaces/kinds/review/diff';
import { formatFindingLocation } from '../../../../../shared/surfaces/kinds/review/model';
import type { ReviewFinding } from '../../../../../shared/surfaces/kinds/review/types';
import { Button } from '../../../ui';
import { ReviewDiff } from './ReviewDiff';
import { SeverityBadge, StatusChip } from './ReviewGlyphs';
import type { ReviewAction } from './useReviewActions';

function Label({ children }: { children: string }) {
  return <h4 className="mt-4 text-eyebrow uppercase text-text-tertiary">{children}</h4>;
}

export function ReviewFindingDetail({
  finding,
  busy,
  canPostToPullRequest,
  onAction,
  onComment,
  onJump,
}: {
  finding: ReviewFinding;
  busy: boolean;
  canPostToPullRequest: boolean;
  onAction: (action: ReviewAction, ids: string[]) => void;
  onComment: (finding: ReviewFinding) => void;
  onJump: (finding: ReviewFinding) => void;
}) {
  const patchHunks = useMemo(() => {
    if (!finding.suggestedPatch) return [];
    return parseUnifiedDiff(finding.suggestedPatch).flatMap((file) => file.hunks);
  }, [finding.suggestedPatch]);
  const resolved = finding.status === 'dismissed' || finding.status === 'fixed';
  const ids = [finding.id];
  const headingId = `review-finding-${finding.id}`;

  return (
    <article aria-labelledby={headingId} className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={finding.severity} />
        <StatusChip status={finding.status} />
        <span className="text-xs text-text-tertiary">{finding.category}</span>
        <span className="ml-auto font-mono text-xs text-text-tertiary">{finding.id}</span>
      </div>
      <h3 id={headingId} className="mt-2 text-sm font-semibold leading-snug text-text-primary">
        {finding.title}
      </h3>
      <button
        type="button"
        className="mt-1 break-all rounded-sm text-left font-mono text-xs text-text-secondary hover:text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        onClick={() => onJump(finding)}
      >
        {formatFindingLocation(finding)}
      </button>

      <p className="mt-3 max-w-[72ch] whitespace-pre-wrap text-sm leading-[1.65] text-text-secondary">
        {finding.rationale}
      </p>

      {finding.suggestion ? (
        <>
          <Label>Suggestion</Label>
          <p className="mt-1 max-w-[72ch] whitespace-pre-wrap text-sm leading-[1.65] text-text-secondary">
            {finding.suggestion}
          </p>
        </>
      ) : null}

      {patchHunks.length ? (
        <>
          <Label>Suggested patch</Label>
          <div className="mt-1.5 overflow-hidden rounded-lg border border-border bg-bg-secondary">
            <ReviewDiff
              filePath={finding.filePath}
              hunks={patchHunks}
              findings={[]}
              label={`Suggested patch for ${finding.filePath}`}
            />
          </div>
          {!resolved ? (
            <Button
              variant="secondary"
              size="sm"
              className="mt-2"
              disabled={busy}
              onClick={() => onAction('apply_patch', ids)}
            >
              Apply patch to working tree
            </Button>
          ) : null}
        </>
      ) : null}

      {finding.status === 'fixed' ? (
        <p className="mt-4 flex items-start gap-1.5 text-xs text-success">
          <CheckCheck size={13} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>
            Fixed in this thread
            {finding.fixNote ? (
              <span className="text-text-secondary"> · {finding.fixNote}</span>
            ) : null}
          </span>
        </p>
      ) : null}
      {finding.status === 'fix-requested' ? (
        <p className="mt-4 flex items-center gap-1.5 text-xs text-info">
          <Hourglass size={13} aria-hidden="true" />
          Waiting for the agent’s fix
        </p>
      ) : null}
      {finding.status === 'dismissed' && finding.dismissReason ? (
        <p className="mt-4 text-xs text-text-tertiary">
          Dismissed · <span className="text-text-secondary">{finding.dismissReason}</span>
        </p>
      ) : null}
      {finding.workItem || finding.prCommentUrl ? (
        <ul className="mt-3 space-y-1 text-xs">
          {finding.workItem ? (
            <li className="flex items-center gap-1.5 text-text-secondary">
              <ListTodo size={13} aria-hidden="true" className="text-text-tertiary" />
              {finding.workItem.url ? (
                <a
                  href={finding.workItem.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 hover:text-text-primary hover:underline"
                >
                  Work item {finding.workItem.id}
                  <ExternalLink size={11} aria-hidden="true" />
                </a>
              ) : (
                <span>Work item {finding.workItem.id}</span>
              )}
            </li>
          ) : null}
          {finding.prCommentUrl ? (
            <li className="flex items-center gap-1.5 text-text-secondary">
              <GitPullRequest size={13} aria-hidden="true" className="text-text-tertiary" />
              <a
                href={finding.prCommentUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 hover:text-text-primary hover:underline"
              >
                Posted to the pull request
                <ExternalLink size={11} aria-hidden="true" />
              </a>
            </li>
          ) : null}
        </ul>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-1.5 border-t border-border-subtle pt-3">
        {!resolved ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => onAction('ask_fix', ids)}
          >
            <Wrench size={13} aria-hidden="true" />
            Ask fix
          </Button>
        ) : null}
        {finding.status === 'open' || finding.status === 'fix-requested' ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => onAction('accept', ids)}
          >
            <Check size={13} aria-hidden="true" />
            Accept
          </Button>
        ) : null}
        {!resolved ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => onAction('dismiss', ids)}
          >
            <X size={13} aria-hidden="true" />
            Dismiss
          </Button>
        ) : (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => onAction('reopen', ids)}>
            <RotateCcw size={13} aria-hidden="true" />
            Reopen
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => onComment(finding)}>
          <MessageSquarePlus size={13} aria-hidden="true" />
          Comment
        </Button>
        {!finding.workItem && !resolved ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => onAction('create_work_items', ids)}
          >
            <ListTodo size={13} aria-hidden="true" />
            Work item
          </Button>
        ) : null}
        {canPostToPullRequest && !finding.prCommentUrl && !resolved ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => onAction('post_to_pr', ids)}
          >
            <GitPullRequest size={13} aria-hidden="true" />
            Post to PR
          </Button>
        ) : null}
      </div>
    </article>
  );
}
