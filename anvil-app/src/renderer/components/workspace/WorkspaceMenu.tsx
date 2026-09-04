import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronsUpDown, Download, ExternalLink, Pencil, Plus, Trash2 } from 'lucide-react';
import { useBrand } from '../../contexts/BrandContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { AnvilLogo } from '../brand/AnvilLogo';

interface WorkspaceMenuProps {
  compact: boolean;
  statusLabel: string;
  onCreateNew: () => void;
}

export function WorkspaceMenu({ compact, statusLabel, onCreateNew }: WorkspaceMenuProps) {
  const brand = useBrand();
  const { workspaces, activeWorkspace, switchWorkspace, updateWorkspace, deleteWorkspace } =
    useWorkspace();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const orderedWorkspaces = activeWorkspace
    ? workspaces.toSorted(
        (left, right) =>
          Number(right.id === activeWorkspace.id) - Number(left.id === activeWorkspace.id),
      )
    : workspaces;

  useEffect(() => {
    if (!open) return;

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', closeOnOutsideClick);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const renameActiveWorkspace = async () => {
    if (!activeWorkspace) return;
    const newName = window.prompt('Rename workspace:', activeWorkspace.name)?.trim();
    if (newName && newName !== activeWorkspace.name) {
      await updateWorkspace(activeWorkspace.id, { name: newName });
    }
    setOpen(false);
  };

  const deleteActiveWorkspace = async () => {
    if (!activeWorkspace) return;
    if (window.confirm('Delete this workspace? Repositories will not be removed.')) {
      await deleteWorkspace(activeWorkspace.id);
    }
    setOpen(false);
  };

  return (
    <div ref={menuRef} className="titlebar-no-drag relative min-w-0 flex-1">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className={`group flex items-center border border-border-subtle bg-bg-tertiary/55 text-left transition-colors hover:border-border hover:bg-bg-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
          compact
            ? 'relative mx-auto h-11 w-11 justify-center rounded-xl'
            : 'w-full gap-2.5 rounded-xl px-2.5 py-2'
        }`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Switch workspace. Current workspace: ${activeWorkspace?.name ?? 'none'}`}
        title={compact ? (activeWorkspace?.name ?? 'Choose workspace') : undefined}
      >
        <AnvilLogo size={compact ? 33 : 34} showGlow />
        {!compact && (
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-text-primary">
              {brand.appName}
            </span>
            <span className="block truncate text-xs text-text-secondary">
              {activeWorkspace?.name ?? 'Choose workspace'}
            </span>
          </span>
        )}
        <ChevronsUpDown
          size={compact ? 12 : 14}
          className={`${
            compact
              ? 'absolute -bottom-1 -right-1 rounded-full border border-border bg-bg-elevated p-0.5'
              : ''
          } shrink-0 text-text-tertiary transition-colors group-hover:text-text-primary`}
        />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Workspaces"
          className="absolute left-0 top-[calc(100%+8px)] z-50 w-72 overflow-hidden rounded-xl border border-border bg-bg-elevated shadow-[0_16px_40px_rgba(0,0,0,0.32)]"
        >
          <div className="max-h-64 overflow-y-auto p-1.5">
            {orderedWorkspaces.map((workspace) => {
              const active = workspace.id === activeWorkspace?.id;
              return (
                <button
                  key={workspace.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  onClick={() => {
                    setOpen(false);
                    if (!active) void switchWorkspace(workspace.id);
                  }}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                    active
                      ? 'bg-accent/12 text-text-primary'
                      : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
                  }`}
                >
                  <span
                    className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg text-xs font-semibold ${
                      active ? 'bg-accent text-bg-primary' : 'bg-bg-tertiary text-text-secondary'
                    }`}
                  >
                    {workspace.name.slice(0, 2).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{workspace.name}</span>
                    <span className="block text-xs text-text-tertiary">
                      {workspace.repoCount}{' '}
                      {workspace.repoCount === 1 ? 'repository' : 'repositories'}
                    </span>
                  </span>
                  {active && <Check size={15} className="shrink-0 text-accent" />}
                </button>
              );
            })}
          </div>

          <div className="border-t border-border-subtle p-1.5">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onCreateNew();
              }}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
            >
              <Plus size={15} className="text-accent" /> New workspace
            </button>
          </div>

          {activeWorkspace && (
            <div className="border-t border-border-subtle p-1.5">
              <div className="flex items-center justify-between px-3 py-1.5 text-xs text-text-tertiary">
                <span>
                  {activeWorkspace.repos.length}{' '}
                  {activeWorkspace.repos.length === 1 ? 'repository' : 'repositories'}
                </span>
                <span>{statusLabel}</span>
              </div>
              <MenuAction
                icon={<Pencil size={14} />}
                label="Rename"
                onClick={renameActiveWorkspace}
              />
              <MenuAction
                icon={<ExternalLink size={14} />}
                label="Open in new window"
                onClick={() => {
                  setOpen(false);
                  void window.anvil.workspace.openInNewWindow(activeWorkspace.id);
                }}
              />
              <MenuAction
                icon={<Download size={14} />}
                label="Export VS Code workspace"
                onClick={() => {
                  setOpen(false);
                  void window.anvil.workspace.exportVSCodeWorkspace(activeWorkspace.id);
                }}
              />
              <MenuAction
                icon={<Trash2 size={14} />}
                label="Delete workspace"
                onClick={deleteActiveWorkspace}
                destructive
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MenuAction({
  icon,
  label,
  onClick,
  destructive = false,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
        destructive
          ? 'text-error hover:bg-error/10'
          : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
