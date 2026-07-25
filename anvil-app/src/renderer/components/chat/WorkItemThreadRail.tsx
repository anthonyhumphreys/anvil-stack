import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ExternalLink,
  Loader2,
  Maximize2,
  MessageSquare,
  RefreshCw,
  Search,
  TicketCheck,
  X,
} from 'lucide-react';
import type { ChatThread, CodexSession, WorkItem, WorkItemProvider } from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { ResizableSidebarPanel } from '../layout/ResizableSidebarPanel';

interface WorkItemThreadRailProps {
  threads: ChatThread[];
  activeThreadId: string | null;
  liveThreadStatuses: Record<string, CodexSession['status']>;
  onSelectWorkItem: (workItem: WorkItem) => void;
}

export function WorkItemThreadRail({
  threads,
  activeThreadId,
  liveThreadStatuses,
  onSelectWorkItem,
}: WorkItemThreadRailProps) {
  const { activeWorkspace } = useWorkspace();
  const [items, setItems] = useState<WorkItem[]>([]);
  const [provider, setProvider] = useState<WorkItemProvider | 'none'>('ado');
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailItem, setDetailItem] = useState<WorkItem | null>(null);

  const workItemThreads = useMemo(() => {
    const map = new Map<string, ChatThread>();
    for (const thread of threads) {
      if (!thread.workItemId || !thread.workItemProvider) continue;
      map.set(buildWorkItemKey(thread.workItemProvider, thread.workItemId), thread);
    }
    return map;
  }, [threads]);

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

  const visibleItems = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return items;
    return items.filter((item) =>
      [item.id, item.title, item.type, item.state, item.assignee]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLowerCase().includes(query)),
    );
  }, [filter, items]);

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
                {provider === 'none'
                  ? 'No provider configured'
                  : `${provider.toUpperCase()} items as chat threads`}
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
          ) : provider === 'none' ? (
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
            <div className="space-y-2">
              {visibleItems.map((item) => {
                const thread = workItemThreads.get(buildWorkItemKey(item.provider, item.id));
                const active = thread?.id === activeThreadId;
                const liveStatus = thread ? liveThreadStatuses[thread.id] : undefined;
                const isRunning = liveStatus === 'starting' || liveStatus === 'busy';
                const preview = thread?.preview?.replace(/\s+/g, ' ').trim();

                return (
                  <div
                    key={`${item.provider}:${item.id}`}
                    className={`group rounded-2xl border transition-all ${
                      active
                        ? 'border-accent/30 bg-accent/5 shadow-sm'
                        : 'border-border/60 bg-bg-primary/70 hover:border-border hover:bg-bg-primary'
                    }`}
                  >
                    <div className="flex items-start gap-1 px-3.5 py-3">
                      <button
                        type="button"
                        onClick={() => onSelectWorkItem(item)}
                        className="flex min-w-0 flex-1 flex-col items-start gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                        aria-current={active ? 'true' : undefined}
                      >
                        <div className="flex w-full items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-2">
                              <span className="shrink-0 rounded-md bg-bg-tertiary px-1.5 py-0.5 font-mono text-[11px] text-text-secondary">
                                {item.id}
                              </span>
                              <span className="truncate text-[11px] uppercase tracking-normal text-text-tertiary">
                                {item.type}
                              </span>
                            </div>
                            <p className="mt-1 line-clamp-2 text-sm font-medium leading-snug text-text-primary">
                              {item.title}
                            </p>
                          </div>
                        </div>

                        <div className="flex w-full items-center justify-between gap-2 text-[11px] text-text-tertiary">
                          <span className="flex min-w-0 items-center gap-1.5">
                            {liveStatus ? (
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
                            ) : (
                              <MessageSquare size={11} className="shrink-0 text-text-muted" />
                            )}
                            <span>
                              {isRunning
                                ? 'Running'
                                : thread
                                  ? `${thread.messageCount} message${
                                      thread.messageCount === 1 ? '' : 's'
                                    }`
                                  : 'Not started'}
                            </span>
                          </span>
                          <span className="truncate">{item.state}</span>
                        </div>

                        <p className="line-clamp-2 min-h-[2.5rem] text-xs leading-relaxed text-text-tertiary">
                          {preview ||
                            stripHtml(item.description) ||
                            'Open this item to start its chat.'}
                        </p>
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
                  </div>
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

function stripHtml(value?: string): string {
  return stripWorkItemHtml(value).replace(/\s+/g, ' ').trim();
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
