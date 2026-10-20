import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, Loader2, RotateCcw } from 'lucide-react';
import type { AgentUISurfaceIntent } from '../../../shared/agent-ui-intents';
import { getSurfaceKind } from '../../../shared/surfaces/registry';
import type {
  SurfaceActionRequest,
  SurfaceActionResult,
  SurfaceAnchor,
  SurfaceComment,
} from '../../../shared/surfaces/types';
import { Button, ConfirmDialog } from '../ui';
import { useSurfaces } from './surfaces-context';
import { formatRelativeTime, isSyntheticSurfaceId } from './surface-utils';

type ActionRequest = Omit<SurfaceActionRequest, 'surfaceId'>;

interface PendingMutation {
  request: ActionRequest;
  label: string;
  resolve: (result: SurfaceActionResult) => void;
}

function errorMessage(caught: unknown, fallback: string): string {
  return caught instanceof Error && caught.message ? caught.message : fallback;
}

/** Runs declared actions; mutations confirm first, then go through runtime approval in main. */
export function useSurfaceActions(intent: AgentUISurfaceIntent) {
  const [pending, setPending] = useState<PendingMutation | null>(null);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const { readOnly } = useSurfaces();
  const surfaceId = intent.id;
  const kind = intent.payload.surfaceKind;

  const run = useCallback(
    async (request: ActionRequest): Promise<SurfaceActionResult> => {
      setRunning(true);
      setNotice(null);
      try {
        const result = await window.anvil.surfaces.runAction({ ...request, surfaceId });
        if (!result.ok) {
          setNotice({ tone: 'error', text: result.error ?? 'The action did not complete.' });
        } else if (result.pendingApproval) {
          setNotice({ tone: 'info', text: 'Waiting for your approval in the conversation.' });
        } else if (result.message) {
          setNotice({ tone: 'info', text: result.message });
        }
        return result;
      } catch (caught) {
        const error = errorMessage(caught, 'The action could not be started.');
        setNotice({ tone: 'error', text: error });
        return { ok: false, error };
      } finally {
        setRunning(false);
      }
    },
    [surfaceId],
  );

  const onAction = useCallback(
    (request: ActionRequest): Promise<SurfaceActionResult> => {
      const spec = getSurfaceKind(kind)?.actions[request.action];
      if (spec?.semantics.type === 'mutation') {
        if (readOnly) {
          const error = `${spec.label} is unavailable while this thread is read-only.`;
          setNotice({ tone: 'error', text: error });
          return Promise.resolve({ ok: false, error });
        }
        return new Promise((resolve) => setPending({ request, label: spec.label, resolve }));
      }
      return run(request);
    },
    [kind, readOnly, run],
  );

  const confirmElement = (
    <ConfirmDialog
      open={pending !== null}
      title={pending ? `${pending.label}?` : ''}
      description="This changes something outside the conversation. Anvil runs it only after your approval."
      confirmLabel={pending?.label ?? 'Continue'}
      loading={running}
      onConfirm={() => {
        const current = pending;
        setPending(null);
        if (current) void run(current.request).then(current.resolve);
      }}
      onCancel={() => {
        pending?.resolve({ ok: false, error: 'Cancelled' });
        setPending(null);
      }}
    />
  );

  return {
    onAction,
    running,
    notice,
    clearNotice: () => setNotice(null),
    confirmElement,
  };
}

export function useSurfaceComments(surfaceId: string, enabled: boolean) {
  const [comments, setComments] = useState<SurfaceComment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const supported = enabled && !isSyntheticSurfaceId(surfaceId);

  const refresh = useCallback(async () => {
    if (!supported) return;
    try {
      setComments(await window.anvil.surfaces.listComments(surfaceId));
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught, 'Comments could not be loaded.'));
    }
  }, [supported, surfaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const add = useCallback(
    async (anchor: SurfaceAnchor, body: string, sendToAgent: boolean) => {
      const comment = await window.anvil.surfaces.addComment({
        surfaceId,
        anchor,
        body,
        sendToAgent,
      });
      setComments((current) => [...current.filter((item) => item.id !== comment.id), comment]);
      return comment;
    },
    [surfaceId],
  );

  const setStatus = useCallback(async (commentId: string, status: SurfaceComment['status']) => {
    try {
      const updated = await window.anvil.surfaces.setCommentStatus(commentId, status);
      setComments((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught, 'The comment could not be updated.'));
    }
  }, []);

  return {
    supported,
    comments,
    openCount: comments.filter((comment) => comment.status === 'open').length,
    error,
    refresh,
    add,
    setStatus,
  };
}

