import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, GitFork, Loader2, Square } from 'lucide-react';
import type { ChatDelegationAction, ChatDelegationRun } from '../../../shared/chat-delegation';
import { sharedPollingCache } from '../../utils/shared-polling-cache';
import { MarkdownRenderer } from './MarkdownRenderer';
import { agentProviderLabel } from '../../utils/agent-display';

const STATUS: Record<string, string> = {
  queued: 'Queued',
  running: 'Working',
  paused: 'Needs attention',
  completed: 'Finished',
  failed: 'Could not finish',
  cancelled: 'Stopped',
  waiting: 'Waiting',
  interrupted: 'Interrupted',
  skipped: 'Not started',
};
const actionClass =
  'rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-bg-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50';

export function ChatDelegations({ threadId }: { threadId: string }) {
  const [runs, setRuns] = useState<ChatDelegationRun[]>([]);
  const [error, setError] = useState(false);
  const [showOlder, setShowOlder] = useState(false);
  const key = `chat-delegations:${threadId}`;
  useEffect(
    () =>
      sharedPollingCache.subscribe(
        key,
        () => window.anvil.chat.listDelegations(threadId),
        (snapshot) => {
          if (snapshot.value) setRuns(snapshot.value);
          setError(Boolean(snapshot.error));
        },
        { pollIntervalMs: 3000, maxAgeMs: 2000, maxStaleMs: 15000 },
      ),
    [key, threadId],
  );
  if (!runs.length && !error) return null;
  return (
    <section aria-label="Delegated work" className="mt-6 w-full border-t border-border-subtle pt-4">
      <div className="mb-3 flex items-center gap-2 text-xs font-medium text-text-secondary">
        <GitFork size={14} aria-hidden="true" /> Delegated work
        <span className="font-normal text-text-tertiary">{runs.length}</span>
      </div>
      {error && (
        <p className="mb-3 text-xs text-warning" role="status">
          Could not refresh delegated work. Showing the last available status.{' '}
          <button className={actionClass} onClick={() => void sharedPollingCache.refresh(key)}>
            Retry
          </button>
        </p>
      )}
      <div className="divide-y divide-border-subtle">
        {runs
          .filter(
            (run, index) =>
              showOlder ||
              index < 3 ||
              ['running', 'queued', 'paused'].includes(run.status) ||
              run.cancellationPending,
          )
          .map((run) => (
            <DelegationRun
              key={run.id}
              run={run}
              threadId={threadId}
              onRefresh={() => sharedPollingCache.refresh(key)}
            />
          ))}
      </div>
      {runs.length > 3 && (
        <button className={actionClass} onClick={() => setShowOlder(!showOlder)}>
          {showOlder ? 'Show recent work' : 'Show earlier work'}
        </button>
      )}
    </section>
  );
}

