import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
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

export function shouldAutoCollapsePanel({
  viewportWidth,
  threshold,
  persistedCollapsed,
}: AutoCollapseInput): boolean {
  return Boolean(threshold && viewportWidth < threshold && !persistedCollapsed);
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
      style={{ width: effectiveCollapsed ? collapsedWidth : width }}
    >
      {effectiveCollapsed ? (
        renderCollapsed ? (
          renderCollapsed({ expand: expandManually })
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
              className={`absolute bottom-0 top-0 z-10 w-2 cursor-col-resize ${
                side === 'left' ? '-right-1' : '-left-1'
              }`}
              aria-hidden="true"
            >
              <div className="mx-auto h-full w-px bg-border/50 transition-colors hover:bg-accent" />
            </div>
          )}
        </>
      )}
    </div>
  );
}
