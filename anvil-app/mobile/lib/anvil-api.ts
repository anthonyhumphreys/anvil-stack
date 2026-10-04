import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';
import { sha256 } from '@noble/hashes/sha2.js';
import type { MeshMachineOperation } from '../../cloud/contract/machine';
import { getMeshMachineSession, type MeshMachineEvent } from './mesh-session';
import type {
  ChatMessage,
  ChatAttachment,
  ChatAttachmentInput,
  Citation,
  ChatFileMentionSearchResult,
  CodexEvent,
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
  /** 'account' uses broker-issued encrypted Mesh sessions; it never sends account bearer to host. */
  authMode?: 'paired' | 'account';
  /** Account enrollment this connection authenticates as (account mode). */
  enrollmentId?: string;
  /** Host verified the credential but has not granted a tier yet. */
  requiresHostApproval?: boolean;
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
    | 'handover'
    | 'machine-event';
  generatedAt?: string;
  ok?: boolean;
  event?: MeshMachineEvent;
  resnapshotReason?: 'epoch-changed' | 'cursor-expired' | 'sequence-gap';
}

const CONNECTION_KEY = 'anvil.mobile.connection.v1';
const CONNECTIONS_KEY = 'anvil.mobile.connections.v2';
const COMPANION_REQUEST_TIMEOUT_MS = 12_000;
const CHAT_ATTACHMENT_CHUNK_BYTES = 256 * 1024;
const MAX_CHAT_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_CHAT_ATTACHMENTS = 10;
const MAX_CHAT_ATTACHMENT_BATCH_BYTES = 75 * 1024 * 1024;
const MAX_INLINE_ATTACHMENT_DATA_URL_CHARS = 350 * 1024;
const stagedAttachmentBatches = new Map<string, Map<string, string>>();
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
    const legacyValue: unknown = JSON.parse(legacyRaw);
    if (isRecord(legacyValue) && legacyValue.authMode === 'account') {
      await deleteStoredValue(CONNECTION_KEY);
      return emptyConnectionState();
    }
    const migrated = normalizeConnection(legacyValue);
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

/**
 * Upserts an account-mode connection keyed by enrollment id. Unlike
 * saveConnection it never dedupes on baseUrl — an account-discovered host
 * may share an address with a manually paired one, and the credentials
 * differ.
 */
export async function saveAccountConnection(
  connection: Pick<CompanionConnection, 'id' | 'baseUrl' | 'deviceName' | 'enrollmentId'> &
    Partial<CompanionConnection>,
): Promise<void> {
  const state = await loadConnectionState();
  const normalized = normalizeConnection({ ...connection, token: '', authMode: 'account' });
  const existing = state.connections.find((candidate) => candidate.id === normalized.id);
  const nextConnection = {
    ...normalized,
    pairedAt: existing?.pairedAt ?? normalized.pairedAt,
    lastUsedAt: new Date().toISOString(),
  };
  const connections = [
    nextConnection,
    ...state.connections.filter((candidate) => candidate.id !== nextConnection.id),
  ];
  await saveConnectionState({
    activeConnectionId: state.activeConnectionId ?? nextConnection.id,
    connections,
  });
}

/** Drops every account-mode connection (used on account sign-out). */
export async function removeAccountConnections(): Promise<void> {
  const state = await loadConnectionState();
  const connections = state.connections.filter((connection) => connection.authMode !== 'account');
  const activeConnectionId =
    state.activeConnectionId !== null &&
    connections.some((connection) => connection.id === state.activeConnectionId)
      ? state.activeConnectionId
      : (connections[0]?.id ?? null);
  await saveConnectionState({ activeConnectionId, connections });
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
  if (connection.authMode === 'account') {
    const machine = await getMeshMachineSession(requireAccountHostEnrollment(connection));
    return normalizeMobileOverview(
      await machine.request('read.snapshot', workspaceId ? { workspaceId } : {}),
      true,
    );
  }
  const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : '';
  return normalizeMobileOverview(await fetchJson(connection, `/api/overview${query}`));
}

export async function fetchWorkspaceSignalDetail(
  connection: CompanionConnection,
  signalId: string,
): Promise<MobileWorkspaceSignalDetail | null> {
  if (connection.authMode === 'account') {
    return normalizeWorkspaceSignalDetail(
      await requestAccountMachine(connection, 'read.workspace-signal-detail', { signalId }),
    );
  }
  const detail = await fetchJson(
    connection,
    `/api/workspace-health/signals/${encodeURIComponent(signalId)}`,
  );
  return normalizeWorkspaceSignalDetail(detail);
}

