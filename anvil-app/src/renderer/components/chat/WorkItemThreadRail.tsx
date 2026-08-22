import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  ExternalLink,
  Loader2,
  LoaderCircle,
  Maximize2,
  MessageSquare,
  MessageSquarePlus,
  Pencil,
  RefreshCw,
  Search,
  TicketCheck,
  Trash2,
  X,
} from 'lucide-react';
import type { ChatThread, CodexSession, WorkItem, WorkItemProvider } from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { ResizableSidebarPanel } from '../layout/ResizableSidebarPanel';
import {
  canSettleThread,
  getThreadActionVisibilityClass,
  getThreadDisplayState,
  partitionThreads,
  shouldSelectThreadFromKey,
} from './ChatThreadRail';

interface WorkItemThreadRailProps {
  threads: ChatThread[];
  activeThreadId: string | null;
  liveThreadStatuses: Record<string, CodexSession['status']>;
  onSelectWorkItem: (workItem: WorkItem) => void;
  onSelectThread: (threadId: string) => void;
  onCreateThread: (workItem: WorkItem) => void;
  onRenameThread: (threadId: string, title: string) => void;
  onSettleThread: (threadId: string, settled: boolean) => void;
  onDeleteThread: (threadId: string) => void;
}

export function WorkItemThreadRail({
  threads,
  activeThreadId,
  liveThreadStatuses,
  onSelectWorkItem,
  onSelectThread,
  onCreateThread,
  onRenameThread,
  onSettleThread,
  onDeleteThread,
}: WorkItemThreadRailProps) {
  const { activeWorkspace } = useWorkspace();
  const [items, setItems] = useState<WorkItem[]>([]);
  const [provider, setProvider] = useState<WorkItemProvider | 'none'>('ado');
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailItem, setDetailItem] = useState<WorkItem | null>(null);
  const [expandedItems, setExpandedItems] = useState<Set<string>>(() => new Set());
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');

  const workItemThreads = useMemo(() => groupWorkItemThreads(threads), [threads]);

  const selectedIterations = useMemo(
    () => activeWorkspace?.preferences?.workitems.iterationIds ?? [],
    [activeWorkspace?.preferences?.workitems.iterationIds],
  );

  const loadItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const settings = await window.anvil.settings.get();
      const nextProvider = settings.workItemProvider ?? 'ado';
      setProvider(nextProvider);

      if (nextProvider === 'none') {
        setItems([]);
        return;
      }

      const filters =
        selectedIterations.length > 0 ? { iterationIds: selectedIterations } : undefined;
      const nextItems = await window.anvil.workitems.list(filters);
      setItems(nextItems);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load work items');
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [activeWorkspace?.id, selectedIterations]);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  useEffect(() => {
    setExpandedItems(new Set());
    setEditingThreadId(null);
  }, [activeWorkspace?.id]);

  const ownedItems = useMemo(
    () => mergeWorkItemsWithOwnedThreads(items, threads),
    [items, threads],
  );

  const visibleItems = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return ownedItems;
    return ownedItems.filter((item) =>
      [item.id, item.title, item.type, item.state, item.assignee]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLowerCase().includes(query)),
    );
  }, [filter, ownedItems]);

  useEffect(() => {
    if (!activeThreadId) return;
    const activeThread = threads.find((thread) => thread.id === activeThreadId);
    if (!activeThread?.workItemId || !activeThread.workItemProvider) return;
    const key = buildWorkItemKey(activeThread.workItemProvider, activeThread.workItemId);
    setExpandedItems((current) => (current.has(key) ? current : new Set([...current, key])));
  }, [activeThreadId, threads]);

  useEffect(() => {
    if (!editingThreadId) setDraftTitle('');
  }, [editingThreadId]);

  const toggleItem = (key: string) => {
    setExpandedItems((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const commitRename = () => {
    if (!editingThreadId) return;
    const trimmed = draftTitle.trim();
    if (trimmed) onRenameThread(editingThreadId, trimmed);
    setEditingThreadId(null);
  };

  const renderThread = (thread: ChatThread, archived: boolean) => {
    const active = thread.id === activeThreadId;
    const liveStatus = liveThreadStatuses[thread.id];
    const displayState = getThreadDisplayState(thread, liveStatus, active);
    const settleAllowed = canSettleThread(thread, liveStatus);

    return (
      <div
        key={thread.id}
        className={`group relative rounded-lg border transition-colors ${
          active
            ? 'border-accent/35 bg-accent/10'
            : archived
              ? 'border-transparent hover:border-border/60 hover:bg-bg-tertiary/45'
              : 'border-border/45 bg-bg-secondary/35 hover:border-border hover:bg-bg-tertiary/45'
        }`}
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
            archived ? 'px-2.5 py-2' : 'px-3 py-2.5'
          }`}
        >
          <div className="flex items-start gap-2">
            <WorkItemThreadStatusIcon state={displayState} />
            <div className="min-w-0 flex-1">
              {editingThreadId === thread.id ? (
                <input
                  autoFocus
                  value={draftTitle}
                  onChange={(event) => setDraftTitle(event.target.value)}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      commitRename();
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      setEditingThreadId(null);
                    }
                  }}
                  className="w-full rounded-lg border border-border bg-bg-secondary px-2 py-1 text-xs text-text-primary outline-none focus:border-accent/40"
                  aria-label="Thread title"
                />
              ) : (
                <p className="truncate text-xs font-medium leading-snug text-text-primary">
                  {thread.title}
                </p>
              )}
              {!archived && (
                <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px]">
                  <span className={threadStateTextClass(displayState)}>
                    {threadStateLabel(displayState)}
                  </span>
                  {thread.preview && (
                    <>
                      <span className="text-text-tertiary/60">·</span>
                      <span className="truncate text-text-tertiary">
                        {thread.preview.replace(/\s+/g, ' ').trim()}
                      </span>
                    </>
                  )}
                </div>
              )}
            </div>
            <div className={getThreadActionVisibilityClass()}>
              {editingThreadId === thread.id ? (
                <>
                  <ThreadAction label="Save title" onClick={commitRename}>
                    <Check size={13} />
                  </ThreadAction>
                  <ThreadAction label="Cancel rename" onClick={() => setEditingThreadId(null)}>
                    <X size={13} />
                  </ThreadAction>
                </>
              ) : (
                <>
                  <ThreadAction
                    label={archived ? 'Return to active threads' : 'Archive thread'}
                    disabled={!archived && !settleAllowed}
                    onClick={() => onSettleThread(thread.id, !archived)}
                  >
                    {archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
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
        </div>
      </div>
    );
  };

  return (
    <>
      <ResizableSidebarPanel
        storageKey="chat:work-item-threads"
        side="left"
        title="Work Items"
        defaultWidth={320}
        minWidth={260}
        maxWidth={480}
        collapsedWidth={0}
        autoCollapseBelow={1500}
        className="border-r border-border/60 bg-bg-secondary/50"
      >
        <div className="border-b border-border/60 px-3 py-3 pr-14">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-text-primary">
                <TicketCheck size={15} className="text-accent" />
                Work Items
              </h3>
              <p className="mt-1 truncate text-xs text-text-tertiary">
                {provider === 'none' ? 'No provider configured' : 'Threads grouped by ticket'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void loadItems()}
              disabled={loading}
              className="flex h-9 w-9 items-center justify-center rounded-xl border border-border text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
              title="Refresh work items"
              aria-label="Refresh work items"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>

          <div className="relative mt-3">
            <Search
              size={13}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary"
            />
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              className="w-full rounded-lg border border-border bg-bg-primary py-1.5 pl-8 pr-3 text-sm text-text-primary outline-none placeholder:text-text-tertiary focus:border-accent/50"
              placeholder="Filter tickets..."
              aria-label="Filter work items"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
          {error && (
            <div className="mb-2 flex items-start gap-2 rounded-xl border border-error/25 bg-error/10 px-3 py-2 text-sm text-error">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {loading && items.length === 0 ? (
            <div className="flex h-40 items-center justify-center">
              <Loader2 size={22} className="animate-spin text-accent" />
            </div>
          ) : provider === 'none' && visibleItems.length === 0 ? (
            <EmptyRailState
              title="No provider"
              body="Choose a work-item provider in Settings to use ticket threads."
            />
          ) : visibleItems.length === 0 ? (
            <EmptyRailState
              title={items.length === 0 ? 'No work items' : 'No matches'}
              body={
                items.length === 0
                  ? 'Refresh after configuring your provider or sprint filters.'
                  : 'Try a different title, id, type, or state.'
              }
            />
          ) : (
            <div className="space-y-1.5">
              {visibleItems.map((item) => {
                const key = buildWorkItemKey(item.provider, item.id);
                const itemThreads = workItemThreads.get(key) ?? [];
                const { activeThreads, settledThreads } = partitionThreads(itemThreads);
                const expanded = expandedItems.has(key);
                const active = itemThreads.some((thread) => thread.id === activeThreadId);
                const needsAttention = activeThreads.some((thread) =>
                  ['approval', 'input', 'failed'].includes(
                    getThreadDisplayState(
                      thread,
                      liveThreadStatuses[thread.id],
                      thread.id === activeThreadId,
                    ),
                  ),
                );

                return (
                  <section
                    key={`${item.provider}:${item.id}`}
                    className={`rounded-xl border transition-colors ${
                      active
                        ? 'border-accent/30 bg-accent/5'
                        : 'border-border/55 bg-bg-primary/65 hover:border-border'
                    }`}
                  >
                    <div className="flex items-start gap-1 px-2.5 py-2.5">
                      <button
                        type="button"
                        onClick={() => toggleItem(key)}
                        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent/40"
                        aria-expanded={expanded}
                        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${item.id}`}
                      >
                        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setExpandedItems((current) => new Set([...current, key]));
                          onSelectWorkItem(item);
                        }}
                        className="min-w-0 flex-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                        aria-current={active ? 'true' : undefined}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="shrink-0 rounded-md bg-bg-tertiary px-1.5 py-0.5 font-mono text-[11px] text-text-secondary">
                            {item.id}
                          </span>
                          <span className="truncate text-[11px] text-text-tertiary">
                            {item.type}
                          </span>
                        </div>
                        <p className="mt-1 line-clamp-2 text-sm font-medium leading-snug text-text-primary">
                          {item.title}
                        </p>
                        <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-text-tertiary">
                          {needsAttention ? (
                            <CircleAlert size={11} className="text-warning" />
                          ) : (
                            <MessageSquare size={11} />
                          )}
                          <span>{formatThreadCount(activeThreads.length, 'active')}</span>
                          {settledThreads.length > 0 && (
                            <>
                              <span>·</span>
                              <span>{formatThreadCount(settledThreads.length, 'archived')}</span>
                            </>
                          )}
                          <span className="ml-auto truncate">{item.state}</span>
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setExpandedItems((current) => new Set([...current, key]));
                          onCreateThread(item);
                        }}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent/40"
                        title={`New thread for ${item.id}`}
                        aria-label={`New thread for ${item.id}`}
                      >
                        <MessageSquarePlus size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setDetailItem(item)}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent/40"
                        title={`View ${item.id} details`}
                        aria-label={`View ${item.id} details`}
                      >
                        <Maximize2 size={13} />
                      </button>
                    </div>

                    {expanded && (
                      <div className="border-t border-border/45 px-2.5 pb-2.5 pt-2">
                        {activeThreads.length > 0 ? (
                          <div className="space-y-1.5">
                            {activeThreads.map((thread) => renderThread(thread, false))}
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => onCreateThread(item)}
                            className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border px-3 py-3 text-xs text-text-secondary transition-colors hover:border-accent/35 hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent/40"
                          >
                            <MessageSquarePlus size={13} />
                            Start a thread
                          </button>
                        )}

                        {settledThreads.length > 0 && (
                          <div className="mt-3 border-t border-border/45 pt-2">
                            <div className="mb-1 flex items-center justify-between px-1 text-[11px] text-text-tertiary">
                              <span>Archived</span>
                              <span className="tabular-nums">{settledThreads.length}</span>
                            </div>
                            <div className="space-y-0.5">
                              {settledThreads.map((thread) => renderThread(thread, true))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </ResizableSidebarPanel>

      {detailItem && <WorkItemDetailsModal item={detailItem} onClose={() => setDetailItem(null)} />}
    </>
  );
}

type ThreadDisplayState = ReturnType<typeof getThreadDisplayState>;

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
      className={`rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30 ${className}`}
      title={accessibleLabel}
      aria-label={accessibleLabel}
    >
      {children}
    </button>
  );
}

