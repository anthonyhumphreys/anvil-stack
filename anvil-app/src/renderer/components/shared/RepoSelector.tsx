import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, Search, X } from 'lucide-react';
import type { RepoInfo } from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BaseProps {
  /** Only show repos with status === 'indexed'. Default true. */
  indexedOnly?: boolean;
  /** Message shown when there are no repos to display. */
  emptyMessage?: string;
  /** Enable a search/filter input. Default false for list, true for modal/dropdown. */
  searchable?: boolean;
}

interface SingleSelectProps extends BaseProps {
  mode?: 'single';
  selectedRepoId: string | null;
  onSelect: (repo: RepoInfo) => void;
  selectedRepoIds?: never;
  onMultiSelect?: never;
}

interface MultiSelectProps extends BaseProps {
  mode: 'multi';
  selectedRepoIds: string[];
  onMultiSelect: (repos: RepoInfo[]) => void;
  /** Show an "All repos" toggle at the top. Default true. */
  showSelectAll?: boolean;
  selectedRepoId?: never;
  onSelect?: never;
}

interface ModalProps extends BaseProps {
  variant: 'modal';
  /** Modal title. */
  title?: string;
  /** Modal subtitle. */
  description?: string;
  /** Confirm button label. */
  confirmLabel?: string;
  /** Called when user cancels the modal. */
  onCancel: () => void;
}

interface DropdownProps extends BaseProps {
  variant: 'dropdown';
  /** Label shown when all repos are selected. */
  allLabel?: string;
}

interface ListProps extends BaseProps {
  variant?: 'list';
}

type VariantProps = ModalProps | DropdownProps | ListProps;

