import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import type {
  ChatMessage,
  MobileApprovalRequest,
  MobileChatThreadSummary,
  MobileCompanionClientType,
  MobileCompanionStatus,
  MobileOverview,
  MobilePairingPayload,
  MobileStartChatInput,
  MobileStartChatResult,
  MobileWorkflowDigest,
  MobileWorkflowHealth,
} from '../../src/shared/types';

export interface CompanionConnection {
  baseUrl: string;
  token: string;
  deviceName: string;
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
  const raw = await getStoredConnection();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as CompanionConnection;
  } catch {
    await deleteStoredConnection();
    return null;
  }
}

export async function saveConnection(connection: CompanionConnection): Promise<void> {
  await setStoredConnection(JSON.stringify(connection));
}

export async function clearConnection(): Promise<void> {
  await deleteStoredConnection();
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
  const response = await fetch(`${trimBaseUrl(payload.baseUrl)}/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket: payload.ticket, deviceName }),
  });
  const body = (await readBody(response)) as PairResponse;
  const connection = {
    baseUrl: trimBaseUrl(payload.baseUrl),
    token: body.token,
    deviceName: body.device.name,
  };
  await saveConnection(connection);
  return connection;
}

export async function fetchOverview(connection: CompanionConnection): Promise<MobileOverview> {
  return normalizeMobileOverview(await fetchJson(connection, '/api/overview'));
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

export async function sendThreadMessage(
  connection: CompanionConnection,
  threadId: string,
  sessionId: string | undefined,
  message: string,
): Promise<void> {
  await fetchJson(connection, `/api/chat/threads/${encodeURIComponent(threadId)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ sessionId, message }),
  });
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
  const response = await fetch(`${connection.baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${connection.token}`,
      ...(init.headers ?? {}),
    },
  });
  return readBody(response) as Promise<T>;
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
  const quickActions = arrayValue(overview.quickActions) as MobileOverview['quickActions'];
  const notifications = arrayValue(overview.notifications) as MobileOverview['notifications'];
  const workflow = normalizeWorkflow(
    overview.workflow,
    activeSessions,
    pendingApprovals,
    threads,
    overview.activeWorkspace,
  );

  return {
    generatedAt: stringValue(overview.generatedAt, new Date().toISOString()),
    activeWorkspace: isRecord(overview.activeWorkspace)
      ? (overview.activeWorkspace as unknown as MobileOverview['activeWorkspace'])
      : undefined,
    workspaces,
    activeSessions,
    pendingApprovals,
    threads,
    workflow,
    quickActions,
    companion: isRecord(overview.companion)
      ? ({ ...DEFAULT_COMPANION_STATUS, ...overview.companion } as MobileCompanionStatus)
      : DEFAULT_COMPANION_STATUS,
    notifications,
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

async function getStoredConnection(): Promise<string | null> {
  if (hasSecureStore()) return SecureStore.getItemAsync(CONNECTION_KEY);
  return getBrowserStorage()?.getItem(CONNECTION_KEY) ?? null;
}

async function setStoredConnection(value: string): Promise<void> {
  if (hasSecureStore()) {
    await SecureStore.setItemAsync(CONNECTION_KEY, value);
    return;
  }
  getBrowserStorage()?.setItem(CONNECTION_KEY, value);
}

async function deleteStoredConnection(): Promise<void> {
  if (hasSecureStore()) {
    await SecureStore.deleteItemAsync(CONNECTION_KEY);
    return;
  }
  getBrowserStorage()?.removeItem(CONNECTION_KEY);
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
