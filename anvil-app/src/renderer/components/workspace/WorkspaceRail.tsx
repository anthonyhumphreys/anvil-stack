import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Check,
  Download,
  ExternalLink,
  FolderGit2,
  MoreHorizontal,
  Pencil,
  Plus,
  Rocket,
  Trash2,
} from 'lucide-react';
import type { WorkspaceActivityStatus } from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { WorkspaceBootstrapPanel } from './WorkspaceBootstrapPanel';
import { WorkspaceSetupPanel } from './WorkspaceSetupPanel';

interface WorkspaceRailProps {
  compact: boolean;
  statusLabel: string;
  onCreateNew: () => void;
}

const STATUS_DOT: Record<WorkspaceActivityStatus, string> = {
  error: 'bg-error',
  warning: 'bg-warning',
  ready: 'bg-success',
  running: 'bg-info animate-pulse',
  queued: 'bg-text-tertiary',
};

function workspaceBadgeLabel(status: WorkspaceActivityStatus, count: number): string {
  const kind =
    status === 'error'
      ? 'needs attention'
      : status === 'warning'
        ? 'waiting on you'
        : status === 'ready'
          ? 'ready to review'
          : status === 'running'
            ? 'running'
            : 'queued';
  return `${count} item${count === 1 ? '' : 's'} ${kind}`;
}

