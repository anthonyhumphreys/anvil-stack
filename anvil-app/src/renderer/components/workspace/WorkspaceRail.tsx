import React, { useState, useRef, useEffect } from 'react';
import { ChevronRight, ChevronLeft } from 'lucide-react';
import type { WorkspaceSummary } from '../../../shared/types.js';
import { useStoredPanelState } from '../../hooks/useStoredPanelState';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface WorkspaceRailProps {
  workspaces: WorkspaceSummary[];
  activeWorkspaceId: string | null;
  reserveTitlebarSpace?: boolean;
  onSwitch: (id: string) => void;
  onCreateNew: () => void;
  onRename: (id: string) => void;
  onManageRepos: (id: string) => void;
  onOpenInNewWindow: (id: string) => void;
  onExportVSCode: (id: string) => void;
  onDelete: (id: string) => void;
}

// ---------------------------------------------------------------------------
// Deterministic colour palette
// ---------------------------------------------------------------------------

const WORKSPACE_COLORS = [
  'from-[#b5121b] to-[#d44a33]',
  'from-[#8f2d23] to-[#b96f2c]',
  'from-[#a65018] to-[#fd9029]',
  'from-[#6b7f52] to-[#72b589]',
  'from-[#5d6f80] to-[#79a7c6]',
  'from-[#555656] to-[#8b847b]',
];

function getWorkspaceColor(id: string): string {
  let hash = 0;
  for (const char of id) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return WORKSPACE_COLORS[Math.abs(hash) % WORKSPACE_COLORS.length];
}

// ---------------------------------------------------------------------------
// Context menu state
// ---------------------------------------------------------------------------

interface ContextMenuState {
  workspaceId: string;
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WorkspaceRail({
  workspaces,
  activeWorkspaceId,
  reserveTitlebarSpace = true,
  onSwitch,
  onCreateNew,
  onRename,
  onManageRepos,
  onOpenInNewWindow,
  onExportVSCode,
  onDelete,
}: WorkspaceRailProps) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { width, setWidth, collapsed, toggleCollapsed } = useStoredPanelState({
    storageKey: 'layout:workspace-rail',
    defaultWidth: 212,
    minWidth: 180,
    maxWidth: 320,
    defaultCollapsed: true,
  });
  const expanded = !collapsed;

  // Close context menu on any outside click
  useEffect(() => {
    if (!contextMenu) return;

    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };

    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [contextMenu]);

  const handleContextMenu = (e: React.MouseEvent, workspaceId: string) => {
    e.preventDefault();
    setContextMenu({ workspaceId, x: e.clientX, y: e.clientY });
  };

  const handleResizeStart = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!expanded) return;

    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handleMouseMove = (moveEvent: MouseEvent) => {
      setWidth(startWidth + (moveEvent.clientX - startX));
    };

    const handleMouseUp = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const closeMenu = () => setContextMenu(null);

  return (
    <div
      className="relative flex flex-shrink-0 flex-col bg-bg-secondary transition-[width] duration-200"
      style={{ width: expanded ? width : 76 }}
    >
      {reserveTitlebarSpace && <div className="titlebar-drag h-14 shrink-0" />}
      <div className="flex min-h-0 flex-1 flex-col gap-2 border-r border-border px-3 pb-3 pt-2.5">
        {/* Label */}
        <span
          className={`mb-1 text-[10px] uppercase tracking-[0.24em] text-text-tertiary ${expanded ? 'px-1' : 'text-center'}`}
        >
          Spaces
        </span>

        {/* Workspace avatars */}
        {workspaces.map((ws) => {
          const isActive = ws.id === activeWorkspaceId;
          const color = getWorkspaceColor(ws.id);
          const initials = ws.name.slice(0, 2).toUpperCase();

          return (
            <button
              key={ws.id}
              type="button"
              title={ws.name}
              onClick={() => onSwitch(ws.id)}
              onContextMenu={(e) => handleContextMenu(e, ws.id)}
              className={[
                'relative flex items-center cursor-pointer transition-all',
                expanded
                  ? 'rounded-xl gap-3 px-3 py-2'
                  : 'mx-auto h-11 w-11 rounded-xl justify-center',
                isActive
                  ? `bg-gradient-to-br ${color} text-white shadow-[0_10px_24px_rgba(0,0,0,0.18)]`
                  : expanded
                    ? 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
                    : 'border border-border bg-bg-tertiary text-text-tertiary hover:text-text-primary',
              ].join(' ')}
            >
              {/* Active indicator pill */}
              {isActive && (
                <div className="absolute -left-3 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r-sm bg-accent" />
              )}
              <span
                className={`shrink-0 ${expanded ? 'flex h-9 w-9 items-center justify-center rounded-lg text-[11px] font-bold' : 'text-sm font-bold'} ${
                  isActive ? '' : expanded ? `bg-gradient-to-br ${color} text-white` : ''
                }`}
              >
                {initials}
              </span>
              {expanded && <span className="truncate text-sm font-medium">{ws.name}</span>}
            </button>
          );
        })}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Add workspace button */}
        <button
          type="button"
          title="New workspace"
          onClick={onCreateNew}
          className={`${expanded ? 'flex items-center gap-3 rounded-xl px-3 py-2' : 'mx-auto flex h-11 w-11 items-center justify-center rounded-xl'} cursor-pointer border border-dashed border-border text-text-tertiary transition-all hover:border-text-tertiary hover:text-text-primary`}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          {expanded && <span className="text-sm font-medium">New workspace</span>}
        </button>

        {/* Expand / Collapse toggle */}
        <button
          type="button"
          title={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
          onClick={toggleCollapsed}
          className={`${expanded ? 'mb-1 flex items-center gap-3 rounded-xl px-3 py-2' : 'mx-auto mb-1 flex h-11 w-11 items-center justify-center rounded-xl'} cursor-pointer text-text-tertiary transition-all hover:bg-bg-tertiary hover:text-text-primary`}
        >
          {expanded ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
          {expanded && <span className="text-xs uppercase tracking-wider">Collapse</span>}
        </button>
      </div>

      {expanded && (
        <div
          onMouseDown={handleResizeStart}
          className="absolute -right-1 bottom-0 top-0 z-10 w-2 cursor-col-resize"
          aria-hidden="true"
        >
          <div className="mx-auto h-full w-px bg-border/50 transition-colors hover:bg-accent" />
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[160px] rounded-md border border-border bg-bg-elevated py-1 shadow-lg"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <div
            className="cursor-pointer px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
            onClick={() => {
              onRename(contextMenu.workspaceId);
              closeMenu();
            }}
          >
            Rename
          </div>
          <div
            className="cursor-pointer px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
            onClick={() => {
              onManageRepos(contextMenu.workspaceId);
              closeMenu();
            }}
          >
            Manage Repos
          </div>
          <div
            className="cursor-pointer px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
            onClick={() => {
              onOpenInNewWindow(contextMenu.workspaceId);
              closeMenu();
            }}
          >
            Open in New Window
          </div>
          <div className="my-1 h-px bg-border-subtle" />
          <div
            className="cursor-pointer px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
            onClick={() => {
              onExportVSCode(contextMenu.workspaceId);
              closeMenu();
            }}
          >
            Export VS Code Workspace
          </div>
          <div className="my-1 h-px bg-border-subtle" />
          <div
            className="cursor-pointer px-3 py-1.5 text-sm text-error hover:bg-error/10"
            onClick={() => {
              onDelete(contextMenu.workspaceId);
              closeMenu();
            }}
          >
            Delete Workspace
          </div>
        </div>
      )}
    </div>
  );
}
