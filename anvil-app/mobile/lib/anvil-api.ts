import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type {
  ChatMessage,
  ChatAttachment,
  ChatAttachmentInput,
  ChatFileMentionSearchResult,
  CodexRegisteredSkill,
  AgentRunSummary,
  AgentRunSource,
  AgentRunStatus,
  MobileApprovalRequest,
  MobileChatThreadSummary,
  MobileCompanionClientType,
  MobileCompanionStatus,
  MobileOverview,
  MobilePairingPayload,
  MobileSendChatMessageInput,
  MobileStartChatInput,
  MobileStartChatResult,
  MobileWorkQueueItem,
  MobileWorkspaceHealth,
  MobileWorkspaceSignal,
  MobileWorkspaceSignalDetail,
  MobileWorkflowDigest,
  MobileWorkflowHealth,
} from '../../src/shared/types';

export interface CompanionConnection {
  id: string;
  baseUrl: string;
  token: string;
  deviceName: string;
  pairedAt: string;
  lastUsedAt: string;
}

export interface CompanionConnectionState {
  activeConnectionId: string | null;
  connections: CompanionConnection[];
}

export interface PairResponse {
  token: string;
  device: {
    id: string;
    name: string;
    clientType?: MobileCompanionClientType;
    createdAt: string;
    lastSeenAt?: string;
  };
}

export interface CompanionStreamEvent {
  type:
    | 'ready'
    | 'heartbeat'
    | 'overview'
    | 'approvals'
    | 'sessions'
    | 'settings'
    | 'notes'
    | 'carplay'
    | 'handover';
  generatedAt?: string;
  ok?: boolean;
}

const CONNECTION_KEY = 'anvil.mobile.connection.v1';
const CONNECTIONS_KEY = 'anvil.mobile.connections.v2';
const COMPANION_REQUEST_TIMEOUT_MS = 12_000;
const DEFAULT_WORKFLOW_COUNTS: MobileWorkflowDigest['counts'] = {
  pendingApprovals: 0,
  activeSessions: 0,
  busySessions: 0,
  readySessions: 0,
  recentThreads: 0,
  workspaceRepos: 0,
};
const DEFAULT_WORKFLOW: MobileWorkflowDigest = {
  health: 'unconfigured',
  headline: 'Pair Anvil on your Mac',
  detail: 'Enable Mobile Companion in desktop Settings, then scan the pairing code.',
  counts: DEFAULT_WORKFLOW_COUNTS,
};
const DEFAULT_WORKSPACE_HEALTH: MobileWorkspaceHealth = {
  reviewFindingCount: 0,
  securityFindingCount: 0,
  lifecycleItemCount: 0,
  workItemCount: 0,
  criticalCount: 0,
  highCount: 0,
  signals: [],
};
const DEFAULT_COMPANION_STATUS: MobileCompanionStatus = {
  enabled: false,
  running: false,
  host: '0.0.0.0',
  port: 47631,
  baseUrl: null,
  advertisedAddresses: [],
  pairedDeviceCount: 0,
};

export async function loadConnection(): Promise<CompanionConnection | null> {
  const state = await loadConnectionState();
  return state.connections.find((connection) => connection.id === state.activeConnectionId) ?? null;
}

export async function loadConnectionState(): Promise<CompanionConnectionState> {
  const raw = await getStoredValue(CONNECTIONS_KEY);
  if (raw) {
    try {
      return normalizeConnectionState(JSON.parse(raw));
    } catch {
      await deleteStoredValue(CONNECTIONS_KEY);
    }
  }

  const legacyRaw = await getStoredValue(CONNECTION_KEY);
  if (!legacyRaw) return emptyConnectionState();

  try {
    const migrated = normalizeConnection(JSON.parse(legacyRaw));
    const state = { activeConnectionId: migrated.id, connections: [migrated] };
    await saveConnectionState(state);
    await deleteStoredValue(CONNECTION_KEY);
    return state;
  } catch {
    await deleteStoredValue(CONNECTION_KEY);
    return emptyConnectionState();
  }
}

