import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { CalendarRange, Info, LayoutGrid, Plus, RotateCcw, SlidersHorizontal } from 'lucide-react';
import {
  addOverviewModule,
  createOverviewModule,
  moduleTitle,
  moveOverviewModule,
  OVERVIEW_TIME_RANGES,
  overviewLayoutsEqual,
  removeOverviewModule,
  updateOverviewModule,
  type OverviewModuleType,
  type OverviewTimeRange,
} from '../../../shared/overview';
import { EmptyState, InlineNotice } from '../layout/ViewScaffold';
import { Button, SegmentedControl, cx } from '../ui';
import { OverviewLibraryPanel } from './OverviewLibraryPanel';
import { OverviewModuleConfigDialog } from './OverviewModuleConfigDialog';
import { LIBRARY_DRAG_TYPE, MODULE_DRAG_TYPE, OverviewModulePanel } from './OverviewModulePanel';
import { useNow } from './useOverviewModuleData';
import { useOverviewNavigate, type OverviewBoardController } from './useOverviewBoard';

type DropTarget = { moduleId: string; after: boolean } | 'end' | null;

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

export function OverviewBoard({ board }: { board: OverviewBoardController }) {
  const open = useOverviewNavigate();
  const now = useNow();
  const [dropTarget, setDropTarget] = useState<DropTarget>(null);
  const [dragging, setDragging] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const pendingFocus = useRef<string | null>(null);
  const modules = board.layout?.modules ?? [];

  const focusModule = useCallback((moduleId: string) => {
    const element = document.querySelector<HTMLElement>(`[data-overview-module="${moduleId}"]`);
    if (!element) return;
    element.scrollIntoView({
      block: 'nearest',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
    element.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!pendingFocus.current) return;
    const id = pendingFocus.current;
    pendingFocus.current = null;
    requestAnimationFrame(() => focusModule(id));
  });

  const move = (moduleId: string, toIndex: number) => {
    board.updateDraft((layout) => moveOverviewModule(layout, moduleId, toIndex));
    const module = modules.find((entry) => entry.id === moduleId);
    if (module) {
      setAnnouncement(
        `${moduleTitle(module)} moved to position ${toIndex + 1} of ${modules.length}.`,
      );
    }
  };

  const add = (type: OverviewModuleType, index?: number) => {
    const sources = board.sources;
    const connectionId =
      type === 'tickets' && board.scope.kind === 'global'
        ? (Object.values(sources?.workspaceConnectionIds ?? {}).find(Boolean) ??
          sources?.workItemConnections[0]?.id)
        : undefined;
    const module = createOverviewModule(type, connectionId ? { config: { connectionId } } : {});
    board.updateDraft((layout) => addOverviewModule(layout, module, index));
    setAnnouncement(`${moduleTitle(module)} added.`);
    pendingFocus.current = module.id;
    // Tickets need a connection and filter choice before they're useful.
    if (type === 'tickets' || type === 'pinned-links') board.setConfiguringId(module.id);
  };

  const indexFor = (target: DropTarget, movingId?: string): number => {
    if (!target || target === 'end') return modules.length;
    const targetIndex = modules.findIndex((module) => module.id === target.moduleId);
    const insertAt = targetIndex + (target.after ? 1 : 0);
    const from = movingId ? modules.findIndex((module) => module.id === movingId) : -1;
    return from >= 0 && from < insertAt ? insertAt - 1 : insertAt;
  };

  const acceptsDrop = (event: DragEvent<HTMLElement>) =>
    board.editing &&
    (event.dataTransfer.types.includes(MODULE_DRAG_TYPE) ||
      event.dataTransfer.types.includes(LIBRARY_DRAG_TYPE));

  const handleDragOver = (event: DragEvent<HTMLElement>, target: DropTarget) => {
    if (!acceptsDrop(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = event.dataTransfer.types.includes(MODULE_DRAG_TYPE)
      ? 'move'
      : 'copy';
    if (target !== 'end' && target) {
      const rect = event.currentTarget.getBoundingClientRect();
      target = { ...target, after: event.clientX > rect.left + rect.width / 2 };
    }
    setDropTarget(target);
  };

  const handleDrop = (event: DragEvent<HTMLElement>, target: DropTarget) => {
    if (!acceptsDrop(event)) return;
    event.preventDefault();
    if (target !== 'end' && target) {
      const rect = event.currentTarget.getBoundingClientRect();
      target = { ...target, after: event.clientX > rect.left + rect.width / 2 };
    }
    const movingId = event.dataTransfer.getData(MODULE_DRAG_TYPE);
    const libraryType = event.dataTransfer.getData(LIBRARY_DRAG_TYPE) as OverviewModuleType;
    if (movingId) move(movingId, indexFor(target, movingId));
    else if (libraryType) add(libraryType, indexFor(target));
    setDropTarget(null);
    setDragging(false);
  };

  const configuring = modules.find((module) => module.id === board.configuringId) ?? null;

  if (!board.layout) {
    if (board.error) {
      return (
        <EmptyState
          icon={LayoutGrid}
          title="Couldn’t load this overview"
          description={board.error}
          action={
            <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
              Reload
            </Button>
          }
        />
      );
    }
    return <BoardSkeleton />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="@container mx-auto max-w-[1600px] px-5 py-5">
          {board.error && (
            <InlineNotice tone="error" className="mb-4">
              {board.error}
            </InlineNotice>
          )}

          {board.editing && <EditBar board={board} />}

          {modules.length === 0 && !board.editing ? (
            <EmptyState
              icon={LayoutGrid}
              title="Nothing on this overview yet"
              description="Choose the modules you want to see and where they sit."
              action={
                <Button variant="secondary" size="sm" onClick={() => board.startEditing()}>
                  <SlidersHorizontal size={13} aria-hidden="true" />
                  Customise overview
                </Button>
              }
            />
          ) : (
            <div className="grid grid-cols-1 items-start gap-4 @3xl:grid-cols-6">
              {modules.map((module, index) => (
                <OverviewModulePanel
                  key={module.id}
                  module={module}
                  index={index}
                  count={modules.length}
                  scope={board.scope}
                  timeRange={board.timeRange}
                  refreshToken={board.refreshToken}
                  now={now}
                  editing={board.editing}
                  dropActive={
                    dropTarget !== null && dropTarget !== 'end' && dropTarget.moduleId === module.id
                  }
                  onOpen={open}
                  onConfigure={() =>
                    board.editing
                      ? board.setConfiguringId(module.id)
                      : board.startEditing(module.id)
                  }
                  onMove={(toIndex) => {
                    move(module.id, toIndex);
                    pendingFocus.current = module.id;
                  }}
                  onResize={(width) =>
                    board.updateDraft((layout) =>
                      updateOverviewModule(layout, module.id, { width }),
                    )
                  }
                  onRemove={() => {
                    board.updateDraft((layout) => removeOverviewModule(layout, module.id));
                    setAnnouncement(`${moduleTitle(module)} removed from this overview.`);
                  }}
                  onDragStart={() => setDragging(true)}
                  onDragEnd={() => {
                    setDragging(false);
                    setDropTarget(null);
                  }}
                  onDragOver={(event) =>
                    handleDragOver(event, { moduleId: module.id, after: false })
                  }
                  onDrop={(event) => handleDrop(event, { moduleId: module.id, after: false })}
                />
              ))}

              {board.editing && (
                <div
                  onDragOver={(event) => handleDragOver(event, 'end')}
                  onDragLeave={() =>
                    setDropTarget((current) => (current === 'end' ? null : current))
                  }
                  onDrop={(event) => handleDrop(event, 'end')}
                  className={cx(
                    'flex min-h-28 flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed text-sm transition-colors @3xl:col-span-6',
                    dropTarget === 'end'
                      ? 'border-accent bg-accent/5 text-text-primary'
                      : 'border-border text-text-tertiary',
                    dragging && dropTarget !== 'end' && 'border-text-tertiary',
                  )}
                >
                  <Plus size={16} aria-hidden="true" />
                  <span>Drop a module here, or use Add in the library.</span>
                </div>
              )}
            </div>
          )}

          <div aria-live="polite" className="sr-only">
            {announcement}
          </div>
        </div>
      </div>

      {board.editing && (
        <OverviewLibraryPanel
          board={board}
          onAdd={(type) => add(type)}
          onFocusModule={focusModule}
        />
      )}

      <OverviewModuleConfigDialog
        module={configuring}
        scope={board.scope}
        sources={board.sources}
        onClose={() => board.setConfiguringId(null)}
        onApply={(patch) => {
          if (!configuring) return;
          board.updateDraft((layout) => updateOverviewModule(layout, configuring.id, patch));
          board.setConfiguringId(null);
        }}
      />
    </div>
  );
}

function EditBar({ board }: { board: OverviewBoardController }) {
  const atFallback =
    board.layout && board.layoutState
      ? overviewLayoutsEqual(board.layout, board.layoutState.fallback)
      : true;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border-subtle bg-bg-secondary/55 px-3 py-2 text-sm text-text-secondary">
      <Info size={15} className="shrink-0 text-text-tertiary" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        Drag modules to rearrange, or focus a handle and use the arrow keys. Changes apply when you
        save.
      </span>
      {board.scope.kind === 'workspace' && (
        <span className="flex items-center gap-2">
          <span className="text-xs text-text-tertiary">Save for</span>
          <SegmentedControl
            label="Save layout for"
            value={board.saveTarget}
            onChange={board.setSaveTarget}
            options={[
              { value: 'workspace', label: 'This workspace' },
              { value: 'all-workspaces', label: 'All workspaces' },
            ]}
          />
        </span>
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={board.resetToFallback}
        disabled={atFallback}
        title={
          board.scope.kind === 'workspace'
            ? 'Return to the default workspace layout'
            : 'Return to the built-in layout'
        }
      >
        <RotateCcw size={12} aria-hidden="true" />
        Reset layout
      </Button>
    </div>
  );
}

export function OverviewHeaderActions({ board }: { board: OverviewBoardController }) {
  if (board.editing) {
    return (
      <>
        <Button variant="secondary" size="sm" onClick={board.cancelEditing} disabled={board.saving}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void board.save()} disabled={board.saving || !board.dirty}>
          {board.saving ? 'Saving…' : 'Save layout'}
        </Button>
      </>
    );
  }
  return (
    <>
      <label className="relative inline-flex items-center">
        <span className="sr-only">Time range for activity and history</span>
        <CalendarRange
          size={14}
          className="pointer-events-none absolute left-2.5 text-text-tertiary"
          aria-hidden="true"
        />
        <select
          value={board.timeRange}
          onChange={(event) => board.setTimeRange(event.target.value as OverviewTimeRange)}
          className="appearance-none rounded-lg border border-border bg-bg-secondary py-1.5 pl-8 pr-7 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          title="Applies to activity and history, not to current state"
        >
          {OVERVIEW_TIME_RANGES.map((range) => (
            <option key={range.value} value={range.value}>
              {range.label}
            </option>
          ))}
        </select>
        <svg
          viewBox="0 0 12 12"
          className="pointer-events-none absolute right-2.5 h-2.5 w-2.5 text-text-tertiary"
          aria-hidden="true"
        >
          <path d="M2 4.5 6 8l4-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </label>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => board.startEditing()}
        disabled={!board.layoutState}
      >
        <SlidersHorizontal size={13} aria-hidden="true" />
        Customise overview
      </Button>
    </>
  );
}

/** Header copy shared by both overviews; names the layout being shown. */
export function overviewLayoutLabel(board: OverviewBoardController): string {
  const source = board.layoutState?.source;
  if (board.scope.kind === 'global') return 'Personal layout';
  if (board.editing) {
    return board.saveTarget === 'all-workspaces'
      ? 'Default for all workspaces'
      : 'Layout for this workspace';
  }
  if (source === 'workspace-override') return 'Layout for this workspace';
  if (source === 'workspace-default') return 'Default workspace layout';
  return 'Default layout';
}

function BoardSkeleton() {
  return (
    <div
      className="@container mx-auto w-full max-w-[1600px] px-5 py-5"
      aria-busy="true"
      aria-label="Loading overview"
    >
      <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-6">
        {['@3xl:col-span-4', '@3xl:col-span-2', '@3xl:col-span-4', '@3xl:col-span-2'].map(
          (span, index) => (
            <div
              key={index}
              className={cx(
                'h-56 rounded-xl border border-border-subtle bg-bg-secondary/40 motion-safe:animate-pulse',
                span,
              )}
            />
          ),
        )}
      </div>
    </div>
  );
}
