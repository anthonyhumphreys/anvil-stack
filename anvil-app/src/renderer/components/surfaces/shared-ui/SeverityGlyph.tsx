import {
  SEVERITY_LABELS,
  SURFACE_SEVERITIES,
  type SeverityCounts,
  type SurfaceSeverity,
} from '../../../../shared/surfaces/kinds/findings';
import { cx } from '../../ui';

/** Semantic text colour per severity; always paired with a shape and a label. */
export const SEVERITY_TEXT_CLASS: Record<SurfaceSeverity, string> = {
  critical: 'text-error',
  high: 'text-error',
  medium: 'text-warning',
  low: 'text-info',
  info: 'text-text-tertiary',
};

export const SEVERITY_BG_CLASS: Record<SurfaceSeverity, string> = {
  critical: 'bg-error',
  high: 'bg-error/70',
  medium: 'bg-warning',
  low: 'bg-info',
  info: 'bg-text-tertiary/50',
};

/** Distinct shape per severity (◆ ▲ ■ ● ○) so colour is never the only cue. */
export function SeverityShape({
  severity,
  size = 10,
}: {
  severity: SurfaceSeverity;
  size?: number;
}) {
  const common = { width: size, height: size, viewBox: '0 0 10 10', 'aria-hidden': true as const };
  switch (severity) {
    case 'critical':
      return (
        <svg {...common} className="shrink-0">
          <path d="M5 0.5 9.5 5 5 9.5 0.5 5Z" fill="currentColor" />
        </svg>
      );
    case 'high':
      return (
        <svg {...common} className="shrink-0">
          <path d="M5 0.8 9.6 9.2H0.4Z" fill="currentColor" />
        </svg>
      );
    case 'medium':
      return (
        <svg {...common} className="shrink-0">
          <rect x="1" y="1" width="8" height="8" rx="1" fill="currentColor" />
        </svg>
      );
    case 'low':
      return (
        <svg {...common} className="shrink-0">
          <circle cx="5" cy="5" r="4" fill="currentColor" />
        </svg>
      );
    default:
      return (
        <svg {...common} className="shrink-0">
          <circle cx="5" cy="5" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
  }
}

export function SeverityBadge({
  severity,
  className,
  compact = false,
}: {
  severity: SurfaceSeverity;
  className?: string;
  /** Hide the visible label (keeps it for assistive tech). */
  compact?: boolean;
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 text-xs font-medium',
        SEVERITY_TEXT_CLASS[severity],
        className,
      )}
    >
      <SeverityShape severity={severity} />
      <span className={compact ? 'sr-only' : undefined}>{SEVERITY_LABELS[severity]}</span>
    </span>
  );
}

/** Counts by severity (glyph + number + label) with a proportional strip. */
export function SeveritySummaryBar({
  counts,
  label = 'Findings by severity',
  onSelect,
  selected,
}: {
  counts: SeverityCounts;
  label?: string;
  onSelect?: (severity: SurfaceSeverity) => void;
  selected?: ReadonlySet<SurfaceSeverity>;
}) {
  const total = SURFACE_SEVERITIES.reduce((sum, severity) => sum + counts[severity], 0);
  return (
    <div className="flex flex-col gap-2">
      <ul aria-label={label} className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {SURFACE_SEVERITIES.map((severity) => {
          const content = (
            <>
              <SeverityShape severity={severity} />
              <span className="tabular-nums text-text-primary">{counts[severity]}</span>
              <span className="text-text-secondary">{SEVERITY_LABELS[severity]}</span>
            </>
          );
          const isSelected = selected?.has(severity) ?? false;
          return (
            <li key={severity} className={cx('text-xs', SEVERITY_TEXT_CLASS[severity])}>
              {onSelect ? (
                <button
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() => onSelect(severity)}
                  className={cx(
                    'inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                    isSelected ? 'bg-bg-tertiary ring-1 ring-accent' : 'hover:bg-bg-tertiary',
                  )}
                >
                  {content}
                </button>
              ) : (
                <span className="inline-flex items-center gap-1.5">{content}</span>
              )}
            </li>
          );
        })}
      </ul>
      {total > 0 && (
        <div
          aria-hidden="true"
          className="flex h-1 w-full overflow-hidden rounded-full bg-bg-tertiary"
        >
          {SURFACE_SEVERITIES.map((severity) =>
            counts[severity] > 0 ? (
              <span
                key={severity}
                className={SEVERITY_BG_CLASS[severity]}
                style={{ width: `${(counts[severity] / total) * 100}%` }}
              />
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}
