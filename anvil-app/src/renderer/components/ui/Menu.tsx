import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { cx } from './cx';

export interface MenuTriggerProps {
  ref: Ref<HTMLButtonElement>;
  onClick: () => void;
  'aria-haspopup': 'menu';
  'aria-expanded': boolean;
}

export interface MenuProps {
  /**
   * Render prop for the element that opens the menu. Spread the given props
   * onto a `Button`/`IconButton` (or a plain `<button>`) to get correct
   * `aria-haspopup` / `aria-expanded` wiring:
   *
   * ```tsx
   * <Menu label="Workspace actions" trigger={(props) => (
   *   <IconButton {...props} icon={MoreHorizontal} label="Workspace actions" />
   * )}>
   *   <MenuItem onSelect={rename}>Rename</MenuItem>
   * </Menu>
   * ```
   */
  trigger: (props: MenuTriggerProps) => ReactNode;
  /** Accessible name for the menu panel. */
  label: string;
  /** Horizontal alignment of the panel relative to the trigger. */
  align?: 'start' | 'end';
  /** Which side of the trigger the panel opens on. `top` suits bottom-anchored UI like the chat composer. */
  side?: 'top' | 'bottom';
  /** Called whenever the menu opens or closes. */
  onOpenChange?: (open: boolean) => void;
  className?: string;
  /** Overrides for the floating panel (e.g. width). */
  menuClassName?: string;
  children?: ReactNode;
}

interface MenuContextValue {
  close: (restoreFocus: boolean) => void;
}

const MenuContext = createContext<MenuContextValue | null>(null);

const MENU_ITEM_SELECTOR = '[role="menuitem"]';

function menuItems(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR)).filter(
    (element) => !element.hasAttribute('disabled'),
  );
}

/**
 * Dropdown menu primitive matching the existing floating-panel convention.
 * Uncontrolled open state with an `onOpenChange` hook; Escape and item
 * selection close the menu and return focus to the trigger, outside clicks
 * close without stealing focus, and ArrowUp/ArrowDown/Home/End navigate
 * items once open.
 */
export function Menu({
  trigger,
  label,
  align = 'end',
  side = 'bottom',
  onOpenChange,
  className,
  menuClassName,
  children,
}: MenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const setOpenState = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };

  const close = (restoreFocus: boolean) => {
    setOpenState(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;

    const panel = panelRef.current;
    if (panel) menuItems(panel)[0]?.focus();

    const closeOnOutsidePointer = (event: globalThis.MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpenState(false);
    };
    document.addEventListener('mousedown', closeOnOutsidePointer);
    return () => document.removeEventListener('mousedown', closeOnOutsidePointer);
  }, [open]);

  const handlePanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (!panel) return;
    const items = menuItems(panel);
    const activeIndex = items.indexOf(document.activeElement as HTMLElement);

    const focusItem = (index: number) => {
      if (items.length > 0) items[((index % items.length) + items.length) % items.length]?.focus();
    };

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusItem(activeIndex < 0 ? 0 : activeIndex + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusItem(activeIndex < 0 ? items.length - 1 : activeIndex - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusItem(0);
        break;
      case 'End':
        event.preventDefault();
        focusItem(items.length - 1);
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        close(true);
        break;
      case 'Tab':
        close(false);
        break;
    }
  };

  return (
    <MenuContext.Provider value={{ close }}>
      <div ref={containerRef} className={cx('relative inline-flex', className)}>
        {trigger({
          ref: triggerRef,
          onClick: () => setOpenState(!open),
          'aria-haspopup': 'menu',
          'aria-expanded': open,
        })}
        {open && (
          <div
            ref={panelRef}
            role="menu"
            aria-label={label}
            className={cx(
              'absolute z-50 w-56 overflow-hidden rounded-xl border border-border bg-bg-elevated p-1.5 shadow-[0_16px_40px_rgba(0,0,0,0.32)]',
              side === 'top' ? 'bottom-[calc(100%+4px)]' : 'top-[calc(100%+4px)]',
              align === 'end' ? 'right-0' : 'left-0',
              menuClassName,
            )}
            onKeyDown={handlePanelKeyDown}
          >
            {children}
          </div>
        )}
      </div>
    </MenuContext.Provider>
  );
}

export interface MenuItemProps {
  icon?: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  onSelect: () => void;
  children?: ReactNode;
  className?: string;
}

export function MenuItem({
  icon,
  destructive = false,
  disabled = false,
  onSelect,
  children,
  className,
}: MenuItemProps) {
  const context = useContext(MenuContext);
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      disabled={disabled}
      onClick={() => {
        onSelect();
        context?.close(true);
      }}
      className={cx(
        'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
        'focus:bg-bg-tertiary focus:outline-none disabled:cursor-not-allowed disabled:opacity-50',
        destructive
          ? 'text-error hover:bg-error/10 focus:bg-error/10'
          : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary focus:text-text-primary',
        className,
      )}
    >
      {icon}
      {children}
    </button>
  );
}

/** Section heading inside a menu — uses the DS4 eyebrow token. */
export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-3 pb-1 pt-2 text-eyebrow uppercase text-text-tertiary">{children}</div>;
}

export function MenuSeparator() {
  return <div role="separator" className="mx-1.5 my-1 h-px bg-border-subtle" />;
}
