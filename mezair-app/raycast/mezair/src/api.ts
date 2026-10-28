import { getPreferenceValues } from '@raycast/api';
import { forgetDialedHost, resolveAccountMachine, subscribeToAccountMeshEvents } from './account';
import type { MeshMachineOperation } from '../../../cloud/contract/machine.js';

export interface Preferences {
  baseUrl?: string;
  token?: string;
  accountApiUrl?: string;
  accountEnrollmentCode?: string;
}

export interface CodexSession {
  id: string;
  personaId: string;
  status: 'starting' | 'ready' | 'busy' | 'error';
  startedAt: string;
  appThreadId?: string;
}

export interface ApprovalRequest {
  sessionId: string;
  requestKey: string;
  requestId: string | number;
  kind: 'command' | 'file_change' | 'permissions';
  reason?: string;
  command?: string;
  cwd?: string;
  grantRoot?: string;
  createdAt: string;
}

export interface ChatThread {
  id: string;
  personaId: string;
  title: string;
  preview?: string;
  messageCount: number;
  updatedAt: string;
  activeSessionId?: string;
  activeSessionStatus?: CodexSession['status'];
  pendingApprovalCount: number;
}

export interface WorkflowDigest {
  health: 'needs-approval' | 'busy' | 'ready' | 'idle' | 'unconfigured';
  headline: string;
  detail: string;
  counts: {
    pendingApprovals: number;
    activeSessions: number;
    busySessions: number;
    readySessions: number;
    recentThreads: number;
    workspaceRepos: number;
  };
}

export interface QuickAction {
  id: string;
  title: string;
  subtitle: string;
  prompt: string;
  personaId: string;
  tone: 'neutral' | 'blue' | 'green' | 'amber' | 'red' | 'purple';
  requiresActiveWorkspace: boolean;
}

export interface Overview {
  generatedAt: string;
  activeWorkspace?: {
    id: string;
    name: string;
    repos: Array<{ id: string; name: string; path: string }>;
  };
  activeSessions: CodexSession[];
  pendingApprovals: ApprovalRequest[];
  threads: ChatThread[];
  workflow: WorkflowDigest;
  quickActions: QuickAction[];
}

export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export interface StartWorkflowInput {
  actionId?: string;
  message?: string;
  title?: string;
  personaId?: string;
}

export interface StartWorkflowResult {
  thread: ChatThread;
  session: CodexSession;
  queuedMessage: string;
}

export async function fetchOverview(): Promise<Overview> {
  if (!pairedTarget()) {
    return mapMeshOverview(await requestMeshOperation('read.snapshot', {}));
  }
  return fetchJson('/api/overview');
}

export async function openDesktop(): Promise<void> {
  if (!pairedTarget()) {
    const result = await requestMeshOperation('command.open-desktop', {});
    if (!isRecord(result) || result.opened !== true) {
      throw new Error('The host did not confirm the desktop focus request.');
    }
    return;
  }
  requirePairedTarget('/api/desktop/open');
  await fetchJson('/api/desktop/open', { method: 'POST' });
}

export async function resolveApproval(
  approval: ApprovalRequest,
  decision: ApprovalDecision,
): Promise<void> {
  if (!pairedTarget()) {
    const result = await requestMeshOperation('command.approve', {
      sessionId: approval.sessionId,
      requestKey: approval.requestKey,
      decision,
    });
    if (!isRecord(result) || result.ok !== true) {
      throw new Error('The host did not confirm the approval decision.');
    }
    return;
  }
  requirePairedTarget('/api/approvals/:sessionId/:requestKey/resolve');
  await fetchJson(
    `/api/approvals/${encodeURIComponent(approval.sessionId)}/${encodeURIComponent(
      approval.requestKey,
    )}/resolve`,
    {
      method: 'POST',
      body: JSON.stringify({ decision }),
    },
  );
}

