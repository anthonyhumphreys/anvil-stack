import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  BookOpen,
  ExternalLink,
  FileText,
  GitFork,
  Library,
  Link2,
  ListChecks,
  Loader2,
  MessageSquare,
  RefreshCw,
  Scale,
  Search,
  Wrench,
} from 'lucide-react';
import type { LibraryItem } from '../../../shared/library-ipc';
import type { Feature } from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { chatItemPath, libraryPath, type LibraryFilterKey } from '../../utils/sidebar-navigation';
import { Button, IconButton, cx } from '../ui';
import { EmptyState, InlineNotice } from '../layout/ViewScaffold';
import { SharedLinksList } from '../share/SharedLinksList';
import { LibraryItemDetail } from './LibraryItemDetail';
import {
  availableLibraryChips,
  formatLibraryUpdatedAt,
  libraryEmptyCopy,
  libraryItemOpenAction,
  libraryListFilter,
  librarySubtypeLabel,
  resolveLibraryFilter,
  visibleLibraryItems,
} from './library-model';
import { isFeatureAllowed, useAllowedFeatures } from './useAllowedFeatures';

const AdrsView = lazy(() =>
  import('../adrs/AdrsView').then((module) => ({ default: module.AdrsView })),
);
const DiagramsView = lazy(() =>
  import('../diagrams/DiagramsView').then((module) => ({ default: module.DiagramsView })),
);
const ComplianceView = lazy(() =>
  import('../compliance/ComplianceView').then((module) => ({ default: module.ComplianceView })),
);
const DocsView = lazy(() =>
  import('../docs/DocsView').then((module) => ({ default: module.DocsView })),
);

const TOOL_LABELS: Partial<Record<LibraryFilterKey, string>> = {
  adr: 'ADR browser',
  diagram: 'Diagram editor',
  compliance: 'Compliance generator',
};

/**
 * Workspace Library (spec §10): `/workspace?view=library[&kind=…][&repo=…]`.
 * Lists the head version of every artifact and durable report across the
 * workspace's threads, plus repo knowledge (ADRs, diagrams, compliance docs).
 * Artifacts and reports open on their thread's stage; knowledge opens in the
 * detail pane, and each knowledge kind keeps its full tool one click away
 * (`&tool=1`). Docs embed the provider docs view; Shared embeds the share
 * manager.
 */
