import { useState, useCallback, useRef, useEffect } from 'react';
import { Edit2, X, Plus, Search, Loader2, ExternalLink, Users, TicketCheck } from 'lucide-react';
import type { LifecycleItem, LifecycleStage, WorkItem } from '../../../../shared/types';
import { useWorkspace } from '../../../contexts/WorkspaceContext';

interface Props {
  item: LifecycleItem;
  onUpdate: () => void;
}

const STAGE_ORDER: LifecycleStage[] = ['ideation', 'discovery_design', 'build', 'run'];

const STAGE_LABELS: Record<LifecycleStage, string> = {
  ideation: 'Ideation',
  discovery_design: 'Discovery & Design',
  build: 'Build',
  run: 'Run',
};

const LABEL_CLASS = 'text-xs font-semibold uppercase tracking-wider text-text-tertiary';
const INPUT_CLASS =
  'w-full rounded-lg border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary focus:border-accent/50 focus:outline-none';

export function LifecycleOverview({ item, onUpdate }: Props) {
  const { activeWorkspace } = useWorkspace();

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleValue, setTitleValue] = useState(item.title);
  const [descValue, setDescValue] = useState(item.description ?? '');
  const [showRepoDropdown, setShowRepoDropdown] = useState(false);
  const [showWorkItemSearch, setShowWorkItemSearch] = useState(false);
  const [workItemQuery, setWorkItemQuery] = useState('');
  const [workItemResults, setWorkItemResults] = useState<WorkItem[]>([]);
  const [searchingWorkItems, setSearchingWorkItems] = useState(false);
  const [linkedWorkItem, setLinkedWorkItem] = useState<WorkItem | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setTitleValue(item.title);
    setDescValue(item.description ?? '');
  }, [item.id, item.title, item.description]);

  useEffect(() => {
    if (editingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [editingTitle]);

  useEffect(() => {
    if (!item.linkedWorkItemId) {
      setLinkedWorkItem(null);
      return;
    }
    window.anvil.workitems
      .get(item.linkedWorkItemId)
      .then(setLinkedWorkItem)
      .catch(() => setLinkedWorkItem(null));
  }, [item.linkedWorkItemId]);

  const saveTitle = useCallback(async () => {
    const trimmed = titleValue.trim();
    if (!trimmed || trimmed === item.title) {
      setTitleValue(item.title);
      setEditingTitle(false);
      return;
    }
    try {
      await window.anvil.lifecycle.updateItem(item.id, { title: trimmed });
      onUpdate();
    } catch (err) {
      console.error('Failed to update title:', err);
    }
    setEditingTitle(false);
  }, [titleValue, item.id, item.title, onUpdate]);

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') saveTitle();
      if (e.key === 'Escape') {
        setTitleValue(item.title);
        setEditingTitle(false);
      }
    },
    [saveTitle, item.title],
  );

  const saveDescription = useCallback(async () => {
    const trimmed = descValue.trim();
    if (trimmed === (item.description ?? '')) return;
    try {
      await window.anvil.lifecycle.updateItem(item.id, { description: trimmed || undefined });
      onUpdate();
    } catch (err) {
      console.error('Failed to update description:', err);
    }
  }, [descValue, item.id, item.description, onUpdate]);

  const handleStageChange = useCallback(
    async (e: React.ChangeEvent<HTMLSelectElement>) => {
      try {
        await window.anvil.lifecycle.updateItem(item.id, {
          stage: e.target.value as LifecycleStage,
        });
        onUpdate();
      } catch (err) {
        console.error('Failed to update stage:', err);
      }
    },
    [item.id, onUpdate],
  );

  const handleClassificationChange = useCallback(
    async (e: React.ChangeEvent<HTMLSelectElement>) => {
      const val = e.target.value as 'major' | 'minor' | 'standard' | '';
      try {
        await window.anvil.lifecycle.updateItem(item.id, {
          changeClassification: val || undefined,
        });
        onUpdate();
      } catch (err) {
        console.error('Failed to update classification:', err);
      }
    },
    [item.id, onUpdate],
  );

  const handleUnlinkRepo = useCallback(
    async (repoId: string) => {
      try {
        await window.anvil.lifecycle.unlinkRepo(item.id, repoId);
        onUpdate();
      } catch (err) {
        console.error('Failed to unlink repo:', err);
      }
    },
    [item.id, onUpdate],
  );

  const handleLinkRepo = useCallback(
    async (repoId: string) => {
      try {
        await window.anvil.lifecycle.linkRepos(item.id, [repoId]);
        onUpdate();
        setShowRepoDropdown(false);
      } catch (err) {
        console.error('Failed to link repo:', err);
      }
    },
    [item.id, onUpdate],
  );

  const searchWorkItems = useCallback((q: string) => {
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    if (!q.trim()) {
      setWorkItemResults([]);
      setSearchingWorkItems(false);
      return;
    }
    setSearchingWorkItems(true);
    searchTimeoutRef.current = setTimeout(async () => {
      try {
        const items = await window.anvil.workitems.search(q);
        setWorkItemResults(items.slice(0, 10));
      } catch {
        setWorkItemResults([]);
      } finally {
        setSearchingWorkItems(false);
      }
    }, 300);
  }, []);

  const handleLinkWorkItem = useCallback(
    async (wi: WorkItem) => {
      try {
        await window.anvil.lifecycle.updateItem(item.id, {
          linkedWorkItemId: wi.id,
          linkedWorkItemProvider: wi.provider,
        });
        setShowWorkItemSearch(false);
        setWorkItemQuery('');
        setWorkItemResults([]);
        onUpdate();
      } catch (err) {
        console.error('Failed to link work item:', err);
      }
    },
    [item.id, onUpdate],
  );

  const handleUnlinkWorkItem = useCallback(async () => {
    try {
      await window.anvil.lifecycle.updateItem(item.id, {
        linkedWorkItemId: null,
        linkedWorkItemProvider: null,
      });
      onUpdate();
    } catch (err) {
      console.error('Failed to unlink work item:', err);
    }
  }, [item.id, onUpdate]);

  const currentStageIndex = STAGE_ORDER.indexOf(item.stage);
  const forwardStages = STAGE_ORDER.slice(currentStageIndex);
  const workspaceRepos = activeWorkspace?.repos ?? [];
  const linkedRepos = workspaceRepos.filter((r) => item.linkedRepoIds.includes(r.id));
  const unlinkableRepos = workspaceRepos.filter((r) => !item.linkedRepoIds.includes(r.id));

  return (
    <div className="space-y-3">
      {/* Title */}
      <div>
        <div className={LABEL_CLASS}>Title</div>
        {editingTitle ? (
          <input
            ref={titleInputRef}
            type="text"
            value={titleValue}
            onChange={(e) => setTitleValue(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={handleTitleKeyDown}
            className={INPUT_CLASS}
          />
        ) : (
          <div className="group flex items-center gap-2">
            <span className="flex-1 text-sm text-text-primary">{item.title}</span>
            <button
              onClick={() => setEditingTitle(true)}
              className="rounded p-0.5 text-text-tertiary opacity-0 hover:text-text-primary group-hover:opacity-100"
            >
              <Edit2 size={13} />
            </button>
          </div>
        )}
      </div>

      {/* Description */}
      <div>
        <div className={LABEL_CLASS}>Description</div>
        <textarea
          value={descValue}
          onChange={(e) => setDescValue(e.target.value)}
          onBlur={saveDescription}
          placeholder="No description"
          rows={2}
          className={INPUT_CLASS}
        />
      </div>

      {/* Stage + Classification row */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className={LABEL_CLASS}>Stage</div>
          <select value={item.stage} onChange={handleStageChange} className={INPUT_CLASS}>
            {forwardStages.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <div className={LABEL_CLASS}>Classification</div>
          <select
            value={item.changeClassification ?? ''}
            onChange={handleClassificationChange}
            className={INPUT_CLASS}
          >
            <option value="">Not set</option>
            <option value="major">Major</option>
            <option value="minor">Minor</option>
            <option value="standard">Standard</option>
          </select>
        </div>
      </div>

      {/* Linked Work Item */}
      <div>
        <div className="flex items-center justify-between">
          <div className={LABEL_CLASS}>Linked Work Item</div>
          {!item.linkedWorkItemId && (
            <button
              onClick={() => setShowWorkItemSearch((v) => !v)}
              className="flex items-center gap-1 rounded p-0.5 text-text-tertiary hover:text-text-primary"
            >
              <Search size={13} />
            </button>
          )}
        </div>
        {item.linkedWorkItemId && linkedWorkItem ? (
          <div className="rounded-lg border border-border bg-bg-tertiary">
            {/* Work item header */}
            <div className="flex items-start gap-2.5 px-3 py-2.5">
              <TicketCheck size={15} className="mt-0.5 shrink-0 text-accent" />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-text-primary">{linkedWorkItem.title}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-text-tertiary">
                  <span>{item.linkedWorkItemId}</span>
                  <span className="text-border">|</span>
                  <span className="rounded bg-bg-primary px-1.5 py-0.5">{linkedWorkItem.type}</span>
                  <span className="rounded bg-bg-primary px-1.5 py-0.5">
                    {linkedWorkItem.state}
                  </span>
                  {linkedWorkItem.assignee && (
                    <>
                      <span className="text-border">|</span>
                      <span className="flex items-center gap-1">
                        <Users size={10} />
                        {linkedWorkItem.assignee}
                      </span>
                    </>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {linkedWorkItem.url && (
                  <button
                    onClick={() => window.open(linkedWorkItem.url, '_blank')}
                    className="rounded p-0.5 text-text-tertiary hover:text-accent"
                    title="Open in provider"
                  >
                    <ExternalLink size={13} />
                  </button>
                )}
                <button
                  onClick={handleUnlinkWorkItem}
                  className="rounded p-0.5 text-text-tertiary hover:text-error"
                  title="Unlink"
                >
                  <X size={13} />
                </button>
              </div>
            </div>

            {/* Child work items summary */}
            {linkedWorkItem.children && linkedWorkItem.children.length > 0 && (
              <div className="border-t border-border px-3 py-2">
                <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-text-tertiary">
                  Child Items ({linkedWorkItem.children.length})
                </div>
                <div className="space-y-1">
                  {linkedWorkItem.children.slice(0, 8).map((child) => (
                    <div key={child.id} className="flex items-center gap-2 text-xs">
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          child.state.toLowerCase().includes('done') ||
                          child.state.toLowerCase().includes('closed')
                            ? 'bg-emerald-500'
                            : child.state.toLowerCase().includes('active') ||
                                child.state.toLowerCase().includes('progress')
                              ? 'bg-blue-500'
                              : 'bg-text-tertiary'
                        }`}
                      />
                      <span className="truncate text-text-primary">{child.title}</span>
                      <span className="ml-auto shrink-0 text-text-tertiary">{child.state}</span>
                    </div>
                  ))}
                  {linkedWorkItem.children.length > 8 && (
                    <div className="text-xs text-text-tertiary">
                      +{linkedWorkItem.children.length - 8} more
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Iteration / tags */}
            {(linkedWorkItem.iterationPath ||
              (linkedWorkItem.tags && linkedWorkItem.tags.length > 0)) && (
              <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2 text-xs text-text-tertiary">
                {linkedWorkItem.iterationPath && (
                  <span className="rounded bg-bg-primary px-1.5 py-0.5">
                    {linkedWorkItem.iterationPath}
                  </span>
                )}
                {linkedWorkItem.tags?.map((tag) => (
                  <span key={tag} className="rounded bg-accent/10 px-1.5 py-0.5 text-accent">
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        ) : item.linkedWorkItemId ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-bg-tertiary px-3 py-2">
            <Loader2 size={13} className="animate-spin text-text-tertiary" />
            <span className="text-sm text-text-tertiary">Loading {item.linkedWorkItemId}...</span>
          </div>
        ) : showWorkItemSearch ? (
          <div className="space-y-1.5">
            <div className="relative">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"
              />
              <input
                type="text"
                value={workItemQuery}
                onChange={(e) => {
                  setWorkItemQuery(e.target.value);
                  searchWorkItems(e.target.value);
                }}
                placeholder="Search by title or ID..."
                className={`${INPUT_CLASS} pl-9`}
                autoFocus
              />
              {searchingWorkItems && (
                <Loader2
                  size={14}
                  className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-text-tertiary"
                />
              )}
            </div>
            {workItemResults.length > 0 && (
              <div className="max-h-40 overflow-y-auto rounded-lg border border-border bg-bg-primary">
                {workItemResults.map((wi) => (
                  <button
                    key={wi.id}
                    onClick={() => handleLinkWorkItem(wi)}
                    className="flex w-full items-start gap-2 px-3 py-1.5 text-left transition-colors hover:bg-bg-tertiary"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-text-primary">{wi.title}</div>
                      <div className="text-xs text-text-tertiary">
                        {wi.id} · {wi.type} · {wi.state}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
            {workItemQuery && !searchingWorkItems && workItemResults.length === 0 && (
              <div className="text-xs text-text-tertiary">No work items found</div>
            )}
          </div>
        ) : (
          <span className="text-sm text-text-tertiary">None linked</span>
        )}
      </div>

      {/* Linked Repos */}
      <div>
        <div className="flex items-center justify-between">
          <div className={LABEL_CLASS}>Linked Repos</div>
          <div className="relative">
            <button
              onClick={() => setShowRepoDropdown((v) => !v)}
              className="rounded p-0.5 text-text-tertiary hover:text-text-primary"
            >
              <Plus size={13} />
            </button>
            {showRepoDropdown && (
              <div className="absolute right-0 top-6 z-10 min-w-[180px] rounded-lg border border-border bg-bg-secondary shadow-lg">
                {unlinkableRepos.length > 0 ? (
                  unlinkableRepos.map((repo) => (
                    <button
                      key={repo.id}
                      onClick={() => handleLinkRepo(repo.id)}
                      className="block w-full px-3 py-1.5 text-left text-sm text-text-primary hover:bg-bg-tertiary"
                    >
                      {repo.name}
                    </button>
                  ))
                ) : (
                  <div className="px-3 py-2 text-sm text-text-tertiary">
                    All workspace repos linked
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        {linkedRepos.length === 0 ? (
          <span className="text-sm text-text-tertiary">No repos linked</span>
        ) : (
          <div className="space-y-1">
            {linkedRepos.map((repo) => (
              <div key={repo.id} className="flex items-center gap-2">
                <span className="flex-1 text-sm text-text-primary">{repo.name}</span>
                <button
                  onClick={() => handleUnlinkRepo(repo.id)}
                  className="rounded p-0.5 text-text-tertiary hover:text-error"
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