export async function fetchThreads(
  connection: CompanionConnection,
): Promise<MobileChatThreadSummary[]> {
  if (connection.authMode === 'account') {
    const raw = await requestAccountMachine(connection, 'read.chat-threads', {});
    return mapChatThreads(raw);
  }
  return fetchJson(connection, '/api/chat/threads');
}

export async function fetchThreadHistory(
  connection: CompanionConnection,
  threadId: string,
): Promise<ChatMessage[]> {
  if (connection.authMode === 'account') {
    return mapChatHistory(
      await requestAccountMachine(connection, 'read.thread-history', { threadId }),
    );
  }
  return fetchJson(connection, `/api/chat/threads/${encodeURIComponent(threadId)}/history`);
}

export function chatAttachmentUrl(connection: CompanionConnection, attachmentId: string): string {
  if (connection.authMode === 'account') {
    throw accountRestUnavailable('/api/chat/attachments/:id');
  }
  return new URL(
    `/api/chat/attachments/${encodeURIComponent(attachmentId)}`,
    trimBaseUrl(connection.baseUrl),
  ).toString();
}

/** Reads account-mode attachments through bounded encrypted Mesh chunks. */
export async function fetchChatAttachmentDataUrl(
  connection: CompanionConnection,
  attachmentId: string,
): Promise<string> {
  if (connection.authMode !== 'account') {
    throw new Error('Attachment data URLs are only used for encrypted account connections.');
  }
  const machine = await getMeshMachineSession(requireAccountHostEnrollment(connection));
  let totalBytes: number | null = null;
  let name: string | null = null;
  let mimeType: string | null = null;
  let bytes = new Uint8Array(0);
  let offset = 0;
  do {
    const result = await machine.request('read.attachment', {
      attachmentId,
      offset,
      byteLength: CHAT_ATTACHMENT_CHUNK_BYTES,
    });
    if (
      !isRecord(result) ||
      result.attachmentId !== attachmentId ||
      !Number.isSafeInteger(result.offset) ||
      result.offset !== offset ||
      !Number.isSafeInteger(result.totalBytes) ||
      (result.totalBytes as number) < 0 ||
      (result.totalBytes as number) > MAX_CHAT_ATTACHMENT_BYTES ||
      typeof result.name !== 'string' ||
      typeof result.mimeType !== 'string' ||
      typeof result.bytesBase64 !== 'string' ||
      !Number.isSafeInteger(result.nextOffset)
    ) {
      throw new Error('The host returned a malformed attachment chunk.');
    }
    const chunk = decodeBase64Chunk(result.bytesBase64);
    const nextOffset = result.nextOffset as number;
    const emptyAttachment = result.totalBytes === 0 && offset === 0 && chunk.byteLength === 0;
    if (
      (!emptyAttachment && chunk.byteLength === 0) ||
      chunk.byteLength > CHAT_ATTACHMENT_CHUNK_BYTES ||
      nextOffset !== offset + chunk.byteLength ||
      nextOffset > (result.totalBytes as number) ||
      (totalBytes !== null && totalBytes !== result.totalBytes) ||
      (name !== null && name !== result.name) ||
      (mimeType !== null && mimeType !== result.mimeType)
    ) {
      throw new Error('The host returned an inconsistent attachment chunk.');
    }
    if (totalBytes === null) {
      totalBytes = result.totalBytes as number;
      name = result.name;
      mimeType = result.mimeType;
      bytes = new Uint8Array(totalBytes);
    }
    bytes.set(chunk, offset);
    offset = nextOffset;
    if (emptyAttachment) break;
  } while (totalBytes !== null && offset < totalBytes);

  if (totalBytes === null || offset !== totalBytes || name === null || mimeType === null) {
    throw new Error('The host returned an incomplete attachment.');
  }
  const safeMimeType = /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(mimeType)
    ? mimeType
    : 'application/octet-stream';
  return `data:${safeMimeType};name=${encodeURIComponent(name)};base64,${encodeBase64Bytes(bytes)}`;
}