// Build the final union: each variant × each selection mode
export type RepoSelectorProps = (SingleSelectProps | MultiSelectProps) & VariantProps;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RepoSelector(props: RepoSelectorProps) {
  const {
    indexedOnly = true,
    emptyMessage = 'No indexed repositories found. Index a repository first from the Repositories view.',
  } = props;

  const variant = 'variant' in props ? (props.variant ?? 'list') : 'list';
  const mode = props.mode ?? 'single';
  const searchable = props.searchable ?? variant !== 'list';

  const { repos: workspaceRepos } = useWorkspace();
  const repos = indexedOnly ? workspaceRepos.filter((r) => r.status === 'indexed') : workspaceRepos;

  const [search, setSearch] = useState('');
  const filtered =
    searchable && search
      ? repos.filter((r) => r.name.toLowerCase().includes(search.toLowerCase()))
      : repos;

  // --- Selection helpers ---------------------------------------------------
  const isSelected = (id: string) => {
    if (mode === 'multi') return (props as MultiSelectProps).selectedRepoIds.includes(id);
    return (props as SingleSelectProps).selectedRepoId === id;
  };

  const handleClick = (repo: RepoInfo) => {
    if (mode === 'single') {
      (props as SingleSelectProps).onSelect(repo);
    } else {
      const mp = props as MultiSelectProps;
      const ids = mp.selectedRepoIds;
      let next: string[];
      if (ids.includes(repo.id)) {
        next = ids.filter((id) => id !== repo.id);
        if (next.length === 0) return; // don't deselect last
      } else {
        next = [...ids, repo.id];
      }
      mp.onMultiSelect(repos.filter((r) => next.includes(r.id)));
    }
  };

  const handleSelectAll = () => {
    if (mode !== 'multi') return;
    const mp = props as MultiSelectProps;
    mp.onMultiSelect(repos);
  };

  const allSelected =
    mode === 'multi' && (props as MultiSelectProps).selectedRepoIds.length === repos.length;

  // --- Render variants -----------------------------------------------------
  if (variant === 'modal') return renderModal();
  if (variant === 'dropdown') return renderDropdown();
  return renderList();

  // --- List variant (inline) -----------------------------------------------
  function renderList() {
    if (repos.length === 0) return renderEmpty();
    return (
      <div className="space-y-2">
        {searchable && renderSearchInput()}
        {renderRepoItems(filtered)}
      </div>
    );
  }

  // --- Modal variant -------------------------------------------------------
  function renderModal() {
    const mp = props as ModalProps;
    const title = mp.title ?? 'Select Repository';
    const description = mp.description ?? 'Choose a repository to continue.';
    const confirmLabel = mp.confirmLabel ?? 'Confirm';

    // For modal single-select, track local selection before confirm
    return (
      <ModalWrapper
        title={title}
        description={description}
        confirmLabel={confirmLabel}
        onCancel={mp.onCancel}
        repos={repos}
        filtered={filtered}
        mode={mode}
        isSelected={isSelected}
        handleClick={handleClick}
        handleSelectAll={handleSelectAll}
        allSelected={allSelected}
        search={search}
        setSearch={setSearch}
        searchable={searchable}
        emptyMessage={emptyMessage}
        singleOnSelect={mode === 'single' ? (props as SingleSelectProps).onSelect : undefined}
        showSelectAll={
          mode === 'multi' ? ((props as MultiSelectProps).showSelectAll ?? true) : false
        }
      />
    );
  }

  // --- Dropdown variant ----------------------------------------------------
  function renderDropdown() {
    const dp = props as DropdownProps;
    const allLabel = dp.allLabel ?? 'All repos';

    return (
      <DropdownWrapper
        allLabel={allLabel}
        repos={repos}
        filtered={filtered}
        mode={mode}
        isSelected={isSelected}
        handleClick={handleClick}
        handleSelectAll={handleSelectAll}
        allSelected={allSelected}
        search={search}
        setSearch={setSearch}
        searchable={searchable}
        singleSelectedName={
          mode === 'single'
            ? repos.find((r) => r.id === (props as SingleSelectProps).selectedRepoId)?.name
            : undefined
        }
        multiCount={mode === 'multi' ? (props as MultiSelectProps).selectedRepoIds.length : 0}
        showSelectAll={
          mode === 'multi' ? ((props as MultiSelectProps).showSelectAll ?? true) : false
        }
      />
    );
  }

  // --- Shared pieces -------------------------------------------------------
  function renderEmpty() {
    return (
      <div className="rounded-md border border-warning/30 bg-warning/10 p-4 text-center">
        <AlertTriangle size={20} className="mx-auto mb-2 text-warning" />
        <p className="text-sm text-text-secondary">{emptyMessage}</p>
      </div>
    );
  }

  function renderSearchInput() {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-bg-primary px-2 py-1.5">
        <Search size={14} className="shrink-0 text-text-tertiary" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search repositories..."
          className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none"
          autoFocus
        />
        {search && (
          <button
            onClick={() => setSearch('')}
            className="text-text-tertiary hover:text-text-primary"
          >
            <X size={14} />
          </button>
        )}
      </div>
    );
  }

  function renderRepoItems(items: RepoInfo[]) {
    if (items.length === 0) {
      return (
        <p className="px-2 py-4 text-center text-sm text-text-tertiary">
          No repositories match your search.
        </p>
      );
    }

    return items.map((repo) => (
      <button
        key={repo.id}
        onClick={() => handleClick(repo)}
        className={`flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left text-sm transition-colors ${
          isSelected(repo.id)
            ? 'border-accent bg-accent/20'
            : 'border-border-subtle hover:border-accent/40 hover:bg-accent/5'
        }`}
      >
        {mode === 'multi' && (
          <input type="checkbox" checked={isSelected(repo.id)} readOnly className="accent-accent" />
        )}
        <div className="flex-1 min-w-0">
          <div className="font-medium text-text-primary">{repo.name}</div>
          <div className="text-xs text-text-secondary truncate">{repo.path}</div>
        </div>
        {mode === 'single' && isSelected(repo.id) && (
          <Check size={14} className="shrink-0 text-accent" />
        )}
      </button>
    ));
  }
}