export function WorkspaceRail({ compact, statusLabel, onCreateNew }: WorkspaceRailProps) {
  const {
    workspaces,
    workspaceActivity,
    activeWorkspace,
    switchWorkspace,
    updateWorkspace,
    deleteWorkspace,
    refreshWorkspaces,
  } = useWorkspace();
  const [actionsOpen, setActionsOpen] = useState(false);
  const [showBootstrap, setShowBootstrap] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);
  const activityByWorkspace = new Map(
    workspaceActivity.map((summary) => [summary.workspaceId, summary]),
  );

  useEffect(() => {
    if (!actionsOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!actionsRef.current?.contains(event.target as Node)) setActionsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActionsOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [actionsOpen]);

  const renameActiveWorkspace = async () => {
    if (!activeWorkspace) return;
    const newName = window.prompt('Rename workspace:', activeWorkspace.name)?.trim();
    if (newName && newName !== activeWorkspace.name) {
      await updateWorkspace(activeWorkspace.id, { name: newName });
    }
    setActionsOpen(false);
  };

  const deleteActiveWorkspace = async () => {
    if (!activeWorkspace) return;
    if (window.confirm('Delete this workspace? Repositories will not be removed.')) {
      await deleteWorkspace(activeWorkspace.id);
    }
    setActionsOpen(false);
  };

  if (compact) {
    return (
      <div className="flex flex-col items-center gap-1.5">
        {workspaces.map((workspace) => {
          const active = workspace.id === activeWorkspace?.id;
          const activity = activityByWorkspace.get(workspace.id);
          return (
            <button
              key={workspace.id}
              type="button"
              onClick={() => {
                if (!active) void switchWorkspace(workspace.id);
              }}
              className={`titlebar-no-drag relative grid h-9 w-9 place-items-center rounded-lg text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
                active
                  ? 'bg-accent text-bg-primary'
                  : 'bg-bg-tertiary text-text-secondary hover:text-text-primary'
              }`}
              title={
                activity
                  ? `${workspace.name} — ${workspaceBadgeLabel(activity.status, activity.count)}`
                  : workspace.name
              }
              aria-label={
                activity
                  ? `Switch to ${workspace.name}. ${workspaceBadgeLabel(activity.status, activity.count)}`
                  : `Switch to ${workspace.name}`
              }
              aria-current={active ? 'true' : undefined}
            >
              {workspace.name.slice(0, 2).toUpperCase()}
              {activity && (
                <span
                  className={`absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-bg-secondary ${STATUS_DOT[activity.status]}`}
                  aria-hidden="true"
                />
              )}
            </button>
          );
        })}
        <button
          type="button"
          onClick={onCreateNew}
          className="titlebar-no-drag grid h-9 w-9 place-items-center rounded-lg border border-dashed border-border text-text-tertiary transition-colors hover:border-accent/50 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          title="New workspace"
          aria-label="New workspace"
        >
          <Plus size={14} />
        </button>
      </div>
    );
  }

  return (
    <div className="titlebar-no-drag min-w-0 flex-1">
      <div className="flex items-center justify-between px-1 pb-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
          Workspaces
        </span>
        <button
          type="button"
          onClick={onCreateNew}
          className="rounded-md p-1 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          title="New workspace"
          aria-label="New workspace"
        >
          <Plus size={13} />
        </button>
      </div>

      <div className="max-h-44 space-y-0.5 overflow-y-auto rounded-lg border border-border-subtle bg-bg-primary/40 p-1">
        {workspaces.map((workspace) => {
          const active = workspace.id === activeWorkspace?.id;
          const activity = activityByWorkspace.get(workspace.id);
          return (
            <div key={workspace.id} className="group/ws relative">
              <button
                type="button"
                onClick={() => {
                  if (!active) void switchWorkspace(workspace.id);
                }}
                className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
                  active
                    ? 'bg-accent/12 text-text-primary'
                    : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
                }`}
                aria-current={active ? 'true' : undefined}
                title={
                  activity
                    ? workspaceBadgeLabel(activity.status, activity.count)
                    : workspace.name
                }
              >
                <span
                  className={`grid h-6 w-6 shrink-0 place-items-center rounded-md text-[10px] font-semibold ${
                    active ? 'bg-accent text-bg-primary' : 'bg-bg-tertiary text-text-secondary'
                  }`}
                >
                  {workspace.name.slice(0, 2).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">{workspace.name}</span>
                  <span className="block truncate text-[11px] text-text-tertiary">
                    {active && statusLabel !== 'Ready'
                      ? statusLabel
                      : workspace.definitionState === 'needs-setup'
                        ? 'Needs checkout setup'
                        : `${workspace.repoCount} ${workspace.repoCount === 1 ? 'repo' : 'repos'}`}
                  </span>
                </span>
                {activity ? (
                  <span
                    className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
                      activity.status === 'error'
                        ? 'bg-error/15 text-error'
                        : activity.status === 'warning'
                          ? 'bg-warning/15 text-warning'
                          : activity.status === 'ready'
                            ? 'bg-success/15 text-success'
                            : activity.status === 'running'
                              ? 'bg-info/15 text-info'
                              : 'bg-bg-tertiary text-text-tertiary'
                    }`}
                    aria-label={workspaceBadgeLabel(activity.status, activity.count)}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[activity.status]}`} />
                    {activity.count > 9 ? '9+' : activity.count}
                  </span>
                ) : (
                  active && <Check size={13} className="shrink-0 text-accent" />
                )}
              </button>
              {active && (
                <div ref={actionsRef} className="absolute right-1.5 top-1/2 -translate-y-1/2">
                  <button
                    type="button"
                    onClick={() => setActionsOpen((open) => !open)}
                    className="rounded-md p-1 text-text-tertiary opacity-0 transition-opacity hover:bg-bg-elevated hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 group-hover/ws:opacity-100"
                    aria-label="Workspace actions"
                    aria-haspopup="menu"
                    aria-expanded={actionsOpen}
                  >
                    <MoreHorizontal size={13} />
                  </button>
                  {actionsOpen && (
                    <div
                      role="menu"
                      aria-label="Workspace actions"
                      className="absolute right-0 top-[calc(100%+4px)] z-50 w-56 overflow-hidden rounded-xl border border-border bg-bg-elevated p-1.5 shadow-[0_16px_40px_rgba(0,0,0,0.32)]"
                    >
                      <MenuAction
                        icon={<Pencil size={14} />}
                        label="Rename"
                        onClick={() => void renameActiveWorkspace()}
                      />
                      <MenuAction
                        icon={<ExternalLink size={14} />}
                        label="Open in new window"
                        onClick={() => {
                          setActionsOpen(false);
                          void window.anvil.workspace.openInNewWindow(workspace.id);
                        }}
                      />
                      {workspace.definitionState === 'needs-setup' && (
                        <MenuAction
                          icon={<FolderGit2 size={14} />}
                          label="Set up checkouts…"
                          onClick={() => {
                            setActionsOpen(false);
                            setShowSetup(true);
                          }}
                        />
                      )}
                      <MenuAction
                        icon={<Rocket size={14} />}
                        label="Bootstrap…"
                        onClick={() => {
                          setActionsOpen(false);
                          setShowBootstrap(true);
                        }}
                      />
                      <MenuAction
                        icon={<Download size={14} />}
                        label="Export VS Code workspace"
                        onClick={() => {
                          setActionsOpen(false);
                          void window.anvil.workspace.exportVSCodeWorkspace(workspace.id);
                        }}
                      />
                      <MenuAction
                        icon={<Trash2 size={14} />}
                        label="Delete workspace"
                        onClick={() => void deleteActiveWorkspace()}
                        destructive
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {showBootstrap && activeWorkspace && (
        <WorkspaceBootstrapPanel
          workspaceId={activeWorkspace.id}
          workspaceName={activeWorkspace.name}
          onClose={() => setShowBootstrap(false)}
        />
      )}
      {showSetup && activeWorkspace && (
        <WorkspaceSetupPanel
          workspaceId={activeWorkspace.id}
          workspaceName={activeWorkspace.name}
          onClose={() => setShowSetup(false)}
          onChanged={() => void refreshWorkspaces()}
        />
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