export async function saveConnection(
  connection: Pick<CompanionConnection, 'baseUrl' | 'token' | 'deviceName'> &
    Partial<CompanionConnection>,
): Promise<void> {
  const state = await loadConnectionState();
  const normalized = normalizeConnection(connection);
  const existingConnection = state.connections.find(
    (candidate) =>
      candidate.id === normalized.id ||
      trimBaseUrl(candidate.baseUrl) === trimBaseUrl(normalized.baseUrl),
  );
  const nextConnection = {
    ...normalized,
    id: existingConnection?.id ?? normalized.id,
    pairedAt: existingConnection?.pairedAt ?? normalized.pairedAt,
    lastUsedAt: new Date().toISOString(),
  };
  const connections = [
    nextConnection,
    ...state.connections.filter((candidate) => candidate.id !== nextConnection.id),
  ];
  await saveConnectionState({ activeConnectionId: nextConnection.id, connections });
}

export async function clearConnection(): Promise<void> {
  const state = await loadConnectionState();
  if (!state.activeConnectionId) {
    await deleteStoredValue(CONNECTIONS_KEY);
    await deleteStoredValue(CONNECTION_KEY);
    return;
  }

  await removeConnection(state.activeConnectionId);
}

export async function activateConnection(
  connectionId: string,
): Promise<CompanionConnection | null> {
  const state = await loadConnectionState();
  const connection = state.connections.find((candidate) => candidate.id === connectionId);
  if (!connection) return null;

  const nextConnection = { ...connection, lastUsedAt: new Date().toISOString() };
  const nextState = {
    activeConnectionId: nextConnection.id,
    connections: state.connections.map((candidate) =>
      candidate.id === nextConnection.id ? nextConnection : candidate,
    ),
  };
  await saveConnectionState(nextState);
  return nextConnection;
}

export async function removeConnection(connectionId: string): Promise<CompanionConnectionState> {
  const state = await loadConnectionState();
  const connections = state.connections.filter((connection) => connection.id !== connectionId);
  const activeConnectionId =
    state.activeConnectionId === connectionId
      ? (connections[0]?.id ?? null)
      : state.activeConnectionId;
  const nextState = { activeConnectionId, connections };
  await saveConnectionState(nextState);
  return nextState;
}

export function parsePairingPayload(raw: string): MobilePairingPayload {
  const payload = JSON.parse(raw) as MobilePairingPayload;
  if (payload.app !== 'anvil' || payload.version !== 1 || !payload.baseUrl || !payload.ticket) {
    throw new Error('That QR code is not an Anvil pairing code.');
  }
  if (new Date(payload.expiresAt).getTime() < Date.now()) {
    throw new Error('That pairing code has expired.');
  }
  return payload;
}

