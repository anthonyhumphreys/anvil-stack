import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, PlayCircle } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import type {
  AgentRunSummary,
  AutomationTriageItem,
  ChatThread,
  Feature,
  SimulatorPreviewStatus,
} from '../../../shared/types';
import type { RunStatus } from '../../../shared/run-types';
import { useChatContext } from '../../contexts/ChatContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';

export type SidebarActivityStatus = 'running' | 'queued' | 'ready' | 'warning' | 'error';

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

interface SidebarActivityValue {
  items: SidebarActivityItem[];
  indicators: Partial<Record<Feature, SidebarActivityIndicator>>;
  activeCount: number;
}

const SidebarActivityContext = createContext<SidebarActivityValue | null>(null);

export function SidebarActivityProvider({ children }: { children: ReactNode }) {
  const value = useSidebarActivityData();
  return (
    <SidebarActivityContext.Provider value={value}>{children}</SidebarActivityContext.Provider>
  );
}

export function useSidebarActivity(): SidebarActivityValue {
  const context = useContext(SidebarActivityContext);
  if (!context) {
    throw new Error('useSidebarActivity must be used within SidebarActivityProvider');
  }
  return context;
}

function useSidebarActivityData(): SidebarActivityValue {
  const location = useLocation();
  const { activeWorkspace, activeScaffoldSession, repos, featureAvailability } = useWorkspace();
  const { busy, liveThreadStatuses, activeThread, threads } = useChatContext();
  const [agentRuns, setAgentRuns] = useState<AgentRunSummary[]>([]);
  const [automationTriage, setAutomationTriage] = useState<AutomationTriageItem[]>([]);
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
    if (!activeWorkspace?.id) {
      setAutomationTriage([]);
      return;
    }

    let cancelled = false;
    const refresh = () => {
      window.anvil.automations
        .triage(activeWorkspace.id)
        .then((items) => {
          if (!cancelled) setAutomationTriage(items);
        })
        .catch(() => {
          if (!cancelled) setAutomationTriage([]);
        });
    };

    refresh();
    const interval = window.setInterval(refresh, 10000);
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

    for (const thread of threads) {
      const attentionItem = activityForThread(
        thread,
        location.pathname.startsWith('/chat') && activeThread?.id === thread.id,
      );
      if (attentionItem) nextItems.push(attentionItem);
    }

    const automationRunIds = new Set(automationTriage.map((item) => item.id));
    for (const item of automationTriage) {
      nextItems.push({
        id: item.id,
        feature: 'automations',
        route: `/automations?automation=${encodeURIComponent(item.automationId)}&run=${encodeURIComponent(item.id)}`,
        title: item.automationName,
        detail: automationTriageDetail(item),
        status:
          item.attention === 'blocked'
            ? 'error'
            : item.attention === 'changes'
              ? 'ready'
              : item.status === 'queued'
                ? 'queued'
                : 'running',
        startedAt: item.completedAt ?? item.startedAt,
      });
    }

    for (const run of agentRuns.filter(
      (run) => ACTIVE_RUN_STATUSES.has(run.status) && !automationRunIds.has(run.id),
    )) {
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

    const uniqueItems = [...new Map(nextItems.map((item) => [item.id, item])).values()];
    return uniqueItems.sort((a, b) => {
      const priorityDelta = statusPriority(b.status) - statusPriority(a.status);
      if (priorityDelta !== 0) return priorityDelta;
      return dateValue(b.startedAt) - dateValue(a.startedAt);
    });
  }, [
    activeScaffoldSession,
    activeThread?.id,
    activeThread?.title,
    agentRuns,
    automationTriage,
    busy,
    featureAvailability.repoFeatureReason,
    featureAvailability.statusLabel,
    liveThreadStatuses,
    location.pathname,
    repos,
    runStatuses,
    simulatorStatus.running,
    simulatorStatus.startedAt,
    simulatorStatus.url,
    threads,
  ]);

  const indicators = useMemo(() => buildIndicators(items), [items]);
  const activeCount = items.filter(
    (item) => item.status === 'running' || item.status === 'queued',
  ).length;

  return { items, indicators, activeCount };
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
        : indicator.status === 'ready'
          ? 'bg-success text-bg-primary'
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

export function SidebarActivityIcon({ status }: { status: SidebarActivityStatus }) {
  if (status === 'error') return <AlertTriangle size={14} className="mt-0.5 shrink-0 text-error" />;
  if (status === 'warning') {
    return <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />;
  }
  if (status === 'queued')
    return <PlayCircle size={14} className="mt-0.5 shrink-0 text-text-tertiary" />;
  if (status === 'ready')
    return <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-success" />;
  return <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin text-info" />;
}

export function buildAggregateActivityIndicator(
  items: SidebarActivityItem[],
): SidebarActivityIndicator | undefined {
  if (items.length === 0) return undefined;
  const status = items.reduce<SidebarActivityStatus>(
    (highest, item) =>
      statusPriority(item.status) > statusPriority(highest) ? item.status : highest,
    'queued',
  );
  return {
    count: items.length,
    status,
    label: `${items.length} inbox item${items.length === 1 ? '' : 's'}`,
  };
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
    existing.label = `${existing.count} items`;
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
    run.source === 'automation'
      ? 'automation'
      : run.source === 'code_review'
        ? 'code review'
        : 'chat';
  return `${status} ${source}${run.summary ? `: ${run.summary}` : ''}`;
}

function statusPriority(status: SidebarActivityStatus): number {
  if (status === 'error') return 5;
  if (status === 'warning') return 4;
  if (status === 'ready') return 3;
  if (status === 'running') return 2;
  return 1;
}

function activityForThread(
  thread: ChatThread,
  currentlyViewing: boolean,
): SidebarActivityItem | null {
  if (thread.settledAt) return null;
  const route = `/chat?thread=${encodeURIComponent(thread.id)}&persona=${encodeURIComponent(thread.personaId)}`;
  const base = {
    id: `thread-${thread.id}`,
    feature: 'chat' as const,
    route,
    title: thread.title,
    startedAt: thread.attentionUpdatedAt ?? thread.lastMessageAt ?? thread.updatedAt,
  };

  if (thread.attentionState === 'approval') {
    return { ...base, detail: 'Approval needed in Chat.', status: 'warning' };
  }
  if (thread.attentionState === 'input') {
    return { ...base, detail: 'Your input is needed in Chat.', status: 'warning' };
  }
  if (thread.attentionState === 'failed') {
    return { ...base, detail: 'The last turn failed.', status: 'error' };
  }
  if (
    thread.attentionState === 'complete' &&
    !currentlyViewing &&
    isThreadCompletionUnseen(thread)
  ) {
    return { ...base, detail: 'Completed work is ready to review.', status: 'ready' };
  }
  return null;
}

function isThreadCompletionUnseen(thread: ChatThread): boolean {
  if (!thread.attentionUpdatedAt) return false;
  if (!thread.lastViewedAt) return true;
  return dateValue(thread.attentionUpdatedAt) > dateValue(thread.lastViewedAt);
}

function automationTriageDetail(item: AutomationTriageItem): string {
  if (item.attention === 'blocked') {
    return item.errorMessage ?? item.summary ?? 'Automation needs attention.';
  }
  if (item.attention === 'changes') {
    return item.summary ?? `${item.changedFileCount} changed files are ready to review.`;
  }
  return item.status === 'queued' ? 'Automation is queued.' : 'Automation is running.';
}

function dateValue(value?: string): number {
  if (!value) return 0;
  const date = new Date(value).getTime();
  return Number.isNaN(date) ? 0 : date;
}
