import { useEffect, useMemo, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  LoaderCircle,
  MessageSquarePlus,
  Pencil,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import type {
  ChatLayout,
  ChatThread,
  CodexMode,
  CodexSession,
  Persona,
  RepoInfo,
} from '../../../shared/types';
import { ResizableSidebarPanel } from '../layout/ResizableSidebarPanel';
import { ConfirmDialog } from '../ui';
import { isEditableShortcutTarget } from '../../utils/keyboard';
import { ChatAccessLevelBadge } from './ChatAccessLevelChip';
import { ChatLayoutToggle } from './ChatLayoutToggle';
import {
  activeChatThreadStatusFilter,
  CHAT_THREAD_STATUS_FILTERS,
  filterChatThreads,
  toggleChatThreadStatusFilter,
  type ChatThreadSearchContext,
} from './chat-thread-search';

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
  /** CH4/CH9 — Chat/Tickets layout toggle lives in the rail header. */
  chatLayout?: ChatLayout;
  onChatLayoutChange?: (layout: ChatLayout) => void;
  /** CH1 — per-thread access level display. */
  accessLevels?: Record<string, CodexMode>;
  defaultAccessLevel?: CodexMode;
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
  chatLayout,
  onChatLayoutChange,
  accessLevels,
  defaultAccessLevel = 'on-request',
}: ChatThreadRailProps) {
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [filter, setFilter] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<ChatThread | null>(null);
  const searchContext = useMemo<ChatThreadSearchContext>(
    () => ({
      repoNames: new Map(repos.map((repo) => [repo.id, repo.name])),
      personaNames: new Map(personas.map((persona) => [persona.id, persona.name])),
      liveThreadStatuses,
    }),
    [liveThreadStatuses, personas, repos],
  );
  const visibleThreads = useMemo(
    () => filterChatThreads(threads, filter, searchContext),
    [threads, filter, searchContext],
  );
  const { activeThreads, settledThreads } = useMemo(
    () => partitionThreads(visibleThreads),
    [visibleThreads],
  );
  const { needsUserThreads, otherActiveThreads } = useMemo(
    () => partitionNeedsUserThreads(activeThreads),
    [activeThreads],
  );
  const filtering = filter.trim().length > 0;
  const activeStatusFilter = activeChatThreadStatusFilter(filter);

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
    const editing = editingThreadId === thread.id;
    const liveStatus = liveThreadStatuses[thread.id];
    const displayState = getThreadDisplayState(thread, liveStatus, active);
    const settleAllowed = canSettleThread(thread, liveStatus);
    const accessLevel = accessLevels?.[thread.id] ?? defaultAccessLevel;
    const context =
      thread.workItemTitle ??
      (thread.activeRepoId ? searchContext.repoNames.get(thread.activeRepoId) : undefined) ??
      searchContext.personaNames.get(thread.personaId);

    const rowContent = (
      <>
        <ThreadStatusIcon state={displayState} />
        <div className="min-w-0 flex-1">
          {editing ? (
            <input
              autoFocus
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              onClick={(event) => event.stopPropagation()}
              aria-label={`Rename ${thread.title}`}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitRename();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setEditingThreadId(null);
                }
              }}
              className="w-full rounded-lg border border-border bg-bg-secondary px-2 py-1 text-sm text-text-primary outline-none focus:border-accent/40 focus-visible:ring-2 focus-visible:ring-accent/40"
            />
          ) : (
            <p
              className="line-clamp-2 text-sm font-medium leading-snug text-text-primary"
              title={thread.title}
            >
              {thread.title}
            </p>
          )}
          {!compact && thread.summary && (
            <p className="mt-1 line-clamp-1 text-xs leading-snug text-text-tertiary">
              {thread.summary}
            </p>
          )}
          {!compact && (
            <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <span className={threadStateTextClass(displayState)}>
                {threadStateLabel(displayState)}
              </span>
              {context && (
                <>
                  <span className="text-text-tertiary/60">·</span>
                  <span className="max-w-full truncate text-text-tertiary">{context}</span>
                </>
              )}
              {accessLevels && <ChatAccessLevelBadge level={accessLevel} />}
            </div>
          )}
        </div>
      </>
    );

    return (
      <div
        key={thread.id}
        className={`group flex min-w-0 rounded-lg transition-colors ${
          active ? 'bg-accent/10' : 'hover:bg-bg-tertiary/55'
        }`}
      >
        {editing ? (
          <div
            className={`flex min-w-0 flex-1 items-start gap-2 ${compact ? 'px-2.5 py-2' : 'px-2.5 py-2.5'}`}
          >
            {rowContent}
          </div>
        ) : (
          <button
            type="button"
            aria-current={active ? 'true' : undefined}
            title={thread.title}
            onClick={() => onSelectThread(thread.id)}
            className={`flex min-w-0 flex-1 cursor-pointer items-start gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50 ${
              compact ? 'px-2.5 py-2' : 'px-2.5 py-2.5'
            }`}
          >
            {rowContent}
          </button>
        )}
        <div className={getThreadActionVisibilityClass()}>
          {editing ? (
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
                onClick={() => setDeleteTarget(thread)}
              >
                <Trash2 size={13} />
              </ThreadAction>
            </>
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
      defaultWidth={280}
      minWidth={240}
      maxWidth={440}
      collapsedWidth={44}
      autoCollapseBelow={1500}
      className="border-r border-border/60 bg-bg-secondary/50"
      renderCollapsed={({ expand }) => (
        <div className="flex h-full w-full flex-col items-center gap-3 border-r border-border/60 bg-bg-secondary/50 py-2">
          <button
            type="button"
            onClick={expand}
            className="flex h-8 w-7 items-center justify-center rounded-lg border border-border bg-bg-elevated text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
            title="Expand threads"
            aria-label="Expand threads"
          >
            <ChevronRight size={14} />
          </button>
          <span className="mt-1 [writing-mode:vertical-rl] rotate-180 text-eyebrow font-medium uppercase tracking-[0.2em] text-text-tertiary">
            Threads
          </span>
        </div>
      )}
    >
      <div className="border-b border-border/60 px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="flex min-w-0 items-center gap-2 truncate text-sm font-semibold text-text-primary">
            Threads
            <span className="text-xs font-normal tabular-nums text-text-tertiary">
              {activeThreads.length}
            </span>
          </h3>
          <button
            onClick={onCreateThread}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
            title="New thread"
            aria-label="New thread"
          >
            <MessageSquarePlus size={15} />
          </button>
        </div>

        {chatLayout && onChatLayoutChange && (
          <div className="mt-2.5">
            <ChatLayoutToggle layout={chatLayout} onChange={onChatLayoutChange} />
          </div>
        )}

        <div className="relative mt-2.5">
          <Search
            size={13}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary"
          />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            className="w-full rounded-lg border border-border bg-bg-primary py-1.5 pl-8 pr-3 text-xs text-text-primary outline-none placeholder:text-text-tertiary focus:border-accent/50"
            placeholder="Filter threads…"
            aria-label="Filter threads"
            aria-describedby="chat-thread-filter-help"
          />
        </div>
        <div
          className="mt-2 flex flex-wrap gap-1"
          role="group"
          aria-label="Quick thread status filters"
        >
          {CHAT_THREAD_STATUS_FILTERS.map((status) => {
            const selected = activeStatusFilter === status.value;
            return (
              <button
                key={status.value}
                type="button"
                aria-pressed={selected}
                aria-label={`Filter threads: ${status.label}`}
                onClick={() =>
                  setFilter((query) => toggleChatThreadStatusFilter(query, status.value))
                }
                className={`rounded-md border px-1 py-1 text-xs leading-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
                  selected
                    ? 'border-accent/40 bg-accent/10 text-accent'
                    : 'border-border/70 text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary'
                }`}
              >
                {status.label}
              </button>
            );
          })}
        </div>
        <p id="chat-thread-filter-help" className="mt-1.5 text-xs leading-4 text-text-muted">
          Search text, <span className="font-mono">repo:name</span>,{' '}
          <span className="font-mono">persona:name</span>, or{' '}
          <span className="font-mono">status:done</span> /{' '}
          <span className="font-mono">status:archived</span>.
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
        {activeThreads.length === 0 ? (
          <div className="px-3 py-6 text-center">
            <p className="text-sm font-medium text-text-primary">
              {filtering ? 'No matching active threads' : 'No active threads'}
            </p>
            <p className="mt-1 text-xs text-text-tertiary">
              {filtering
                ? settledThreads.length > 0
                  ? 'Matching archived threads appear below.'
                  : 'Try another search or clear a status filter.'
                : 'Start a thread or restore one below.'}
            </p>
          </div>
        ) : (
          <>
            {needsUserThreads.length > 0 && (
              <section
                className="mb-2 border-b border-border/60 pb-2"
                aria-label="Threads waiting for you"
              >
                <div className="mb-1.5 flex items-center justify-between px-1">
                  <h4 className="text-xs font-semibold text-text-primary">Waiting for you</h4>
                  <span className="rounded-full bg-warning/10 px-1.5 py-0.5 text-xs font-medium tabular-nums text-warning">
                    {needsUserThreads.length}
                  </span>
                </div>
                <div className="space-y-0.5">
                  {needsUserThreads.map((thread) => renderThread(thread, false))}
                </div>
              </section>
            )}
            <div className="space-y-0.5">
              {otherActiveThreads.map((thread) => renderThread(thread, false))}
            </div>
          </>
        )}

        {settledThreads.length > 0 && (
          <section className="mt-5 border-t border-border/60 pt-3" aria-label="Archived threads">
            <div className="mb-1.5 flex items-center justify-between px-1">
              <h4 className="text-xs font-semibold uppercase tracking-[0.12em] text-text-tertiary">
                Archived
              </h4>
              <span className="text-xs tabular-nums text-text-tertiary">
                {settledThreads.length}
              </span>
            </div>
            <div className="space-y-0.5">
              {settledThreads.map((thread) => renderThread(thread, true))}
            </div>
          </section>
        )}
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        title={`Delete "${deleteTarget?.title ?? 'thread'}"?`}
        description="This permanently removes the thread and its history."
        confirmLabel="Delete thread"
        tone="danger"
        onConfirm={() => {
          if (deleteTarget) onDeleteThread(deleteTarget.id);
          setDeleteTarget(null);
        }}
        onCancel={() => setDeleteTarget(null)}
      />
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
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      disabled={disabled}
      className={`rounded-lg p-1.5 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
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

export function partitionNeedsUserThreads(threads: ChatThread[]): {
  needsUserThreads: ChatThread[];
  otherActiveThreads: ChatThread[];
} {
  return {
    needsUserThreads: threads.filter(
      (thread) => thread.attentionState === 'approval' || thread.attentionState === 'input',
    ),
    otherActiveThreads: threads.filter(
      (thread) => thread.attentionState !== 'approval' && thread.attentionState !== 'input',
    ),
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
  // Reveal actions only while the row is hovered or keyboard-focused so titles
  // keep their full width during scanning and never sit underneath the controls.
  return 'pointer-events-none flex min-w-0 max-w-0 shrink-0 items-center gap-0.5 self-start overflow-hidden whitespace-nowrap p-0 opacity-0 transition-all group-hover:pointer-events-auto group-hover:max-w-[6.5rem] group-hover:rounded-lg group-hover:border group-hover:border-border/60 group-hover:bg-bg-secondary group-hover:p-0.5 group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:max-w-[6.5rem] group-focus-within:rounded-lg group-focus-within:border group-focus-within:border-border/60 group-focus-within:bg-bg-secondary group-focus-within:p-0.5 group-focus-within:opacity-100';
}
