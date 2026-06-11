import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Search, TicketPlus, X } from 'lucide-react';
import type { BaFinding, WorkItem, WorkItemCreateInput } from '../../../shared/types';

type ParentMode = 'current' | 'existing' | 'standalone';

interface CreateFindingWorkItemModalProps {
  finding: BaFinding;
  currentWorkItem: WorkItem | null;
  onCreate: (findingId: string, input: WorkItemCreateInput) => Promise<unknown>;
  onClose: () => void;
}

export function CreateFindingWorkItemModal({
  finding,
  currentWorkItem,
  onCreate,
  onClose,
}: CreateFindingWorkItemModalProps) {
  const [parentMode, setParentMode] = useState<ParentMode>(
    currentWorkItem ? 'current' : 'standalone',
  );
  const [title, setTitle] = useState(() => buildDefaultTitle(finding));
  const [description, setDescription] = useState(() =>
    buildDefaultDescription(finding, currentWorkItem),
  );
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<WorkItem[]>([]);
  const [selectedParent, setSelectedParent] = useState<WorkItem | null>(null);
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, []);

  const selectedParentId = useMemo(() => {
    if (parentMode === 'current') {
      return currentWorkItem?.id;
    }
    if (parentMode === 'existing') {
      return selectedParent?.id;
    }
    return undefined;
  }, [currentWorkItem?.id, parentMode, selectedParent?.id]);

  const searchWorkItems = useCallback(
    (value: string) => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }

      const trimmed = value.trim();
      if (!trimmed) {
        setResults([]);
        setSearching(false);
        return;
      }

      setSearching(true);
      searchTimeoutRef.current = setTimeout(async () => {
        try {
          const items = await window.anvil.workitems.search(trimmed);
          setResults(
            items.filter(
              (item) => item.id !== currentWorkItem?.id && item.id !== finding.workItemId,
            ),
          );
        } catch (searchError) {
          console.error('Failed to search work items:', searchError);
          setResults([]);
        } finally {
          setSearching(false);
        }
      }, 250);
    },
    [currentWorkItem?.id, finding.workItemId],
  );

  const handleCreate = useCallback(async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError('A title is required.');
      return;
    }

    if (parentMode === 'existing' && !selectedParent) {
      setError('Choose a parent work item or create a standalone item instead.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await onCreate(finding.id, {
        title: trimmedTitle,
        description: description.trim() || undefined,
        parentId: selectedParentId,
      });
      onClose();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Failed to create work item.');
    } finally {
      setSubmitting(false);
    }
  }, [
    description,
    finding.id,
    onClose,
    onCreate,
    parentMode,
    selectedParent,
    selectedParentId,
    title,
  ]);

  const inputClass =
    'w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus:border-accent/50 focus:outline-none';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-4">
      <div className="w-full max-w-2xl rounded-xl border border-border bg-bg-secondary p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-text-primary">
              Create follow-up work item
            </h3>
            <p className="mt-1 text-sm text-text-secondary">
              Turn this BA finding into a new task under the current item, another existing item, or
              as a standalone piece of work.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="mb-4 rounded-lg border border-border bg-bg-primary/70 p-3">
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-text-tertiary">
            Finding
          </div>
          <p className="mt-2 text-sm leading-relaxed text-text-secondary">{finding.content}</p>
        </div>

        <div className="mb-4 grid gap-2 sm:grid-cols-3">
          {currentWorkItem ? (
            <ModeButton
              active={parentMode === 'current'}
              label="Child of current"
              detail={`${currentWorkItem.id} · ${currentWorkItem.title}`}
              onClick={() => setParentMode('current')}
            />
          ) : null}
          <ModeButton
            active={parentMode === 'existing'}
            label="Child of existing"
            detail="Search for another parent item"
            onClick={() => setParentMode('existing')}
          />
          <ModeButton
            active={parentMode === 'standalone'}
            label="Standalone"
            detail="Create a new task with no parent"
            onClick={() => setParentMode('standalone')}
          />
        </div>

        <div className="space-y-4">
          {parentMode === 'current' && currentWorkItem ? (
            <SelectedParentCard item={currentWorkItem} label="Parent work item" />
          ) : null}

          {parentMode === 'existing' ? (
            <div className="space-y-3">
              {selectedParent ? (
                <SelectedParentCard
                  item={selectedParent}
                  label="Selected parent"
                  onClear={() => {
                    setSelectedParent(null);
                    setQuery('');
                    setResults([]);
                  }}
                />
              ) : (
                <div>
                  <label className="mb-1 block text-sm text-text-secondary">
                    Search work items
                  </label>
                  <div className="relative">
                    <Search
                      size={14}
                      className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"
                    />
                    <input
                      type="text"
                      value={query}
                      onChange={(event) => {
                        setQuery(event.target.value);
                        searchWorkItems(event.target.value);
                      }}
                      placeholder="Search by title or ID..."
                      className={`${inputClass} pl-9 pr-9`}
                      autoFocus
                    />
                    {searching ? (
                      <Loader2
                        size={14}
                        className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-text-tertiary"
                      />
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-text-tertiary">
                    Fuzzy search runs against the active work item provider.
                  </p>
                </div>
              )}

              {!selectedParent && results.length > 0 ? (
                <div className="max-h-60 overflow-y-auto rounded-lg border border-border bg-bg-primary">
                  {results.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => {
                        setSelectedParent(item);
                        setQuery('');
                        setResults([]);
                      }}
                      className="flex w-full items-start gap-3 border-b border-border-subtle px-3 py-3 text-left transition-colors last:border-b-0 hover:bg-bg-tertiary"
                    >
                      <TicketPlus size={14} className="mt-0.5 shrink-0 text-accent" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-text-primary">
                          {item.title}
                        </div>
                        <div className="mt-0.5 text-xs text-text-tertiary">
                          {item.id} · {item.type} · {item.state}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              ) : null}

              {!selectedParent && query.trim() && !searching && results.length === 0 ? (
                <div className="rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-tertiary">
                  No work items matched that search.
                </div>
              ) : null}
            </div>
          ) : null}

          <div>
            <label className="mb-1 block text-sm text-text-secondary">
              Title <span className="text-error">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className={inputClass}
            />
          </div>

          <div>
            <label className="mb-1 block text-sm text-text-secondary">Description</label>
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={7}
              className={`${inputClass} resize-y`}
            />
          </div>

          {error ? (
            <div className="rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-sm text-error">
              {error}
            </div>
          ) : null}
        </div>

        <div className="mt-6 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/85 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? <Loader2 size={14} className="animate-spin" /> : <TicketPlus size={14} />}
            Create work item
          </button>
        </div>
      </div>
    </div>
  );
}

