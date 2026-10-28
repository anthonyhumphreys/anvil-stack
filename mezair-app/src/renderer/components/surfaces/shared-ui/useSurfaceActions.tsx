import { useCallback, useState, type ReactNode, type Ref } from 'react';
import { MessageSquarePlus } from 'lucide-react';
import type { SurfaceActionResult, SurfaceAnchor } from '../../../../shared/surfaces/types';
import { ConfirmDialog, IconButton, cx } from '../../ui';
import type { SurfaceViewProps } from '../types';

export interface ActionStatus {
  tone: 'ok' | 'error';
  text: string;
}

export interface PendingConfirm {
  action: string;
  targetIds: string[];
  title: string;
  description: string;
  confirmLabel: string;
}

/** Mirrors the main-process cap on targets per action (src/main/surfaces/actions.ts). */
export const MAX_ACTION_TARGETS = 200;

/**
 * Runs surface actions with a pending flag and a polite status line.
 * Mutations go through `confirm` first: the click plus this confirmation is
 * the user's approval (§5.3).
 */
export function useSurfaceActions(onAction: SurfaceViewProps['onAction']) {
  const [pending, setPending] = useState<string | null>(null);
  const [status, setStatus] = useState<ActionStatus | null>(null);
  const [confirming, setConfirming] = useState<PendingConfirm | null>(null);

  const run = useCallback(
    async (
      action: string,
      targetIds: string[] = [],
      note?: string,
    ): Promise<SurfaceActionResult> => {
      if (targetIds.length > MAX_ACTION_TARGETS) {
        const error = `Select at most ${MAX_ACTION_TARGETS} items for one action.`;
        setStatus({ tone: 'error', text: error });
        return { ok: false, error };
      }
      setPending(action);
      setStatus(null);
      try {
        const result = await onAction({ action, targetIds, ...(note ? { note } : {}) });
        if (result.pendingApproval) {
          setStatus({ tone: 'ok', text: result.message ?? 'Waiting for approval.' });
        } else if (result.ok) {
          setStatus(result.message ? { tone: 'ok', text: result.message } : null);
        } else {
          setStatus({ tone: 'error', text: result.error ?? result.message ?? 'Action failed.' });
        }
        return result;
      } catch (error) {
        const text = error instanceof Error ? error.message : 'Action failed.';
        setStatus({ tone: 'error', text });
        return { ok: false, error: text };
      } finally {
        setPending(null);
      }
    },
    [onAction],
  );

  const confirm = useCallback((request: PendingConfirm) => setConfirming(request), []);

  const confirmDialog: ReactNode = (
    <ConfirmDialog
      open={confirming !== null}
      title={confirming?.title ?? ''}
      description={confirming?.description}
      confirmLabel={confirming?.confirmLabel ?? 'Confirm'}
      loading={pending !== null}
      onCancel={() => setConfirming(null)}
      onConfirm={() => {
        const request = confirming;
        setConfirming(null);
        if (request) void run(request.action, request.targetIds);
      }}
    />
  );

  return { run, pending, status, confirm, confirmDialog, clearStatus: () => setStatus(null) };
}

export function ActionStatusLine({ status }: { status: ActionStatus | null }) {
  return (
    <p
      role="status"
      aria-live="polite"
      className={cx(
        'min-h-[1rem] text-xs',
        status?.tone === 'error' ? 'text-error' : 'text-text-tertiary',
      )}
    >
      {status?.text ?? ''}
    </p>
  );
}

export function CommentButton({
  anchor,
  onComment,
  label = 'Comment',
}: {
  anchor: SurfaceAnchor;
  onComment: (anchor: SurfaceAnchor) => void;
  label?: string;
}) {
  return (
    <IconButton
      icon={MessageSquarePlus}
      label={label}
      onClick={(event) => {
        event.stopPropagation();
        onComment(anchor);
      }}
    />
  );
}

/** Streaming placeholder: reserved rows, opacity pulse only (none under reduced motion). */
export function SurfaceSkeleton({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-2 py-1">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="h-3 rounded-sm bg-bg-tertiary motion-safe:animate-pulse"
          style={{ width: `${88 - index * 14}%` }}
        />
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function FilterInput({
  value,
  onChange,
  placeholder,
  label,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
  inputRef?: Ref<HTMLInputElement>;
}) {
  return (
    <input
      ref={inputRef}
      type="search"
      value={value}
      aria-label={label}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && value) {
          event.stopPropagation();
          onChange('');
        }
      }}
      className="min-w-0 flex-1 rounded-lg border border-border bg-bg-primary px-2.5 py-1 text-xs text-text-primary placeholder:text-text-muted focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    />
  );
}

export function FilterSelect<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T | 'all';
  onChange: (value: T | 'all') => void;
  options: Array<{ value: T | 'all'; label: string }>;
  label: string;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value as T | 'all')}
      className="rounded-lg border border-border bg-bg-primary px-2 py-1 text-xs text-text-secondary focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** Download text as a file purely in the renderer. */
export function downloadText(fileName: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
