import { useState, useCallback, useEffect } from 'react';
import { Plus, Loader2, Trash2, Settings, RotateCcw, ArrowDown, ArrowUp } from 'lucide-react';
import type {
  LifecycleItem,
  LifecycleStage,
  LifecycleStageDefinition,
  LifecycleStageUpdate,
} from '../../../../shared/types';
import { CreateLifecycleItemModal } from './CreateLifecycleItemModal';
import { stageBadgeClass, stageLabel } from './stage-utils';

interface Props {
  selectedItemId: string | null;
  onSelectItem: (id: string | null) => void;
  workspaceId: string;
}

type StageFilter = LifecycleStage | 'all';

export function LifecycleListPanel({ selectedItemId, onSelectItem, workspaceId }: Props) {
  const [items, setItems] = useState<LifecycleItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [stages, setStages] = useState<LifecycleStageDefinition[]>([]);
  const [stageFilter, setStageFilter] = useState<StageFilter>('all');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showStageEditor, setShowStageEditor] = useState(false);

  const loadStages = useCallback(async () => {
    try {
      const result = await window.anvil.lifecycle.listStages(workspaceId);
      setStages(result);
      if (stageFilter !== 'all' && !result.some((stage) => stage.id === stageFilter)) {
        setStageFilter('all');
      }
    } catch (err) {
      console.error('Failed to load lifecycle stages:', err);
    }
  }, [workspaceId, stageFilter]);

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
    loadStages();
  }, [loadStages]);

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
          {stages.map((stage) => (
            <option key={stage.id} value={stage.id}>
              {stage.label}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowStageEditor(true)}
            className="rounded-md border border-border p-1 text-text-tertiary hover:text-text-primary"
            title="Configure lifecycle stages"
          >
            <Settings size={13} />
          </button>
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-xs font-medium text-white hover:bg-accent/90"
          >
            <Plus size={12} />
            New
          </button>
        </div>
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
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${stageBadgeClass(item.stage, stages)}`}
                  >
                    {stageLabel(item.stage, stages)}
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

      {showStageEditor && (
        <LifecycleStageEditor
          workspaceId={workspaceId}
          stages={stages}
          onSaved={() => {
            setShowStageEditor(false);
            loadStages();
            loadItems();
          }}
          onClose={() => setShowStageEditor(false)}
        />
      )}
    </div>
  );
}

function LifecycleStageEditor({
  workspaceId,
  stages,
  onSaved,
  onClose,
}: {
  workspaceId: string;
  stages: LifecycleStageDefinition[];
  onSaved: () => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<LifecycleStageUpdate[]>(() =>
    stages.map((stage) => ({ id: stage.id, label: stage.label })),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const updateDraft = (index: number, updates: Partial<LifecycleStageUpdate>) => {
    setDraft((current) =>
      current.map((stage, stageIndex) => (stageIndex === index ? { ...stage, ...updates } : stage)),
    );
  };

  const moveDraft = (index: number, direction: -1 | 1) => {
    setDraft((current) => {
      const nextIndex = index + direction;

      if (nextIndex < 0 || nextIndex >= current.length) {
        return current;
      }

      const next = [...current];
      const [stage] = next.splice(index, 1);

      next.splice(nextIndex, 0, stage);
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await window.anvil.lifecycle.updateStages(workspaceId, draft);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update lifecycle stages.');
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    setError(null);
    try {
      await window.anvil.lifecycle.resetStages(workspaceId);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset lifecycle stages.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-[520px] rounded-lg border border-border bg-bg-secondary shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Lifecycle Stages</h3>
            <p className="mt-0.5 text-xs text-text-tertiary">
              Define the stage ids and labels used in this workspace.
            </p>
          </div>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary">
            ×
          </button>
        </div>

        <div className="space-y-2 p-4">
          {draft.map((stage, index) => (
            <div key={`${stage.id}-${index}`} className="grid grid-cols-[1fr_1fr_auto_auto] gap-2">
              <input
                value={stage.id}
                onChange={(event) => updateDraft(index, { id: event.currentTarget.value })}
                className="rounded border border-border bg-bg-primary px-2 py-1.5 text-sm text-text-primary"
                placeholder="stage_id"
              />
              <input
                value={stage.label}
                onChange={(event) => updateDraft(index, { label: event.currentTarget.value })}
                className="rounded border border-border bg-bg-primary px-2 py-1.5 text-sm text-text-primary"
                placeholder="Stage label"
              />
              <div className="flex items-center gap-1">
                <button
                  onClick={() => moveDraft(index, -1)}
                  className="rounded border border-border p-1 text-text-tertiary hover:text-text-primary disabled:opacity-40"
                  disabled={index === 0}
                  title="Move stage up"
                >
                  <ArrowUp size={12} />
                </button>
                <button
                  onClick={() => moveDraft(index, 1)}
                  className="rounded border border-border p-1 text-text-tertiary hover:text-text-primary disabled:opacity-40"
                  disabled={index === draft.length - 1}
                  title="Move stage down"
                >
                  <ArrowDown size={12} />
                </button>
              </div>
              <button
                onClick={() => setDraft((current) => current.filter((_, i) => i !== index))}
                className="rounded border border-border px-2 text-xs text-text-tertiary hover:text-error"
                disabled={draft.length <= 1}
              >
                Remove
              </button>
            </div>
          ))}

          <button
            onClick={() => setDraft((current) => [...current, { id: '', label: '' }])}
            className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-text-secondary hover:text-text-primary"
          >
            <Plus size={12} />
            Add stage
          </button>

          {error && (
            <div className="rounded bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border px-4 py-3">
          <button
            onClick={reset}
            className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-text-secondary hover:text-text-primary"
            disabled={saving}
          >
            <RotateCcw size={12} />
            Reset defaults
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="rounded border border-border px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary"
              disabled={saving}
            >
              Cancel
            </button>
            <button
              onClick={save}
              className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-60"
              disabled={saving}
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
