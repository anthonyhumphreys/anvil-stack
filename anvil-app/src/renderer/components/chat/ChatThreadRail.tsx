import { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  Check,
  CheckCircle2,
  CircleAlert,
  CircleHelp,
  LoaderCircle,
  MessageSquarePlus,
  Pencil,
  Trash2,
  X,
} from 'lucide-react';
import type { ChatThread, CodexSession, Persona, RepoInfo } from '../../../shared/types';
import { ResizableSidebarPanel } from '../layout/ResizableSidebarPanel';
import { isEditableShortcutTarget } from '../../utils/keyboard';

interface ChatThreadRailProps {
  personas: Persona[];
  repos: RepoInfo[];
  threads: ChatThread[];
  activeThreadId: string | null;
  liveThreadStatuses: Record<string, CodexSession['status']>;
  onSelectThread: (threadId: string) => void;
  onCreateThread: () => void;
  onRenameThread: (threadId: string, title: string) => void;
  onSettleThread: (threadId: string, settled: boolean) => void;
  onDeleteThread: (threadId: string) => void;
}

type ThreadDisplayState = 'approval' | 'input' | 'failed' | 'complete' | 'working' | 'idle';

export function ChatThreadRail({
  personas,
  repos,
  threads,
  activeThreadId,
  liveThreadStatuses,
  onSelectThread,
  onCreateThread,
  onRenameThread,
  onSettleThread,
  onDeleteThread,
}: ChatThreadRailProps) {
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const { activeThreads, settledThreads } = useMemo(() => partitionThreads(threads), [threads]);
  const repoNames = useMemo(() => new Map(repos.map((repo) => [repo.id, repo.name])), [repos]);
  const personaNames = useMemo(
    () => new Map(personas.map((persona) => [persona.id, persona.name])),
    [personas],
  );

  useEffect(() => {
    if (!editingThreadId) setDraftTitle('');
  }, [editingThreadId]);

  const commitRename = () => {
    if (!editingThreadId) return;
    const trimmed = draftTitle.trim();
    if (trimmed) onRenameThread(editingThreadId, trimmed);
    setEditingThreadId(null);
  };

  const renderThread = (thread: ChatThread, compact: boolean) => {
    const active = thread.id === activeThreadId;
    const liveStatus = liveThreadStatuses[thread.id];
    const displayState = getThreadDisplayState(thread, liveStatus, active);
    const settleAllowed = canSettleThread(thread, liveStatus);
    const context =
      thread.workItemTitle ??
      (thread.activeRepoId ? repoNames.get(thread.activeRepoId) : undefined) ??
      personaNames.get(thread.personaId);

    return (
      <div
        key={thread.id}
        className={`group relative rounded-xl border transition-colors ${
          active
            ? 'border-accent/35 bg-accent/10'
            : compact
              ? 'border-transparent hover:border-border/60 hover:bg-bg-tertiary/45'
              : 'border-border/55 bg-bg-secondary/45 hover:border-border hover:bg-bg-tertiary/45'
        } ${displayState === 'working' && !active ? 'opacity-70' : ''}`}
      >
        <div
          role="button"
          tabIndex={0}
          aria-current={active ? 'true' : undefined}
          onClick={() => onSelectThread(thread.id)}
          onKeyDown={(event) => {
            if (!shouldSelectThreadFromKey(event)) return;
            event.preventDefault();
            onSelectThread(thread.id);
          }}
          className={`w-full cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 ${
            compact ? 'px-2.5 py-2' : 'px-3 py-3'
          }`}
        >
          <div className="flex items-start gap-2">
            <ThreadStatusIcon state={displayState} />
            <div className="min-w-0 flex-1">
              {editingThreadId === thread.id ? (
                <input
                  autoFocus
                  value={draftTitle}
                  onChange={(event) => setDraftTitle(event.target.value)}
                  onClick={(event) => event.stopPropagation()}
                  aria-label="Thread title"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      commitRename();
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      setEditingThreadId(null);
                    }
                  }}
                  className="w-full rounded-lg border border-border bg-bg-secondary px-2 py-1 text-sm text-text-primary outline-none focus:border-accent/40"
                />
              ) : (
                <p
                  className={`truncate font-medium leading-snug text-text-primary ${
                    compact ? 'text-xs' : 'text-sm'
                  }`}
                >
                  {thread.title}
                </p>
              )}
              {!compact && (
                <div className="mt-1.5 flex min-w-0 items-center gap-2 text-[11px]">
                  <span className={threadStateTextClass(displayState)}>
                    {threadStateLabel(displayState)}
                  </span>
                  {context && (
                    <>
                      <span className="text-text-tertiary/60">·</span>
                      <span className="truncate text-text-tertiary">{context}</span>
                    </>
                  )}
                </div>
              )}
            </div>
            <div className={getThreadActionVisibilityClass()}>
              {editingThreadId === thread.id ? (
                <>
                  <ThreadAction
                    label="Save title"
                    className="text-success hover:bg-success/10"
                    onClick={commitRename}
                  >
                    <Check size={13} />
                  </ThreadAction>
                  <ThreadAction label="Cancel rename" onClick={() => setEditingThreadId(null)}>
                    <X size={13} />
                  </ThreadAction>
                </>
              ) : (
                <>
                  <ThreadAction
                    label={compact ? 'Return to active threads' : 'Archive thread'}
                    disabled={!compact && !settleAllowed}
                    onClick={() => onSettleThread(thread.id, compact ? false : true)}
                  >
                    {compact ? <ArchiveRestore size={13} /> : <Archive size={13} />}
                  </ThreadAction>
                  <ThreadAction
                    label="Rename thread"
                    onClick={() => {
                      setEditingThreadId(thread.id);
                      setDraftTitle(thread.title);
                    }}
                  >
                    <Pencil size={13} />
                  </ThreadAction>
                  <ThreadAction
                    label="Delete thread"
                    className="hover:bg-error/10 hover:text-error"
                    onClick={() => {
                      if (window.confirm(`Delete "${thread.title}"?`)) onDeleteThread(thread.id);
                    }}
                  >
                    <Trash2 size={13} />
                  </ThreadAction>
                </>
              )}
            </div>
          </div>
          {!compact && (
            <p className="mt-2 truncate pl-5 text-xs text-text-tertiary">
              {thread.preview?.replace(/\s+/g, ' ').trim() ||
                'Empty thread. Add a prompt to get this work moving.'}
            </p>
          )}
        </div>
      </div>
    );
  };

  return (
    <ResizableSidebarPanel
      storageKey="chat:threads"
      side="left"
      title="Threads"
      defaultWidth={300}
      minWidth={240}
      maxWidth={440}
      collapsedWidth={0}
      autoCollapseBelow={1500}
      className="border-r border-border/60 bg-bg-secondary/50"
    >
      <div className="border-b border-border/60 px-3 py-3 pr-14">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-text-primary">Threads</h3>
            <p className="mt-0.5 text-[11px] text-text-tertiary">
              {activeThreads.length} active · all assistants
            </p>
          </div>
          <button
            onClick={onCreateThread}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
            title="New thread"
            aria-label="New thread"
          >
            <MessageSquarePlus size={15} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
        {activeThreads.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-4 py-5 text-center">
            <p className="text-sm font-medium text-text-primary">No active work.</p>
            <p className="mt-2 text-xs leading-relaxed text-text-tertiary">
              Start a thread, or return archived work when it needs another pass.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {activeThreads.map((thread) => renderThread(thread, false))}
          </div>
        )}

        {settledThreads.length > 0 && (
          <section className="mt-5 border-t border-border/60 pt-3" aria-label="Archived threads">
            <div className="mb-1.5 flex items-center justify-between px-1">
              <h4 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-tertiary">
                Archived
              </h4>
              <span className="text-[11px] tabular-nums text-text-tertiary">
                {settledThreads.length}
              </span>
            </div>
            <div className="space-y-0.5">
              {settledThreads.map((thread) => renderThread(thread, true))}
            </div>
          </section>
        )}
      </div>
    </ResizableSidebarPanel>
  );
}