export async function sendThreadMessage(
  connection: CompanionConnection,
  threadId: string,
  sessionId: string | undefined,
  input: string | MobileSendChatMessageInput,
): Promise<void> {
  const body = typeof input === 'string' ? { sessionId, message: input } : { ...input, sessionId };
  if (connection.authMode === 'account') {
    const targetSessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    const message = typeof body.message === 'string' ? body.message : '';
    if (
      !targetSessionId ||
      (!message.trim() && !(body.attachments?.length ?? 0) && !(body.fileMentions?.length ?? 0))
    ) {
      throw new Error(
        'Account Mesh can steer an active session only; select an active session first.',
      );
    }
    const attachmentBatch = await resolveAttachmentBatch(connection, body.attachments ?? []);
    const result = await requestAccountMachine(connection, 'command.steer', {
      sessionId: targetSessionId,
      message,
      ...(body.collaborationMode === undefined
        ? {}
        : { collaborationMode: body.collaborationMode }),
      ...(body.reasoningEffort === undefined ? {} : { reasoningEffort: body.reasoningEffort }),
      ...(body.model === undefined ? {} : { model: body.model }),
      ...(body.fileMentions === undefined
        ? {}
        : { fileMentions: body.fileMentions.map(validateMeshFileMentionReference) }),
      ...(attachmentBatch === null
        ? {}
        : { batchId: attachmentBatch.batchId, attachmentIds: attachmentBatch.attachmentIds }),
    });
    if (attachmentBatch !== null) consumeAttachmentBatch(connection, attachmentBatch);
    if (!isRecord(result) || result.accepted !== true || result.sessionId !== targetSessionId) {
      throw new Error('The host did not confirm the Mesh steer request.');
    }
    return;
  }
  await fetchJson(connection, `/api/chat/threads/${encodeURIComponent(threadId)}/messages`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function prepareChatAttachments(
  connection: CompanionConnection,
  attachments: ChatAttachmentInput[],
): Promise<ChatAttachment[]> {
  if (connection.authMode === 'account') {
    return stageMeshAttachments(connection, attachments);
  }
  return fetchJson(connection, '/api/chat/attachments/prepare', {
    method: 'POST',
    body: JSON.stringify({ attachments }),
  });
}

export async function searchChatFileMentions(
  connection: CompanionConnection,
  input: { repoIds: string[]; query?: string; limit?: number },
): Promise<ChatFileMentionSearchResult[]> {
  if (connection.authMode === 'account') {
    return mapFileMentionResults(
      await requestAccountMachine(connection, 'read.file-mentions', input),
    );
  }
  return fetchJson(connection, '/api/chat/file-mentions/search', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function fetchChatSkills(
  connection: CompanionConnection,
  query = '',
): Promise<CodexRegisteredSkill[]> {
  if (connection.authMode === 'account') {
    return mapRegisteredSkills(
      await requestAccountMachine(connection, 'read.chat-skills', { query }),
    );
  }
  const params = query.trim() ? `?query=${encodeURIComponent(query.trim())}` : '';
  return fetchJson(connection, `/api/chat/skills${params}`);
}

export async function startWorkflow(
  connection: CompanionConnection,
  input: MobileStartChatInput,
): Promise<MobileStartChatResult> {
  if (connection.authMode === 'account') {
    const attachmentBatch = await resolveAttachmentBatch(connection, input.attachments ?? []);
    const result = await requestAccountMachine(connection, 'command.submit', {
      ...input,
      attachments: [],
      ...(input.fileMentions === undefined
        ? {}
        : { fileMentions: input.fileMentions.map(validateMeshFileMentionReference) }),
      ...(attachmentBatch === null
        ? {}
        : { batchId: attachmentBatch.batchId, attachmentIds: attachmentBatch.attachmentIds }),
    });
    if (attachmentBatch !== null) consumeAttachmentBatch(connection, attachmentBatch);
    return mapStartChatResult(result);
  }
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
  if (connection.authMode === 'account') {
    const result = await requestAccountMachine(connection, 'command.approve', {
      sessionId,
      requestKey,
      decision,
    });
    assertOkResult(result, 'The host did not confirm the approval decision.');
    return;
  }
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
  if (connection.authMode === 'account') {
    const result = await requestAccountMachine(connection, 'command.cancel', { sessionId });
    assertOkResult(result, 'The host did not confirm the interrupt request.');
    return;
  }
  await fetchJson(connection, `/api/sessions/${encodeURIComponent(sessionId)}/interrupt`, {
    method: 'POST',
  });
}

export async function openDesktop(connection: CompanionConnection): Promise<void> {
  if (connection.authMode === 'account') {
    const result = await requestAccountMachine(connection, 'command.open-desktop', {});
    assertOkResult(result, 'The host did not confirm the desktop focus request.');
    return;
  }
  await fetchJson(connection, '/api/desktop/open', { method: 'POST' });
}

export function subscribeToCompanionEvents(
  connection: CompanionConnection,
  onEvent: (event: CompanionStreamEvent) => void,
  onError?: () => void,
): () => void {
  if (connection.authMode === 'account') {
    const enrollmentId = requireAccountHostEnrollment(connection);
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectDelayMs = 1_000;
    let unsubscribe: (() => void) | null = null;
    const scheduleReconnect = () => {
      if (cancelled || reconnectTimer !== null) return;
      const delay = reconnectDelayMs;
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, delay);
    };
    const connect = async () => {
      try {
        const machine = await getMeshMachineSession(enrollmentId);
        if (cancelled) return;
        reconnectDelayMs = 1_000;
        unsubscribe = machine.subscribe({
          onEvent: (event) => onEvent({ type: 'machine-event', event }),
          onResnapshot: (resnapshotReason) => onEvent({ type: 'machine-event', resnapshotReason }),
          onClosed: () => {
            if (cancelled) return;
            onError?.();
            scheduleReconnect();
          },
        });
      } catch {
        if (cancelled) return;
        onError?.();
        scheduleReconnect();
      }
    };
    void connect();
    return () => {
      cancelled = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      unsubscribe?.();
      unsubscribe = null;
    };
  }

  const EventSourceCtor = (globalThis as unknown as { EventSource?: EventSourceConstructor })
    .EventSource;
  if (!EventSourceCtor) return () => {};
  const EventSource = EventSourceCtor;

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

  let source: EventSourceLike | null = null;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelayMs = 1_000;

  function scheduleReconnect(): void {
    if (closed || reconnectTimer !== null) return;
    const delay = reconnectDelayMs;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      openStream();
    }, delay);
  }

  function openStream(): void {
    void fetchJson<{ ticket: string }>(connection, '/api/events/ticket', { method: 'POST' })
      .then(({ ticket }) => {
        if (closed) return;
        const nextSource = new EventSource(
          `${connection.baseUrl}/api/events?ticket=${encodeURIComponent(ticket)}`,
        );
        source = nextSource;
        const listeners = eventTypes.map((type) => {
          const listener = (event: MessageEvent) => {
            try {
              onEvent({ type, ...(event.data ? JSON.parse(String(event.data)) : {}) });
            } catch {
              onEvent({ type });
            }
            if (type === 'ready') reconnectDelayMs = 1_000;
          };
          nextSource.addEventListener(type, listener);
          return { type, listener };
        });
        nextSource.onerror = () => {
          if (source !== nextSource) return;
          source = null;
          for (const { type, listener } of listeners) {
            nextSource.removeEventListener(type, listener);
          }
          nextSource.close();
          onError?.();
          scheduleReconnect();
        };
        if (closed) {
          for (const { type, listener } of listeners) {
            nextSource.removeEventListener(type, listener);
          }
          nextSource.close();
          source = null;
        }
      })
      .catch(() => {
        onError?.();
        scheduleReconnect();
      });
  }

  openStream();

  return () => {
    closed = true;
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    source?.close();
    source = null;
  };
}

async function fetchJson<T>(
  connection: CompanionConnection,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  if (connection.authMode === 'account') {
    throw accountRestUnavailable(path);
  }
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

function requireAccountHostEnrollment(connection: CompanionConnection): string {
  if (typeof connection.enrollmentId !== 'string' || connection.enrollmentId.trim() === '') {
    throw new Error('Rediscover the host through the HTTPS Anvil account service.');
  }
  return connection.enrollmentId;
}

async function requestAccountMachine(
  connection: CompanionConnection,
  operation: MeshMachineOperation,
  payload: unknown,
): Promise<unknown> {
  const machine = await getMeshMachineSession(requireAccountHostEnrollment(connection));
  if (!machine.host.operations.includes(operation)) {
    throw new Error(
      `The connected host does not provide the current Mesh operation '${operation}'.`,
    );
  }
  try {
    return await machine.request(operation, payload);
  } catch (error) {
    if (error instanceof Error && error.message === 'machine-request-uncertain') {
      throw new Error(
        'The host connection dropped before this action was confirmed. Refresh the host state before trying again.',
      );
    }
    if (error instanceof Error && error.message === 'machine-route-unavailable') {
      throw new Error('Host connection unavailable. Check the host and tap Refresh devices.');
    }
    if (error instanceof Error && error.message === 'machine-approval-required') {
      throw new Error(
        'Waiting for host approval. On that host, open Settings → Devices → Account device access, approve this device, then tap Refresh devices.',
      );
    }
    if (error instanceof Error && error.message === 'machine-device-denied') {
      throw new Error('The host denied this device under its local trust policy.');
    }
    throw error;
  }
}

export function requestEncryptedCompanionOperation(
  connection: CompanionConnection,
  operation: MeshMachineOperation,
  payload: unknown,
): Promise<unknown> {
  if (connection.authMode !== 'account') {
    throw new Error('An encrypted Mesh request requires an account-mode host connection.');
  }
  return requestAccountMachine(connection, operation, payload);
}

function mapChatThreads(value: unknown): MobileChatThreadSummary[] {
  if (!Array.isArray(value)) throw new Error('The host returned a malformed thread list.');
  return value.map((item): MobileChatThreadSummary => {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      typeof item.personaId !== 'string' ||
      typeof item.title !== 'string' ||
      !Array.isArray(item.repoIds) ||
      !item.repoIds.every((repoId) => typeof repoId === 'string') ||
      typeof item.messageCount !== 'number' ||
      !Number.isFinite(item.messageCount) ||
      typeof item.updatedAt !== 'string' ||
      typeof item.pendingApprovalCount !== 'number' ||
      !Number.isFinite(item.pendingApprovalCount)
    ) {
      throw new Error('The host returned a malformed thread summary.');
    }
    return {
      id: item.id,
      personaId: item.personaId,
      title: item.title,
      repoIds: item.repoIds,
      messageCount: item.messageCount,
      updatedAt: item.updatedAt,
      pendingApprovalCount: item.pendingApprovalCount,
      ...(typeof item.workspaceId === 'string' ? { workspaceId: item.workspaceId } : {}),
      ...(typeof item.preview === 'string' ? { preview: item.preview } : {}),
      ...(typeof item.activeSessionId === 'string'
        ? { activeSessionId: item.activeSessionId }
        : {}),
      ...(isSessionStatus(item.activeSessionStatus)
        ? { activeSessionStatus: item.activeSessionStatus }
        : {}),
    };
  });
}

function mapChatHistory(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) throw new Error('The host returned a malformed chat history.');
  return value.map((item): ChatMessage => {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      !['user', 'assistant', 'system'].includes(String(item.role)) ||
      typeof item.content !== 'string' ||
      typeof item.timestamp !== 'string'
    ) {
      throw new Error('The host returned a malformed chat message.');
    }
    const attachments =
      item.attachments === undefined ? undefined : mapChatAttachments(item.attachments);
    const event = isCodexEvent(item.event) ? item.event : undefined;
    return {
      id: item.id,
      role: item.role as ChatMessage['role'],
      content: item.content,
      timestamp: item.timestamp,
      ...(event === undefined ? {} : { event }),
      ...(typeof item.repoContext === 'string' ? { repoContext: item.repoContext } : {}),
      ...(typeof item.personaId === 'string' ? { personaId: item.personaId } : {}),
      ...(typeof item.threadId === 'string' ? { threadId: item.threadId } : {}),
      ...(typeof item.sessionId === 'string' ? { sessionId: item.sessionId } : {}),
      ...(item.citations === undefined ? {} : { citations: mapCitations(item.citations) }),
      ...(attachments === undefined ? {} : { attachments }),
    };
  });
}

