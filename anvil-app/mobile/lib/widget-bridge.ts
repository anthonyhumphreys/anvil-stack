import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import type {
  MobileApprovalRequest,
  MobileOverview,
  MobileQuickAction,
  MobileWorkflowDigest,
  MobileWorkflowHealth,
} from '../../src/shared/types';

export interface WidgetActionSnapshot {
  id: string;
  title: string;
  subtitle: string;
  tone?: MobileQuickAction['tone'];
  destination: string;
}

export interface WidgetSnapshot {
  version: 1;
  generatedAt: string;
  health: MobileWorkflowHealth;
  headline: string;
  detail: string;
  activeWorkspaceName?: string;
  counts: MobileOverview['workflow']['counts'];
  reviewFindings: number;
  securityFindings: number;
  workSignals: number;
  quickActions: WidgetActionSnapshot[];
  primaryDestination: string;
  primaryLabel: string;
  attentionLevel: 'setup' | 'idle' | 'working' | 'approval' | 'stale';
}

export interface LiveActivitySnapshot {
  version: 1;
  generatedAt: string;
  title: string;
  status: string;
  detail: string;
  primaryLabel: string;
  primaryDestination: string;
  attentionLevel: WidgetSnapshot['attentionLevel'];
  pendingApprovals: number;
  busySessions: number;
  workSignals: number;
  workspaceName?: string;
}

interface AnvilWidgetBridgeModule {
  writeSnapshot: (payload: WidgetSnapshot) => Promise<boolean>;
  clearSnapshot: () => Promise<boolean>;
  writeLiveActivity?: (payload: LiveActivitySnapshot) => Promise<boolean>;
  clearLiveActivity?: () => Promise<boolean>;
  activateWatchRelay?: () => Promise<boolean>;
  replyToWatchRequest?: (requestId: string, payload: WatchReplyPayload) => Promise<boolean>;
}

export interface WatchCompanionMessage {
  type?: string;
  sessionId?: string;
  requestKey?: string;
  decision?: 'accept' | 'acceptForSession' | 'decline' | 'cancel';
  threadId?: string;
  activeSessionId?: string;
  message?: string;
}

export interface WatchRequestEvent {
  requestId: string;
  message: WatchCompanionMessage;
}

export interface WatchApprovalSnapshot {
  id: string;
  sessionId: string;
  requestKey: string;
  title: string;
  detail: string;
}

export interface WatchThreadSnapshot {
  id: string;
  title: string;
  preview: string;
  activeSessionId?: string;
}

export interface WatchReplyPayload {
  approvalsJson: string;
  threadsJson: string;
}

const FALLBACK_ACTIONS: WidgetActionSnapshot[] = [
  {
    id: 'status-sweep',
    title: 'Status sweep',
    subtitle: 'Check active work',
    tone: 'blue',
    destination: 'anvil-companion://workflow/status-sweep',
  },
  {
    id: 'review-diff',
    title: 'Code review',
    subtitle: 'Inspect changes',
    tone: 'purple',
    destination: 'anvil-companion://workflow/review-diff',
  },
  {
    id: 'security-sweep',
    title: 'Security sweep',
    subtitle: 'Inspect risk',
    tone: 'red',
    destination: 'anvil-companion://workflow/security-sweep',
  },
  {
    id: 'test-hunt',
    title: 'Find tests',
    subtitle: 'Run the right checks',
    tone: 'green',
    destination: 'anvil-companion://workflow/test-hunt',
  },
  {
    id: 'ship-handoff',
    title: 'Ship handoff',
    subtitle: 'Summarize release state',
    tone: 'amber',
    destination: 'anvil-companion://workflow/ship-handoff',
  },
];
const FALLBACK_COUNTS: MobileWorkflowDigest['counts'] = {
  pendingApprovals: 0,
  activeSessions: 0,
  busySessions: 0,
  readySessions: 0,
  recentThreads: 0,
  workspaceRepos: 0,
};

