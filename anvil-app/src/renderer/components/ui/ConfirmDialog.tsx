import { useEffect, useState, type ReactNode } from 'react';
import { Button } from './Button';
import { Dialog } from './Dialog';

export interface ConfirmDialogProps {
  open: boolean;
  /** Heading, wired to `aria-labelledby`. */
  title: string;
  /** Body copy explaining the consequence. Rendered via `aria-describedby`. */
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` renders the confirm button in the destructive (error) style. */
  tone?: 'default' | 'danger';
  /**
   * When set, the confirm button stays disabled until the user types this
   * exact string (e.g. a workspace name) — the WS1 type-to-confirm pattern.
   */
  requireText?: string;
  /** Disables confirm while an async action is in flight. */
  loading?: boolean;
  onConfirm: () => void;
  /** Called by the cancel button, Escape, and overlay clicks. */
  onCancel: () => void;
}

/**
 * Themed replacement for `window.confirm`. Focus lands on Cancel by default
 * (first focusable in the footer), so a destructive confirm is never the
 * default focus target; when `requireText` is set, the input is focused.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'default',
  requireText,
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  const needsTyping = requireText !== undefined;
  const confirmDisabled = loading || (needsTyping && typed !== requireText);

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            onClick={onConfirm}
            disabled={confirmDisabled}
          >
            {loading ? 'Working…' : confirmLabel}
          </Button>
        </>
      }
    >
      {needsTyping && (
        <label className="mt-4 block">
          <span className="text-eyebrow uppercase text-text-tertiary">
            Type “{requireText}” to confirm
          </span>
          <input
            className="workflow-input mt-1.5"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            data-autofocus
          />
        </label>
      )}
    </Dialog>
  );
}
