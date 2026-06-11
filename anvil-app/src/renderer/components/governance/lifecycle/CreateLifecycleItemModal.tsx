import { useState, useCallback, useRef } from 'react';
import { X, Search, Loader2, TicketCheck } from 'lucide-react';
import type { WorkItem } from '../../../../shared/types';

interface Props {
  workspaceId: string;
  onCreated: () => void;
  onClose: () => void;
}

type CreateMode = 'work-item' | 'manual';

export function CreateLifecycleItemModal({ workspaceId, onCreated, onClose }: Props) {
  const [mode, setMode] = useState<CreateMode>('work-item');

  // Work item search
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<WorkItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedWorkItem, setSelectedWorkItem] = useState<WorkItem | null>(null);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Manual / shared fields
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [changeClassification, setChangeClassification] = useState<
    'major' | 'minor' | 'standard' | ''
  >('');
  const [submitting, setSubmitting] = useState(false);

  const searchWorkItems = useCallback((q: string) => {
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    if (!q.trim()) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimeoutRef.current = setTimeout(async () => {
      try {
        const items = await window.anvil.workitems.search(q);
        setResults(items.slice(0, 15));
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
  }, []);

  const handleSelectWorkItem = useCallback((wi: WorkItem) => {
    setSelectedWorkItem(wi);
    setTitle(wi.title);
    setDescription(wi.description ?? '');
    setQuery('');
    setResults([]);
  }, []);

  const handleCreate = useCallback(async () => {
    if (!title.trim()) return;
    setSubmitting(true);
    try {
      await window.anvil.lifecycle.createItem(workspaceId, {
        title: title.trim(),
        description: description.trim() || undefined,
        changeClassification: changeClassification || undefined,
        linkedWorkItemId: selectedWorkItem?.id,
        linkedWorkItemProvider: selectedWorkItem?.provider,
      });
      onCreated();
    } catch (err) {
      console.error('Failed to create lifecycle item:', err);
    } finally {
      setSubmitting(false);
    }
  }, [workspaceId, title, description, changeClassification, selectedWorkItem, onCreated]);

  const INPUT_CLASS =
    'w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary focus:border-accent/50 focus:outline-none';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-lg rounded-xl border border-border bg-bg-secondary p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-text-primary">New Lifecycle Item</h3>
          <button
            onClick={onClose}
            className="rounded p-0.5 text-text-tertiary hover:text-text-primary"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Mode tabs */}
        <div className="mb-4 flex rounded-lg border border-border bg-bg-primary p-0.5">
          <button
            onClick={() => {
              setMode('work-item');
              setSelectedWorkItem(null);
              setTitle('');
              setDescription('');
            }}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              mode === 'work-item'
                ? 'bg-accent text-white'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            <TicketCheck size={14} />
            From Work Item
          </button>
          <button
            onClick={() => {
              setMode('manual');
              setSelectedWorkItem(null);
              setTitle('');
              setDescription('');
            }}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              mode === 'manual'
                ? 'bg-accent text-white'
                : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            Manual
          </button>
        </div>

        <div className="space-y-4">
          {/* Work item search */}
          {mode === 'work-item' && !selectedWorkItem && (
            <div>
              <label className="mb-1 block text-sm text-text-secondary">Search Work Items</label>
              <div className="relative">
                <Search
                  size={14}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"
                />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    searchWorkItems(e.target.value);
                  }}
                  placeholder="Search by title or ID..."
                  className={`${INPUT_CLASS} pl-9`}
                  autoFocus
                />
                {searching && (
                  <Loader2
                    size={14}
                    className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-text-tertiary"
                  />
                )}
              </div>
              {results.length > 0 && (
                <div className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-border bg-bg-primary">
                  {results.map((wi) => (
                    <button
                      key={wi.id}
                      onClick={() => handleSelectWorkItem(wi)}
                      className="flex w-full items-start gap-2 border-b border-border-subtle px-3 py-2 text-left transition-colors last:border-0 hover:bg-bg-tertiary"
                    >
                      <TicketCheck size={14} className="mt-0.5 shrink-0 text-accent" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-text-primary">
                          {wi.title}
                        </div>
                        <div className="text-xs text-text-tertiary">
                          {wi.id} · {wi.type} · {wi.state}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {query && !searching && results.length === 0 && (
                <div className="mt-2 px-3 py-2 text-sm text-text-tertiary">No work items found</div>
              )}
            </div>
          )}

          {/* Selected work item card */}
          {mode === 'work-item' && selectedWorkItem && (
            <div className="flex items-start gap-3 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2.5">
              <TicketCheck size={16} className="mt-0.5 shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-text-primary">
                  {selectedWorkItem.title}
                </div>
                <div className="text-xs text-text-tertiary">
                  {selectedWorkItem.id} · {selectedWorkItem.type} · {selectedWorkItem.state} ·{' '}
                  {selectedWorkItem.provider.toUpperCase()}
                </div>
              </div>
              <button
                onClick={() => {
                  setSelectedWorkItem(null);
                  setTitle('');
                  setDescription('');
                }}
                className="rounded p-0.5 text-text-tertiary hover:text-text-primary"
                aria-label="Clear selection"
              >
                <X size={14} />
              </button>
            </div>
          )}

          {/* Title — editable, pre-filled from work item */}
          {(mode === 'manual' || selectedWorkItem) && (
            <div>
              <label className="mb-1 block text-sm text-text-secondary">
                Title <span className="text-error">*</span>
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. CRM Platform Replacement"
                autoFocus={mode === 'manual'}
                className={INPUT_CLASS}
              />
            </div>
          )}

          {/* Description — editable, pre-filled from work item */}
          {(mode === 'manual' || selectedWorkItem) && (
            <div>
              <label className="mb-1 block text-sm text-text-secondary">Description</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Optional description"
                rows={3}
                className={INPUT_CLASS}
              />
            </div>
          )}

          {/* Classification */}
          {(mode === 'manual' || selectedWorkItem) && (
            <div>
              <label className="mb-1 block text-sm text-text-secondary">
                Change Classification
              </label>
              <select
                value={changeClassification}
                onChange={(e) =>
                  setChangeClassification(e.target.value as 'major' | 'minor' | 'standard' | '')
                }
                className={INPUT_CLASS}
              >
                <option value="">Select...</option>
                <option value="major">Major</option>
                <option value="minor">Minor</option>
                <option value="standard">Standard</option>
              </select>
            </div>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-border px-4 py-2 text-sm text-text-secondary hover:bg-bg-tertiary"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={!title.trim() || submitting}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
          >
            {submitting ? 'Creating...' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