function isCodexEvent(value: unknown): value is CodexEvent {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    [
      'text',
      'thinking',
      'file_read',
      'file_edit',
      'command_exec',
      'tool_call',
      'approval_request',
      'input_request',
      'subagent_update',
      'thread_status',
      'request_resolved',
      'plan_update',
      'agent_ui_intent',
      'agent_ui_intent_resolved',
      'goal_update',
      'goal_cleared',
      'queue_update',
      'follow_up_delivery',
      'error',
      'status',
      'usage',
      'turn_outcome',
      'context_compaction',
      'usage_context',
      'thread_metadata',
    ].includes(value.type)
  );
}

function isSessionStatus(
  value: unknown,
): value is NonNullable<MobileChatThreadSummary['activeSessionStatus']> {
  return value === 'starting' || value === 'ready' || value === 'busy' || value === 'error';
}

function mapCitations(value: unknown): Citation[] {
  if (!Array.isArray(value)) throw new Error('The host returned malformed chat citations.');
  return value.map((item): Citation => {
    if (!isRecord(item) || typeof item.filePath !== 'string') {
      throw new Error('The host returned malformed chat citations.');
    }
    return {
      filePath: item.filePath,
      ...(typeof item.lineStart === 'number' ? { lineStart: item.lineStart } : {}),
      ...(typeof item.lineEnd === 'number' ? { lineEnd: item.lineEnd } : {}),
      ...(typeof item.snippet === 'string' ? { snippet: item.snippet } : {}),
    };
  });
}

