import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Download,
  ExternalLink,
  FolderGit2,
  MoreHorizontal,
  Pencil,
  Plus,
  Rocket,
} from 'lucide-react';
import type { WorkspaceActivityStatus, WorkspaceSummary } from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { WorkspaceBootstrapPanel } from './WorkspaceBootstrapPanel';
import { WorkspaceSetupPanel } from './WorkspaceSetupPanel';
import { ConfirmDialog, IconButton, Menu, MenuItem, MenuSeparator, PromptDialog, cx } from '../ui';

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

/**
 * Workspace rail rows. WS6/4.6/J7: every row (not just the active one) gets a
 * keyboard-reachable `…` menu built on the shared Menu primitive; right-click
 * opens the same menu. Rename goes through PromptDialog and delete through a
 * type-to-confirm ConfirmDialog — no native prompts.
 */
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
  const [renaming, setRenaming] = useState<WorkspaceSummary | null>(null);
  const [deleting, setDeleting] = useState<WorkspaceSummary | null>(null);
  const [panelWorkspace, setPanelWorkspace] = useState<WorkspaceSummary | null>(null);
  const [panelKind, setPanelKind] = useState<'bootstrap' | 'setup' | null>(null);
  // WS5: workspaces with a synced bootstrap recipe that still needs local
  // approval. The rail only surfaces "Review setup recipe" for these.
  const [pendingBootstrapIds, setPendingBootstrapIds] = useState<ReadonlySet<string>>(new Set());
  const activityByWorkspace = new Map(
    workspaceActivity.map((summary) => [summary.workspaceId, summary]),
  );

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      workspaces.map(async (workspace) => {
        try {
          const status = await window.anvil.workspace.bootstrapStatus(workspace.id);
          return status.recipe !== null && !status.approved ? workspace.id : null;
        } catch {
          return null;
        }
      }),
    ).then((ids) => {
      if (cancelled) return;
      setPendingBootstrapIds(new Set(ids.filter((id): id is string => id !== null)));
    });
    return () => {
      cancelled = true;
    };
  }, [workspaces]);

  const openRowMenu = (container: HTMLElement) => {
    container.querySelector<HTMLButtonElement>('[data-ws-menu-trigger]')?.click();
  };

  const openPanel = (workspace: WorkspaceSummary, kind: 'bootstrap' | 'setup') => {
    if (workspace.id !== activeWorkspace?.id) {
      void switchWorkspace(workspace.id);
    }
    setPanelWorkspace(workspace);
    setPanelKind(kind);
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
              onContextMenu={(event) => {
                // Compact rail has no room for a per-row menu — right-click
                // switches to the workspace so its actions stay reachable.
                event.preventDefault();
                if (!active) void switchWorkspace(workspace.id);
              }}
              className={cx(
                'titlebar-no-drag relative grid h-9 w-9 place-items-center rounded-lg text-xs font-semibold transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                active
                  ? 'bg-accent text-bg-primary'
                  : 'bg-bg-tertiary text-text-secondary hover:text-text-primary',
              )}
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
                  className={cx(
                    'absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-bg-secondary',
                    STATUS_DOT[activity.status],
                  )}
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
        <span className="text-eyebrow font-semibold uppercase tracking-wider text-text-tertiary">
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
            <div
              key={workspace.id}
              className="group/ws relative"
              onContextMenu={(event) => {
                event.preventDefault();
                openRowMenu(event.currentTarget);
              }}
            >
              <button
                type="button"
                onClick={() => {
                  if (!active) void switchWorkspace(workspace.id);
                }}
                className={cx(
                  'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                  active
                    ? 'bg-accent/12 text-text-primary'
                    : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary',
                )}
                aria-current={active ? 'true' : undefined}
                title={
                  activity ? workspaceBadgeLabel(activity.status, activity.count) : workspace.name
                }
              >
                <span
                  className={cx(
                    'grid h-6 w-6 shrink-0 place-items-center rounded-md text-eyebrow font-semibold',
                    active ? 'bg-accent text-bg-primary' : 'bg-bg-tertiary text-text-secondary',
                  )}
                >
                  {workspace.name.slice(0, 2).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">{workspace.name}</span>
                  <span className="block truncate text-xs text-text-tertiary">
                    {active && statusLabel !== 'Ready'
                      ? statusLabel
                      : workspace.definitionState === 'needs-setup'
                        ? 'Needs checkout setup'
                        : `${workspace.repoCount} ${workspace.repoCount === 1 ? 'repo' : 'repos'}`}
                  </span>
                </span>
                {activity ? (
                  <span
                    className={cx(
                      'inline-flex shrink-0 items-center gap-1.5 rounded-full px-1.5 py-0.5 text-eyebrow font-semibold',
                      activity.status === 'error'
                        ? 'bg-error/15 text-error'
                        : activity.status === 'warning'
                          ? 'bg-warning/15 text-warning'
                          : activity.status === 'ready'
                            ? 'bg-success/15 text-success'
                            : activity.status === 'running'
                              ? 'bg-info/15 text-info'
                              : 'bg-bg-tertiary text-text-tertiary',
                    )}
                    aria-label={workspaceBadgeLabel(activity.status, activity.count)}
                  >
                    <span className={cx('h-1.5 w-1.5 rounded-full', STATUS_DOT[activity.status])} />
                    {activity.count > 9 ? '9+' : activity.count}
                  </span>
                ) : (
                  active && <Check size={13} className="shrink-0 text-accent" />
                )}
              </button>

              {/* J7/4.6: actions on every row — visible on hover/focus-within,
                  reachable by keyboard, and opened by right-click. */}
              <span className="absolute right-1.5 top-1/2 -translate-y-1/2">
                <Menu
                  label={`${workspace.name} actions`}
                  trigger={(props) => (
                    <IconButton
                      {...props}
                      data-ws-menu-trigger
                      icon={MoreHorizontal}
                      label={`${workspace.name} actions`}
                      className="opacity-0 transition-opacity focus-visible:opacity-100 group-focus-within/ws:opacity-100 group-hover/ws:opacity-100"
                    />
                  )}
                >
                  {!active && (
                    <MenuItem
                      icon={<Check size={14} />}
                      onSelect={() => void switchWorkspace(workspace.id)}
                    >
                      Switch to workspace
                    </MenuItem>
                  )}
                  <MenuItem icon={<Pencil size={14} />} onSelect={() => setRenaming(workspace)}>
                    Rename…
                  </MenuItem>
                  <MenuItem
                    icon={<ExternalLink size={14} />}
                    onSelect={() => void window.anvil.workspace.openInNewWindow(workspace.id)}
                  >
                    Open in new window
                  </MenuItem>
                  {workspace.definitionState === 'needs-setup' && (
                    <MenuItem
                      icon={<FolderGit2 size={14} />}
                      onSelect={() => openPanel(workspace, 'setup')}
                    >
                      Set up checkouts…
                    </MenuItem>
                  )}
                  {pendingBootstrapIds.has(workspace.id) && (
                    <MenuItem
                      icon={<Rocket size={14} />}
                      onSelect={() => openPanel(workspace, 'bootstrap')}
                    >
                      Review setup recipe…
                    </MenuItem>
                  )}
                  <MenuItem
                    icon={<Download size={14} />}
                    onSelect={() => void window.anvil.workspace.exportVSCodeWorkspace(workspace.id)}
                  >
                    Export VS Code workspace
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem destructive onSelect={() => setDeleting(workspace)}>
                    Delete workspace…
                  </MenuItem>
                </Menu>
              </span>
            </div>
          );
        })}
      </div>

      {/* WS6/J6: themed rename prompt replaces window.prompt. */}
      <PromptDialog
        open={renaming !== null}
        title="Rename workspace"
        label="Workspace name"
        defaultValue={renaming?.name ?? ''}
        confirmLabel="Rename"
        onSubmit={(name) => {
          if (renaming && name !== renaming.name) {
            void updateWorkspace(renaming.id, { name });
          }
          setRenaming(null);
        }}
        onCancel={() => setRenaming(null)}
      />

      <DeleteWorkspaceDialog
        workspace={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={async (id) => {
          setDeleting(null);
          await deleteWorkspace(id);
        }}
      />

      {panelKind === 'bootstrap' && panelWorkspace && (
        <WorkspaceBootstrapPanel
          workspaceId={panelWorkspace.id}
          workspaceName={panelWorkspace.name}
          onClose={() => {
            setPanelKind(null);
            setPanelWorkspace(null);
          }}
        />
      )}
      {panelKind === 'setup' && panelWorkspace && (
        <WorkspaceSetupPanel
          workspaceId={panelWorkspace.id}
          workspaceName={panelWorkspace.name}
          onClose={() => {
            setPanelKind(null);
            setPanelWorkspace(null);
          }}
          onChanged={() => void refreshWorkspaces()}
        />
      )}
    </div>
  );
}