export async function interruptSession(sessionId: string): Promise<void> {
  if (!pairedTarget()) {
    const result = await requestMeshOperation('command.cancel', { sessionId });
    if (!isRecord(result) || result.ok !== true) {
      throw new Error('The host did not confirm the interrupt request.');
    }
    return;
  }
  requirePairedTarget('/api/sessions/:sessionId/interrupt');
  await fetchJson(`/api/sessions/${encodeURIComponent(sessionId)}/interrupt`, { method: 'POST' });
}

export async function sendThreadMessage(
  threadId: string,
  sessionId: string | undefined,
  message: string,
): Promise<void> {
  if (!pairedTarget()) {
    const activeSessionId = sessionId?.trim();
    if (!activeSessionId || !message.trim()) {
      throw new Error('Mesh can send a message only to an active host session.');
    }
    const result = await requestMeshOperation('command.steer', {
      sessionId: activeSessionId,
      message,
    });
    if (!isRecord(result) || result.accepted !== true || result.sessionId !== activeSessionId) {
      throw new Error('The host did not confirm the Mesh steer request.');
    }
    return;
  }
  await fetchJson(`/api/chat/threads/${encodeURIComponent(threadId)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ sessionId, message }),
  });
}

export async function startWorkflow(input: StartWorkflowInput): Promise<StartWorkflowResult> {
  if (!pairedTarget()) {
    return mapMeshStartWorkflow(await requestMeshOperation('command.submit', input));
  }
  requirePairedTarget('/api/chat/start');
  return fetchJson('/api/chat/start', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

async function fetchJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const target = requirePairedTarget(path);

  const response = await fetch(`${target.baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${target.token}`,
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `Request failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

function pairedTarget(): { baseUrl: string; token: string } | null {
  const preferences = getPreferenceValues<Preferences>();
  const baseUrl = preferences.baseUrl?.trim().replace(/\/+$/, '');
  const token = preferences.token?.trim();
  return baseUrl && token ? { baseUrl, token } : null;
}

function requirePairedTarget(path: string): { baseUrl: string; token: string } {
  const target = pairedTarget();
  if (!target) {
    throw new Error(
      `This operation (${path}) is not part of the current encrypted Mesh session. Use a paired local-token connection for this companion-only action.`,
    );
  }
  return target;
}

async function requestMeshOperation(
  operation: MeshMachineOperation,
  payload: unknown,
): Promise<unknown> {
  const { host, connection } = await resolveAccountMachine();
  if (!host.operations.includes(operation)) {
    throw new Error(`The host does not provide the current Mesh operation '${operation}'.`);
  }
  try {
    return await connection.request<unknown>(operation, payload);
  } catch (error) {
    if (error instanceof Error && error.message === 'machine-request-uncertain') {
      throw new Error(
        'The host connection dropped before this action was confirmed. Refresh host state before retrying.',
        { cause: error },
      );
    }
    if (error instanceof Error && error.message.startsWith('machine-')) {
      await forgetDialedHost();
      if (error.message === 'machine-approval-required') {
        throw new Error(
          'On this host, open Settings → Devices → Account device access and approve Raycast.',
          { cause: error },
        );
      }
      if (error.message === 'machine-device-denied') {
        throw new Error('The host denied Raycast under its local trust policy.', { cause: error });
      }
      if (error.message === 'machine-route-unavailable') {
        throw new Error('Host connection unavailable. Check the host and refresh.', {
          cause: error,
        });
      }
    }
    throw error;
  }
}

function mapMeshStartWorkflow(value: unknown): StartWorkflowResult {
  if (
    !isRecord(value) ||
    !isRecord(value.thread) ||
    !isRecord(value.session) ||
    typeof value.queuedMessage !== 'string'
  ) {
    throw new Error('The host returned a malformed Mesh workflow result.');
  }
  const threadValue = value.thread;
  const sessionValue = value.session;
  if (
    typeof threadValue.id !== 'string' ||
    typeof threadValue.personaId !== 'string' ||
    typeof threadValue.title !== 'string' ||
    typeof threadValue.messageCount !== 'number' ||
    typeof threadValue.updatedAt !== 'string' ||
    typeof threadValue.pendingApprovalCount !== 'number' ||
    typeof sessionValue.id !== 'string' ||
    typeof sessionValue.personaId !== 'string' ||
    typeof sessionValue.startedAt !== 'string' ||
    !['starting', 'ready', 'busy', 'error'].includes(String(sessionValue.status))
  ) {
    throw new Error('The host returned a malformed Mesh workflow result.');
  }
  return {
    thread: {
      id: threadValue.id,
      personaId: threadValue.personaId,
      title: threadValue.title,
      preview: typeof threadValue.preview === 'string' ? threadValue.preview : undefined,
      messageCount: threadValue.messageCount,
      updatedAt: threadValue.updatedAt,
      ...(typeof threadValue.activeSessionId === 'string'
        ? { activeSessionId: threadValue.activeSessionId }
        : {}),
      ...(isRaycastSessionStatus(threadValue.activeSessionStatus)
        ? { activeSessionStatus: threadValue.activeSessionStatus }
        : {}),
      pendingApprovalCount: threadValue.pendingApprovalCount,
    },
    session: {
      id: sessionValue.id,
      personaId: sessionValue.personaId,
      status: sessionValue.status as CodexSession['status'],
      startedAt: sessionValue.startedAt,
      ...(typeof sessionValue.appThreadId === 'string'
        ? { appThreadId: sessionValue.appThreadId }
        : {}),
    },
    queuedMessage: value.queuedMessage,
  };
}

export function subscribeToMeshUpdates(onUpdate: () => void): () => void {
  if (pairedTarget()) return () => {};
  return subscribeToAccountMeshEvents(() => onUpdate());
}

function isRaycastSessionStatus(value: unknown): value is CodexSession['status'] {
  return value === 'starting' || value === 'ready' || value === 'busy' || value === 'error';
}

function mapMeshOverview(value: unknown): Overview {
  if (
    !isRecord(value) ||
    typeof value.generatedAt !== 'string' ||
    !Array.isArray(value.activeSessions) ||
    !Array.isArray(value.pendingApprovals) ||
    !Array.isArray(value.threads) ||
    !isRecord(value.workflow) ||
    !Array.isArray(value.quickActions)
  ) {
    throw new Error('The host returned a malformed Mesh snapshot.');
  }

  const activeSessions = value.activeSessions.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      typeof item.personaId !== 'string' ||
      typeof item.startedAt !== 'string' ||
      !['starting', 'ready', 'busy', 'error'].includes(String(item.status))
    ) {
      throw new Error('The host returned a malformed session snapshot.');
    }
    return {
      id: item.id,
      personaId: item.personaId,
      status: item.status as CodexSession['status'],
      startedAt: item.startedAt,
      ...(typeof item.appThreadId === 'string' ? { appThreadId: item.appThreadId } : {}),
    };
  });

  const pendingApprovals = value.pendingApprovals.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.sessionId !== 'string' ||
      typeof item.requestKey !== 'string' ||
      (typeof item.requestId !== 'string' && typeof item.requestId !== 'number') ||
      !['command', 'file_change', 'permissions'].includes(String(item.kind)) ||
      typeof item.createdAt !== 'string'
    ) {
      throw new Error('The host returned a malformed approval snapshot.');
    }
    return {
      sessionId: item.sessionId,
      requestKey: item.requestKey,
      requestId: item.requestId,
      kind: item.kind as ApprovalRequest['kind'],
      createdAt: item.createdAt,
      ...(typeof item.reason === 'string' ? { reason: item.reason } : {}),
      ...(typeof item.command === 'string' ? { command: item.command } : {}),
      ...(typeof item.cwd === 'string' ? { cwd: item.cwd } : {}),
      ...(typeof item.grantRoot === 'string' ? { grantRoot: item.grantRoot } : {}),
    };
  });

  const threads = value.threads.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      typeof item.personaId !== 'string' ||
      typeof item.title !== 'string' ||
      typeof item.messageCount !== 'number' ||
      typeof item.updatedAt !== 'string' ||
      typeof item.pendingApprovalCount !== 'number'
    ) {
      throw new Error('The host returned a malformed thread snapshot.');
    }
    return {
      id: item.id,
      personaId: item.personaId,
      title: item.title,
      messageCount: item.messageCount,
      updatedAt: item.updatedAt,
      pendingApprovalCount: item.pendingApprovalCount,
      ...(typeof item.preview === 'string' ? { preview: item.preview } : {}),
      ...(typeof item.activeSessionId === 'string'
        ? { activeSessionId: item.activeSessionId }
        : {}),
      ...(typeof item.activeSessionStatus === 'string'
        ? { activeSessionStatus: item.activeSessionStatus as CodexSession['status'] }
        : {}),
    };
  });

  const workflow = mapWorkflow(value.workflow);
  const quickActions = value.quickActions.map(mapQuickAction);
  const activeWorkspace =
    value.activeWorkspace === undefined ? undefined : mapWorkspace(value.activeWorkspace);
  return {
    generatedAt: value.generatedAt,
    ...(activeWorkspace ? { activeWorkspace } : {}),
    activeSessions,
    pendingApprovals,
    threads,
    workflow,
    quickActions,
  };
}

