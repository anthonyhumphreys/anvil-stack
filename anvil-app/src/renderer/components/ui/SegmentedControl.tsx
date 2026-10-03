import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cx } from './cx';

export interface SegmentedControlOption<T extends string = string> {
  value: T;
  label: ReactNode;
  icon?: LucideIcon;
  disabled?: boolean;
  /** Accessible name override (use when `label` is icon-only or decorative). */
  ariaLabel?: string;
  title?: string;
}

export interface SegmentedControlProps<T extends string = string> {
  options: SegmentedControlOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Fires when the already-selected option is activated (e.g. toggle-off). */
  onReselect?: (value: T) => void;
  /** Required accessible name for the group. */
  label: string;
  size?: 'sm' | 'md';
  className?: string;
}

const SIZE_CLASSES: Record<NonNullable<SegmentedControlProps['size']>, string> = {
  sm: 'px-2.5 py-1 text-xs',
  md: 'px-3 py-1.5 text-sm',
};

/**
 * Mutually-exclusive option switcher (e.g. "Panels: Activity · Canvas ·
 * Preview"). Uses radiogroup semantics: ArrowLeft/ArrowRight (and Up/Down),
 * Home, and End move selection; focus roves to the selected option.
 */
export function SegmentedControl<T extends string = string>({
  options,
  value,
  onChange,
  onReselect,
  label,
  size = 'sm',
  className,
}: SegmentedControlProps<T>) {
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const selectIndex = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    optionRefs.current[index]?.focus();
    if (option.value !== value) onChange(option.value);
    else onReselect?.(option.value);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = Math.max(
      0,
      options.findIndex((option) => option.value === value),
    );
    const count = options.length;

    const step = (direction: 1 | -1) => {
      for (let offset = 1; offset <= count; offset += 1) {
        const index = (((currentIndex + direction * offset) % count) + count) % count;
        if (!options[index].disabled) {
          selectIndex(index);
          return;
        }
      }
    };

    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        step(1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        step(-1);
        break;
      case 'Home':
        event.preventDefault();
        for (let index = 0; index < count; index += 1) {
          if (!options[index].disabled) {
            selectIndex(index);
            break;
          }
        }
        break;
      case 'End':
        event.preventDefault();
        for (let index = count - 1; index >= 0; index -= 1) {
          if (!options[index].disabled) {
            selectIndex(index);
            break;
          }
        }
        break;
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cx('inline-flex gap-1 rounded-lg bg-bg-primary/60 p-0.5', className)}
      onKeyDown={handleKeyDown}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            ref={(element) => {
              optionRefs.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option.ariaLabel}
            title={option.title}
            tabIndex={selected ? 0 : -1}
            disabled={option.disabled}
            onClick={() => selectIndex(index)}
            className={cx(
              'inline-flex items-center gap-1.5 rounded-md font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
              'disabled:cursor-not-allowed disabled:opacity-50',
              SIZE_CLASSES[size],
              selected
                ? 'bg-bg-tertiary text-text-primary'
                : 'text-text-tertiary hover:text-text-primary',
            )}
          >
            {Icon && <Icon size={size === 'sm' ? 12 : 14} aria-hidden="true" />}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