function DelegationRun({
  run,
  threadId,
  onRefresh,
}: {
  run: ChatDelegationRun;
  threadId: string;
  onRefresh: () => Promise<void>;
}) {
  const [detail, setDetail] = useState<ChatDelegationRun | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);
  const active = run.status === 'running' || run.status === 'queued' || run.status === 'paused';
  const pending = run.cancellationPending || stopping;
  const status = pending ? 'Stop requested' : STATUS[run.status];
  const version = JSON.stringify(run.tasks.map((task) => [task.id, task.status, task.error]));
  useEffect(() => {
    if (!open) return;
    let current = true;
    const id = ++request.current;
    setLoading(true);
    void window.anvil.chat
      .readDelegation(threadId, run.id)
      .then(
        (value) => {
          if (current && id === request.current) {
            setDetail(value);
            setError(null);
          }
        },
        () => {
          if (current) setError('Could not load the task reports. Close and reopen to retry.');
        },
      )
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [open, threadId, run.id, version]);
  const stop = async () => {
    setStopping(true);
    setError(null);
    try {
      await window.anvil.chat.stopDelegation(threadId, run.id);
      await onRefresh();
    } catch {
      setError('Could not confirm the stop request. Retry or inspect the execution details.');
    } finally {
      setStopping(false);
    }
  };
  const act = async (action: ChatDelegationAction, taskId?: string) => {
    setActing(true);
    setError(null);
    try {
      setDetail(await window.anvil.chat.actOnDelegation(threadId, run.id, action, taskId));
      await onRefresh();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'Could not complete this action. Retry or inspect the execution details.',
      );
    } finally {
      setActing(false);
    }
  };
  return (
    <div className="py-3">
      <div className="flex items-start gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`delegation-${run.id}`}
          onClick={() => setOpen(!open)}
          className="min-w-0 flex-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <span className="block break-words text-sm font-medium text-text-primary">
            {run.title}
          </span>
          <span
            className="mt-1 flex items-center gap-1.5 text-xs text-text-secondary"
            role="status"
          >
            {pending || run.status === 'running' || run.status === 'queued' ? (
              <Loader2
                size={12}
                className="animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : run.status === 'completed' ? (
              <Check size={12} className="text-success" aria-hidden="true" />
            ) : run.status === 'paused' || run.status === 'failed' ? (
              <AlertCircle size={12} className="text-warning" aria-hidden="true" />
            ) : null}
            {status} · {run.tasks.filter((task) => task.status === 'completed').length}/
            {run.tasks.length} tasks
            <span className="ml-1 text-text-tertiary">
              {open ? 'Hide details' : 'Show details'}
            </span>
          </span>
        </button>
        {(active || pending) && (
          <button
            type="button"
            disabled={stopping}
            onClick={() => void stop()}
            className={actionClass}
            aria-label={`${pending ? 'Retry stop for' : 'Stop'} ${run.title}`}
          >
            <span className="inline-flex items-center gap-1">
              <Square size={11} aria-hidden="true" />
              {pending ? 'Retry stop' : 'Stop'}
            </span>
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-warning">
          {error}
        </p>
      )}
      {open && (
        <div id={`delegation-${run.id}`} className="mt-3 space-y-3">
          <p className="max-w-[72ch] text-xs leading-5 text-text-secondary">{run.reason}</p>
          {(detail?.tasks ?? run.tasks).map((task) => (
            <div key={task.id} className="border-t border-border-subtle pt-3">
              <div className="flex flex-wrap items-baseline justify-between gap-1 text-xs">
                <span className="max-w-full break-words font-medium text-text-primary">
                  {task.name}
                </span>
                <span className="text-text-tertiary">
                  {pending && task.status === 'cancelled' ? 'Stop requested' : STATUS[task.status]}
                </span>
              </div>
              <p className="mt-1 break-words text-xs text-text-tertiary">
                {task.destination} · {agentProviderLabel(task.provider)} · {task.model} ·{' '}
                {task.mode === 'read-only' ? 'Read only' : 'Chat access'}
              </p>
              {task.error && (
                <p className="mt-2 whitespace-pre-wrap break-words text-xs text-warning">
                  {task.error}
                </p>
              )}
              {task.output && (
                <div className="mt-2 max-h-72 max-w-[72ch] overflow-auto break-words text-sm text-text-primary">
                  <MarkdownRenderer content={task.output} />
                </div>
              )}
              {task.outputTruncated && (
                <p className="mt-1 text-xs text-text-tertiary">
                  Report shortened. Full output is available in execution details.
                </p>
              )}
              {!active &&
                !pending &&
                (task.status === 'failed' || task.status === 'interrupted') && (
                  <button
                    disabled={acting}
                    className={`${actionClass} mt-2`}
                    onClick={() => void act('retry', task.id)}
                  >
                    Retry {task.name}
                  </button>
                )}
              {run.status === 'paused' && task.status === 'interrupted' && (
                <button
                  disabled={acting}
                  className={`${actionClass} mt-2`}
                  onClick={() => void act('retry', task.id)}
                >
                  Retry {task.name}
                </button>
              )}
            </div>
          ))}
          {loading && (
            <p role="status" className="text-xs text-text-tertiary">
              Loading task reports…
            </p>
          )}
          {run.error && (
            <p className="whitespace-pre-wrap break-words text-xs text-warning">{run.error}</p>
          )}
          {run.hasRemoteChanges && (
            <p className="text-xs text-text-secondary">
              {run.integrationState === 'integrated'
                ? 'Result branches combined in an integration checkout.'
                : run.status === 'completed'
                  ? 'Returned code awaits integration. Combine result branches in a separate checkout, then review and verify the changes.'
                  : 'Remote code changes need explicit integration when the work finishes.'}
            </p>
          )}
          {run.hasRemoteChanges && run.status === 'completed' && !run.integrationState && (
            <button disabled={acting} className={actionClass} onClick={() => void act('integrate')}>
              Combine result branches
            </button>
          )}
          {run.integrationState && run.integrationState !== 'integrated' && (
            <p role="status" className="text-xs text-warning">
              Integration needs attention. Open execution details to inspect and resolve it.
            </p>
          )}
          {run.status === 'paused' && !run.tasks.some((task) => task.status === 'interrupted') && (
            <button disabled={acting} className={actionClass} onClick={() => void act('resume')}>
              Resume work
            </button>
          )}
          {run.cancellationPending && (
            <p className="text-xs text-text-secondary">
              Waiting for the remote worker to confirm it stopped.
            </p>
          )}
          <a
            href={`#/workflows?run=${encodeURIComponent(run.id)}`}
            className={`${actionClass} inline-block`}
          >
            Execution details
          </a>
        </div>
      )}
    </div>
  );
}