function mapChatAttachments(value: unknown): ChatAttachment[] {
  if (!Array.isArray(value)) throw new Error('The host returned malformed attachment metadata.');
  return value.map((item): ChatAttachment => {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      typeof item.name !== 'string' ||
      typeof item.mimeType !== 'string' ||
      typeof item.size !== 'number' ||
      !Number.isSafeInteger(item.size) ||
      (item.kind !== 'image' && item.kind !== 'file') ||
      typeof item.createdAt !== 'string'
    ) {
      throw new Error('The host returned malformed attachment metadata.');
    }
    return {
      id: item.id,
      name: item.name,
      mimeType: item.mimeType,
      size: item.size,
      kind: item.kind,
      // Mesh intentionally does not disclose the host-local attachment path.
      path: '',
      createdAt: item.createdAt,
    };
  });
}

async function stageMeshAttachments(
  connection: CompanionConnection,
  attachments: ChatAttachmentInput[],
): Promise<ChatAttachment[]> {
  if (attachments.length === 0) return [];
  if (attachments.length > MAX_CHAT_ATTACHMENTS) {
    throw new Error(`Attach up to ${MAX_CHAT_ATTACHMENTS} files at a time.`);
  }
  const parsed = attachments.map(parseMeshAttachmentInput);
  const totalBytes = parsed.reduce((total, attachment) => total + attachment.bytes.byteLength, 0);
  if (totalBytes > MAX_CHAT_ATTACHMENT_BATCH_BYTES) {
    throw new Error('Attachments are limited to 75 MiB total.');
  }
  const batchId = Crypto.randomUUID();
  let prepared: ChatAttachment[];
  const dataUrlChars = attachments.reduce(
    (total, attachment) => total + (attachment.dataUrl?.length ?? 0),
    0,
  );
  if (dataUrlChars <= MAX_INLINE_ATTACHMENT_DATA_URL_CHARS) {
    const result = await requestAccountMachine(connection, 'command.prepare-attachments', {
      batchId,
      attachments: attachments.map(({ path: _path, ...attachment }) => attachment),
    });
    if (!isRecord(result) || result.batchId !== batchId || !Array.isArray(result.attachments)) {
      throw new Error('The host returned malformed prepared attachment metadata.');
    }
    prepared = mapChatAttachments(result.attachments);
  } else {
    prepared = [];
    for (const attachment of parsed) {
      const uploadId = Crypto.randomUUID();
      const begin = await requestAccountMachine(connection, 'command.attachment.begin', {
        batchId,
        uploadId,
        name: attachment.name,
        mimeType: attachment.mimeType,
        totalBytes: attachment.bytes.byteLength,
      });
      if (
        !isRecord(begin) ||
        begin.batchId !== batchId ||
        begin.uploadId !== uploadId ||
        begin.nextOffset !== 0 ||
        !Number.isSafeInteger(begin.chunkBytes) ||
        (begin.chunkBytes as number) < 1 ||
        (begin.chunkBytes as number) > CHAT_ATTACHMENT_CHUNK_BYTES
      ) {
        throw new Error('The host returned malformed attachment upload metadata.');
      }
      const chunkBytes = begin.chunkBytes as number;
      for (let offset = 0; offset < attachment.bytes.byteLength; offset += chunkBytes) {
        const bytes = attachment.bytes.subarray(
          offset,
          Math.min(offset + chunkBytes, attachment.bytes.byteLength),
        );
        const chunkResult = await requestAccountMachine(connection, 'command.attachment.chunk', {
          uploadId,
          offset,
          bytesBase64: encodeBase64Bytes(bytes),
        });
        if (
          !isRecord(chunkResult) ||
          chunkResult.uploadId !== uploadId ||
          chunkResult.nextOffset !== offset + bytes.byteLength
        ) {
          throw new Error('The host did not confirm the attachment chunk.');
        }
      }
      const finished = await requestAccountMachine(connection, 'command.attachment.finish', {
        uploadId,
        sha256: toHex(sha256(attachment.bytes)),
      });
      prepared.push(...mapChatAttachments([finished]));
    }
  }
  if (prepared.length !== attachments.length) {
    throw new Error('The host returned an incomplete attachment batch.');
  }
  const byId = stagedAttachmentBatches.get(connection.id) ?? new Map<string, string>();
  for (const attachment of prepared) byId.set(attachment.id, batchId);
  stagedAttachmentBatches.set(connection.id, byId);
  return prepared;
}

