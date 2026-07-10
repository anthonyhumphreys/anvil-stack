import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import type {
  MobileApprovalRequest,
  MobileOverview,
  MobileQuickAction,
  MobileWorkflowDigest,
  MobileWorkflowHealth,
} from '../../src/shared/types';
import type { CompanionConnection } from './anvil-api';

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
    quickActions,
    primaryDestination: state.destination,
    primaryLabel: state.label,
    attentionLevel: state.attentionLevel,
  };
}

export function buildConnectionWidgetSnapshot(
  connection: CompanionConnection | null,
  connectionCount = connection ? 1 : 0,
): WidgetSnapshot {
  const paired = connectionCount > 0;
  const pluralHost = connectionCount === 1 ? 'host' : 'hosts';
  const headline = connection
    ? 'Host paired'
    : paired
      ? `${connectionCount} ${pluralHost} paired`
      : 'Pair a Mac';
  const detail = connection
    ? 'Open Anvil to refresh workspace state.'
    : paired
      ? 'Choose the Mac to control from Settings.'
      : 'Scan the desktop pairing QR before using the widget.';

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    health: 'unconfigured',
    headline,
    detail,
    counts: FALLBACK_COUNTS,
    reviewFindings: 0,
    securityFindings: 0,
    workSignals: 0,
    quickActions: [
      {
        id: 'settings',
        title: 'Settings',
        subtitle: paired ? 'Hosts' : 'Pair Mac',
        tone: 'blue',
        destination: 'anvil-companion://settings',
      },
    ],
    primaryDestination: 'anvil-companion://settings',
    primaryLabel: 'Settings',
    attentionLevel: 'setup',
  };
}

export function buildLiveActivitySnapshot(overview: MobileOverview): LiveActivitySnapshot | null {
  const counts = overview.workflow?.counts ?? FALLBACK_COUNTS;
  if (counts.pendingApprovals === 0 && counts.busySessions === 0) return null;
  const state = widgetState(overview);
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

export async function publishConnectionWidgetSnapshot(
  connection: CompanionConnection | null,
  connectionCount = connection ? 1 : 0,
): Promise<void> {
  const bridge = getWidgetBridge();
  if (!bridge) return;

  try {
    await bridge.writeSnapshot(buildConnectionWidgetSnapshot(connection, connectionCount));
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

function buildWidgetActions(overview: MobileOverview): WidgetActionSnapshot[] {
  const actions: WidgetActionSnapshot[] = [];
  const topQueueItem = overview.workQueue[0];
  const topApproval =
    (topQueueItem?.sessionId
      ? overview.pendingApprovals.find((approval) => approval.sessionId === topQueueItem.sessionId)
      : undefined) ?? overview.pendingApprovals[0];
  const activeThread =
    (topQueueItem?.threadId
      ? overview.threads.find(
          (thread) => thread.id === topQueueItem.threadId && thread.activeSessionId,
        )
      : undefined) ?? overview.threads.find((thread) => thread.activeSessionId);
  const topSignal = overview.workspaceHealth?.signals.find(isAttentionSignal);

  if (topApproval) {
    actions.push({
      id: `approval:${topApproval.sessionId}:${topApproval.requestKey}`,
      title: 'Approval',
      subtitle: approvalHeadline(topApproval),
      tone: 'red',
      destination: topQueueItem?.threadId
        ? `anvil-companion://chats/${encodeURIComponent(topQueueItem.threadId)}`
        : 'anvil-companion://approvals',
    });
  }

  if (activeThread) {
    actions.push({
      id: `thread:${activeThread.id}`,
      title: 'Active run',
      subtitle: activeThread.title,
      tone: 'blue',
      destination: `anvil-companion://chats/${encodeURIComponent(activeThread.id)}`,
    });
  }

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
    subtitle: topQueueItem?.title ?? 'Open current work',
    tone: 'blue',
    destination: 'anvil-companion://work',
  });

  return actions.slice(0, 4);
}

function countWorkSignals(overview: MobileOverview): number {
  const health = overview.workspaceHealth;
  if (!health) return 0;
  return (
    health.reviewFindingCount +
    health.securityFindingCount +
    health.lifecycleItemCount +
    health.workItemCount
  );
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

  if (!overview.companion.running) {
    return {
      headline: 'Host unavailable',
      detail: 'Open Anvil on Mac, then refresh from the app.',
      destination: 'anvil-companion://settings',
      label: 'Settings',
      attentionLevel: 'setup',
    };
  }

  if (!activeWorkspaceName) {
    return {
      headline: 'Select a workspace on Mac',
      detail: 'Remote runs need the desktop app to have an active workspace.',
      destination: 'anvil-companion://settings',
      label: 'Open',
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
      label: 'Open',
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