export function LibraryView() {
  const navigate = useNavigate();
  const { activeWorkspace, repos } = useWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();
  const allowedFeatures = useAllowedFeatures();
  const isAllowed = useCallback(
    (feature?: Feature) => isFeatureAllowed(allowedFeatures, feature),
    [allowedFeatures],
  );
  const chips = useMemo(() => availableLibraryChips(isAllowed), [isAllowed]);
  const filter = resolveLibraryFilter(searchParams.get('kind'), chips);
  const repoFilter = searchParams.get('repo');
  const toolOpen = searchParams.get('tool') === '1';
  const selectedId = searchParams.get('item');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const workspaceId = activeWorkspace?.id;

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 200);
    return () => window.clearTimeout(timer);
  }, [query]);

  const listFilter = useMemo(
    () => libraryListFilter(filter, { repoId: repoFilter, query: debouncedQuery }),
    [filter, repoFilter, debouncedQuery],
  );
  const showsList = listFilter !== null && !(toolOpen && TOOL_LABELS[filter]);

  useEffect(() => {
    if (!workspaceId || !listFilter || !showsList) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    window.anvil.library
      .list(workspaceId, listFilter)
      .then((next) => {
        if (!cancelled) setItems(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setItems([]);
          setError(err instanceof Error ? err.message : 'Failed to load the Library.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, listFilter, showsList, reloadToken]);

  const visible = useMemo(() => visibleLibraryItems(items, isAllowed), [items, isAllowed]);
  const selected = visible.find((item) => item.id === selectedId) ?? null;

  const updateParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams);
    next.set('view', 'library');
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    setSearchParams(next, { replace: true });
  };

  const selectFilter = (key: LibraryFilterKey) =>
    updateParams({ kind: key === 'all' ? null : key, tool: null, item: null });

  const openItem = (item: LibraryItem) => {
    const action = libraryItemOpenAction(item);
    if (action.type === 'navigate') navigate(action.to);
    else updateParams({ item: item.id });
  };

  const openTool = (kind: LibraryFilterKey, repoId?: string) =>
    navigate(libraryPath({ kind, repoId: repoId ?? repoFilter ?? undefined, tool: true }));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-3 border-b border-border-subtle px-5 py-3">
        <div
          role="toolbar"
          aria-label="Library filters"
          className="flex flex-wrap items-center gap-1.5"
        >
          {chips.map((chip) => {
            const active = chip.key === filter;
            return (
              <button
                key={chip.key}
                type="button"
                aria-pressed={active}
                onClick={() => selectFilter(chip.key)}
                className={cx(
                  'rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                  active
                    ? 'border-accent/40 bg-accent/12 text-text-primary'
                    : 'border-border bg-bg-secondary text-text-secondary hover:bg-bg-tertiary hover:text-text-primary',
                )}
              >
                {chip.label}
              </button>
            );
          })}
        </div>
        {showsList && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative min-w-56 flex-1">
              <span className="sr-only">Search the Library</span>
              <Search
                size={14}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary"
                aria-hidden="true"
              />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search titles, threads, repositories…"
                className="w-full rounded-lg border border-border bg-bg-primary py-1.5 pl-8 pr-3 text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent/50 focus:outline-none"
              />
            </label>
            <label className="flex items-center gap-2 text-xs text-text-tertiary">
              Repository
              <select
                value={repoFilter ?? ''}
                onChange={(event) => updateParams({ repo: event.target.value || null, item: null })}
                className="rounded-lg border border-border bg-bg-primary px-2 py-1.5 text-sm text-text-primary focus:border-accent/50 focus:outline-none"
              >
                <option value="">All repositories</option>
                {repos.map((repo) => (
                  <option key={repo.id} value={repo.id}>
                    {repo.name}
                  </option>
                ))}
              </select>
            </label>
            {TOOL_LABELS[filter] && (
              <Button variant="secondary" size="sm" onClick={() => openTool(filter)}>
                <Wrench size={13} aria-hidden="true" />
                Open {TOOL_LABELS[filter]}
              </Button>
            )}
            <IconButton
              icon={RefreshCw}
              label="Refresh the Library"
              onClick={() => setReloadToken((token) => token + 1)}
            />
          </div>
        )}
        {toolOpen && TOOL_LABELS[filter] && (
          <div className="flex items-center gap-2 text-xs text-text-tertiary">
            <Wrench size={13} aria-hidden="true" />
            <span>{TOOL_LABELS[filter]}</span>
            <button
              type="button"
              onClick={() => updateParams({ tool: null })}
              className="rounded text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            >
              Back to the list
            </button>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1">
        {filter === 'shared' ? (
          <div className="h-full overflow-auto p-5">
            <SharedLinksList workspaceId={workspaceId} />
          </div>
        ) : filter === 'doc' ? (
          <EmbeddedTool>
            <DocsView />
          </EmbeddedTool>
        ) : toolOpen && filter === 'adr' ? (
          <EmbeddedTool>
            <AdrsView />
          </EmbeddedTool>
        ) : toolOpen && filter === 'diagram' ? (
          <EmbeddedTool>
            <DiagramsView repoId={repoFilter ?? undefined} />
          </EmbeddedTool>
        ) : toolOpen && filter === 'compliance' ? (
          <EmbeddedTool>
            <ComplianceView />
          </EmbeddedTool>
        ) : (
          <div className="flex h-full min-h-0">
            <div className="min-w-0 flex-1 overflow-auto">
              {error && (
                <InlineNotice tone="error" className="m-5">
                  {error}
                </InlineNotice>
              )}
              {loading && visible.length === 0 ? (
                <div className="flex items-center gap-2 px-5 py-6 text-sm text-text-tertiary">
                  <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                  Loading the Library…
                </div>
              ) : visible.length === 0 && !error ? (
                <EmptyState
                  icon={Library}
                  {...libraryEmptyCopy(filter, debouncedQuery.trim().length > 0)}
                  action={
                    TOOL_LABELS[filter] ? (
                      <Button variant="secondary" size="sm" onClick={() => openTool(filter)}>
                        Open {TOOL_LABELS[filter]}
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <ul aria-label="Library items" className="divide-y divide-border-subtle">
                  {visible.map((item) => (
                    <LibraryRow
                      key={item.id}
                      item={item}
                      selected={item.id === selected?.id}
                      onOpen={() => openItem(item)}
                      onOpenThread={
                        item.threadId
                          ? () => navigate(chatItemPath(item.threadId ?? ''))
                          : undefined
                      }
                    />
                  ))}
                </ul>
              )}
            </div>
            {selected && (
              <aside
                aria-label={`${selected.title} details`}
                className="flex w-[min(46%,560px)] shrink-0 flex-col border-l border-border-subtle bg-bg-secondary/35"
              >
                <LibraryItemDetail
                  key={selected.id}
                  item={selected}
                  workspaceId={workspaceId}
                  onClose={() => updateParams({ item: null })}
                  onOpenTool={() =>
                    openTool(selected.kind as LibraryFilterKey, selected.repoId ?? undefined)
                  }
                  toolLabel={TOOL_LABELS[selected.kind as LibraryFilterKey]}
                />
              </aside>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function EmbeddedTool({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <Suspense
        fallback={
          <div className="flex items-center gap-2 px-5 py-6 text-sm text-text-tertiary">
            <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            Loading…
          </div>
        }
      >
        {children}
      </Suspense>
    </div>
  );
}

function LibraryItemIcon({ item }: { item: LibraryItem }) {
  const Icon =
    item.kind === 'surface'
      ? ListChecks
      : item.kind === 'adr'
        ? BookOpen
        : item.kind === 'diagram'
          ? GitFork
          : item.kind === 'compliance'
            ? Scale
            : FileText;
  return (
    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-bg-tertiary text-text-secondary">
      <Icon size={15} aria-hidden="true" />
    </span>
  );
}

function LibraryRow({
  item,
  selected,
  onOpen,
  onOpenThread,
}: {
  item: LibraryItem;
  selected: boolean;
  onOpen: () => void;
  onOpenThread?: () => void;
}) {
  const opensThread = item.kind === 'artifact' || item.kind === 'surface';
  const updated = formatLibraryUpdatedAt(item.updatedAt);
  return (
    <li
      className={cx(
        'group relative flex items-center gap-3 px-5 py-2.5',
        selected && 'bg-accent/8',
      )}
    >
      <LibraryItemIcon item={item} />
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={onOpen}
          aria-current={selected || undefined}
          className="block max-w-full truncate text-left text-sm font-medium text-text-primary after:absolute after:inset-0 hover:underline focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-accent/50"
          title={opensThread ? `Open “${item.title}” in its thread` : item.title}
        >
          {item.title}
        </button>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-text-tertiary">
          <span>{librarySubtypeLabel(item)}</span>
          {item.repoName && (
            <>
              <span aria-hidden="true">·</span>
              <span className="truncate">{item.repoName}</span>
            </>
          )}
          {item.threadTitle && onOpenThread && (
            <>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                onClick={onOpenThread}
                className="relative z-10 inline-flex min-w-0 items-center gap-1 truncate rounded hover:text-text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                title={`Open thread “${item.threadTitle}”`}
              >
                <MessageSquare size={11} aria-hidden="true" />
                <span className="truncate">{item.threadTitle}</span>
              </button>
            </>
          )}
          {item.path && !item.threadTitle && (
            <>
              <span aria-hidden="true">·</span>
              <span className="truncate font-mono">{item.path}</span>
            </>
          )}
        </div>
      </div>
      {item.shared && (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-info/10 px-1.5 py-0.5 text-xs text-info">
          <Link2 size={11} aria-hidden="true" />
          Shared
        </span>
      )}
      {updated && (
        <time
          dateTime={item.updatedAt}
          className="w-20 shrink-0 text-right text-xs tabular-nums text-text-tertiary"
        >
          {updated}
        </time>
      )}
      {opensThread && (
        <ExternalLink size={13} className="shrink-0 text-text-muted" aria-hidden="true" />
      )}
    </li>
  );
}