function parseMeshAttachmentInput(input: ChatAttachmentInput): {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
} {
  if (
    typeof input.name !== 'string' ||
    input.name.trim().length === 0 ||
    input.name.length > 256 ||
    input.path !== undefined ||
    typeof input.dataUrl !== 'string'
  ) {
    throw new Error(
      'Encrypted account attachments must contain uploaded file data, not a host path.',
    );
  }
  const match =
    /^data:([A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/]*={0,2})$/.exec(
      input.dataUrl,
    );
  if (!match) throw new Error(`Could not read ${input.name}. Choose the file again and retry.`);
  const bytes = decodeBase64Chunk(match[2] ?? '');
  if (
    bytes.byteLength > MAX_CHAT_ATTACHMENT_BYTES ||
    (input.size !== undefined && input.size !== bytes.byteLength)
  ) {
    throw new Error(
      `${input.name} exceeds the 25 MiB attachment limit or has invalid size metadata.`,
    );
  }
  const mimeType = input.mimeType?.trim() || match[1] || 'application/octet-stream';
  if (mimeType.length > 128 || !/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(mimeType)) {
    throw new Error(`${input.name} has an invalid content type.`);
  }
  return { name: input.name, mimeType, bytes };
}

async function resolveAttachmentBatch(
  connection: CompanionConnection,
  attachments: ChatAttachmentInput[],
): Promise<{ batchId: string; attachmentIds: string[] } | null> {
  if (attachments.length === 0) return null;
  if (attachments.some((attachment) => attachment.dataUrl !== undefined)) {
    const prepared = await stageMeshAttachments(connection, attachments);
    return resolveAttachmentIds(
      connection,
      prepared.map((attachment) => attachment.id),
    );
  }
  const attachmentIds = attachments.map((attachment) => attachment.id);
  if (attachmentIds.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new Error('Encrypted account attachments must be prepared before sending.');
  }
  return resolveAttachmentIds(connection, attachmentIds as string[]);
}