export async function pairWithDesktop(
  payload: MobilePairingPayload,
  deviceName: string,
): Promise<CompanionConnection> {
  const baseUrl = trimBaseUrl(payload.baseUrl);
  const response = await fetchWithTimeout(`${baseUrl}/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket: payload.ticket, deviceName }),
    timeoutMessage: `Timed out pairing with ${baseUrl}. Check the iPhone and Mac are on the same network, or use a Tailscale/manual address.`,
  });
  const body = (await readBody(response)) as PairResponse;
  if (!body.token || !body.device) {
    throw new Error('Pairing response was missing device credentials.');
  }
  const now = new Date().toISOString();
  const connection = {
    id: body.device.id || createConnectionId(baseUrl),
    baseUrl,
    token: body.token,
    deviceName: body.device.name,
    pairedAt: body.device.createdAt || now,
    lastUsedAt: now,
  };
  await saveConnection(connection);
  return connection;
}

export async function fetchOverview(
  connection: CompanionConnection,
  workspaceId?: string | null,
): Promise<MobileOverview> {
  const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '';
  return normalizeMobileOverview(await fetchJson(connection, `/api/overview${query}`));
}

export async function fetchWorkspaceSignalDetail(
  connection: CompanionConnection,
  signalId: string,
): Promise<MobileWorkspaceSignalDetail | null> {
  const detail = await fetchJson(
    connection,
    `/api/workspace-health/signals/${encodeURIComponent(signalId)}`,
  );
  return normalizeWorkspaceSignalDetail(detail);
}

export async function fetchThreads(
  connection: CompanionConnection,
): Promise<MobileChatThreadSummary[]> {
  return fetchJson(connection, '/api/chat/threads');
}

export async function fetchThreadHistory(
  connection: CompanionConnection,
  threadId: string,
): Promise<ChatMessage[]> {
  return fetchJson(connection, `/api/chat/threads/${encodeURIComponent(threadId)}/history`);
}

export function chatAttachmentUrl(connection: CompanionConnection, attachmentId: string): string {
  const url = new URL(
    `/api/chat/attachments/${encodeURIComponent(attachmentId)}`,
    trimBaseUrl(connection.baseUrl),
  );
  url.searchParams.set('access_token', connection.token);
  return url.toString();
}

export async function sendThreadMessage(
  connection: CompanionConnection,
  threadId: string,
  sessionId: string | undefined,
  input: string | MobileSendChatMessageInput,
): Promise<void> {
  const body = typeof input === 'string' ? { sessionId, message: input } : { ...input, sessionId };
  await fetchJson(connection, `/api/chat/threads/${encodeURIComponent(threadId)}/messages`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function prepareChatAttachments(
  connection: CompanionConnection,
  attachments: ChatAttachmentInput[],
): Promise<ChatAttachment[]> {
  return fetchJson(connection, '/api/chat/attachments/prepare', {
    method: 'POST',
    body: JSON.stringify({ attachments }),
  });
}

export async function searchChatFileMentions(
  connection: CompanionConnection,
  input: { repoIds: string[]; query?: string; limit?: number },
): Promise<ChatFileMentionSearchResult[]> {
  return fetchJson(connection, '/api/chat/file-mentions/search', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function fetchChatSkills(
  connection: CompanionConnection,
  query = '',
): Promise<CodexRegisteredSkill[]> {
  const params = query.trim() ? `?query=${encodeURIComponent(query.trim())}` : '';
  return fetchJson(connection, `/api/chat/skills${params}`);
}

export async function startWorkflow(
  connection: CompanionConnection,
  input: MobileStartChatInput,
): Promise<MobileStartChatResult> {
  return fetchJson(connection, '/api/chat/start', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function resolveApproval(
  connection: CompanionConnection,
  approval: MobileApprovalRequest,
  decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
): Promise<void> {
  await resolveApprovalByKey(connection, approval.sessionId, approval.requestKey, decision);
}

export async function resolveApprovalByKey(
  connection: CompanionConnection,
  sessionId: string,
  requestKey: string,
  decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
): Promise<void> {
  await fetchJson(
    connection,
    `/api/approvals/${encodeURIComponent(sessionId)}/${encodeURIComponent(requestKey)}/resolve`,
    {
      method: 'POST',
      body: JSON.stringify({ decision }),
    },
  );
}

export async function interruptSession(
  connection: CompanionConnection,
  sessionId: string,
): Promise<void> {
  await fetchJson(connection, `/api/sessions/${encodeURIComponent(sessionId)}/interrupt`, {
    method: 'POST',
  });
}

export async function openDesktop(connection: CompanionConnection): Promise<void> {
  await fetchJson(connection, '/api/desktop/open', { method: 'POST' });
}

export function subscribeToCompanionEvents(
  connection: CompanionConnection,
  onEvent: (event: CompanionStreamEvent) => void,
  onError?: () => void,
): () => void {
  const EventSourceCtor = (globalThis as unknown as { EventSource?: EventSourceConstructor })
    .EventSource;
  if (!EventSourceCtor) return () => {};

  const source = new EventSourceCtor(
    `${connection.baseUrl}/api/events?access_token=${encodeURIComponent(connection.token)}`,
  );
  const eventTypes: CompanionStreamEvent['type'][] = [
    'ready',
    'heartbeat',
    'overview',
    'approvals',
    'sessions',
    'settings',
    'notes',
    'carplay',
    'handover',
  ];

  const listeners = eventTypes.map((type) => {
    const listener = (event: MessageEvent) => {
      try {
        onEvent({ type, ...(event.data ? JSON.parse(String(event.data)) : {}) });
      } catch {
        onEvent({ type });
      }
    };
    source.addEventListener(type, listener);
    return { type, listener };
  });

  source.onerror = () => onError?.();

  return () => {
    for (const { type, listener } of listeners) {
      source.removeEventListener(type, listener);
    }
    source.close();
  };
}

async function fetchJson<T>(
  connection: CompanionConnection,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetchWithTimeout(`${connection.baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${connection.token}`,
      ...(init.headers ?? {}),
    },
  });
  return readBody(response) as Promise<T>;
}

type TimedFetchInit = RequestInit & {
  timeoutMs?: number;
  timeoutMessage?: string;
};

async function fetchWithTimeout(url: string, init: TimedFetchInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    init.timeoutMs ?? COMPANION_REQUEST_TIMEOUT_MS,
  );
  const { timeoutMs: _timeoutMs, timeoutMessage, signal: _signal, ...fetchInit } = init;

  try {
    return await fetch(url, {
      ...fetchInit,
      signal: controller.signal,
    });
  } catch (err) {
    if (isAbortError(err)) {
      throw new Error(timeoutMessage ?? `Timed out reaching Anvil at ${url}.`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.message.toLowerCase().includes('aborted'))
  );
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `Request failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  return body;
}

function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function normalizeMobileOverview(raw: unknown): MobileOverview {
  const overview = isRecord(raw) ? raw : {};
  const workspaces = arrayValue(overview.workspaces) as MobileOverview['workspaces'];
  const activeSessions = arrayValue(overview.activeSessions) as MobileOverview['activeSessions'];
  const pendingApprovals = arrayValue(
    overview.pendingApprovals,
  ) as MobileOverview['pendingApprovals'];
  const threads = arrayValue(overview.threads) as MobileOverview['threads'];
  const recentRuns = arrayValue(overview.recentRuns)
    .map(normalizeAgentRun)
    .filter((run): run is AgentRunSummary => Boolean(run));
  const quickActions = arrayValue(overview.quickActions) as MobileOverview['quickActions'];
  const notifications = arrayValue(overview.notifications) as MobileOverview['notifications'];
  const activeWorkspace = isRecord(overview.activeWorkspace)
    ? (overview.activeWorkspace as unknown as MobileOverview['activeWorkspace'])
    : undefined;
  const workflow = normalizeWorkflow(
    overview.workflow,
    activeSessions,
    pendingApprovals,
    threads,
    activeWorkspace,
  );
  const workQueue = normalizeWorkQueue(
    overview.workQueue,
    activeSessions,
    pendingApprovals,
    threads,
    activeWorkspace,
  );

  return {
    generatedAt: stringValue(overview.generatedAt, new Date().toISOString()),
    activeWorkspace,
    workspaces,
    activeSessions,
    pendingApprovals,
    threads,
    recentRuns,
    workspaceHealth: normalizeWorkspaceHealth(overview.workspaceHealth),
    workQueue,
    workflow,
    quickActions,
    companion: isRecord(overview.companion)
      ? ({ ...DEFAULT_COMPANION_STATUS, ...overview.companion } as MobileCompanionStatus)
      : DEFAULT_COMPANION_STATUS,
    notifications,
  };
}

function normalizeWorkspaceHealth(raw: unknown): MobileWorkspaceHealth {
  if (!isRecord(raw)) return DEFAULT_WORKSPACE_HEALTH;
  const signals = arrayValue(raw.signals)
    .map(normalizeWorkspaceSignal)
    .filter((signal): signal is MobileWorkspaceSignal => Boolean(signal));

  return {
    reviewFindingCount: numberValue(raw.reviewFindingCount, 0),
    securityFindingCount: numberValue(raw.securityFindingCount, 0),
    lifecycleItemCount: numberValue(raw.lifecycleItemCount, 0),
    workItemCount: numberValue(raw.workItemCount, 0),
    criticalCount: numberValue(raw.criticalCount, 0),
    highCount: numberValue(raw.highCount, 0),
    signals,
  };
}

function normalizeWorkspaceSignal(raw: unknown): MobileWorkspaceSignal | null {
  if (!isRecord(raw)) return null;
  const id = stringValue(raw.id, '');
  const title = stringValue(raw.title, '');
  if (!id || !title) return null;

  return {
    id,
    kind:
      raw.kind === 'code_review' ||
      raw.kind === 'security' ||
      raw.kind === 'lifecycle' ||
      raw.kind === 'work_item'
        ? raw.kind
        : 'work_item',
    priority:
      raw.priority === 'critical' ||
      raw.priority === 'high' ||
      raw.priority === 'normal' ||
      raw.priority === 'low'
        ? raw.priority
        : 'normal',
    title,
    detail: stringValue(raw.detail, ''),
    statusLabel: stringValue(raw.statusLabel, 'Open'),
    updatedAt: stringValue(raw.updatedAt, new Date().toISOString()),
    repoId: optionalString(raw.repoId),
    repoName: optionalString(raw.repoName),
    sourceId: optionalString(raw.sourceId),
    actionId: optionalString(raw.actionId),
  };
}

function normalizeWorkspaceSignalDetail(raw: unknown): MobileWorkspaceSignalDetail | null {
  if (!isRecord(raw)) return null;
  const signal = normalizeWorkspaceSignal(raw.signal);
  if (!signal) return null;

  return {
    signal,
    summary: optionalString(raw.summary),
    description: optionalString(raw.description),
    recommendation: optionalString(raw.recommendation),
    files: arrayValue(raw.files)
      .map(normalizeWorkspaceSignalFile)
      .filter((file): file is MobileWorkspaceSignalDetail['files'][number] => Boolean(file)),
    linkedWorkItemId: optionalString(raw.linkedWorkItemId),
    provenance: arrayValue(raw.provenance)
      .map(normalizeWorkspaceSignalProvenance)
      .filter((entry): entry is MobileWorkspaceSignalDetail['provenance'][number] =>
        Boolean(entry),
      ),
  };
}

function normalizeWorkspaceSignalFile(
  raw: unknown,
): MobileWorkspaceSignalDetail['files'][number] | null {
  if (!isRecord(raw)) return null;
  const path = stringValue(raw.path, '');
  if (!path) return null;
  const lineStart = numberValue(raw.lineStart, Number.NaN);
  const lineEnd = numberValue(raw.lineEnd, Number.NaN);
  return {
    path,
    lineStart: Number.isFinite(lineStart) ? lineStart : undefined,
    lineEnd: Number.isFinite(lineEnd) ? lineEnd : undefined,
  };
}

function normalizeWorkspaceSignalProvenance(
  raw: unknown,
): MobileWorkspaceSignalDetail['provenance'][number] | null {
  if (!isRecord(raw)) return null;
  const label = stringValue(raw.label, '');
  const value = stringValue(raw.value, '');
  if (!label || !value) return null;
  return { label, value };
}

function normalizeAgentRun(raw: unknown): AgentRunSummary | null {
  if (!isRecord(raw)) return null;
  const id = stringValue(raw.id, '');
  const title = stringValue(raw.title, '');
  if (!id || !title) return null;

  return {
    id,
    source: normalizeAgentRunSource(raw.source),
    title,
    status: normalizeAgentRunStatus(raw.status),
    workspaceId: optionalString(raw.workspaceId),
    repoIds: arrayValue(raw.repoIds).filter(
      (repoId): repoId is string => typeof repoId === 'string',
    ),
    threadId: optionalString(raw.threadId),
    sessionId: optionalString(raw.sessionId),
    automationId: optionalString(raw.automationId),
    reviewId: optionalString(raw.reviewId),
    startedAt: stringValue(raw.startedAt, new Date().toISOString()),
    completedAt: optionalString(raw.completedAt),
    summary: optionalString(raw.summary),
    changedFileCount: numberValue(raw.changedFileCount, 0),
    evidenceCount: numberValue(raw.evidenceCount, 0),
  };
}

function normalizeAgentRunSource(value: unknown): AgentRunSource {
  return value === 'automation' || value === 'code_review' || value === 'chat' ? value : 'chat';
}

function normalizeAgentRunStatus(value: unknown): AgentRunStatus {
  return value === 'queued' ||
    value === 'running' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled'
    ? value
    : 'running';
}

function normalizeWorkQueue(
  raw: unknown,
  activeSessions: MobileOverview['activeSessions'],
  pendingApprovals: MobileOverview['pendingApprovals'],
  threads: MobileOverview['threads'],
  activeWorkspace: MobileOverview['activeWorkspace'],
): MobileWorkQueueItem[] {
  const fromHost = arrayValue(raw)
    .map(normalizeWorkQueueItem)
    .filter((item): item is MobileWorkQueueItem => Boolean(item));
  if (fromHost.length > 0) return fromHost;

  const approvalItems = pendingApprovals.map(
    (approval): MobileWorkQueueItem => ({
      id: `approval:${approval.sessionId}:${approval.requestKey}`,
      kind: 'approval',
      priority: approval.policy?.risk === 'low' ? 'high' : 'critical',
      title:
        approval.policy?.summary ??
        (approval.kind === 'command' ? 'Command approval' : 'File change approval'),
      detail:
        approval.reason ?? approval.command ?? approval.grantRoot ?? 'Codex needs a decision.',
      statusLabel: approval.policy?.requiresFullReview ? 'Desktop review' : 'Needs approval',
      updatedAt: approval.createdAt,
      workspaceId: approval.workspaceId,
      workspaceName: approval.workspaceName,
      repoId: approval.repoId,
      repoName: approval.repoName,
      sessionId: approval.sessionId,
      requestKey: approval.requestKey,
      risk: approval.policy?.risk,
      requiresDesktopReview: approval.policy?.requiresFullReview,
      actionLabel: approval.policy?.requiresFullReview ? 'Open Mac' : 'Decide',
    }),
  );

  const activeThreadIds = new Set<string>();
  const sessionItems = activeSessions.map((session): MobileWorkQueueItem => {
    const thread = threads.find((candidate) => candidate.activeSessionId === session.id);
    if (thread) activeThreadIds.add(thread.id);
    const approvalCount = pendingApprovals.filter(
      (approval) => approval.sessionId === session.id,
    ).length;
    const repo = session.repoId
      ? activeWorkspace?.repos.find((candidate) => candidate.id === session.repoId)
      : undefined;

    return {
      id: `session:${session.id}`,
      kind: 'session',
      priority:
        session.status === 'error'
          ? 'critical'
          : approvalCount > 0
            ? 'high'
            : session.status === 'busy' || session.status === 'starting'
              ? 'normal'
              : 'low',
      title: thread?.title ?? `${session.personaId} session`,
      detail:
        approvalCount > 0
          ? `${approvalCount} approval${approvalCount === 1 ? '' : 's'} blocking this run.`
          : session.status === 'busy'
            ? 'Agent is working on the desktop host.'
            : 'Session is ready for steering or handoff.',
      statusLabel: approvalCount > 0 ? 'Blocked' : sessionStatusLabel(session.status),
      updatedAt: thread?.updatedAt ?? session.startedAt,
      workspaceId: session.workspaceId ?? activeWorkspace?.id,
      workspaceName: activeWorkspace?.name,
      repoId: repo?.id ?? session.repoId,
      repoName: repo?.name ?? repo?.path,
      sessionId: session.id,
      threadId: thread?.id ?? session.appThreadId,
      actionLabel:
        session.status === 'busy' || session.status === 'starting' ? 'Interrupt' : 'Open thread',
    };
  });

  const threadItems = threads
    .filter((thread) => !activeThreadIds.has(thread.id) && thread.pendingApprovalCount === 0)
    .slice(0, 4)
    .map(
      (thread): MobileWorkQueueItem => ({
        id: `thread:${thread.id}`,
        kind: 'thread',
        priority: 'low',
        title: thread.title,
        detail: thread.preview ?? `${thread.personaId} thread`,
        statusLabel: 'Recent',
        updatedAt: thread.updatedAt,
        workspaceId: thread.workspaceId,
        workspaceName:
          thread.workspaceId && thread.workspaceId === activeWorkspace?.id
            ? activeWorkspace.name
            : undefined,
        threadId: thread.id,
        sessionId: thread.activeSessionId,
        actionLabel: 'Continue',
      }),
    );

  return [...approvalItems, ...sessionItems, ...threadItems]
    .sort(compareWorkQueueItems)
    .slice(0, 12);
}

function normalizeWorkQueueItem(raw: unknown): MobileWorkQueueItem | null {
  if (!isRecord(raw)) return null;
  const id = stringValue(raw.id, '');
  const title = stringValue(raw.title, '');
  if (!id || !title) return null;

  return {
    id,
    kind:
      raw.kind === 'approval' || raw.kind === 'session' || raw.kind === 'thread'
        ? raw.kind
        : 'thread',
    priority:
      raw.priority === 'critical' ||
      raw.priority === 'high' ||
      raw.priority === 'normal' ||
      raw.priority === 'low'
        ? raw.priority
        : 'normal',
    title,
    detail: stringValue(raw.detail, ''),
    statusLabel: stringValue(raw.statusLabel, 'Needs attention'),
    updatedAt: stringValue(raw.updatedAt, new Date().toISOString()),
    workspaceId: optionalString(raw.workspaceId),
    workspaceName: optionalString(raw.workspaceName),
    repoId: optionalString(raw.repoId),
    repoName: optionalString(raw.repoName),
    sessionId: optionalString(raw.sessionId),
    threadId: optionalString(raw.threadId),
    requestKey: optionalString(raw.requestKey),
    risk:
      raw.risk === 'low' ||
      raw.risk === 'medium' ||
      raw.risk === 'high' ||
      raw.risk === 'destructive'
        ? raw.risk
        : undefined,
    requiresDesktopReview:
      typeof raw.requiresDesktopReview === 'boolean' ? raw.requiresDesktopReview : undefined,
    actionLabel: optionalString(raw.actionLabel),
  };
}

function normalizeWorkflow(
  raw: unknown,
  activeSessions: MobileOverview['activeSessions'],
  pendingApprovals: MobileOverview['pendingApprovals'],
  threads: MobileOverview['threads'],
  activeWorkspace: unknown,
): MobileWorkflowDigest {
  const workflow = isRecord(raw) ? raw : {};
  const counts = isRecord(workflow.counts) ? workflow.counts : {};
  const workspaceRepos = isRecord(activeWorkspace) ? arrayValue(activeWorkspace.repos).length : 0;

  return {
    health: workflowHealth(workflow.health),
    headline: stringValue(workflow.headline, DEFAULT_WORKFLOW.headline),
    detail: stringValue(workflow.detail, DEFAULT_WORKFLOW.detail),
    counts: {
      pendingApprovals: numberValue(counts.pendingApprovals, pendingApprovals.length),
      activeSessions: numberValue(counts.activeSessions, activeSessions.length),
      busySessions: numberValue(
        counts.busySessions,
        activeSessions.filter((session) => session.status === 'busy').length,
      ),
      readySessions: numberValue(
        counts.readySessions,
        activeSessions.filter((session) => session.status === 'ready').length,
      ),
      recentThreads: numberValue(counts.recentThreads, threads.length),
      workspaceRepos: numberValue(counts.workspaceRepos, workspaceRepos),
    },
  };
}

function workflowHealth(value: unknown): MobileWorkflowHealth {
  return value === 'needs-approval' ||
    value === 'busy' ||
    value === 'ready' ||
    value === 'idle' ||
    value === 'unconfigured'
    ? value
    : DEFAULT_WORKFLOW.health;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function sessionStatusLabel(status: MobileOverview['activeSessions'][number]['status']): string {
  switch (status) {
    case 'busy':
      return 'Working';
    case 'starting':
      return 'Starting';
    case 'error':
      return 'Error';
    case 'ready':
      return 'Ready';
  }
}

function compareWorkQueueItems(a: MobileWorkQueueItem, b: MobileWorkQueueItem): number {
  const priorityOrder: Record<MobileWorkQueueItem['priority'], number> = {
    critical: 0,
    high: 1,
    normal: 2,
    low: 3,
  };
  const priorityDelta = priorityOrder[a.priority] - priorityOrder[b.priority];
  if (priorityDelta !== 0) return priorityDelta;
  return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
}

function emptyConnectionState(): CompanionConnectionState {
  return { activeConnectionId: null, connections: [] };
}

async function saveConnectionState(state: CompanionConnectionState): Promise<void> {
  await setStoredValue(
    CONNECTIONS_KEY,
    JSON.stringify({
      version: 2,
      activeConnectionId: state.activeConnectionId,
      connections: state.connections,
    }),
  );
}

function normalizeConnectionState(raw: unknown): CompanionConnectionState {
  const state = isRecord(raw) ? raw : {};
  const connections = arrayValue(state.connections)
    .map((connection) => {
      try {
        return normalizeConnection(connection);
      } catch {
        return null;
      }
    })
    .filter((connection): connection is CompanionConnection => Boolean(connection));
  const activeConnectionId =
    typeof state.activeConnectionId === 'string' &&
    connections.some((connection) => connection.id === state.activeConnectionId)
      ? state.activeConnectionId
      : (connections[0]?.id ?? null);
  return { activeConnectionId, connections };
}

function normalizeConnection(raw: unknown): CompanionConnection {
  if (!isRecord(raw)) throw new Error('Invalid companion connection.');

  const baseUrl = stringValue(raw.baseUrl, '');
  const token = stringValue(raw.token, '');
  if (!baseUrl || !token) throw new Error('Invalid companion connection.');

  const now = new Date().toISOString();
  return {
    id: stringValue(raw.id, createConnectionId(baseUrl)),
    baseUrl: trimBaseUrl(baseUrl),
    token,
    deviceName: stringValue(raw.deviceName, hostLabelFromBaseUrl(baseUrl)),
    pairedAt: stringValue(raw.pairedAt, now),
    lastUsedAt: stringValue(raw.lastUsedAt, now),
  };
}

function createConnectionId(seed: string): string {
  const normalized = trimBaseUrl(seed).toLowerCase();
  let hash = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    hash = (hash * 31 + normalized.charCodeAt(index)) >>> 0;
  }
  return `host-${hash.toString(36) || 'local'}`;
}

function hostLabelFromBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return 'Anvil host';
  }
}