function ModeButton({
  active,
  label,
  detail,
  onClick,
}: {
  active: boolean;
  label: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg border px-3 py-3 text-left transition-colors ${
        active
          ? 'border-accent/35 bg-accent/10'
          : 'border-border bg-bg-primary/60 hover:border-border hover:bg-bg-tertiary'
      }`}
    >
      <div className="text-sm font-medium text-text-primary">{label}</div>
      <div className="mt-1 text-xs leading-relaxed text-text-tertiary">{detail}</div>
    </button>
  );
}

function SelectedParentCard({
  item,
  label,
  onClear,
}: {
  item: WorkItem;
  label: string;
  onClear?: () => void;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-accent/25 bg-accent/5 px-3 py-3">
      <TicketPlus size={16} className="mt-0.5 shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-text-tertiary">
          {label}
        </div>
        <div className="mt-1 text-sm font-medium text-text-primary">{item.title}</div>
        <div className="mt-0.5 text-xs text-text-tertiary">
          {item.id} · {item.type} · {item.state}
        </div>
      </div>
      {onClear ? (
        <button
          onClick={onClear}
          className="rounded p-1 text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary"
          aria-label="Clear parent selection"
        >
          <X size={14} />
        </button>
      ) : null}
    </div>
  );
}

function buildDefaultTitle(finding: BaFinding): string {
  const compact = finding.content.replace(/\s+/g, ' ').trim();
  const trimmed = compact.length > 88 ? `${compact.slice(0, 85).trimEnd()}...` : compact;
  return `${labelForFindingType(finding.type)}: ${trimmed}`;
}

function buildDefaultDescription(finding: BaFinding, currentWorkItem: WorkItem | null): string {
  const contextLine = currentWorkItem
    ? `Source work item: ${currentWorkItem.id} — ${currentWorkItem.title}`
    : `Source work item: ${finding.workItemId}`;

  return [
    'Created from a BA finding in Anvil.',
    contextLine,
    `Finding type: ${labelForFindingType(finding.type)}`,
    '',
    finding.content.trim(),
  ].join('\n');
}

function labelForFindingType(type: BaFinding['type']): string {
  switch (type) {
    case 'compliance':
      return 'Compliance';
    case 'feasibility':
      return 'Feasibility';
    case 'dependency':
      return 'Dependency';
    case 'risk':
      return 'Risk';
    case 'question':
    default:
      return 'Follow-up';
  }
}