function WorkItemThreadStatusIcon({ state }: { state: ThreadDisplayState }) {
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

export function groupWorkItemThreads(threads: ChatThread[]): Map<string, ChatThread[]> {
  const groups = new Map<string, ChatThread[]>();
  for (const thread of threads) {
    if (!thread.workItemId || !thread.workItemProvider) continue;
    const key = buildWorkItemKey(thread.workItemProvider, thread.workItemId);
    const group = groups.get(key);
    if (group) group.push(thread);
    else groups.set(key, [thread]);
  }
  return groups;
}

export function mergeWorkItemsWithOwnedThreads(
  items: WorkItem[],
  threads: ChatThread[],
): WorkItem[] {
  const merged = [...items];
  const knownKeys = new Set(items.map((item) => buildWorkItemKey(item.provider, item.id)));
  for (const thread of threads) {
    if (!thread.workItemId || !thread.workItemProvider) continue;
    const key = buildWorkItemKey(thread.workItemProvider, thread.workItemId);
    if (knownKeys.has(key)) continue;
    knownKeys.add(key);
    merged.push({
      id: thread.workItemId,
      provider: thread.workItemProvider,
      title: thread.workItemTitle ?? thread.workItemId,
      type: 'Task',
      state: 'Outside current view',
      priority: 0,
    });
  }
  return merged;
}

function formatThreadCount(count: number, label: 'active' | 'archived'): string {
  return `${count} ${label}`;
}

function EmptyRailState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-border px-4 py-5 text-center">
      <p className="text-sm font-medium text-text-primary">{title}</p>
      <p className="mt-2 text-xs leading-relaxed text-text-tertiary">{body}</p>
    </div>
  );
}

