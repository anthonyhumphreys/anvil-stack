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
}

export interface WidgetSnapshot {
  version: 1;
  generatedAt: string;
  health: MobileWorkflowHealth;
  headline: string;
  detail: string;
  activeWorkspaceName?: string;
  counts: MobileOverview['workflow']['counts'];
  quickActions: WidgetActionSnapshot[];
}

interface AnvilWidgetBridgeModule {
  writeSnapshot: (payload: WidgetSnapshot) => Promise<boolean>;
  clearSnapshot: () => Promise<boolean>;
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
  },
  {
    id: 'review-diff',
    title: 'Review diff',
    subtitle: 'Inspect changes',
    tone: 'purple',
  },
  {
    id: 'test-hunt',
    title: 'Find tests',
    subtitle: 'Run the right checks',
    tone: 'green',
  },
  {
    id: 'ship-handoff',
    title: 'Ship handoff',
    subtitle: 'Summarize release state',
    tone: 'amber',
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
  const quickActions = (overview.quickActions ?? []).slice(0, 4).map(toWidgetAction);
  const workflow = overview.workflow;

  return {
    version: 1,
    generatedAt: overview.generatedAt ?? new Date().toISOString(),
    health: workflow?.health ?? 'unconfigured',
    headline: workflow?.headline ?? 'Pair Anvil on your Mac',
    detail:
      workflow?.detail ?? 'Enable Mobile Companion in desktop Settings, then scan the pairing code.',
    activeWorkspaceName: overview.activeWorkspace?.name,
    counts: workflow?.counts ?? FALLBACK_COUNTS,
    quickActions: quickActions.length > 0 ? quickActions : FALLBACK_ACTIONS,
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
  };
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
