import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

interface ViewHeaderProps {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function ViewHeader({
  icon: Icon,
  title,
  description,
  meta,
  actions,
  className = '',
}: ViewHeaderProps) {
  return (
    <header className={`shrink-0 border-b border-border bg-bg-secondary/45 px-5 py-4 ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2.5">
            {Icon && <Icon size={18} className="shrink-0 text-accent" aria-hidden="true" />}
            <h1 className="truncate text-base font-semibold text-text-primary">{title}</h1>
            {meta}
          </div>
          {description && (
            <div className="mt-1 max-w-[72ch] text-sm leading-relaxed text-text-secondary">
              {description}
            </div>
          )}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  compact = false,
  className = '',
}: EmptyStateProps) {
  return (
    <div
      className={`flex flex-col items-center justify-center px-6 text-center ${compact ? 'min-h-36 py-6' : 'min-h-64 py-10'} ${className}`}
    >
      {Icon && (
        <div className="grid h-10 w-10 place-items-center rounded-lg bg-bg-tertiary text-text-secondary">
          <Icon size={19} aria-hidden="true" />
        </div>
      )}
      <h2 className={`${Icon ? 'mt-3' : ''} text-sm font-semibold text-text-primary`}>{title}</h2>
      {description && (
        <div className="mt-1 max-w-md text-sm leading-relaxed text-text-tertiary">
          {description}
        </div>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

interface InlineNoticeProps {
  icon?: LucideIcon;
  tone?: 'neutral' | 'info' | 'warning' | 'error' | 'success';
  children: ReactNode;
  className?: string;
}

const NOTICE_TONES = {
  neutral: 'border-border-subtle bg-bg-secondary text-text-secondary',
  info: 'border-info/25 bg-info/5 text-text-secondary',
  warning: 'border-warning/25 bg-warning/5 text-text-secondary',
  error: 'border-error/30 bg-error/5 text-error',
  success: 'border-success/25 bg-success/5 text-text-secondary',
} as const;

export function InlineNotice({
  icon: Icon,
  tone = 'neutral',
  children,
  className = '',
}: InlineNoticeProps) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm ${NOTICE_TONES[tone]} ${className}`}
    >
      {Icon && <Icon size={15} className="mt-0.5 shrink-0" aria-hidden="true" />}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