function resolveAttachmentIds(
  connection: CompanionConnection,
  attachmentIds: string[],
): { batchId: string; attachmentIds: string[] } {
  const batches = stagedAttachmentBatches.get(connection.id);
  const batchIds = [...new Set(attachmentIds.map((id) => batches?.get(id)))];
  if (batchIds.length !== 1 || typeof batchIds[0] !== 'string') {
    throw new Error('These attachments have expired. Select them again and retry.');
  }
  return { batchId: batchIds[0], attachmentIds };
}

function consumeAttachmentBatch(
  connection: CompanionConnection,
  batch: { batchId: string; attachmentIds: string[] },
): void {
  const attachments = stagedAttachmentBatches.get(connection.id);
  if (!attachments) return;
  for (const attachmentId of batch.attachmentIds) {
    if (attachments.get(attachmentId) === batch.batchId) attachments.delete(attachmentId);
  }
  if (attachments.size === 0) stagedAttachmentBatches.delete(connection.id);
}

function toHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function mapFileMentionResults(value: unknown): ChatFileMentionSearchResult[] {
  if (!Array.isArray(value)) throw new Error('The host returned malformed file search results.');
  return value.map((item): ChatFileMentionSearchResult => {
    if (
      !isRecord(item) ||
      typeof item.repoId !== 'string' ||
      typeof item.repoName !== 'string' ||
      typeof item.relativePath !== 'string' ||
      typeof item.name !== 'string' ||
      typeof item.size !== 'number' ||
      !Number.isSafeInteger(item.size)
    ) {
      throw new Error('The host returned a malformed file search result.');
    }
    const fileMention = validateMeshFileMentionReference(item);
    return {
      repoId: fileMention.repoId,
      repoName: item.repoName,
      relativePath: fileMention.relativePath,
      name: item.name,
      // The Mesh dispatcher should omit host paths. Keep a relative value for the
      // shared search-result type; account submissions serialize repoId + relativePath.
      path: fileMention.relativePath,
      size: item.size,
    };
  });
}

function validateMeshFileMentionReference(
  value: unknown,
): NonNullable<MobileStartChatInput['fileMentions']>[number] {
  if (
    !isRecord(value) ||
    typeof value.repoId !== 'string' ||
    value.repoId.length === 0 ||
    value.repoId.length > 256 ||
    typeof value.relativePath !== 'string' ||
    value.relativePath.length === 0 ||
    value.relativePath.length > 4096 ||
    value.relativePath.startsWith('/') ||
    value.relativePath.startsWith('\\') ||
    /^[A-Za-z]:/.test(value.relativePath) ||
    value.relativePath.includes('\0') ||
    value.relativePath.split(/[\\/]/).some((segment) => segment === '..' || segment === '.')
  ) {
    throw new Error('The host returned an unsafe repository-relative file reference.');
  }
  return { repoId: value.repoId, relativePath: value.relativePath };
}

