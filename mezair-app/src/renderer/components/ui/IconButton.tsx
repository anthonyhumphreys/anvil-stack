import type { ButtonHTMLAttributes, Ref } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cx } from './cx';

export type IconButtonSize = 'sm' | 'md';
export type IconButtonVariant = 'ghost' | 'secondary';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: LucideIcon;
  /** Required accessible name — also used as the tooltip. */
  label: string;
  size?: IconButtonSize;
  variant?: IconButtonVariant;
  /** Pixel size passed to the Lucide icon. Defaults to a size that fits `size`. */
  iconSize?: number;
  ref?: Ref<HTMLButtonElement>;
}

const BASE_CLASSES =
  'inline-flex shrink-0 items-center justify-center rounded-md transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

const VARIANT_CLASSES: Record<IconButtonVariant, string> = {
  ghost: 'text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary',
  secondary:
    'border border-border bg-bg-secondary text-text-secondary hover:bg-bg-tertiary hover:text-text-primary',
};

const SIZE_CLASSES: Record<IconButtonSize, string> = {
  sm: 'p-1',
  md: 'p-1.5',
};

const DEFAULT_ICON_SIZE: Record<IconButtonSize, number> = {
  sm: 13,
  md: 15,
};

export function IconButton({
  icon: Icon,
  label,
  size = 'sm',
  variant = 'ghost',
  iconSize,
  type = 'button',
  className,
  ref,
  ...rest
}: IconButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      title={label}
      aria-label={label}
      className={cx(BASE_CLASSES, VARIANT_CLASSES[variant], SIZE_CLASSES[size], className)}
      {...rest}
    >
      <Icon size={iconSize ?? DEFAULT_ICON_SIZE[size]} aria-hidden="true" />
    </button>
  );
}