export function describeAnchor(anchor: SurfaceAnchor): string {
  if (anchor.label) return anchor.label;
  if (anchor.type === 'surface') return 'Whole output';
  if (anchor.filePath) {
    const lines =
      anchor.lineStart !== undefined
        ? `:${anchor.lineStart}${anchor.lineEnd && anchor.lineEnd !== anchor.lineStart ? `-${anchor.lineEnd}` : ''}`
        : '';
    return `${anchor.filePath}${lines}`;
  }
  if (anchor.quote) return `“${anchor.quote.slice(0, 80)}${anchor.quote.length > 80 ? '…' : ''}”`;
  return anchor.targetId ? `${anchor.type} ${anchor.targetId}` : anchor.type;
}

export function SurfaceCommentComposer({
  anchor,
  onSubmit,
  onCancel,
}: {
  anchor: SurfaceAnchor;
  onSubmit: (body: string, sendToAgent: boolean) => Promise<unknown>;
  onCancel: () => void;
}) {
  const [body, setBody] = useState('');
  const [sendToAgent, setSendToAgent] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fieldId = useId();

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const submit = async () => {
    const trimmed = body.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(trimmed, sendToAgent);
    } catch (caught) {
      setError(errorMessage(caught, 'The comment could not be saved.'));
      setSubmitting(false);
    }
  };

  return (
    <form
      className="space-y-2 rounded-lg border border-border bg-bg-secondary p-3"
      aria-label="Comment on output"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          if (!submitting) onCancel();
        }
      }}
    >
      <label htmlFor={fieldId} className="block text-xs text-text-tertiary">
        Comment on <span className="break-words text-text-secondary">{describeAnchor(anchor)}</span>
      </label>
      <textarea
        id={fieldId}
        ref={textareaRef}
        value={body}
        disabled={submitting}
        rows={3}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key === 'Enter' &&
            (event.metaKey || event.ctrlKey) &&
            !event.nativeEvent.isComposing &&
            event.keyCode !== 229
          ) {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder="What should change here?"
        className="w-full resize-y rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm leading-5 text-text-primary outline-none placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
      />
      {error && (
        <p role="alert" className="text-xs text-error">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <label className="mr-auto inline-flex items-center gap-2 text-xs text-text-secondary">
          <input
            type="checkbox"
            checked={sendToAgent}
            disabled={submitting}
            onChange={(event) => setSendToAgent(event.target.checked)}
            className="accent-accent"
          />
          Send to agent
        </label>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!body.trim() || submitting}>
          {submitting && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
          {sendToAgent ? 'Comment and send' : 'Comment'}
        </Button>
      </div>
    </form>
  );
}

export function SurfaceCommentList({
  comments,
  onSetStatus,
}: {
  comments: SurfaceComment[];
  onSetStatus: (commentId: string, status: SurfaceComment['status']) => void;
}) {
  if (comments.length === 0) {
    return (
      <p className="px-1 text-xs leading-5 text-text-tertiary">
        No comments yet. Add one here or select part of the preview to discuss it.
      </p>
    );
  }
  const ordered = [...comments].sort((left, right) =>
    left.status === right.status
      ? Date.parse(left.createdAt) - Date.parse(right.createdAt)
      : left.status === 'open'
        ? -1
        : 1,
  );
  return (
    <ul className="space-y-2">
      {ordered.map((comment) => (
        <li
          key={comment.id}
          className={`rounded-lg border border-border-subtle px-3 py-2 ${comment.status === 'resolved' ? 'opacity-70' : ''}`}
        >
          <p className="break-words text-xs text-text-tertiary">{describeAnchor(comment.anchor)}</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-5 text-text-primary">
            {comment.body}
          </p>
          <div className="mt-1.5 flex items-center gap-2 text-xs text-text-tertiary">
            <span>
              {comment.status === 'resolved' ? 'Resolved' : 'Open'} ·{' '}
              {formatRelativeTime(comment.updatedAt)}
            </span>
            <button
              type="button"
              onClick={() =>
                onSetStatus(comment.id, comment.status === 'open' ? 'resolved' : 'open')
              }
              className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            >
              {comment.status === 'open' ? (
                <>
                  <Check size={12} aria-hidden="true" /> Resolve
                </>
              ) : (
                <>
                  <RotateCcw size={12} aria-hidden="true" /> Reopen
                </>
              )}
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
