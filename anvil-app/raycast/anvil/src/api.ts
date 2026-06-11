import { getPreferenceValues } from '@raycast/api';

export interface Preferences {
  baseUrl: string;
  token: string;
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
  kind: 'command' | 'file_change';
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
  return fetchJson('/api/overview');
}

export async function openDesktop(): Promise<void> {
  await fetchJson('/api/desktop/open', { method: 'POST' });
}

export async function resolveApproval(
  approval: ApprovalRequest,
  decision: ApprovalDecision,
): Promise<void> {
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
  await fetchJson(`/api/sessions/${encodeURIComponent(sessionId)}/interrupt`, { method: 'POST' });
}

export async function sendThreadMessage(
  threadId: string,
  sessionId: string | undefined,
  message: string,
): Promise<void> {
  await fetchJson(`/api/chat/threads/${encodeURIComponent(threadId)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ sessionId, message }),
  });
}

export async function startWorkflow(input: StartWorkflowInput): Promise<StartWorkflowResult> {
  return fetchJson('/api/chat/start', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

async function fetchJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const preferences = getPreferenceValues<Preferences>();
  const baseUrl = preferences.baseUrl.replace(/\/+$/, '');
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${preferences.token}`,
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