export function buildWidgetSnapshot(overview: MobileOverview): WidgetSnapshot {
  const quickActions = buildWidgetActions(overview);
  const workflow = overview.workflow;
  const counts = workflow?.counts ?? FALLBACK_COUNTS;
  const state = widgetState(overview);
  const workSignals = countWorkSignals(overview);

  return {
    version: 1,
    generatedAt: overview.generatedAt ?? new Date().toISOString(),
    health: workflow?.health ?? 'unconfigured',
    headline: state.headline,
    detail: state.detail,
    activeWorkspaceName: overview.activeWorkspace?.name,
    counts,
    reviewFindings: overview.workspaceHealth?.reviewFindingCount ?? 0,
    securityFindings: overview.workspaceHealth?.securityFindingCount ?? 0,
    workSignals,
    quickActions: quickActions.length > 0 ? quickActions : FALLBACK_ACTIONS,
    primaryDestination: state.destination,
    primaryLabel: state.label,
    attentionLevel: state.attentionLevel,
  };
}

export function buildLiveActivitySnapshot(overview: MobileOverview): LiveActivitySnapshot | null {
  const counts = overview.workflow?.counts ?? FALLBACK_COUNTS;
  const state = widgetState(overview);
  if (state.attentionLevel === 'idle') return null;
  const workSignals = countWorkSignals(overview);

  return {
    version: 1,
    generatedAt: overview.generatedAt ?? new Date().toISOString(),
    title: overview.activeWorkspace?.name ?? 'Anvil',
    status: state.headline,
    detail: state.detail,
    primaryLabel: state.label,
    primaryDestination: state.destination,
    attentionLevel: state.attentionLevel,
    pendingApprovals: counts.pendingApprovals,
    busySessions: counts.busySessions,
    workSignals,
    workspaceName: overview.activeWorkspace?.name,
  };
}

export async function publishWidgetSnapshot(overview: MobileOverview | null): Promise<void> {
  if (!overview) {
    await clearWidgetSnapshot();
    return;
  }

  const bridge = getWidgetBridge();
  if (!bridge) return;

  try {
    await bridge.writeSnapshot(buildWidgetSnapshot(overview));
  } catch (error) {
    void error;
  }
}

export async function clearWidgetSnapshot(): Promise<void> {
  const bridge = getWidgetBridge();
  if (!bridge) return;

  try {
    await bridge.clearSnapshot();
  } catch (error) {
    void error;
  }
}

export async function publishLiveActivitySnapshot(overview: MobileOverview | null): Promise<void> {
  const bridge = getWidgetBridge();
  if (!bridge?.writeLiveActivity || !bridge.clearLiveActivity) return;

  const snapshot = overview ? buildLiveActivitySnapshot(overview) : null;
  try {
    if (snapshot) {
      await bridge.writeLiveActivity(snapshot);
    } else {
      await bridge.clearLiveActivity();
    }
  } catch (error) {
    void error;
  }
}

export async function clearLiveActivitySnapshot(): Promise<void> {
  const bridge = getWidgetBridge();
  if (!bridge?.clearLiveActivity) return;

  try {
    await bridge.clearLiveActivity();
  } catch (error) {
    void error;
  }
}

export function subscribeToWatchRequests(
  onRequest: (event: WatchRequestEvent) => void,
): () => void {
  const bridge = getWidgetBridge();
  if (!bridge?.activateWatchRelay || !bridge.replyToWatchRequest) return () => {};

  void bridge.activateWatchRelay();
  const emitter = new NativeEventEmitter(NativeModules.AnvilWidgetBridge);
  const subscription = emitter.addListener('AnvilWatchMessage', (event: WatchRequestEvent) => {
    onRequest(event);
  });

  return () => subscription.remove();
}

export async function replyToWatchRequest(
  requestId: string,
  overview: MobileOverview | null,
): Promise<void> {
  const bridge = getWidgetBridge();
  if (!bridge?.replyToWatchRequest) return;

  try {
    await bridge.replyToWatchRequest(requestId, buildWatchReplyPayload(overview));
  } catch (error) {
    void error;
  }
}

export function buildWatchReplyPayload(overview: MobileOverview | null): WatchReplyPayload {
  return {
    approvalsJson: JSON.stringify((overview?.pendingApprovals ?? []).map(toWatchApproval)),
    threadsJson: JSON.stringify((overview?.threads ?? []).slice(0, 8).map(toWatchThread)),
  };
}

function toWidgetAction(action: MobileQuickAction): WidgetActionSnapshot {
  return {
    id: action.id,
    title: action.title,
    subtitle: action.subtitle,
    tone: action.tone,
    destination: `anvil-companion://workflow/${encodeURIComponent(action.id)}`,
  };
}

