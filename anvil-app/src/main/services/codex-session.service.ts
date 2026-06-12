import { spawn, type ChildProcess } from 'node:child_process';

import { randomUUID } from 'node:crypto';
import { BrowserWindow } from 'electron';
import type {
  ChatAttachment,
  ChatSendOptions,
  ChatStartOptions,
  CodexEvent,
  CodexMode,
  CodexSession,
  MobileApprovalRequest,
} from '../../shared/types.js';
import {
  buildSystemPrompt,
  buildDesignSystemPrompt,
  buildScaffoldSystemPrompt,
} from './persona.service.js';
import { getSettings } from './settings.service.js';
import {
  commonParentDir,
  handleCodexServerLine,
  type JsonRpcRequestId,
  sendCodexJsonRpc,
} from './codex-protocol.service.js';
import { emitCompanionEvent } from './companion-events.service.js';

interface ManagedSession {
  id: string;
  repoId?: string;
  workspaceId?: string;
  appThreadId?: string;
  kind: 'repo' | 'workspace' | 'scaffold';
  personaId: string;
  mode: CodexMode;
  process: ChildProcess;
  status: CodexSession['status'];
  startedAt: string;
  cwd: string;
  buffer: string;
  threadId: string | null;
  turnId: string | null;
  initialized: boolean;
  /** Resolves when thread/started is received from the server */
  threadReady: Promise<void>;
  resolveThreadReady: (() => void) | null;
}

type CodexUserInput =
  | { type: 'text'; text: string; text_elements: [] }
  | { type: 'localImage'; path: string }
  | { type: 'mention'; name: string; path: string };

const sessions = new Map<string, ManagedSession>();
const pendingApprovals = new Map<string, string>();
const pendingApprovalDetails = new Map<string, MobileApprovalRequest>();

/**
 * Start a new Codex app-server session for a repo + persona combo.
 * Protocol: initialize → thread/start → turn/start for each message.
 */
export async function startSession(
  repoPaths: string[],
  repoIds: string[],
  personaId: string,
  options?: ChatStartOptions,
): Promise<CodexSession> {
  const id = randomUUID();
  const settings = getSettings();
  const mode = settings.codexMode ?? 'on-request';
  const codexPolicy = codexModeToPolicy(mode);
  const systemPrompt = options?.scaffold
    ? buildScaffoldSystemPrompt(personaId, options.scaffold.rootPath)
    : personaId === 'design'
      ? buildDesignSystemPrompt(repoIds, options?.designMode ?? 'design', options?.figmaContext)
      : buildSystemPrompt(personaId, repoIds, options?.workspace?.workspaceId);
  const cwd = resolveSessionCwd(repoPaths, options);

  // Build environment
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };

  const args = ['app-server'];

  // Azure AI Foundry: Codex reads config from ~/.codex/config.toml (set up by user).
  // OpenAI: pass the API key via environment.
  if (settings.llmProvider === 'openai') {
    if (settings.openaiApiKey) env['OPENAI_API_KEY'] = settings.openaiApiKey;
  }

  let proc: ChildProcess;
  try {
    proc = spawn('codex', args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw new Error(
      `Failed to spawn codex app-server: ${err instanceof Error ? err.message : err}`,
    );
  }

  let resolveThreadReady: (() => void) | null = null;
  const threadReady = new Promise<void>((resolve) => {
    resolveThreadReady = resolve;
  });

  const session: ManagedSession = {
    id,
    repoId: repoIds[0],
    workspaceId: options?.scaffold?.workspaceId ?? options?.workspace?.workspaceId,
    appThreadId: options?.threadId,
    kind: options?.scaffold ? 'scaffold' : repoIds.length > 0 ? 'repo' : 'workspace',
    personaId,
    mode,
    process: proc,
    status: 'starting',
    startedAt: new Date().toISOString(),
    cwd,
    buffer: '',
    threadId: null,
    turnId: null,
    initialized: false,
    threadReady,
    resolveThreadReady,
  };

  sessions.set(id, session);

  // Handle stdout — JSON-RPC events, one per line
  proc.stdout?.on('data', (chunk: Buffer) => {
    session.buffer += chunk.toString();
    const lines = session.buffer.split('\n');
    session.buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      handleServerMessage(session, line.trim());
    }
  });

  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) {
      console.warn(`[Codex:${id.slice(0, 8)}] stderr: ${text}`);
    }
  });

  proc.on('exit', (code, signal) => {
    console.log(`[Codex:${id.slice(0, 8)}] exited with code=${code} signal=${signal}`);
    session.status = 'error';
    broadcastEvent(id, { type: 'status', status: 'complete' });
  });

  proc.on('error', (err) => {
    console.error(`[Codex:${id.slice(0, 8)}] process error:`, err);
    session.status = 'error';
    broadcastEvent(id, { type: 'error', errorMessage: `Codex process error: ${err.message}` });
  });

  // Step 1: Send initialize
  sendCodexJsonRpc(proc, 'initialize', {
    clientInfo: { name: 'anvil', version: '0.1.0' },
  });

  // Step 2: Start a thread with system prompt and cwd
  sendCodexJsonRpc(proc, 'thread/start', {
    cwd,
    developerInstructions: systemPrompt,
    approvalPolicy: codexPolicy.approvalPolicy,
    sandbox: codexPolicy.sandbox,
  });

  // Wait for thread/started before marking ready
  await threadReady;

  session.status = 'ready';
  broadcastEvent(id, { type: 'status', status: 'executing' });

  return sessionToPublic(session);
}

