import { useState, useCallback, useEffect } from 'react';
import { Plus, Loader2, Trash2 } from 'lucide-react';
import type { LifecycleItem, LifecycleStage } from '../../../../shared/types';
import { CreateLifecycleItemModal } from './CreateLifecycleItemModal';

interface Props {
  selectedItemId: string | null;
  onSelectItem: (id: string | null) => void;
  workspaceId: string;
}

const STAGE_LABELS: Record<LifecycleStage, string> = {
  ideation: 'Ideation',
  discovery_design: 'Discovery & Design',
  build: 'Build',
  run: 'Run',
};

const STAGE_BADGE_CLASSES: Record<LifecycleStage, string> = {
  ideation: 'bg-blue-500/10 text-blue-400',
  discovery_design: 'bg-purple-500/10 text-purple-400',
  build: 'bg-amber-500/10 text-amber-400',
  run: 'bg-emerald-500/10 text-emerald-400',
};

type StageFilter = LifecycleStage | 'all';

export function LifecycleListPanel({ selectedItemId, onSelectItem, workspaceId }: Props) {
  const [items, setItems] = useState<LifecycleItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [stageFilter, setStageFilter] = useState<StageFilter>('all');
  const [showCreateModal, setShowCreateModal] = useState(false);

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      const filters = stageFilter !== 'all' ? { stage: stageFilter } : {};
      const result = await window.anvil.lifecycle.listItems(workspaceId, filters);
      setItems(result as LifecycleItem[]);
    } catch (err) {
      console.error('Failed to load lifecycle items:', err);
    } finally {
      setLoading(false);
    }
  }, [workspaceId, stageFilter]);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  const handleCreated = useCallback(() => {
    setShowCreateModal(false);
    loadItems();
  }, [loadItems]);

  const handleDelete = useCallback(
    async (e: React.MouseEvent, itemId: string) => {
      e.stopPropagation();
      try {
        await window.anvil.lifecycle.deleteItem(itemId);
        if (selectedItemId === itemId) onSelectItem(null);
        loadItems();
      } catch (err) {
        console.error('Failed to delete lifecycle item:', err);
      }
    },
    [selectedItemId, onSelectItem, loadItems],
  );

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <select
          value={stageFilter}
          onChange={(e) => setStageFilter(e.target.value as StageFilter)}
          className="rounded border border-border bg-bg-primary px-2 py-1 text-xs text-text-primary focus:outline-none"
        >
          <option value="all">All Stages</option>
          <option value="ideation">Ideation</option>
          <option value="discovery_design">Discovery & Design</option>
          <option value="build">Build</option>
          <option value="run">Run</option>
        </select>
        <button
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-xs font-medium text-white hover:bg-accent/90"
        >
          <Plus size={12} />
          New
        </button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto p-2">
        {loading ? (
          <div className="flex h-24 items-center justify-center">
            <Loader2 size={20} className="animate-spin text-accent" />
          </div>
        ) : items.length === 0 ? (
          <div className="mt-4 text-center text-xs text-text-tertiary">
            No lifecycle items yet.
            <br />
            <button
              onClick={() => setShowCreateModal(true)}
              className="mt-2 text-accent hover:underline"
            >
              Create one
            </button>
          </div>
        ) : (
          <div className="space-y-1">
            {items.map((item) => (
              <div
                key={item.id}
                onClick={() => onSelectItem(item.id)}
                className={`group relative w-full cursor-pointer rounded-lg border px-3 py-2.5 text-left transition-colors ${
                  selectedItemId === item.id
                    ? 'border-accent/30 bg-accent/5'
                    : 'border-border bg-bg-tertiary hover:border-border hover:bg-bg-elevated'
                }`}
              >
                <div className="mb-1.5 text-sm font-medium text-text-primary leading-snug pr-6">
                  {item.title}
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${STAGE_BADGE_CLASSES[item.stage]}`}
                  >
                    {STAGE_LABELS[item.stage]}
                  </span>
                  {item.changeClassification && (
                    <span className="bg-bg-tertiary text-text-secondary rounded px-1.5 py-0.5 text-xs capitalize">
                      {item.changeClassification}
                    </span>
                  )}
                </div>
                <button
                  onClick={(e) => handleDelete(e, item.id)}
                  className="absolute right-2 top-2 rounded p-0.5 text-text-tertiary opacity-0 hover:text-error group-hover:opacity-100"
                  aria-label={`Delete ${item.title}`}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {showCreateModal && (
        <CreateLifecycleItemModal
          workspaceId={workspaceId}
          onCreated={handleCreated}
          onClose={() => setShowCreateModal(false)}
        />
      )}
    </div>
  );
}