function buildWidgetActions(overview: MobileOverview): WidgetActionSnapshot[] {
  const actions: WidgetActionSnapshot[] = [];
  const topSignal = overview.workspaceHealth?.signals[0];

  if (topSignal) {
    actions.push({
      id: `signal:${topSignal.id}`,
      title: 'Inspect',
      subtitle: healthSignalKindLabel(topSignal.kind),
      tone: signalTone(topSignal.kind),
      destination: healthSignalUrl(topSignal.id),
    });
  }

  actions.push({
    id: 'work',
    title: 'Work',
    subtitle: 'Review signals',
    tone: 'blue',
    destination: 'anvil-companion://work',
  });

  if ((overview.workspaceHealth?.reviewFindingCount ?? 0) > 0) {
    actions.push({
      id: 'review-findings',
      title: 'Review',
      subtitle: `${overview.workspaceHealth?.reviewFindingCount ?? 0} finding${overview.workspaceHealth?.reviewFindingCount === 1 ? '' : 's'}`,
      tone: 'amber',
      destination: 'anvil-companion://work?filter=code_review',
    });
  }

  if ((overview.workspaceHealth?.securityFindingCount ?? 0) > 0) {
    actions.push({
      id: 'security-findings',
      title: 'Security',
      subtitle: `${overview.workspaceHealth?.securityFindingCount ?? 0} finding${overview.workspaceHealth?.securityFindingCount === 1 ? '' : 's'}`,
      tone: 'red',
      destination: 'anvil-companion://work?filter=security',
    });
  }

  for (const action of overview.quickActions ?? []) {
    if (actions.length >= 4) break;
    actions.push(toWidgetAction(action));
  }

  return actions.slice(0, 4);
}

function countWorkSignals(overview: MobileOverview): number {
  const health = overview.workspaceHealth;
  if (!health) return 0;
  return health.reviewFindingCount + health.securityFindingCount + health.lifecycleItemCount + health.workItemCount;
}

function signalTone(
  kind: MobileOverview['workspaceHealth']['signals'][number]['kind'],
): WidgetActionSnapshot['tone'] {
  if (kind === 'security') return 'red';
  if (kind === 'code_review') return 'amber';
  if (kind === 'lifecycle') return 'purple';
  return 'blue';
}

function widgetState(overview: MobileOverview): {
  headline: string;
  detail: string;
  destination: string;
  label: string;
  attentionLevel: WidgetSnapshot['attentionLevel'];
} {
  const workflow = overview.workflow;
  const counts = workflow?.counts ?? FALLBACK_COUNTS;
  const activeWorkspaceName = overview.activeWorkspace?.name;
  const topQueueItem = overview.workQueue[0];
  const topThread = topQueueItem?.threadId
    ? overview.threads.find((thread) => thread.id === topQueueItem.threadId)
    : undefined;
  const topApproval = topQueueItem?.sessionId
    ? overview.pendingApprovals.find((approval) => approval.sessionId === topQueueItem.sessionId)
    : undefined;
  const desktopReviewCount = overview.pendingApprovals.filter(
    (approval) => approval.policy?.requiresFullReview,
  ).length;
  const topHealthSignal = overview.workspaceHealth?.signals[0];

  if (!overview.companion.running || !activeWorkspaceName) {
    return {
      headline: 'No host paired',
      detail: 'Open Anvil on Mac and scan the pairing code.',
      destination: 'anvil-companion://settings',
      label: 'Pair',
      attentionLevel: 'setup',
    };
  }

  if (counts.pendingApprovals > 0) {
    return {
      headline: topApproval
        ? approvalHeadline(topApproval)
        : `${counts.pendingApprovals} approval${counts.pendingApprovals === 1 ? '' : 's'}`,
      detail:
        desktopReviewCount > 0
          ? `${desktopReviewCount} require Mac review.`
          : topQueueItem?.detail || 'Review command and file access requests.',
      destination: topQueueItem?.threadId
        ? `anvil-companion://chats/${encodeURIComponent(topQueueItem.threadId)}`
        : 'anvil-companion://approvals',
      label: topQueueItem?.actionLabel ?? 'Review',
      attentionLevel: 'approval',
    };
  }

  if (counts.busySessions > 0) {
    return {
      headline:
        topThread?.title ??
        `${counts.busySessions} run${counts.busySessions === 1 ? '' : 's'} active`,
      detail:
        topQueueItem?.detail ??
        topThread?.preview ??
        workflow?.detail ??
        'Anvil is working on the desktop host.',
      destination: topThread
        ? `anvil-companion://chats/${encodeURIComponent(topThread.id)}`
        : 'anvil-companion://work',
      label: topQueueItem?.actionLabel ?? 'Open',
      attentionLevel: 'working',
    };
  }

  if (topHealthSignal && isAttentionSignal(topHealthSignal)) {
    return {
      headline: healthSignalHeadline(topHealthSignal),
      detail: healthSignalDetail(topHealthSignal),
      destination: healthSignalUrl(topHealthSignal.id),
      label: 'Inspect',
      attentionLevel: 'approval',
    };
  }

  const latestRun = overview.recentRuns?.[0];
  const latestRunDetail = latestRun
    ? `Last ${runSourceLabel(latestRun.source)}: ${runStatusLabel(latestRun.status)} / ${latestRun.evidenceCount} evidence`
    : null;
  const healthSignalDetailText = topHealthSignal
    ? `${healthSignalKindLabel(topHealthSignal.kind)}: ${topHealthSignal.statusLabel}`
    : null;

  return {
    headline: workflow?.headline ?? 'Ready',
    detail:
      latestRunDetail ??
      healthSignalDetailText ??
      (activeWorkspaceName ? `${activeWorkspaceName} is ready.` : 'Choose a workspace on Mac.'),
    destination: topHealthSignal ? healthSignalUrl(topHealthSignal.id) : 'anvil-companion://work',
    label: topHealthSignal ? 'Inspect' : 'Start',
    attentionLevel: 'idle',
  };
}

