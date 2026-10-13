import type { KeyboardEvent, ReactNode } from 'react';
import { cx } from '../ui';

export interface ViewTab<T extends string> {
  id: T;
  label: ReactNode;
  /** Optional counter or badge rendered after the label. */
  meta?: ReactNode;
}

/**
 * Underlined tab strip shared by Workspace (Overview | Repositories |
 * Library), Notes, and repo detail sections. Roving focus with
 * ArrowLeft/ArrowRight/Home/End; selection follows focus.
 */
export function ViewTabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  idPrefix,
  className,
  size = 'md',
}: {
  tabs: ViewTab<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name for the tablist. */
  label: string;
  /** Prefix for tab element ids (`${idPrefix}-${id}`), used for focus and aria. */
  idPrefix: string;
  className?: string;
  size?: 'sm' | 'md';
}) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = Math.max(
      0,
      tabs.findIndex((tab) => tab.id === value),
    );
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    const next = tabs[nextIndex];
    if (!next) return;
    onChange(next.id);
    requestAnimationFrame(() => document.getElementById(`${idPrefix}-${next.id}`)?.focus());
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      className={cx('flex gap-5', className)}
      onKeyDown={handleKeyDown}
    >
      {tabs.map((tab) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            id={`${idPrefix}-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={cx(
              'relative -mb-px flex items-center gap-1.5 border-b-2 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
              size === 'sm' ? 'pb-2 pt-2 text-sm' : 'pb-2.5 pt-3 text-sm',
              selected
                ? 'border-accent text-text-primary'
                : 'border-transparent text-text-tertiary hover:text-text-primary',
            )}
          >
            {tab.label}
            {tab.meta}
          </button>
        );
      })}
    </div>
  );
}