function mapWorkflow(value: Record<string, unknown>): WorkflowDigest {
  const counts = value.counts;
  if (
    !['needs-approval', 'busy', 'ready', 'idle', 'unconfigured'].includes(String(value.health)) ||
    typeof value.headline !== 'string' ||
    typeof value.detail !== 'string' ||
    !isRecord(counts) ||
    ![
      'pendingApprovals',
      'activeSessions',
      'busySessions',
      'readySessions',
      'recentThreads',
      'workspaceRepos',
    ].every((key) => typeof counts[key] === 'number')
  ) {
    throw new Error('The host returned a malformed workflow snapshot.');
  }
  return {
    health: value.health as WorkflowDigest['health'],
    headline: value.headline,
    detail: value.detail,
    counts: {
      pendingApprovals: counts.pendingApprovals as number,
      activeSessions: counts.activeSessions as number,
      busySessions: counts.busySessions as number,
      readySessions: counts.readySessions as number,
      recentThreads: counts.recentThreads as number,
      workspaceRepos: counts.workspaceRepos as number,
    },
  };
}

function mapQuickAction(value: unknown): QuickAction {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.subtitle !== 'string' ||
    typeof value.prompt !== 'string' ||
    typeof value.personaId !== 'string' ||
    !['neutral', 'blue', 'green', 'amber', 'red', 'purple'].includes(String(value.tone)) ||
    typeof value.requiresActiveWorkspace !== 'boolean'
  ) {
    throw new Error('The host returned a malformed quick action snapshot.');
  }
  return {
    id: value.id,
    title: value.title,
    subtitle: value.subtitle,
    prompt: value.prompt,
    personaId: value.personaId,
    tone: value.tone as QuickAction['tone'],
    requiresActiveWorkspace: value.requiresActiveWorkspace,
  };
}

function mapWorkspace(value: unknown): NonNullable<Overview['activeWorkspace']> {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.name !== 'string' ||
    !Array.isArray(value.repos)
  ) {
    throw new Error('The host returned a malformed workspace snapshot.');
  }
  const repos = value.repos.map((repo) => {
    if (
      !isRecord(repo) ||
      typeof repo.id !== 'string' ||
      typeof repo.name !== 'string' ||
      typeof repo.path !== 'string'
    ) {
      throw new Error('The host returned a malformed repository snapshot.');
    }
    return { id: repo.id, name: repo.name, path: repo.path };
  });
  return { id: value.id, name: value.name, repos };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
