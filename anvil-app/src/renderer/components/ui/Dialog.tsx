import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { cx } from './cx';

export type DialogSize = 'sm' | 'md' | 'lg' | 'xl';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  /** Rendered as the heading and wired to `aria-labelledby`. */
  title?: ReactNode;
  /** Rendered under the title and wired to `aria-describedby`. */
  description?: ReactNode;
  children?: ReactNode;
  /** Action row, rendered right-aligned under the content. */
  footer?: ReactNode;
  size?: DialogSize;
  closeOnOverlayClick?: boolean;
  closeOnEscape?: boolean;
  /** Focused instead of `[data-autofocus]` / first focusable when provided. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Accessible name when `title` is not provided. */
  ariaLabel?: string;
  className?: string;
}

const SIZE_CLASSES: Record<DialogSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-xl',
  xl: 'max-w-2xl',
};

const FOCUSABLE_SELECTOR =
  'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      !element.hasAttribute('disabled') &&
      element.getAttribute('aria-disabled') !== 'true' &&
      element.getClientRects().length > 0,
  );
}

/**
 * Modal dialog rendered in a portal over a `--color-scrim` overlay.
 *
 * Behaviour: focuses `[data-autofocus]`, `initialFocusRef`, or the first
 * focusable element on open; traps Tab within the panel; closes on Escape and
 * on overlay mousedown (both opt-out); returns focus to the previously
 * focused element on close; locks body scroll while open.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  closeOnOverlayClick = true,
  closeOnEscape = true,
  initialFocusRef,
  ariaLabel,
  className,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const autofocusTarget = panel?.querySelector<HTMLElement>('[data-autofocus]');
    const target =
      initialFocusRef?.current ??
      autofocusTarget ??
      (panel ? focusableElements(panel)[0] : null) ??
      panel;
    target?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [open, initialFocusRef]);

  if (!open) return null;

  const handleOverlayMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    if (closeOnOverlayClick && event.target === event.currentTarget) onClose();
  };

  const handlePanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      if (closeOnEscape) {
        event.stopPropagation();
        onClose();
      }
      return;
    }
    if (event.key !== 'Tab') return;

    const panel = panelRef.current;
    if (!panel) return;
    const focusables = focusableElements(panel);
    if (focusables.length === 0) {
      event.preventDefault();
      panel.focus();
      return;
    }

    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || !panel.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else if (active === last || !panel.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim px-4 py-6"
      onMouseDown={handleOverlayMouseDown}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descriptionId : undefined}
        aria-label={title ? undefined : ariaLabel}
        tabIndex={-1}
        className={cx(
          'animate-fade-in max-h-full w-full overflow-y-auto rounded-xl border border-border bg-bg-secondary p-6 shadow-2xl',
          SIZE_CLASSES[size],
          className,
        )}
        onKeyDown={handlePanelKeyDown}
      >
        {title && (
          <h2 id={titleId} className="text-lg font-semibold text-text-primary">
            {title}
          </h2>
        )}
        {description && (
          <p id={descriptionId} className="mt-1 text-sm text-text-secondary">
            {description}
          </p>
        )}
        {children}
        {footer && <div className="mt-6 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
