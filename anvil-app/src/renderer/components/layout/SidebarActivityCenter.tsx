import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  Loader2,
  PlayCircle,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { AgentRunSummary, Feature, SimulatorPreviewStatus } from '../../../shared/types';
import type { RunStatus } from '../../../shared/run-types';
import { useChatContext } from '../../contexts/ChatContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';

type SidebarActivityStatus = 'running' | 'queued' | 'warning' | 'error';

export interface SidebarActivityItem {
  id: string;
  feature: Feature;
  route: string;
  title: string;
  detail: string;
  status: SidebarActivityStatus;
  startedAt?: string;
}

export interface SidebarActivityIndicator {
  count: number;
  status: SidebarActivityStatus;
  label: string;
}

const ACTIVE_RUN_STATUSES = new Set(['queued', 'running']);
const ACTIVE_CHAT_STATUSES = new Set(['starting', 'busy']);

export function useSidebarActivity(): {
  items: SidebarActivityItem[];
  indicators: Partial<Record<Feature, SidebarActivityIndicator>>;
  activeCount: number;
} {
  const { activeWorkspace, activeScaffoldSession, repos, featureAvailability } = useWorkspace();
  const { busy, liveThreadStatuses, activeThread } = useChatContext();
  const [agentRuns, setAgentRuns] = useState<AgentRunSummary[]>([]);
  const [runStatuses, setRunStatuses] = useState<RunStatus[]>([]);
  const [simulatorStatus, setSimulatorStatus] = useState<SimulatorPreviewStatus>({
    running: false,
  });

  useEffect(() => {
    if (!activeWorkspace?.id) {
      setAgentRuns([]);
      return;
    }

    let cancelled = false;
    const refresh = () => {
      window.anvil.agentRuns
        .list(activeWorkspace.id, 12)
        .then((runs) => {
          if (!cancelled) setAgentRuns(runs);
        })
        .catch(() => {
          if (!cancelled) setAgentRuns([]);
        });
    };

    refresh();
    const interval = window.setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeWorkspace?.id]);

  useEffect(() => {
    const repoIds = repos.map((repo) => repo.id);
    if (repoIds.length === 0) {
      setRunStatuses([]);
      return;
    }

    let cancelled = false;
    const refresh = () => {
      Promise.all(repoIds.map((repoId) => window.anvil.run.getStatus(repoId).catch(() => null)))
        .then((statuses) => {
          if (!cancelled) {
            setRunStatuses(statuses.filter((status): status is RunStatus => !!status?.running));
          }
        })
        .catch(() => {
          if (!cancelled) setRunStatuses([]);
        });
    };

    refresh();
    const interval = window.setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [repos]);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      window.anvil.simulatorPreview
        .getStatus()
        .then((status) => {
          if (!cancelled) setSimulatorStatus(status);
        })
        .catch(() => {
          if (!cancelled) setSimulatorStatus({ running: false });
        });
    };

    refresh();
    const interval = window.setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const items = useMemo<SidebarActivityItem[]>(() => {
    const nextItems: SidebarActivityItem[] = [];
    const liveChatCount = Object.values(liveThreadStatuses).filter((status) =>
      ACTIVE_CHAT_STATUSES.has(status),
    ).length;
    const chatBusyCount = Math.max(liveChatCount, busy ? 1 : 0);

    if (activeScaffoldSession) {
      if (activeScaffoldSession.status === 'failed') {
        nextItems.push({
          id: `scaffold-${activeScaffoldSession.id}`,
          feature: 'chat',
          route: '/chat',
          title: 'Workspace setup needs attention',
          detail: activeScaffoldSession.errorMessage ?? 'Scaffold session failed.',
          status: 'error',
          startedAt: activeScaffoldSession.createdAt,
        });
      } else if (
        activeScaffoldSession.status === 'active' ||
        activeScaffoldSession.status === 'syncing' ||
        activeScaffoldSession.status === 'indexing'
      ) {
        nextItems.push({
          id: `scaffold-${activeScaffoldSession.id}`,
          feature: activeScaffoldSession.status === 'indexing' ? 'repos' : 'chat',
          route: activeScaffoldSession.status === 'indexing' ? '/repos' : '/chat',
          title:
            activeScaffoldSession.status === 'indexing'
              ? 'Workspace indexing'
              : 'Workspace setup running',
          detail:
            activeScaffoldSession.status === 'indexing'
              ? 'Generated repositories are being indexed.'
              : 'Continue the scaffold flow in Chat.',
          status: 'running',
          startedAt: activeScaffoldSession.createdAt,
        });
      }
    }

    const indexingRepos = repos.filter((repo) => repo.status === 'indexing');
    if (indexingRepos.length > 0) {
      nextItems.push({
        id: 'repos-indexing',
        feature: 'repos',
        route: '/repos',
        title: `${indexingRepos.length} repo${indexingRepos.length === 1 ? '' : 's'} indexing`,
        detail: indexingRepos.map((repo) => repo.name).join(', '),
        status: 'running',
      });
    } else if (featureAvailability.statusLabel === 'indexing') {
      nextItems.push({
        id: 'workspace-indexing',
        feature: 'repos',
        route: '/repos',
        title: 'Repository indexing pending',
        detail: featureAvailability.repoFeatureReason ?? 'Index repositories to unlock features.',
        status: 'warning',
      });
    }

    const erroredRepos = repos.filter((repo) => repo.status === 'error');
    if (erroredRepos.length > 0) {
      nextItems.push({
        id: 'repos-error',
        feature: 'repos',
        route: '/repos',
        title: `${erroredRepos.length} repo${erroredRepos.length === 1 ? '' : 's'} need attention`,
        detail: erroredRepos.map((repo) => repo.name).join(', '),
        status: 'error',
      });
    }

    if (chatBusyCount > 0) {
      nextItems.push({
        id: 'chat-active',
        feature: 'chat',
        route: '/chat',
        title: `${chatBusyCount} chat turn${chatBusyCount === 1 ? '' : 's'} in progress`,
        detail: activeThread?.title ?? 'Codex is working in Chat.',
        status: 'running',
      });
    }

    for (const run of agentRuns.filter((run) => ACTIVE_RUN_STATUSES.has(run.status))) {
      nextItems.push({
        id: run.id,
        feature: featureForRun(run),
        route: routeForRun(run),
        title: run.title,
        detail: labelForRun(run),
        status: run.status === 'queued' ? 'queued' : 'running',
        startedAt: run.startedAt,
      });
    }

    for (const status of runStatuses) {
      const repo = repos.find((item) => item.id === status.repoId);
      nextItems.push({
        id: `run-${status.repoId}`,
        feature: 'browser',
        route: '/browser',
        title: repo ? `${repo.name} dev process running` : 'Dev process running',
        detail: status.command,
        status: 'running',
        startedAt: status.startedAt,
      });
    }

    if (simulatorStatus.running) {
      nextItems.push({
        id: 'simulator-preview',
        feature: 'argent',
        route: '/browser?mode=simulator',
        title: 'Simulator preview running',
        detail: simulatorStatus.url ?? 'serve-sim is active.',
        status: 'running',
        startedAt: simulatorStatus.startedAt,
      });
    }

    return nextItems.sort((a, b) => {
      const priorityDelta = statusPriority(b.status) - statusPriority(a.status);
      if (priorityDelta !== 0) return priorityDelta;
      return dateValue(b.startedAt) - dateValue(a.startedAt);
    });
  }, [
    activeScaffoldSession,
    activeThread?.title,
    agentRuns,
    busy,
    featureAvailability.repoFeatureReason,
    featureAvailability.statusLabel,
    liveThreadStatuses,
    repos,
    runStatuses,
    simulatorStatus.running,
    simulatorStatus.startedAt,
    simulatorStatus.url,
  ]);

  const indicators = useMemo(() => buildIndicators(items), [items]);
  const activeCount = items.filter((item) => item.status === 'running' || item.status === 'queued')
    .length;

  return { items, indicators, activeCount };
}

