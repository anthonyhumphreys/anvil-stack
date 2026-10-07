/**
 * Design-system primitives (DS2). Theme-aware building blocks for the UI
 * remediation workstreams — import from `components/ui`:
 *
 * ```tsx
 * import { Button, IconButton, Dialog, ConfirmDialog, PromptDialog, Menu, MenuItem, SegmentedControl } from '../ui';
 * ```
 *
 * Token notes:
 * - `Button variant="primary"` uses `text-accent-foreground` (never
 *   `text-white` — it fails WCAG AA on the accent, DS1).
 * - `text-eyebrow` (+ `uppercase`) is the only sub-12px text size; readable
 *   text floors at 12px (DS4).
 */
export { Button } from './Button';
export type { ButtonProps, ButtonSize, ButtonVariant } from './Button';
export { IconButton } from './IconButton';
export type { IconButtonProps, IconButtonSize, IconButtonVariant } from './IconButton';
export { Dialog } from './Dialog';
export type { DialogProps, DialogSize } from './Dialog';
export { ConfirmDialog } from './ConfirmDialog';
export type { ConfirmDialogProps } from './ConfirmDialog';
export { PromptDialog } from './PromptDialog';
export type { PromptDialogProps } from './PromptDialog';
export { Menu, MenuItem, MenuLabel, MenuSeparator } from './Menu';
export type { MenuItemProps, MenuProps, MenuTriggerProps } from './Menu';
export { SegmentedControl } from './SegmentedControl';
export type { SegmentedControlOption, SegmentedControlProps } from './SegmentedControl';
export { cx } from './cx';