async function getStoredValue(key: string): Promise<string | null> {
  if (!hasSecureStore()) return getBrowserStorage()?.getItem(key) ?? null;
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

async function setStoredValue(key: string, value: string): Promise<void> {
  if (hasSecureStore()) {
    try {
      await SecureStore.setItemAsync(key, value);
    } catch {
      throw new Error('Secure storage is unavailable in this build, so pairing cannot be saved.');
    }
    return;
  }
  getBrowserStorage()?.setItem(key, value);
}

async function deleteStoredValue(key: string): Promise<void> {
  if (hasSecureStore()) {
    try {
      await SecureStore.deleteItemAsync(key);
    } catch {
      return;
    }
    return;
  }
  getBrowserStorage()?.removeItem(key);
}

function hasSecureStore(): boolean {
  return (
    Platform.OS !== 'web' &&
    typeof SecureStore.getItemAsync === 'function' &&
    typeof SecureStore.setItemAsync === 'function' &&
    typeof SecureStore.deleteItemAsync === 'function'
  );
}

function getBrowserStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

interface EventSourceConstructor {
  new (url: string): EventSourceLike;
}

interface EventSourceLike {
  onerror: (() => void) | null;
  addEventListener: (type: string, listener: (event: MessageEvent) => void) => void;
  removeEventListener: (type: string, listener: (event: MessageEvent) => void) => void;
  close: () => void;
}
