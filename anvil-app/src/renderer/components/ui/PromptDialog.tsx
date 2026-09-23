import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from './Button';
import { Dialog } from './Dialog';

export interface PromptDialogProps {
  open: boolean;
  /** Heading, wired to `aria-labelledby`. */
  title: string;
  description?: ReactNode;
  /** Visible label above the input (uppercase eyebrow style). */
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** When false (default), submitting an empty/whitespace value is blocked. */
  allowEmpty?: boolean;
  /** Receives the trimmed input value. */
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

/**
 * Themed replacement for `window.prompt` (e.g. workspace rename). Enter
 * submits, Escape cancels, and the input is focused with its value selected
 * on open.
 */
export function PromptDialog({
  open,
  title,
  description,
  label,
  defaultValue = '',
  placeholder,
  confirmLabel = 'Save',
  cancelLabel = 'Cancel',
  allowEmpty = false,
  onSubmit,
  onCancel,
}: PromptDialogProps) {
  const [value, setValue] = useState(defaultValue);
  const formId = useId();

  useEffect(() => {
    if (open) setValue(defaultValue);
  }, [open, defaultValue]);

  const trimmed = value.trim();
  const canSubmit = allowEmpty || trimmed.length > 0;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (canSubmit) onSubmit(trimmed);
  };

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button type="submit" form={formId} disabled={!canSubmit}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={handleSubmit} className="mt-4">
        <label className="block">
          {label && <span className="text-eyebrow uppercase text-text-tertiary">{label}</span>}
          <input
            className={`workflow-input ${label ? 'mt-1.5' : ''}`}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
            data-autofocus
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
      </form>
    </Dialog>
  );
}