function isAttentionSignal(signal: MobileOverview['workspaceHealth']['signals'][number]): boolean {
  return signal.priority === 'critical' || signal.priority === 'high';
}

function healthSignalUrl(signalId: string): string {
  return `anvil-companion://health/${encodeURIComponent(signalId)}`;
}

function healthSignalHeadline(
  signal: MobileOverview['workspaceHealth']['signals'][number],
): string {
  if (signal.kind === 'security') return 'Security needs review';
  if (signal.kind === 'code_review') return 'Review finding';
  if (signal.kind === 'lifecycle') return 'Lifecycle item';
  return 'Work item';
}

function healthSignalDetail(signal: MobileOverview['workspaceHealth']['signals'][number]): string {
  const target = signal.repoName ? `${signal.repoName} / ` : '';
  return `${target}${signal.statusLabel}: ${signal.title}`;
}

function healthSignalKindLabel(
  kind: MobileOverview['workspaceHealth']['signals'][number]['kind'],
): string {
  if (kind === 'security') return 'Security';
  if (kind === 'code_review') return 'Review';
  if (kind === 'lifecycle') return 'Lifecycle';
  return 'Work';
}

function runSourceLabel(source: MobileOverview['recentRuns'][number]['source']): string {
  if (source === 'code_review') return 'review';
  if (source === 'automation') return 'automation';
  return 'chat';
}

function runStatusLabel(status: MobileOverview['recentRuns'][number]['status']): string {
  if (status === 'completed') return 'done';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  return status;
}

function approvalHeadline(approval: MobileApprovalRequest): string {
  if (approval.kind === 'command')
    return approval.command ? `Approve: ${approval.command}` : 'Command approval';
  return approval.grantRoot ? `File access: ${approval.grantRoot}` : 'File access approval';
}

function toWatchApproval(approval: MobileApprovalRequest): WatchApprovalSnapshot {
  return {
    id: `${approval.sessionId}:${approval.requestKey}`,
    sessionId: approval.sessionId,
    requestKey: approval.requestKey,
    title:
      approval.kind === 'command'
        ? approval.command || 'Command approval'
        : approval.grantRoot || 'File change approval',
    detail: approval.reason || approval.cwd || 'Codex needs a decision.',
  };
}

function toWatchThread(thread: MobileOverview['threads'][number]): WatchThreadSnapshot {
  return {
    id: thread.id,
    title: thread.title,
    preview: thread.preview || `${thread.personaId} thread`,
    activeSessionId: thread.activeSessionId,
  };
}

function getWidgetBridge(): AnvilWidgetBridgeModule | null {
  if (Platform.OS !== 'ios') return null;
  const bridge = NativeModules.AnvilWidgetBridge as AnvilWidgetBridgeModule | undefined;
  if (!bridge?.writeSnapshot || !bridge?.clearSnapshot) return null;
  return bridge;
}