/**
 * Send a user message to an active session via turn/start.
 */
export async function sendMessage(
  sessionId: string,
  message: string,
  attachments: ChatAttachment[] = [],
  options?: ChatSendOptions,
): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (!session.process.stdin?.writable) throw new Error('Session stdin not writable');

  // Wait for thread to be ready before sending
  await session.threadReady;

  session.status = 'busy';
  broadcastEvent(sessionId, { type: 'status', status: 'thinking' });

  const mode = getSettings().codexMode ?? session.mode;
  const codexPolicy =
    options?.collaborationMode === 'plan'
      ? { approvalPolicy: 'on-request' as const, sandbox: 'read-only' as const }
      : codexModeToPolicy(mode);
  session.mode = mode;

  sendCodexJsonRpc(session.process, 'turn/start', {
    threadId: session.threadId,
    input: buildUserInput(message, attachments),
    approvalPolicy: codexPolicy.approvalPolicy,
    sandboxPolicy: sandboxModeToTurnPolicy(codexPolicy.sandbox, session.cwd),
  });
}

function buildUserInput(message: string, attachments: ChatAttachment[]): CodexUserInput[] {
  const input: CodexUserInput[] = [{ type: 'text', text: message, text_elements: [] }];

  for (const attachment of attachments) {
    if (attachment.kind === 'image') {
      input.push({ type: 'localImage', path: attachment.path });
    } else {
      input.push({ type: 'mention', name: attachment.name, path: attachment.path });
    }
  }

  return input;
}

export function interruptTurn(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (!session.threadId || !session.turnId) return;

  sendCodexJsonRpc(session.process, 'turn/interrupt', {
    threadId: session.threadId,
    turnId: session.turnId,
  });

  session.status = 'ready';
  session.turnId = null;
  broadcastEvent(sessionId, { type: 'status', status: 'complete' });
}

export function stopSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  try {
    session.process.kill('SIGTERM');
  } catch {
    /* already dead */
  }
  sessions.delete(sessionId);
  for (const [requestId, ownerSessionId] of pendingApprovals) {
    if (ownerSessionId === sessionId) {
      pendingApprovals.delete(requestId);
      pendingApprovalDetails.delete(requestId);
    }
  }
}

export function stopAllSessions(): void {
  for (const [id] of sessions) {
    stopSession(id);
  }
}

export function getSessionStatus(sessionId: string): CodexSession['status'] {
  return sessions.get(sessionId)?.status ?? 'error';
}

export function getSessionForRepo(repoId: string): CodexSession | null {
  for (const session of sessions.values()) {
    if (session.repoId === repoId && session.status !== 'error') {
      return sessionToPublic(session);
    }
  }
  return null;
}

export function listActiveCodexSessions(): CodexSession[] {
  return [...sessions.values()]
    .filter((session) => session.status !== 'error')
    .map(sessionToPublic);
}

export function getCodexSession(sessionId: string): CodexSession | null {
  const session = sessions.get(sessionId);
  return session ? sessionToPublic(session) : null;
}

export function listPendingApprovalRequests(): MobileApprovalRequest[] {
  return [...pendingApprovalDetails.values()].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}

export function getCodexSessionDiagnostics(): {
  activeSessions: number;
  pendingApprovals: number;
  bufferedBytes: number;
} {
  let bufferedBytes = 0;
  for (const session of sessions.values()) {
    bufferedBytes += Buffer.byteLength(session.buffer, 'utf8');
  }

  return {
    activeSessions: sessions.size,
    pendingApprovals: pendingApprovals.size,
    bufferedBytes,
  };
}