export function SidebarActivityCenter({
  items,
  activeCount,
  collapsed,
}: {
  items: SidebarActivityItem[];
  activeCount: number;
  collapsed: boolean;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const visibleItems = items.slice(0, 8);

  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={`titlebar-no-drag flex w-full items-center rounded-lg border py-2.5 text-sm font-medium transition-colors ${
          open
            ? 'border-accent/30 bg-accent/10 text-text-primary'
            : 'border-border-subtle text-text-secondary hover:border-border hover:bg-bg-tertiary hover:text-text-primary'
        } ${collapsed ? 'justify-center px-2' : 'gap-2 px-3'}`}
        aria-label="Activity"
        title="Activity"
      >
        <span className="relative inline-flex">
          <Bell size={16} />
          {activeCount > 0 && (
            <span className="absolute -right-1.5 -top-1.5 h-2.5 w-2.5 rounded-full bg-info ring-2 ring-bg-secondary" />
          )}
        </span>
        {!collapsed && (
          <>
            <span>Activity</span>
            {activeCount > 0 && (
              <span className="ml-auto rounded-full bg-info/15 px-2 py-0.5 text-xs text-info">
                {activeCount}
              </span>
            )}
          </>
        )}
      </button>

      {open && !collapsed && (
        <div className="mt-2 max-h-72 overflow-y-auto rounded-lg border border-border bg-bg-primary p-2 shadow-lg">
          {visibleItems.length === 0 ? (
            <div className="flex items-center gap-2 px-2 py-3 text-sm text-text-tertiary">
              <CheckCircle2 size={14} />
              Nothing in progress.
            </div>
          ) : (
            <div className="space-y-1">
              {visibleItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    navigate(item.route);
                  }}
                  className="flex w-full items-start gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-bg-tertiary"
                >
                  <ActivityIcon status={item.status} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-text-primary">
                      {item.title}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-text-tertiary">
                      {item.detail}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function SidebarActivityBadge({
  indicator,
  collapsed,
}: {
  indicator?: SidebarActivityIndicator;
  collapsed: boolean;
}) {
  if (!indicator) return null;

  const colour =
    indicator.status === 'error'
      ? 'bg-error text-white'
      : indicator.status === 'warning'
        ? 'bg-warning text-bg-primary'
        : indicator.status === 'queued'
          ? 'bg-text-tertiary text-bg-primary'
          : 'bg-info text-white';

  if (collapsed) {
    return (
      <span
        className={`absolute right-2 top-2 h-2.5 w-2.5 rounded-full ${colour} ${
          indicator.status === 'running' ? 'animate-pulse' : ''
        }`}
        title={indicator.label}
        aria-label={indicator.label}
      />
    );
  }

  return (
    <span
      className={`ml-auto inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${colour} ${
        indicator.status === 'running' ? 'animate-pulse' : ''
      }`}
      title={indicator.label}
      aria-label={indicator.label}
    >
      {indicator.count > 9 ? '9+' : indicator.count}
    </span>
  );
}

function ActivityIcon({ status }: { status: SidebarActivityStatus }) {
  if (status === 'error') return <AlertTriangle size={14} className="mt-0.5 shrink-0 text-error" />;
  if (status === 'warning') {
    return <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />;
  }
  if (status === 'queued') return <PlayCircle size={14} className="mt-0.5 shrink-0 text-text-tertiary" />;
  return <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin text-info" />;
}

function buildIndicators(
  items: SidebarActivityItem[],
): Partial<Record<Feature, SidebarActivityIndicator>> {
  const indicators: Partial<Record<Feature, SidebarActivityIndicator>> = {};

  for (const item of items) {
    const existing = indicators[item.feature];
    if (!existing) {
      indicators[item.feature] = {
        count: 1,
        status: item.status,
        label: item.title,
      };
      continue;
    }

    existing.count += 1;
    existing.label = `${existing.count} active items`;
    if (statusPriority(item.status) > statusPriority(existing.status)) {
      existing.status = item.status;
    }
  }

  return indicators;
}

function featureForRun(run: AgentRunSummary): Feature {
  if (run.source === 'automation') return 'automations';
  if (run.source === 'code_review') return 'codereview';
  return 'chat';
}

function routeForRun(run: AgentRunSummary): string {
  if (run.source === 'automation') return '/automations';
  if (run.source === 'code_review') return '/codereview';
  return '/chat';
}

function labelForRun(run: AgentRunSummary): string {
  const status = run.status === 'queued' ? 'Queued' : 'Running';
  const source =
    run.source === 'automation' ? 'automation' : run.source === 'code_review' ? 'code review' : 'chat';
  return `${status} ${source}${run.summary ? `: ${run.summary}` : ''}`;
}

function statusPriority(status: SidebarActivityStatus): number {
  if (status === 'error') return 4;
  if (status === 'warning') return 3;
  if (status === 'running') return 2;
  return 1;
}

function dateValue(value?: string): number {
  if (!value) return 0;
  const date = new Date(value).getTime();
  return Number.isNaN(date) ? 0 : date;
}