function mapRegisteredSkills(value: unknown): CodexRegisteredSkill[] {
  if (!Array.isArray(value)) throw new Error('The host returned malformed skill results.');
  const scopes: CodexRegisteredSkill['scope'][] = [
    'codex-global',
    'codex-system',
    'user-agents',
    'project',
    'plugin',
    'unknown',
  ];
  return value.map((item): CodexRegisteredSkill => {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      typeof item.name !== 'string' ||
      !scopes.includes(item.scope as CodexRegisteredSkill['scope'])
    ) {
      throw new Error('The host returned malformed skill metadata.');
    }
    return {
      id: item.id,
      name: item.name,
      // Mesh skill results need display metadata only; never retain host-local paths.
      path: '',
      directory: '',
      scope: item.scope as CodexRegisteredSkill['scope'],
      ...(typeof item.description === 'string' ? { description: item.description } : {}),
      ...(typeof item.source === 'string' ? { source: item.source } : {}),
      ...(Array.isArray(item.tags) && item.tags.every((tag) => typeof tag === 'string')
        ? { tags: item.tags }
        : {}),
      ...(typeof item.updatedAt === 'string' ? { updatedAt: item.updatedAt } : {}),
    };
  });
}

function mapStartChatResult(value: unknown): MobileStartChatResult {
  if (
    !isRecord(value) ||
    !isRecord(value.thread) ||
    !isRecord(value.session) ||
    typeof value.queuedMessage !== 'string'
  ) {
    throw new Error('The host returned a malformed workflow result.');
  }
  const thread = mapChatThreads([value.thread])[0];
  const session = value.session;
  if (
    typeof session.id !== 'string' ||
    typeof session.personaId !== 'string' ||
    typeof session.startedAt !== 'string' ||
    !isSessionStatus(session.status)
  ) {
    throw new Error('The host returned a malformed started session.');
  }
  return {
    thread,
    session: {
      id: session.id,
      personaId: session.personaId,
      startedAt: session.startedAt,
      status: session.status,
      ...(typeof session.appThreadId === 'string' ? { appThreadId: session.appThreadId } : {}),
    },
    queuedMessage: value.queuedMessage,
  };
}

function assertOkResult(value: unknown, message: string): void {
  if (!isRecord(value) || value.ok !== true) throw new Error(message);
}

function decodeBase64Chunk(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('The host returned invalid attachment bytes.');
  }
  const binary = atob(value);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) result[index] = binary.charCodeAt(index);
  if (encodeBase64Bytes(result) !== value)
    throw new Error('The host returned invalid attachment bytes.');
  return result;
}

function encodeBase64Bytes(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)),
    );
  }
  return btoa(binary);
}

function accountRestUnavailable(path: string): Error {
  return new Error(
    `This operation (${path}) is not part of the current encrypted Mesh session. Use a paired local-token connection for this companion-only operation.`,
  );
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

function normalizeMobileOverview(raw: unknown, hideHostPaths = false): MobileOverview {
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
  const rawActiveWorkspace = isRecord(overview.activeWorkspace)
    ? (overview.activeWorkspace as unknown as MobileOverview['activeWorkspace'])
    : undefined;
  const activeWorkspace =
    hideHostPaths && rawActiveWorkspace
      ? {
          ...rawActiveWorkspace,
          repos: Array.isArray(rawActiveWorkspace.repos)
            ? rawActiveWorkspace.repos.map((repo) => ({ ...repo, path: '' }))
            : [],
        }
      : rawActiveWorkspace;
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
    workItems: arrayValue(overview.workItems) as MobileOverview['workItems'],
    currentIterationPath:
      !hideHostPaths && typeof overview.currentIterationPath === 'string'
        ? overview.currentIterationPath
        : undefined,
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
  const authMode = raw.authMode === 'account' ? 'account' : 'paired';
  const enrollmentId = typeof raw.enrollmentId === 'string' ? raw.enrollmentId : undefined;
  // Account host rows use their enrollment identity to establish a fresh Mesh session.
  if (!baseUrl || (authMode === 'paired' && !token) || (authMode === 'account' && !enrollmentId)) {
    throw new Error('Invalid companion connection.');
  }

  const now = new Date().toISOString();
  return {
    id: stringValue(raw.id, createConnectionId(baseUrl)),
    baseUrl: trimBaseUrl(baseUrl),
    token,
    deviceName: stringValue(raw.deviceName, hostLabelFromBaseUrl(baseUrl)),
    pairedAt: stringValue(raw.pairedAt, now),
    lastUsedAt: stringValue(raw.lastUsedAt, now),
    authMode,
    enrollmentId,
    requiresHostApproval: raw.requiresHostApproval === true,
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