function WorkItemDetailsModal({ item, onClose }: { item: WorkItem; onClose: () => void }) {
  const titleId = useId();
  const description = stripWorkItemHtml(item.description);
  const acceptanceCriteria = stripWorkItemHtml(item.acceptanceCriteria);
  const extras = getDisplayExtras(item.extras);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-4 py-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-bg-elevated shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs text-text-tertiary">
              <span className="rounded-md bg-bg-tertiary px-2 py-1 font-mono text-text-secondary">
                {item.id}
              </span>
              <span>{formatProviderLabel(item.provider)}</span>
              <span>{item.type}</span>
            </div>
            <h3
              id={titleId}
              className="mt-2 text-base font-semibold leading-snug text-text-primary"
            >
              {item.title}
            </h3>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {item.url && (
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                title="Open in provider"
                aria-label="Open in provider"
              >
                <ExternalLink size={13} />
                <span>Open</span>
              </a>
            )}
            <button
              type="button"
              onClick={onClose}
              autoFocus
              className="flex h-8 w-8 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent/40"
              title="Close"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="min-h-0 overflow-y-auto px-5 py-4">
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <DetailValue label="State" value={item.state || 'Unknown'} />
            <DetailValue label="Priority" value={`P${item.priority || 4}`} />
            <DetailValue label="Assignee" value={item.assignee || 'Unassigned'} />
            <DetailValue label="Iteration" value={item.iterationPath || 'Not set'} />
          </dl>

          {item.tags && item.tags.length > 0 && (
            <section className="mt-4">
              <h4 className="text-xs font-medium uppercase tracking-normal text-text-tertiary">
                Tags
              </h4>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {item.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full border border-border bg-bg-primary px-2 py-1 text-xs text-text-secondary"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </section>
          )}

          <WorkItemTextSection
            title="Description"
            text={description}
            emptyText="No description supplied."
          />

          <WorkItemTextSection
            title="Acceptance criteria"
            text={acceptanceCriteria}
            emptyText="No acceptance criteria supplied."
          />

          {item.children && item.children.length > 0 && (
            <section className="mt-4">
              <h4 className="text-xs font-medium uppercase tracking-normal text-text-tertiary">
                Child work items
              </h4>
              <div className="mt-2 space-y-2">
                {item.children.map((child) => (
                  <div
                    key={`${child.provider}:${child.id}`}
                    className="rounded-lg border border-border bg-bg-primary px-3 py-2"
                  >
                    <div className="flex flex-wrap items-center gap-2 text-xs text-text-tertiary">
                      <span className="font-mono text-text-secondary">{child.id}</span>
                      <span>{child.type}</span>
                      <span>{child.state}</span>
                    </div>
                    <p className="mt-1 text-sm font-medium leading-snug text-text-primary">
                      {child.title}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          )}

          {(item.parentId || item.repoUrl || item.linkedCommits?.length || extras.length > 0) && (
            <section className="mt-4">
              <h4 className="text-xs font-medium uppercase tracking-normal text-text-tertiary">
                More detail
              </h4>
              <dl className="mt-2 grid gap-2 sm:grid-cols-2">
                {item.parentId && <DetailValue label="Parent" value={item.parentId} />}
                {item.repoUrl && <DetailLink label="Repository" href={item.repoUrl} />}
                {item.linkedCommits && item.linkedCommits.length > 0 && (
                  <DetailValue label="Linked commits" value={item.linkedCommits.join(', ')} />
                )}
                {extras.map(([label, value]) => (
                  <DetailValue key={label} label={label} value={value} />
                ))}
              </dl>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function DetailValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-bg-primary px-3 py-2">
      <dt className="text-[11px] font-medium uppercase tracking-normal text-text-tertiary">
        {label}
      </dt>
      <dd className="mt-1 break-words text-sm text-text-primary">{value}</dd>
    </div>
  );
}

function DetailLink({ label, href }: { label: string; href: string }) {
  return (
    <div className="rounded-lg border border-border bg-bg-primary px-3 py-2">
      <dt className="text-[11px] font-medium uppercase tracking-normal text-text-tertiary">
        {label}
      </dt>
      <dd className="mt-1">
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex max-w-full items-center gap-1.5 text-sm text-accent hover:underline"
        >
          <ExternalLink size={13} className="shrink-0" />
          <span className="truncate">{href}</span>
        </a>
      </dd>
    </div>
  );
}

function WorkItemTextSection({
  title,
  text,
  emptyText,
}: {
  title: string;
  text: string;
  emptyText: string;
}) {
  return (
    <section className="mt-4">
      <h4 className="text-xs font-medium uppercase tracking-normal text-text-tertiary">{title}</h4>
      <p
        className={`mt-2 whitespace-pre-wrap rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm leading-relaxed ${
          text ? 'text-text-secondary' : 'text-text-tertiary'
        }`}
      >
        {text || emptyText}
      </p>
    </section>
  );
}

function buildWorkItemKey(provider: WorkItemProvider, id: string): string {
  return `${provider}:${id}`;
}

function formatProviderLabel(provider: WorkItemProvider): string {
  if (provider === 'ado') return 'Azure DevOps';
  if (provider === 'jira') return 'Jira';
  return 'Linear';
}

function getDisplayExtras(extras?: Record<string, unknown>): Array<[string, string]> {
  if (!extras) return [];
  return Object.entries(extras)
    .filter(([key, value]) => key !== 'originalType' && value != null && value !== '')
    .map(([key, value]) => [formatExtraLabel(key), formatExtraValue(value)]);
}

function formatExtraLabel(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function formatExtraValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(formatExtraValue).join(', ');
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function stripWorkItemHtml(value?: string): string {
  if (!value) return '';
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/(p|div|li|ul|ol)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
