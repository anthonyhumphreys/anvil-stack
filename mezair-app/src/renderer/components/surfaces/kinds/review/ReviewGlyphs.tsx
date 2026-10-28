import {
  Ban,
  Check,
  CheckCheck,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDot,
  Diamond,
  Hourglass,
  Info,
  OctagonAlert,
  TriangleAlert,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  DECISION_LABEL,
  SEVERITY_LABEL,
  STATUS_LABEL,
} from '../../../../../shared/surfaces/kinds/review/model';
import type {
  ReviewDecision,
  ReviewFindingStatus,
  ReviewSeverity,
} from '../../../../../shared/surfaces/kinds/review/types';
import { cx } from '../../../ui';

// Severity, decision and status are always shape + label (+ semantic colour),
// never colour alone.

export const SEVERITY_ICON: Record<ReviewSeverity, LucideIcon> = {
  critical: OctagonAlert,
  high: TriangleAlert,
  medium: Diamond,
  low: Circle,
  info: Info,
};

export const SEVERITY_TONE: Record<ReviewSeverity, string> = {
  critical: 'text-error',
  high: 'text-error',
  medium: 'text-warning',
  low: 'text-info',
  info: 'text-text-tertiary',
};

export function SeverityBadge({
  severity,
  compact = false,
  className,
}: {
  severity: ReviewSeverity;
  /** Icon only, with the label kept for assistive tech and as a tooltip. */
  compact?: boolean;
  className?: string;
}) {
  const Icon = SEVERITY_ICON[severity];
  const label = SEVERITY_LABEL[severity];
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center gap-1 text-xs font-medium',
        SEVERITY_TONE[severity],
        className,
      )}
      title={compact ? `${label} severity` : undefined}
    >
      <Icon size={13} aria-hidden="true" strokeWidth={2.25} />
      {compact ? <span className="sr-only">{label}</span> : label}
    </span>
  );
}

const DECISION_ICON: Record<ReviewDecision, LucideIcon> = {
  ship: CircleCheck,
  'ship-with-fixes': CircleDot,
  'needs-work': CircleAlert,
  blocked: Ban,
};

const DECISION_TONE: Record<ReviewDecision, string> = {
  ship: 'text-success',
  'ship-with-fixes': 'text-info',
  'needs-work': 'text-warning',
  blocked: 'text-error',
};

export function DecisionGlyph({
  decision,
  size = 18,
  className,
}: {
  decision: ReviewDecision;
  size?: number;
  className?: string;
}) {
  const Icon = DECISION_ICON[decision];
  return (
    <span className={cx('inline-flex shrink-0', DECISION_TONE[decision], className)}>
      <Icon size={size} aria-hidden="true" strokeWidth={2} />
      <span className="sr-only">{DECISION_LABEL[decision]}</span>
    </span>
  );
}

const STATUS_ICON: Record<ReviewFindingStatus, LucideIcon | null> = {
  open: null,
  accepted: Check,
  dismissed: X,
  'fix-requested': Hourglass,
  fixed: CheckCheck,
};

const STATUS_TONE: Record<ReviewFindingStatus, string> = {
  open: 'border-border text-text-tertiary',
  accepted: 'border-border text-text-secondary',
  dismissed: 'border-border-subtle text-text-tertiary',
  'fix-requested': 'border-info/40 text-info',
  fixed: 'border-success/40 text-success',
};

export function StatusChip({
  status,
  className,
}: {
  status: ReviewFindingStatus;
  className?: string;
}) {
  const Icon = STATUS_ICON[status];
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-px text-xs leading-5',
        STATUS_TONE[status],
        className,
      )}
    >
      {Icon ? <Icon size={11} aria-hidden="true" strokeWidth={2.5} /> : null}
      {STATUS_LABEL[status]}
    </span>
  );
}

export function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="whitespace-nowrap font-mono text-xs tabular-nums">
      <span className="text-success">+{additions}</span>{' '}
      <span className="text-error">
        <span aria-hidden="true">−</span>
        <span className="sr-only">minus </span>
        {deletions}
      </span>
    </span>
  );
}
