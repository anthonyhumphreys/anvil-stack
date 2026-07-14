import { useEffect, useMemo, useState } from 'react';
import { Check, MessageSquarePlus, Pencil, Trash2, X } from 'lucide-react';
import type { ChatThread, CodexSession, Persona } from '../../../shared/types';
import { ResizableSidebarPanel } from '../layout/ResizableSidebarPanel';
import { isEditableShortcutTarget } from '../../utils/keyboard';

interface ChatThreadRailProps {
  persona: Persona | null;
  threads: ChatThread[];
  activeThreadId: string | null;
  liveThreadStatuses: Record<string, CodexSession['status']>;
  onSelectThread: (threadId: string) => void;
  onCreateThread: () => void;
  onRenameThread: (threadId: string, title: string) => void;
  onDeleteThread: (threadId: string) => void;
}

export function ChatThreadRail({
  persona,
  threads,
  activeThreadId,
  liveThreadStatuses,
  onSelectThread,
  onCreateThread,
  onRenameThread,
  onDeleteThread,
}: ChatThreadRailProps) {
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');

  useEffect(() => {
    if (!editingThreadId) {
      setDraftTitle('');
    }
  }, [editingThreadId]);

  const emptyLabel = useMemo(
    () => (persona ? `No ${persona.name} threads yet.` : 'No threads yet.'),
    [persona],
  );

  const commitRename = () => {
    if (!editingThreadId) return;
    const trimmed = draftTitle.trim();
    if (!trimmed) {
      setEditingThreadId(null);
      return;
    }
    onRenameThread(editingThreadId, trimmed);
    setEditingThreadId(null);
  };

  return (
    <ResizableSidebarPanel
      storageKey="chat:threads"
      side="left"
      title="Threads"
      defaultWidth={280}
      minWidth={220}
      maxWidth={420}
      collapsedWidth={0}
      autoCollapseBelow={1200}
      className="border-r border-border/60 bg-bg-secondary/50"
    >
      <div className="border-b border-border/60 px-3 py-2.5 pr-14">
        <div className="flex items-center justify-between gap-2">
          <h3 className="truncate text-sm font-semibold text-text-primary">
            {persona ? `${persona.name} threads` : 'Threads'}
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
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {threads.length === 0 ? (
          <div className="m-3 rounded-xl border border-dashed border-border px-4 py-5 text-center">
            <p className="text-sm font-medium text-text-primary">{emptyLabel}</p>
            <p className="mt-2 text-xs leading-relaxed text-text-tertiary">
              Start a new thread to keep separate investigations, follow-ups, and alternate
              approaches organised by persona.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border-subtle">
            {threads.map((thread) => {
              const active = thread.id === activeThreadId;
              const preview = thread.preview?.replace(/\s+/g, ' ').trim();
              const liveStatus = liveThreadStatuses[thread.id];
              const isRunning = liveStatus === 'starting' || liveStatus === 'busy';
              return (
                <div
                  key={thread.id}
                  className={`group transition-colors ${
                    active ? 'bg-accent/10' : 'hover:bg-bg-tertiary/55'
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
                    className="flex w-full cursor-pointer flex-col items-start gap-1.5 px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40"
                  >
                    <div className="flex w-full items-start gap-2">
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
                            className="w-full rounded-lg border border-border bg-bg-secondary px-2.5 py-1.5 text-sm text-text-primary outline-none focus:border-accent/40"
                          />
                        ) : (
                          <p className="truncate text-sm font-medium leading-snug text-text-primary">
                            {thread.title}
                          </p>
                        )}
                      </div>
                      <div className={getThreadActionVisibilityClass()}>
                        {editingThreadId === thread.id ? (
                          <>
                            <button
                              onClick={(event) => {
                                event.stopPropagation();
                                commitRename();
                              }}
                              className="rounded-lg p-1.5 text-success transition-colors hover:bg-success/10"
                              title="Save title"
                              aria-label="Save title"
                            >
                              <Check size={13} />
                            </button>
                            <button
                              onClick={(event) => {
                                event.stopPropagation();
                                setEditingThreadId(null);
                              }}
                              className="rounded-lg p-1.5 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                              title="Cancel rename"
                              aria-label="Cancel rename"
                            >
                              <X size={13} />
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              onClick={(event) => {
                                event.stopPropagation();
                                setEditingThreadId(thread.id);
                                setDraftTitle(thread.title);
                              }}
                              className="rounded-lg p-1.5 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                              title="Rename thread"
                              aria-label="Rename thread"
                            >
                              <Pencil size={13} />
                            </button>
                            <button
                              onClick={(event) => {
                                event.stopPropagation();
                                if (window.confirm(`Delete "${thread.title}"?`)) {
                                  onDeleteThread(thread.id);
                                }
                              }}
                              className="rounded-lg p-1.5 text-text-tertiary transition-colors hover:bg-error/10 hover:text-error"
                              title="Delete thread"
                              aria-label="Delete thread"
                            >
                              <Trash2 size={13} />
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="flex w-full items-center justify-between gap-2 text-[11px] text-text-tertiary">
                      <span className="flex min-w-0 items-center gap-1.5">
                        {liveStatus && (
                          <span
                            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                              isRunning
                                ? 'animate-pulse bg-accent'
                                : liveStatus === 'error'
                                  ? 'bg-error'
                                  : 'bg-success'
                            }`}
                            aria-hidden="true"
                          />
                        )}
                        <span>
                          {isRunning
                            ? 'Running'
                            : `${thread.messageCount} message${thread.messageCount === 1 ? '' : 's'}`}
                        </span>
                      </span>
                      <span>{formatThreadTimestamp(thread.lastMessageAt ?? thread.updatedAt)}</span>
                    </div>

                    <p className="w-full truncate text-xs text-text-tertiary">
                      {preview || 'Empty thread. Add a prompt to get this conversation started.'}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </ResizableSidebarPanel>
  );
}

function formatThreadTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return 'Unknown';

  const diffMs = Date.now() - timestamp;
  const diffMinutes = Math.max(1, Math.floor(diffMs / 60000));

  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) {
    return `${diffDays}d ago`;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(new Date(timestamp));
}

export function shouldSelectThreadFromKey(event: Pick<KeyboardEvent, 'key' | 'target'>): boolean {
  if (isEditableShortcutTarget(event.target)) return false;
  return event.key === 'Enter' || event.key === ' ';
}

export function getThreadActionVisibilityClass(): string {
  return 'flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100';
}
