import {
  Ban,
  ChevronRight,
  CircleDashed,
  CircleDot,
  CirclePause,
  Lock,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { FactoryDefinition } from '../../../shared/factories';
import { cx } from '../ui/cx';

export function inputClass(extra?: string): string {
  return cx(
    'factory-field w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary',
    'outline-none transition-colors placeholder:text-text-muted',
    'focus-visible:border-accent/70 focus-visible:ring-2 focus-visible:ring-accent/25 focus-visible:outline-none',
    'disabled:cursor-not-allowed disabled:opacity-60',
    extra,
  );
}

/** A labelled control. Set `group` when the field holds several controls. */
export function Field({
  label,
  hint,
  children,
  className,
  group = false,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
  group?: boolean;
}) {
  const Root = group ? 'div' : 'label';
  return (
    <Root
      className={cx('block min-w-0', className)}
      {...(group ? { role: 'group', 'aria-label': label } : {})}
    >
      <span className="block text-xs font-medium text-text-secondary">{label}</span>
      <span className="mt-1.5 block">{children}</span>
      {hint && <span className="mt-1.5 block text-xs leading-5 text-text-tertiary">{hint}</span>}
    </Root>
  );
}

const FACTORY_STATUS: Record<
  FactoryDefinition['status'] | 'pending',
  { label: string; icon: LucideIcon; className: string }
> = {
  active: { label: 'Active', icon: CircleDot, className: 'text-success' },
  paused: { label: 'Paused', icon: CirclePause, className: 'text-warning' },
  draft: { label: 'Draft', icon: CircleDashed, className: 'text-text-tertiary' },
  inactive: { label: 'Inactive', icon: Ban, className: 'text-text-tertiary' },
  pending: { label: 'Access pending', icon: Lock, className: 'text-warning' },
};

export function factoryStatusKey(factory: FactoryDefinition): keyof typeof FACTORY_STATUS {
  return factory.accessPending ? 'pending' : factory.status;
}

export function FactoryStatus({
  status,
  iconOnly = false,
}: {
  status: keyof typeof FACTORY_STATUS;
  iconOnly?: boolean;
}) {
  const meta = FACTORY_STATUS[status];
  const Icon = meta.icon;
  return (
    <span
      className={cx(
        'inline-flex shrink-0 items-center gap-1.5 text-xs font-medium',
        meta.className,
      )}
      title={iconOnly ? meta.label : undefined}
    >
      <Icon size={13} aria-hidden="true" />
      <span className={iconOnly ? 'sr-only' : undefined}>{meta.label}</span>
    </span>
  );
}

/** A flat, divided section with a disclosure summary. Never a card inside a card. */
export function Disclosure({
  title,
  meta,
  defaultOpen = false,
  children,
}: {
  title: ReactNode;
  meta?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="group border-t border-border-subtle" open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-center gap-2 py-3 text-sm text-text-primary hover:text-text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
        <ChevronRight
          size={14}
          aria-hidden="true"
          className="shrink-0 text-text-tertiary transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none"
        />
        <span className="min-w-0 flex-1 font-medium">{title}</span>
        {meta && <span className="shrink-0 text-xs text-text-tertiary">{meta}</span>}
      </summary>
      <div className="pb-4 pl-[22px]">{children}</div>
    </details>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <code className={cx('font-mono text-[0.92em] text-text-secondary', className)}>{children}</code>
  );
}

export function ExternalAnchor({
  href,
  children,
  icon: Icon,
}: {
  href: string;
  children: ReactNode;
  icon?: LucideIcon;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1.5 rounded-md text-xs text-text-secondary underline decoration-border underline-offset-4 hover:text-text-primary hover:decoration-text-tertiary focus-visible:outline-2 focus-visible:outline-accent"
    >
      {Icon && <Icon size={13} aria-hidden="true" />}
      {children}
    </a>
  );
}

export function TextAction({
  onClick,
  children,
  icon: Icon,
  disabled,
}: {
  onClick: () => void;
  children: ReactNode;
  icon?: LucideIcon;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1.5 rounded-md text-xs text-text-secondary underline decoration-border underline-offset-4 hover:text-text-primary hover:decoration-text-tertiary focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
    >
      {Icon && <Icon size={13} aria-hidden="true" />}
      {children}
    </button>
  );
}

export function Notice({
  tone,
  icon: Icon,
  children,
  action,
}: {
  tone: 'warning' | 'error' | 'info' | 'success' | 'neutral';
  icon?: LucideIcon;
  children: ReactNode;
  action?: ReactNode;
}) {
  const tones = {
    warning: 'border-warning/30 bg-warning/[0.06] text-text-secondary',
    error: 'border-error/30 bg-error/[0.06] text-text-secondary',
    info: 'border-info/30 bg-info/[0.06] text-text-secondary',
    success: 'border-success/30 bg-success/[0.06] text-text-secondary',
    neutral: 'border-border-subtle bg-bg-secondary text-text-secondary',
  } as const;
  const iconTone = {
    warning: 'text-warning',
    error: 'text-error',
    info: 'text-info',
    success: 'text-success',
    neutral: 'text-text-tertiary',
  } as const;
  return (
    <div
      className={cx(
        'flex flex-wrap items-start gap-x-3 gap-y-2 rounded-xl border px-3 py-2.5 text-xs leading-5',
        tones[tone],
      )}
    >
      {Icon && (
        <Icon size={14} aria-hidden="true" className={cx('mt-0.5 shrink-0', iconTone[tone])} />
      )}
      <div className="min-w-0 flex-1">{children}</div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