export function resolveApproval(
  sessionId: string,
  requestId: JsonRpcRequestId,
  decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
): void {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  const requestKey = String(requestId);
  const ownerSessionId = pendingApprovals.get(requestKey);
  if (ownerSessionId !== sessionId) {
    throw new Error('Approval request is no longer active for this session.');
  }

  pendingApprovals.delete(requestKey);
  pendingApprovalDetails.delete(requestKey);
  sendCodexJsonRpcResult(session.process, requestId, { decision });
  emitCompanionEvent('approvals');
}

// --- Internal helpers ---

function resolveSessionCwd(repoPaths: string[], options?: ChatStartOptions): string {
  if (options?.scaffold?.rootPath) return options.scaffold.rootPath;
  if (options?.workspace?.cwd) return options.workspace.cwd;
  if (repoPaths.length > 0) return commonParentDir(repoPaths);
  return process.cwd();
}

function handleServerMessage(session: ManagedSession, line: string): void {
  handleCodexServerLine(session, line, {
    onThreadReady: () => {
      session.resolveThreadReady?.();
      session.resolveThreadReady = null;
    },
    onTurnStarted: () => {
      session.status = 'busy';
    },
    onTurnCompleted: () => {
      session.status = 'ready';
    },
    onEvent: (event) => {
      if (event.type === 'approval_request' && event.approvalRequestId) {
        const requestKey = String(event.approvalRequestId);
        pendingApprovals.set(requestKey, session.id);
        pendingApprovalDetails.set(requestKey, {
          sessionId: session.id,
          requestKey,
          requestId: event.approvalRequestId,
          kind: event.approvalKind ?? 'command',
          reason: event.approvalReason,
          command: event.approvalCommand,
          cwd: event.approvalCwd,
          grantRoot: event.approvalGrantRoot,
          createdAt: new Date().toISOString(),
        });
        emitCompanionEvent('approvals');
      }
      if (event.type === 'status' && event.status === 'complete') {
        session.status = 'ready';
        emitCompanionEvent('sessions');
      } else if (event.type === 'status' && event.status === 'thinking') {
        session.status = 'busy';
        emitCompanionEvent('sessions');
      }
      broadcastEvent(session.id, event);
    },
    onLog: (message) => {
      console.log(`[Codex:${session.id.slice(0, 8)}] ${message}`);
    },
    onServerRequestResolved: (requestId) => {
      const requestKey = String(requestId);
      pendingApprovals.delete(requestKey);
      pendingApprovalDetails.delete(requestKey);
      emitCompanionEvent('approvals');
    },
  });
}

function broadcastEvent(sessionId: string, event: CodexEvent): void {
  const session = sessions.get(sessionId);
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('chat:event', {
      sessionId,
      appThreadId: session?.appThreadId,
      ...event,
    });
  }
}

function sessionToPublic(session: ManagedSession): CodexSession {
  return {
    id: session.id,
    repoId: session.repoId,
    workspaceId: session.workspaceId,
    appThreadId: session.appThreadId,
    kind: session.kind,
    personaId: session.personaId,
    status: session.status,
    startedAt: session.startedAt,
    mode: session.mode,
  };
}

function sendCodexJsonRpcResult(
  proc: ChildProcess,
  requestId: JsonRpcRequestId,
  result: Record<string, unknown>,
): void {
  proc.stdin?.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      result,
    }) + '\n',
  );
}

function codexModeToPolicy(mode: CodexMode): {
  approvalPolicy: 'on-request' | 'never';
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
} {
  switch (mode) {
    case 'read-only':
      return { approvalPolicy: 'on-request', sandbox: 'read-only' };
    case 'workspace-auto':
      return { approvalPolicy: 'never', sandbox: 'workspace-write' };
    case 'full-access':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access' };
    case 'on-request':
    default:
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
  }
}

function sandboxModeToTurnPolicy(
  mode: 'read-only' | 'workspace-write' | 'danger-full-access',
  cwd: string,
): Record<string, unknown> {
  switch (mode) {
    case 'danger-full-access':
      return { type: 'dangerFullAccess' };
    case 'read-only':
      return { type: 'readOnly', networkAccess: false };
    case 'workspace-write':
    default:
      return {
        type: 'workspaceWrite',
        writableRoots: [cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
  }
}