/**
 * WS1: honest hard-delete confirmation. Lists what is deleted, notes that the
 * deletion syncs to other devices and that repositories on disk are
 * untouched, and requires typing the workspace name when it has chat
 * history.
 */
function DeleteWorkspaceDialog({
  workspace,
  onClose,
  onDeleted,
}: {
  workspace: WorkspaceSummary | null;
  onClose: () => void;
  onDeleted: (id: string) => Promise<void>;
}) {
  const [threadCount, setThreadCount] = useState<number | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;
    setThreadCount(null);
    setError(null);
    window.anvil.chat
      .listThreads(workspace.id)
      .then((threads) => {
        if (!cancelled) setThreadCount(threads.length);
      })
      .catch(() => {
        if (!cancelled) setThreadCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [workspace]);

  if (!workspace) return null;
  const hasHistory = (threadCount ?? 0) > 0;

  return (
    <ConfirmDialog
      open
      tone="danger"
      title={`Delete "${workspace.name}"?`}
      requireText={hasHistory ? workspace.name : undefined}
      confirmLabel="Delete workspace"
      loading={working}
      onCancel={onClose}
      onConfirm={() => {
        setWorking(true);
        void onDeleted(workspace.id).catch((err) => {
          if (mountedRef.current) {
            setError(err instanceof Error ? err.message : 'Failed to delete the workspace.');
            setWorking(false);
          }
        });
      }}
      description={
        <div className="space-y-2">
          <p>
            This permanently deletes the workspace
            {hasHistory
              ? `, its ${threadCount} chat ${threadCount === 1 ? 'thread' : 'threads'} and messages,`
              : ','}{' '}
            its preferences, and its repo links — on this device and, via sync, on your other
            devices.
          </p>
          <p>
            Repositories on disk and their indexes are not touched; reviews and audit history are
            kept.
          </p>
          {threadCount === null && (
            <p className="text-text-tertiary">Checking workspace history…</p>
          )}
          {error && <p className="text-error">{error}</p>}
        </div>
      }
    />
  );
}
