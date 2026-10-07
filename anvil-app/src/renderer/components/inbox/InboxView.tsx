import { useMemo } from 'react';
import { ArrowRight, CheckCircle2, Inbox } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { WorkspaceActivityItem, WorkspaceActivityStatus } from '../../../shared/types';
import {
  SidebarActivityIcon,
  useSidebarActivity,
  type SidebarActivityItem,
} from '../layout/SidebarActivityCenter';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { EmptyState, ViewHeader } from '../layout/ViewScaffold';

interface ActivityRow {
  item: WorkspaceActivityItem;
  onOpen: () => void;
}

interface WorkspaceGroup {
  workspaceId: string;
  name: string;
  active: boolean;
  worstStatus: WorkspaceActivityStatus;
  items: WorkspaceActivityItem[];
}

function worstStatusOf(items: WorkspaceActivityItem[]): WorkspaceActivityStatus {
  return items.reduce<WorkspaceActivityStatus>(
    (worst, item) => (statusRank(item.status) > statusRank(worst) ? item.status : worst),
    'queued',
  );
}

function statusRank(status: WorkspaceActivityStatus): number {
  if (status === 'error') return 5;
  if (status === 'warning') return 4;
  if (status === 'ready') return 3;
  if (status === 'running') return 2;
  return 1;
}

export function InboxView() {
  const navigate = useNavigate();
  const { items } = useSidebarActivity();
  const { workspaceActivity, activeWorkspace, switchWorkspace } = useWorkspace();

  // The active workspace renders its live, richer activity items; every other
  // workspace comes from the shared cross-workspace feed.
  const groups = useMemo<WorkspaceGroup[]>(() => {
    const byWorkspace = new Map<string, WorkspaceGroup>();

    if (activeWorkspace && items.length > 0) {
      const liveItems = items.map((item: SidebarActivityItem) => ({
        ...item,
        workspaceId: activeWorkspace.id,
      }));
      byWorkspace.set(activeWorkspace.id, {
        workspaceId: activeWorkspace.id,
        name: activeWorkspace.name,
        active: true,
        worstStatus: worstStatusOf(liveItems),
        items: liveItems,
      });
    }

    for (const summary of workspaceActivity) {
      if (summary.workspaceId === activeWorkspace?.id && byWorkspace.has(summary.workspaceId)) {
        continue;
      }
      byWorkspace.set(summary.workspaceId, {
        workspaceId: summary.workspaceId,
        name: summary.workspaceName,
        active: summary.workspaceId === activeWorkspace?.id,
        worstStatus: summary.status,
        items: summary.items,
      });
    }

    return [...byWorkspace.values()].sort((a, b) => {
      const rankDelta = statusRank(b.worstStatus) - statusRank(a.worstStatus);
      if (rankDelta !== 0) return rankDelta;
      return Number(b.active) - Number(a.active);
    });
  }, [items, workspaceActivity, activeWorkspace]);

  const totalItems = groups.reduce((sum, group) => sum + group.items.length, 0);

  const openItem = (item: WorkspaceActivityItem) => {
    if (item.workspaceId === activeWorkspace?.id) {
      navigate(item.route);
      return;
    }
    void switchWorkspace(item.workspaceId).then(() => navigate(item.route));
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-primary">
      <ViewHeader
        icon={Inbox}
        title="Activity"
        description="Decisions waiting on you and work in flight across every workspace."
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        {totalItems === 0 ? (
          <EmptyState
            icon={CheckCircle2}
            title="All quiet"
            description="Approvals, questions, failures, completed work, and active runs across your workspaces will appear here."
          />
        ) : (
          <div className="mx-auto max-w-4xl space-y-8">
            {groups.map((group) => (
              <section key={group.workspaceId}>
                <div className="mb-3 flex items-end justify-between gap-4">
                  <div className="flex items-center gap-2">
                    <span
                      className={`h-2 w-2 rounded-full ${
                        group.worstStatus === 'error'
                          ? 'bg-error'
                          : group.worstStatus === 'warning'
                            ? 'bg-warning'
                            : group.worstStatus === 'ready'
                              ? 'bg-success'
                              : group.worstStatus === 'running'
                                ? 'bg-info animate-pulse'
                                : 'bg-text-tertiary'
                      }`}
                      aria-hidden="true"
                    />
                    <h3 className="text-sm font-semibold text-text-primary">
                      {group.name}
                      {group.active && (
                        <span className="ml-2 text-xs font-normal text-text-tertiary">
                          current workspace
                        </span>
                      )}
                    </h3>
                  </div>
                  <span className="text-xs tabular-nums text-text-tertiary">
                    {group.items.length}
                  </span>
                </div>
                <div className="divide-y divide-border-subtle rounded-lg border border-border-subtle">
                  {group.items.map((item) => (
                    <ActivityItemRow key={item.id} item={item} onOpen={() => openItem(item)} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ActivityItemRow({ item, onOpen }: ActivityRow) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex w-full items-start gap-3 px-3 py-3.5 text-left transition-colors hover:bg-bg-secondary"
    >
      <SidebarActivityIcon status={item.status} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-text-primary">{item.title}</span>
        <span className="mt-0.5 block truncate text-xs text-text-tertiary">{item.detail}</span>
      </span>
      {item.startedAt && (
        <span className="shrink-0 pt-0.5 text-xs text-text-tertiary">
          {formatActivityTime(item.startedAt)}
        </span>
      )}
      <ArrowRight
        size={14}
        className="mt-0.5 shrink-0 text-text-tertiary transition-transform group-hover:translate-x-0.5 group-hover:text-text-secondary"
      />
    </button>
  );
}

function formatActivityTime(value: string): string {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return '';
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (elapsedMinutes < 1) return 'Now';
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h`;
  return `${Math.floor(elapsedHours / 24)}d`;
}
