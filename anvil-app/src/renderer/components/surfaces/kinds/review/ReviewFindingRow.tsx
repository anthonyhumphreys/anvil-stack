import type { MouseEvent } from 'react';
import { Check, MessageSquarePlus, RotateCcw, Wrench, X } from 'lucide-react';
import { formatFindingLocation } from '../../../../../shared/surfaces/kinds/review/model';
import type { ReviewFinding } from '../../../../../shared/surfaces/kinds/review/types';
import { IconButton, cx } from '../../../ui';
import { SeverityBadge, StatusChip } from './ReviewGlyphs';
import type { ReviewAction } from './useReviewActions';

export interface ReviewFindingRowProps {
  finding: ReviewFinding;
  selected: boolean;
  focused?: boolean;
  /** Fade in as the agent streams findings (opacity only; none under reduced motion). */
  fadeIn?: boolean;
  dense?: boolean;
  disabled?: boolean;
  onToggleSelected: (id: string, event: MouseEvent | null) => void;
  onOpen: (id: string, event: MouseEvent) => void;
  onAction: (action: ReviewAction, ids: string[]) => void;
  onComment: (finding: ReviewFinding) => void;
}

export function ReviewFindingRow({
  finding,
  selected,
  focused = false,
  fadeIn = false,
  dense = false,
  disabled = false,
  onToggleSelected,
  onOpen,
  onAction,
  onComment,
}: ReviewFindingRowProps) {
  const resolved = finding.status === 'dismissed' || finding.status === 'fixed';
  const location = formatFindingLocation(finding);
  return (
    <li
      data-finding-id={finding.id}
      className={cx(
        'group relative flex items-start gap-2.5 rounded-lg border px-2 transition-colors',
        dense ? 'py-1' : 'py-1.5',
        focused ? 'border-accent/70 bg-bg-hover/50' : 'border-transparent hover:bg-bg-hover/50',
        'focus-within:bg-bg-hover/50',
        fadeIn &&
          'transition-opacity duration-300 starting:opacity-0 motion-reduce:transition-none',
      )}
    >
      <input
        type="checkbox"
        className="mt-1 size-3.5 shrink-0 cursor-pointer accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        checked={selected}
        aria-label={`Select finding ${finding.id}: ${finding.title}`}
        onChange={() => onToggleSelected(finding.id, null)}
        onClick={(event) => {
          if (event.shiftKey || event.metaKey || event.ctrlKey) {
            event.preventDefault();
            onToggleSelected(finding.id, event);
          }
        }}
      />
      <SeverityBadge severity={finding.severity} className="mt-0.5 w-[4.75rem]" />
      <button
        type="button"
        className="min-w-0 flex-1 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
        onClick={(event) => onOpen(finding.id, event)}
        aria-label={`${finding.title}, ${location}. Open in the review workbench.`}
      >
        <span
          className={cx(
            'block truncate leading-snug',
            resolved
              ? 'text-text-tertiary line-through decoration-text-tertiary/60'
              : 'text-text-primary',
          )}
          title={finding.title}
        >
          {finding.title}
        </span>
        <span className="mt-0.5 block break-all font-mono text-xs text-text-tertiary">
          {location}
        </span>
      </button>
      <StatusChip status={finding.status} className="mt-0.5" />
      <div
        className={cx(
          'flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none',
          focused && 'opacity-100',
        )}
      >
        {finding.status === 'open' || finding.status === 'fix-requested' ? (
          <IconButton
            icon={Check}
            label={`Accept ${finding.id}`}
            disabled={disabled}
            onClick={() => onAction('accept', [finding.id])}
          />
        ) : null}
        {!resolved ? (
          <IconButton
            icon={Wrench}
            label={`Ask the agent to fix ${finding.id}`}
            disabled={disabled}
            onClick={() => onAction('ask_fix', [finding.id])}
          />
        ) : null}
        {finding.status !== 'dismissed' && finding.status !== 'fixed' ? (
          <IconButton
            icon={X}
            label={`Dismiss ${finding.id}`}
            disabled={disabled}
            onClick={() => onAction('dismiss', [finding.id])}
          />
        ) : (
          <IconButton
            icon={RotateCcw}
            label={`Reopen ${finding.id}`}
            disabled={disabled}
            onClick={() => onAction('reopen', [finding.id])}
          />
        )}
        <IconButton
          icon={MessageSquarePlus}
          label={`Comment on ${finding.id}`}
          onClick={() => onComment(finding)}
        />
      </div>
    </li>
  );
}
