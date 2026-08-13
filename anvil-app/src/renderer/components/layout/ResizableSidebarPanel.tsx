import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, GripVertical } from 'lucide-react';
import { useStoredPanelState } from '../../hooks/useStoredPanelState';

interface ResizableSidebarPanelProps {
  storageKey: string;
  side: 'left' | 'right';
  title: string;
  children: React.ReactNode;
  defaultWidth: number;
  minWidth?: number;
  maxWidth?: number;
  collapsedWidth?: number;
  defaultCollapsed?: boolean;
  className?: string;
  collapsedClassName?: string;
  renderCollapsed?: (controls: { expand: () => void }) => React.ReactNode;
  collapsible?: boolean;
  resizable?: boolean;
  autoCollapseBelow?: number;
}

interface AutoCollapseInput {
  viewportWidth: number;
  threshold?: number;
  persistedCollapsed: boolean;
}

interface PanelWidthInput {
  width: number;
  collapsedWidth: number;
  collapsed: boolean;
}

export function shouldAutoCollapsePanel({
  viewportWidth,
  threshold,
  persistedCollapsed,
}: AutoCollapseInput): boolean {
  return Boolean(threshold && viewportWidth < threshold && !persistedCollapsed);
}

export function resolvePanelWidth({ width, collapsedWidth, collapsed }: PanelWidthInput): number {
  return collapsed ? collapsedWidth : width;
}

export function ResizableSidebarPanel({
  storageKey,
  side,
  title,
  children,
  defaultWidth,
  minWidth = 220,
  maxWidth = 520,
  collapsedWidth = 44,
  defaultCollapsed = false,
  className = '',
  collapsedClassName = '',
  renderCollapsed,
  collapsible = true,
  resizable = true,
  autoCollapseBelow,
}: ResizableSidebarPanelProps) {
  const { width, setWidth, collapsed, setCollapsed, toggleCollapsed } = useStoredPanelState({
    storageKey,
    defaultWidth,
    minWidth,
    maxWidth,
    defaultCollapsed,
  });
  const [autoCollapsed, setAutoCollapsed] = useState(false);
  const effectiveCollapsed = collapsed || autoCollapsed;
  const isWidthZeroCollapsed = effectiveCollapsed && collapsedWidth === 0;

  const collapseManually = useCallback(() => {
    setAutoCollapsed(false);
    toggleCollapsed();
  }, [toggleCollapsed]);

  const expandManually = useCallback(() => {
    setAutoCollapsed(false);
    setCollapsed(false);
  }, [setCollapsed]);

  const startResize = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!resizable || effectiveCollapsed) return;

      event.preventDefault();
      event.stopPropagation();

      const startX = event.clientX;
      const startWidth = width;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;

      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const deltaX = moveEvent.clientX - startX;
        const nextWidth = side === 'left' ? startWidth + deltaX : startWidth - deltaX;
        setWidth(nextWidth);
      };

      const handleMouseUp = () => {
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };

      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    },
    [effectiveCollapsed, resizable, setWidth, side, width],
  );

  const resizeByKeyboard = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!resizable || effectiveCollapsed) return;
      const growKey = side === 'left' ? 'ArrowRight' : 'ArrowLeft';
      const shrinkKey = side === 'left' ? 'ArrowLeft' : 'ArrowRight';
      if (![growKey, shrinkKey, 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      if (event.key === 'Home') {
        setWidth(minWidth);
        return;
      }
      if (event.key === 'End') {
        setWidth(maxWidth);
        return;
      }
      setWidth(width + (event.key === growKey ? 24 : -24));
    },
    [effectiveCollapsed, maxWidth, minWidth, resizable, setWidth, side, width],
  );

  const collapseButton = side === 'left' ? <ChevronLeft size={14} /> : <ChevronRight size={14} />;
  const expandButton = side === 'left' ? <ChevronRight size={14} /> : <ChevronLeft size={14} />;

  useEffect(() => {
    if (!autoCollapseBelow || !collapsible) return;

    const collapseWhenNarrow = () => {
      if (
        shouldAutoCollapsePanel({
          viewportWidth: window.innerWidth,
          threshold: autoCollapseBelow,
          persistedCollapsed: collapsed,
        })
      ) {
        setAutoCollapsed(true);
        return;
      }

      setAutoCollapsed(false);
    };

    collapseWhenNarrow();
    window.addEventListener('resize', collapseWhenNarrow);
    return () => window.removeEventListener('resize', collapseWhenNarrow);
  }, [autoCollapseBelow, collapsed, collapsible]);

  return (
    <div
      className="relative flex min-h-0 shrink-0"
      style={{
        width: resolvePanelWidth({
          width,
          collapsedWidth,
          collapsed: effectiveCollapsed,
        }),
      }}
    >
      {effectiveCollapsed ? (
        renderCollapsed ? (
          renderCollapsed({ expand: expandManually })
        ) : isWidthZeroCollapsed ? (
          <button
            type="button"
            onClick={expandManually}
            className={`absolute top-3 z-20 flex h-8 w-8 items-center justify-center rounded-lg border border-border/70 bg-bg-elevated text-text-secondary shadow-sm transition-colors hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
              side === 'left' ? 'left-2' : 'right-2'
            }`}
            title={`Expand ${title}`}
            aria-label={`Expand ${title}`}
          >
            {expandButton}
          </button>
        ) : (
          <div
            className={`flex min-h-0 w-full flex-col items-center justify-start border-border bg-bg-secondary py-2 ${
              side === 'left' ? 'border-r' : 'border-l'
            } ${collapsedClassName}`}
          >
            <button
              onClick={expandManually}
              className="rounded p-1 text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
              title={`Expand ${title}`}
              aria-label={`Expand ${title}`}
            >
              {expandButton}
            </button>
            <span className="mt-3 [writing-mode:vertical-rl] rotate-180 text-[10px] uppercase tracking-[0.2em] text-text-tertiary">
              {title}
            </span>
          </div>
        )
      ) : (
        <>
          <div className={`flex min-h-0 w-full flex-col overflow-hidden ${className}`}>
            {children}
          </div>

          {collapsible && (
            <button
              onClick={collapseManually}
              className={`absolute top-3 z-10 rounded-md border border-border/70 bg-bg-elevated/95 p-1 text-text-tertiary shadow-sm transition-colors hover:bg-bg-tertiary hover:text-text-primary ${
                side === 'left' ? 'right-3' : 'left-3'
              }`}
              title={`Collapse ${title}`}
              aria-label={`Collapse ${title}`}
            >
              {collapseButton}
            </button>
          )}

          {resizable && (
            <div
              onMouseDown={startResize}
              onKeyDown={resizeByKeyboard}
              className={`group absolute bottom-0 top-0 z-20 flex w-3 cursor-col-resize items-center justify-center ${
                side === 'left' ? '-right-1.5' : '-left-1.5'
              }`}
              role="separator"
              aria-label={`Resize ${title}`}
              aria-orientation="vertical"
              aria-valuemin={minWidth}
              aria-valuemax={maxWidth}
              aria-valuenow={width}
              tabIndex={0}
            >
              <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border/60 transition-colors group-hover:bg-accent" />
              <span className="relative flex h-9 w-3 items-center justify-center rounded-full border border-border bg-bg-elevated text-text-muted shadow-sm transition-colors group-hover:border-accent/50 group-hover:text-accent">
                <GripVertical size={10} />
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