function ThreadAction({
  label,
  onClick,
  children,
  className = '',
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  const accessibleLabel = disabled ? 'Finish or resolve this thread before archiving it' : label;
  return (
    <button
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      disabled={disabled}
      className={`rounded-lg p-1.5 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30 ${className}`}
      title={accessibleLabel}
      aria-label={accessibleLabel}
    >
      {children}
    </button>
  );
}

function ThreadStatusIcon({ state }: { state: ThreadDisplayState }) {
  const className = `mt-0.5 h-3.5 w-3.5 shrink-0 ${threadStateTextClass(state)}`;
  if (state === 'working') return <LoaderCircle className={`${className} animate-spin`} />;
  if (state === 'approval') return <CircleAlert className={className} />;
  if (state === 'input') return <CircleHelp className={className} />;
  if (state === 'failed') return <CircleAlert className={className} />;
  if (state === 'complete') return <CheckCircle2 className={className} />;
  return <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-text-tertiary/50" />;
}

function threadStateLabel(state: ThreadDisplayState): string {
  if (state === 'approval') return 'Approval needed';
  if (state === 'input') return 'Input needed';
  if (state === 'failed') return 'Needs a look';
  if (state === 'complete') return 'Ready to archive';
  if (state === 'working') return 'Working';
  return 'Idle';
}

function threadStateTextClass(state: ThreadDisplayState): string {
  if (state === 'approval' || state === 'input') return 'text-warning';
  if (state === 'failed') return 'text-error';
  if (state === 'complete') return 'text-success';
  if (state === 'working') return 'text-accent';
  return 'text-text-tertiary';
}

export function partitionThreads(threads: ChatThread[]): {
  activeThreads: ChatThread[];
  settledThreads: ChatThread[];
} {
  return {
    activeThreads: threads.filter((thread) => !thread.settledAt),
    settledThreads: threads.filter((thread) => Boolean(thread.settledAt)),
  };
}

export function getThreadDisplayState(
  thread: ChatThread,
  liveStatus: CodexSession['status'] | undefined,
  active: boolean,
): ThreadDisplayState {
  if (liveStatus === 'error' || thread.attentionState === 'failed') return 'failed';
  if (thread.attentionState === 'approval') return 'approval';
  if (thread.attentionState === 'input') return 'input';
  if (liveStatus === 'starting' || liveStatus === 'busy' || thread.attentionState === 'working') {
    return 'working';
  }
  const unseenCompletion =
    thread.attentionState === 'complete' &&
    !active &&
    (!thread.lastViewedAt ||
      Date.parse(thread.attentionUpdatedAt ?? '') > Date.parse(thread.lastViewedAt));
  return unseenCompletion ? 'complete' : 'idle';
}

export function canSettleThread(
  thread: ChatThread,
  liveStatus: CodexSession['status'] | undefined,
): boolean {
  const state = getThreadDisplayState(thread, liveStatus, false);
  return state !== 'working' && state !== 'approval' && state !== 'input';
}

export function shouldSelectThreadFromKey(event: Pick<KeyboardEvent, 'key' | 'target'>): boolean {
  if (isEditableShortcutTarget(event.target)) return false;
  return event.key === 'Enter' || event.key === ' ';
}

export function getThreadActionVisibilityClass(): string {
  return 'flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100';
}