// ---------------------------------------------------------------------------
// Modal wrapper – handles local selection state for single-select confirm flow
// ---------------------------------------------------------------------------

function ModalWrapper({
  title,
  description,
  confirmLabel,
  onCancel,
  repos,
  filtered,
  mode,
  isSelected: isSelectedProp,
  handleClick: handleClickProp,
  handleSelectAll,
  allSelected,
  search,
  setSearch,
  searchable,
  emptyMessage,
  singleOnSelect,
  showSelectAll,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  onCancel: () => void;
  repos: RepoInfo[];
  filtered: RepoInfo[];
  mode: 'single' | 'multi';
  isSelected: (id: string) => boolean;
  handleClick: (repo: RepoInfo) => void;
  handleSelectAll: () => void;
  allSelected: boolean;
  search: string;
  setSearch: (s: string) => void;
  searchable: boolean;
  emptyMessage: string;
  singleOnSelect?: (repo: RepoInfo) => void;
  showSelectAll: boolean;
}) {
  // For single-select modals, we need local state so the user clicks to highlight,
  // then confirms. For multi-select, we delegate directly to parent state.
  const [localSelectedId, setLocalSelectedId] = useState<string | null>(null);

  const isSelected = (id: string) => {
    if (mode === 'single') return localSelectedId === id;
    return isSelectedProp(id);
  };

  const handleClick = (repo: RepoInfo) => {
    if (mode === 'single') {
      setLocalSelectedId(repo.id);
    } else {
      handleClickProp(repo);
    }
  };

  const handleConfirm = () => {
    if (mode === 'single' && localSelectedId && singleOnSelect) {
      const repo = repos.find((r) => r.id === localSelectedId);
      if (repo) singleOnSelect(repo);
    }
    // Multi-select: parent already has the state, just close
    if (mode === 'multi') onCancel();
  };

  const canConfirm = mode === 'single' ? !!localSelectedId : true;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-md rounded-lg border border-border bg-bg-elevated shadow-xl">
        {/* Header */}
        <div className="border-b border-border px-4 py-3">
          <h3 className="text-base font-semibold text-text-primary">{title}</h3>
          <p className="mt-0.5 text-sm text-text-tertiary">{description}</p>
        </div>

        {/* Search */}
        {searchable && (
          <div className="border-b border-border-subtle px-4 py-2">
            <div className="flex items-center gap-2 rounded-md border border-border bg-bg-primary px-2 py-1.5">
              <Search size={14} className="shrink-0 text-text-tertiary" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search repositories..."
                className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none"
                autoFocus
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  className="text-text-tertiary hover:text-text-primary"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </div>
        )}

        {/* Repo list */}
        <div className="max-h-64 overflow-auto p-2">
          {repos.length === 0 ? (
            <div className="px-2 py-4 text-center">
              <AlertTriangle size={20} className="mx-auto mb-2 text-warning" />
              <p className="text-sm text-text-secondary">{emptyMessage}</p>
            </div>
          ) : filtered.length === 0 ? (
            <p className="px-2 py-4 text-center text-sm text-text-tertiary">
              No repositories match your search.
            </p>
          ) : (
            <>
              {mode === 'multi' && showSelectAll && (
                <>
                  <button
                    onClick={handleSelectAll}
                    className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-bg-tertiary ${
                      allSelected ? 'bg-bg-tertiary' : ''
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={allSelected}
                      readOnly
                      className="accent-accent"
                    />
                    <span className="font-medium text-text-primary">All workspace repos</span>
                  </button>
                  <div className="mx-2 h-px bg-border" />
                </>
              )}
              {filtered.map((repo) => (
                <button
                  key={repo.id}
                  onClick={() => handleClick(repo)}
                  className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors ${
                    isSelected(repo.id)
                      ? 'bg-accent/10 border border-accent/30'
                      : 'border border-transparent hover:bg-bg-tertiary'
                  }`}
                >
                  {mode === 'multi' && (
                    <input
                      type="checkbox"
                      checked={isSelected(repo.id)}
                      readOnly
                      className="accent-accent"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-text-primary truncate">
                      {repo.name}
                    </div>
                    <div className="text-xs text-text-secondary truncate">{repo.path}</div>
                  </div>
                  {mode === 'single' && isSelected(repo.id) && (
                    <Check size={14} className="shrink-0 text-accent" />
                  )}
                </button>
              ))}
            </>
          )}
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button
            onClick={onCancel}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-tertiary"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={!canConfirm}
            className="rounded-md bg-accent px-3 py-1.5 text-sm text-white hover:bg-accent/80 disabled:opacity-40"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dropdown wrapper – handles open/close, click-outside, trigger button
// ---------------------------------------------------------------------------

function DropdownWrapper({
  allLabel,
  repos,
  filtered,
  mode,
  isSelected,
  handleClick,
  handleSelectAll,
  allSelected,
  search,
  setSearch,
  searchable,
  singleSelectedName,
  multiCount,
  showSelectAll,
}: {
  allLabel: string;
  repos: RepoInfo[];
  filtered: RepoInfo[];
  mode: 'single' | 'multi';
  isSelected: (id: string) => boolean;
  handleClick: (repo: RepoInfo) => void;
  handleSelectAll: () => void;
  allSelected: boolean;
  search: string;
  setSearch: (s: string) => void;
  searchable: boolean;
  singleSelectedName?: string;
  multiCount: number;
  showSelectAll: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const label = (() => {
    if (mode === 'multi') {
      if (allSelected) return allLabel;
      if (multiCount === 1) {
        const selected = repos.find((r) => isSelected(r.id));
        return selected?.name ?? `${multiCount} repo`;
      }
      return `${multiCount} repos`;
    }
    return singleSelectedName ?? 'Select repo';
  })();

  const onItemClick = (repo: RepoInfo) => {
    handleClick(repo);
    if (mode === 'single') setOpen(false);
  };

  return (
    <div className="relative z-50" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-sm transition-colors hover:bg-bg-tertiary"
        aria-label="Select repositories"
        aria-expanded={open}
      >
        <span className="text-text-primary">{label}</span>
        <ChevronDown size={12} className="text-text-tertiary" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-50 mt-1.5 w-72 overflow-hidden rounded-xl border border-border bg-bg-elevated shadow-2xl ring-1 ring-black/10">
          {searchable && (
            <div className="border-b border-border-subtle px-3 py-2">
              <div className="flex items-center gap-2 rounded-md border border-border bg-bg-primary px-2 py-1">
                <Search size={12} className="shrink-0 text-text-tertiary" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search..."
                  className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none"
                  autoFocus
                />
              </div>
            </div>
          )}

          {mode === 'multi' && showSelectAll && (
            <>
              <button
                onClick={() => {
                  handleSelectAll();
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-bg-tertiary ${
                  allSelected ? 'bg-bg-tertiary' : ''
                }`}
              >
                <input type="checkbox" checked={allSelected} readOnly className="accent-accent" />
                <span className="font-medium text-text-primary">All workspace repos</span>
              </button>
              <div className="h-px bg-border" />
            </>
          )}

          {filtered.map((repo) => (
            <button
              key={repo.id}
              onClick={() => onItemClick(repo)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-bg-tertiary"
            >
              {mode === 'multi' && (
                <input
                  type="checkbox"
                  checked={isSelected(repo.id)}
                  readOnly
                  className="accent-accent"
                />
              )}
              <div className="flex-1 min-w-0">
                <div className="text-text-primary truncate">{repo.name}</div>
                <div className="text-xs text-text-tertiary truncate">{repo.path}</div>
              </div>
              {mode === 'single' && isSelected(repo.id) && (
                <Check size={14} className="shrink-0 text-accent" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
