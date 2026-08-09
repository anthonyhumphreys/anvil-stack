import { spawn, type ChildProcess } from 'node:child_process';

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import type {
  AgentProvider,
  ChatAttachment,
  ChatSendOptions,
  ChatStartOptions,
  CodexEvent,
  CodexInputResponse,
  CodexMode,
  CodexSession,
  MobileApprovalRequest,
} from '../../shared/types.js';
import {
  buildSystemPrompt,
  buildDesignSystemPrompt,
  buildScaffoldSystemPrompt,
  getPersonaById,
} from './persona.service.js';
import { getSettings } from './settings.service.js';
import {
  commonParentDir,
  handleCodexServerLine,
  type JsonRpcRequestId,
  sendCodexJsonRpc,
  sendCodexJsonRpcNotification,
} from './codex-protocol.service.js';
import { emitCompanionEvent } from './companion-events.service.js';
import { normaliseCodexModel, normaliseReasoningEffort } from '../../shared/codex-models.js';
import { notifyChatActivity, type ChatActivityKind } from './notification.service.js';
import { updateChatThreadAttention } from './chat-persistence.service.js';

interface ManagedSession {
  id: string;
  repoId?: string;
  workspaceId?: string;
  appThreadId?: string;
  kind: 'repo' | 'workspace' | 'scaffold';
  personaId: string;
  mode: CodexMode;
  process: ChildProcess;
  provider: 'codex' | 'cursor';
  status: CodexSession['status'];
  startedAt: string;
  cwd: string;
  buffer: string;
  threadId: string | null;
  turnId: string | null;
  initialized: boolean;
  stopping: boolean;
  /** Resolves when thread/started is received from the server */
  threadReady: Promise<void>;
  resolveThreadReady: (() => void) | null;
  rejectThreadReady: ((err: Error) => void) | null;
}

type CodexUserInput =
  | { type: 'text'; text: string; text_elements: [] }
  | { type: 'localImage'; path: string }
  | { type: 'mention'; name: string; path: string };

export interface CodexTurnSteerParams {
  threadId: string;
  expectedTurnId: string;
  input: CodexUserInput[];
}

const sessions = new Map<string, ManagedSession>();
type PendingServerRequest =
  | {
      sessionId: string;
      requestId: JsonRpcRequestId;
      kind: 'command' | 'file_change';
    }
  | {
      sessionId: string;
      requestId: JsonRpcRequestId;
      kind: 'permissions';
      permissions: Record<string, unknown>;
    }
  | {
      sessionId: string;
      requestId: JsonRpcRequestId;
      kind: 'user_input' | 'mcp_elicitation';
    };

const pendingServerRequests = new Map<string, PendingServerRequest>();
const pendingApprovalDetails = new Map<string, MobileApprovalRequest>();

export function resolveSessionModel(provider: AgentProvider, configuredModel: string): string {
  return provider === 'cursor'
    ? configuredModel.trim() || 'auto'
    : normaliseCodexModel(configuredModel);
}

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
  const model = resolveSessionModel(settings.llmProvider, settings.openaiModel);
  const codexPolicy = resolvePersonaCodexPolicy(mode, personaId);
  const systemPrompt = options?.scaffold
    ? buildScaffoldSystemPrompt(personaId, options.scaffold.rootPath)
    : personaId === 'design'
      ? buildDesignSystemPrompt(repoIds, options?.designMode ?? 'design', options?.figmaContext)
      : buildSystemPrompt(personaId, repoIds, options?.workspace?.workspaceId);
  const cwd = resolveSessionCwd(repoPaths, options, app.getPath('userData'));

  // Build environment
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };

  const provider = settings.llmProvider === 'cursor' ? 'cursor' : 'codex';
  const command = provider === 'cursor' ? 'cursor-agent' : 'codex';
  const args = provider === 'cursor' ? ['acp'] : ['app-server'];

  // Azure AI Foundry: Codex reads config from ~/.codex/config.toml (set up by user).
  // OpenAI: pass the API key via environment.
  if (provider === 'codex' && settings.llmProvider === 'openai') {
    if (settings.openaiApiKey) env['OPENAI_API_KEY'] = settings.openaiApiKey;
  }

  let proc: ChildProcess;
  try {
    proc = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw new Error(
      `Failed to spawn ${provider === 'cursor' ? 'cursor-agent acp' : 'codex app-server'}: ${err instanceof Error ? err.message : err}`,
    );
  }

  let resolveThreadReady: (() => void) | null = null;
  let rejectThreadReady: ((err: Error) => void) | null = null;
  const threadReady = new Promise<void>((resolve, reject) => {
    resolveThreadReady = resolve;
    rejectThreadReady = reject;
  });

  const session: ManagedSession = {
    id,
    repoId: repoIds[0],
    workspaceId: options?.scaffold?.workspaceId ?? options?.workspace?.workspaceId,
    appThreadId: options?.threadId,
    kind: options?.scaffold ? 'scaffold' : repoIds.length > 0 ? 'repo' : 'workspace',
    personaId,
    mode: codexPolicy.sandbox === 'read-only' ? 'read-only' : mode,
    process: proc,
    provider,
    status: 'starting',
    startedAt: new Date().toISOString(),
    cwd,
    buffer: '',
    threadId: null,
    turnId: null,
    initialized: false,
    stopping: false,
    threadReady,
    resolveThreadReady,
    rejectThreadReady,
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
    if (session.stopping) {
      setSessionThreadAttention(session, 'idle');
      return;
    }
    session.status = 'error';
    session.rejectThreadReady?.(
      new Error(`Codex app-server exited before thread was ready (code=${code}, signal=${signal})`),
    );
    session.rejectThreadReady = null;
    setSessionThreadAttention(session, 'failed');
    broadcastEvent(id, {
      type: 'status',
      status: 'error',
      errorMessage: `Codex app-server exited (code=${code}, signal=${signal}).`,
    });
  });

  proc.on('error', (err) => {
    console.error(`[Codex:${id.slice(0, 8)}] process error:`, err);
    session.status = 'error';
    session.rejectThreadReady?.(err);
    session.rejectThreadReady = null;
    setSessionThreadAttention(session, 'failed');
    broadcastEvent(id, { type: 'error', errorMessage: `Codex process error: ${err.message}` });
  });

  if (provider === 'cursor') {
    sendCodexJsonRpc(proc, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        _meta: { parameterizedModelPicker: true },
      },
      clientInfo: { name: 'anvil', version: app.getVersion() },
    });
    sendCodexJsonRpc(proc, 'authenticate', { methodId: 'cursor_login' });
    sendCodexJsonRpc(proc, 'session/new', { cwd, mcpServers: [] });
  } else {
    // Step 1: Send initialize
    sendCodexJsonRpc(proc, 'initialize', {
      clientInfo: { name: 'anvil', version: app.getVersion() },
      capabilities: {
        experimentalApi: true,
        mcpServerOpenaiFormElicitation: true,
      },
    });
    sendCodexJsonRpcNotification(proc, 'initialized', {});

    // Step 2: Start, resume, or fork a thread with system prompt and cwd.
    const threadParams = {
      model,
      cwd,
      developerInstructions: systemPrompt,
      approvalPolicy: codexPolicy.approvalPolicy,
      sandbox: codexPolicy.sandbox,
    };
    if (options?.forkFromProviderThreadId) {
      sendCodexJsonRpc(proc, 'thread/fork', {
        threadId: options.forkFromProviderThreadId,
        ...threadParams,
      });
    } else if (options?.providerThreadId) {
      sendCodexJsonRpc(proc, 'thread/resume', {
        threadId: options.providerThreadId,
        ...threadParams,
      });
    } else {
      sendCodexJsonRpc(proc, 'thread/start', threadParams);
    }
  }

  // Wait for thread/started before marking ready
  await waitForThreadReady(threadReady, id);

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
  setSessionThreadAttention(session, 'working');
  broadcastEvent(sessionId, { type: 'status', status: 'thinking' });

  const settings = getSettings();
  const mode = settings.codexMode ?? session.mode;
  const model = normaliseCodexModel(options?.model ?? settings.openaiModel);
  const codexPolicy = resolvePersonaCodexPolicy(mode, session.personaId, {
    planMode: options?.collaborationMode === 'plan',
  });
  session.mode = codexPolicy.sandbox === 'read-only' ? 'read-only' : mode;

  if (session.provider === 'cursor') {
    if (!session.threadId) throw new Error('Cursor ACP session is not ready.');
    sendCodexJsonRpc(session.process, 'session/set_config', {
      sessionId: session.threadId,
      configId: 'model',
      value: model,
    });
    sendCodexJsonRpc(session.process, 'session/prompt', {
      sessionId: session.threadId,
      prompt: buildCursorPrompt(message, attachments),
    });
    return;
  }

  sendCodexJsonRpc(session.process, 'turn/start', {
    threadId: session.threadId,
    input: buildUserInput(message, attachments),
    approvalPolicy: codexPolicy.approvalPolicy,
    sandboxPolicy: sandboxModeToTurnPolicy(codexPolicy.sandbox, session.cwd),
    model,
    effort: normaliseReasoningEffort(options?.reasoningEffort ?? settings.reasoningLevel),
  });
}

export async function steerTurn(
  sessionId: string,
  message: string,
  attachments: ChatAttachment[] = [],
): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (!session.process.stdin?.writable) throw new Error('Session stdin not writable');

  await session.threadReady;
  if (!session.threadId || !session.turnId) {
    throw new Error('No active Codex turn to steer.');
  }

  sendCodexJsonRpc(
    session.process,
    'turn/steer',
    buildTurnSteerParams(session.threadId, session.turnId, message, attachments),
  );
}

function buildCursorPrompt(
  message: string,
  attachments: ChatAttachment[],
): Array<Record<string, unknown>> {
  return buildUserInput(message, attachments).map((item) => {
    if (item.type === 'text') return { type: 'text', text: item.text };
    if (item.type === 'localImage') return { type: 'resource_link', uri: `file://${item.path}` };
    return { type: 'resource_link', uri: `file://${item.path}`, name: item.name };
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

export function buildTurnSteerParams(
  threadId: string,
  turnId: string,
  message: string,
  attachments: ChatAttachment[] = [],
): CodexTurnSteerParams {
  return {
    threadId,
    expectedTurnId: turnId,
    input: buildUserInput(message, attachments),
  };
}

/**
 * Emit an assistant reply that was produced locally (e.g. by Apple Foundation
 * Models) through the same event stream a Codex turn would use, so the
 * renderer displays and persists it without a Codex round-trip.
 */
export function emitLocalAssistantTurn(sessionId: string, text: string): void {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  broadcastEvent(sessionId, { type: 'status', status: 'thinking' });
  setSessionThreadAttention(session, 'working');
  broadcastEvent(sessionId, { type: 'text', text });
  session.status = 'ready';
  setSessionThreadAttention(session, 'complete');
  broadcastEvent(sessionId, { type: 'status', status: 'complete' });
  emitCompanionEvent('sessions');
}

export function interruptTurn(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (!session.threadId) return;
  if (session.provider === 'cursor') {
    sendCodexJsonRpcNotification(session.process, 'session/cancel', {
      sessionId: session.threadId,
    });
    session.status = 'ready';
    broadcastEvent(sessionId, { type: 'status', status: 'complete' });
    return;
  }
  if (!session.turnId) return;

  sendCodexJsonRpc(session.process, 'turn/interrupt', {
    threadId: session.threadId,
    turnId: session.turnId,
  });

  session.status = 'ready';
  session.turnId = null;
  setSessionThreadAttention(session, 'idle');
  broadcastEvent(sessionId, { type: 'status', status: 'complete' });
}

export function stopSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.stopping = true;
  try {
    session.process.kill('SIGTERM');
  } catch {
    /* already dead */
  }
  sessions.delete(sessionId);
  for (const [requestKey, request] of pendingServerRequests) {
    if (request.sessionId === sessionId) {
      pendingServerRequests.delete(requestKey);
      pendingApprovalDetails.delete(requestKey);
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
    pendingApprovals: [...pendingServerRequests.values()].filter(
      (request) =>
        request.kind === 'command' ||
        request.kind === 'file_change' ||
        request.kind === 'permissions',
    ).length,
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
  const requestKey = buildPendingRequestKey(sessionId, requestId);
  const request = pendingServerRequests.get(requestKey);
  if (
    !request ||
    (request.kind !== 'command' && request.kind !== 'file_change' && request.kind !== 'permissions')
  ) {
    throw new Error('Approval request is no longer active for this session.');
  }

  pendingServerRequests.delete(requestKey);
  pendingApprovalDetails.delete(requestKey);
  const result = buildApprovalResponse(
    request.kind,
    request.kind === 'permissions' ? request.permissions : undefined,
    decision,
  );
  sendCodexJsonRpcResult(session.process, requestId, result);
  setSessionThreadAttention(session, 'working');
  emitCompanionEvent('approvals');
}

export function resolveInputRequest(
  sessionId: string,
  requestId: JsonRpcRequestId,
  response: CodexInputResponse,
): void {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  const requestKey = buildPendingRequestKey(sessionId, requestId);
  const request = pendingServerRequests.get(requestKey);
  if (!request || request.kind !== response.kind) {
    throw new Error('Input request is no longer active for this session.');
  }

  pendingServerRequests.delete(requestKey);
  sendCodexJsonRpcResult(session.process, requestId, buildInputResponse(response));
  setSessionThreadAttention(session, 'working');
}

export function buildApprovalResponse(
  kind: 'command' | 'file_change' | 'permissions',
  permissions: Record<string, unknown> | undefined,
  decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
): Record<string, unknown> {
  if (kind !== 'permissions') return { decision };
  const acpOptions = Array.isArray(permissions?.options) ? permissions.options : [];
  const acpOption = acpOptions.find((option) => {
    if (typeof option !== 'object' || option === null) return false;
    const optionKind = (option as { kind?: unknown }).kind;
    return decision === 'decline' || decision === 'cancel'
      ? optionKind === 'reject_once' || optionKind === 'reject_always'
      : optionKind === 'allow_once' || optionKind === 'allow_always';
  }) as { optionId?: unknown } | undefined;
  if (typeof acpOption?.optionId === 'string') {
    return { outcome: { outcome: 'selected', optionId: acpOption.optionId } };
  }
  return {
    permissions:
      decision === 'accept' || decision === 'acceptForSession' ? (permissions ?? {}) : {},
    scope: decision === 'acceptForSession' ? 'session' : 'turn',
  };
}

export function buildInputResponse(response: CodexInputResponse): Record<string, unknown> {
  if (response.kind === 'user_input') {
    return {
      answers: Object.fromEntries(
        Object.entries(response.answers).map(([questionId, answers]) => [questionId, { answers }]),
      ),
    };
  }
  return {
    action: response.action,
    content: response.content ?? null,
    _meta: null,
  };
}

// --- Internal helpers ---

export function resolveSessionCwd(
  repoPaths: string[],
  options: ChatStartOptions | undefined,
  userDataPath: string,
): string {
  if (options?.scaffold?.rootPath) return options.scaffold.rootPath;
  if (options?.workspace?.cwd) return options.workspace.cwd;
  if (repoPaths.length > 0) return commonParentDir(repoPaths);
  if (options?.workspace?.workspaceId) {
    const workspaceId = options.workspace.workspaceId;
    if (!/^[a-zA-Z0-9_-]+$/.test(workspaceId)) {
      throw new Error('Invalid workspace ID for chat working directory.');
    }
    const workspaceCwd = path.join(userDataPath, 'workspace-chat', workspaceId);
    mkdirSync(workspaceCwd, { recursive: true });
    return workspaceCwd;
  }
  return process.cwd();
}

function handleServerMessage(session: ManagedSession, line: string): void {
  handleCodexServerLine(session, line, {
    onThreadReady: () => {
      session.resolveThreadReady?.();
      session.resolveThreadReady = null;
      session.rejectThreadReady = null;
    },
    onThreadError: (message) => {
      session.rejectThreadReady?.(new Error(message));
      session.resolveThreadReady = null;
      session.rejectThreadReady = null;
    },
    onTurnStarted: () => {
      session.status = 'busy';
    },
    onTurnCompleted: (status) => {
      session.status = 'ready';
      setSessionThreadAttention(
        session,
        status === 'failed' ? 'failed' : status === 'interrupted' ? 'idle' : 'complete',
      );
    },
    onTurnIdChanged: (turnId) => {
      session.turnId = turnId;
    },
    onEvent: (event) => {
      if (event.type === 'approval_request' && event.approvalRequestId !== undefined) {
        const requestKey = buildPendingRequestKey(session.id, event.approvalRequestId);
        const kind = event.approvalKind ?? 'command';
        pendingServerRequests.set(
          requestKey,
          kind === 'permissions'
            ? {
                sessionId: session.id,
                requestId: event.approvalRequestId,
                kind,
                permissions: event.approvalPermissions ?? {},
              }
            : {
                sessionId: session.id,
                requestId: event.approvalRequestId,
                kind,
              },
        );
        if (kind === 'command' || kind === 'file_change') {
          pendingApprovalDetails.set(requestKey, {
            sessionId: session.id,
            requestKey,
            requestId: event.approvalRequestId,
            kind,
            reason: event.approvalReason,
            command: event.approvalCommand,
            cwd: event.approvalCwd,
            grantRoot: event.approvalGrantRoot,
            createdAt: new Date().toISOString(),
          });
        }
        emitCompanionEvent('approvals');
      }
      if (event.type === 'input_request' && event.inputRequestId !== undefined) {
        const kind = event.inputRequest?.kind;
        if (kind === 'user_input' || kind === 'mcp_elicitation') {
          pendingServerRequests.set(buildPendingRequestKey(session.id, event.inputRequestId), {
            sessionId: session.id,
            requestId: event.inputRequestId,
            kind,
          });
        }
      }
      if (event.type === 'approval_request') {
        setSessionThreadAttention(session, 'approval');
      } else if (event.type === 'input_request') {
        setSessionThreadAttention(session, 'input');
      } else if (event.type === 'thread_status') {
        if (event.threadActiveFlags?.includes('waitingOnApproval')) {
          setSessionThreadAttention(session, 'approval');
        } else if (event.threadActiveFlags?.includes('waitingOnUserInput')) {
          setSessionThreadAttention(session, 'input');
        } else if (session.status === 'busy') {
          setSessionThreadAttention(session, 'working');
        }
      } else if (event.type === 'error' || (event.type === 'status' && event.status === 'error')) {
        setSessionThreadAttention(session, 'failed');
      } else if (event.type === 'status' && event.status === 'complete') {
        setSessionThreadAttention(session, 'complete');
      } else if (event.type === 'status' && event.status === 'thinking') {
        setSessionThreadAttention(session, 'working');
      }
      if (event.type === 'status' && event.status === 'complete') {
        session.status = 'ready';
        emitCompanionEvent('sessions');
      } else if (event.type === 'status' && event.status === 'thinking') {
        session.status = 'busy';
        emitCompanionEvent('sessions');
      }
      broadcastEvent(session.id, event);
      notifyForChatEvent(session, event);
    },
    onLog: (message) => {
      console.log(`[Codex:${session.id.slice(0, 8)}] ${message}`);
    },
    onServerRequestResolved: (requestId) => {
      const requestKey = buildPendingRequestKey(session.id, requestId);
      pendingServerRequests.delete(requestKey);
      pendingApprovalDetails.delete(requestKey);
      if (session.status === 'busy') {
        setSessionThreadAttention(session, 'working');
      }
      emitCompanionEvent('approvals');
    },
  });
}

function setSessionThreadAttention(
  session: ManagedSession,
  state: Parameters<typeof updateChatThreadAttention>[1],
): void {
  if (!session.appThreadId) return;
  try {
    updateChatThreadAttention(session.appThreadId, state);
  } catch (error) {
    console.warn(
      `[Codex:${session.id.slice(0, 8)}] Failed to persist thread attention state:`,
      error,
    );
  }
}

function notifyForChatEvent(session: ManagedSession, event: CodexEvent): void {
  if (!session.workspaceId || !session.appThreadId) return;

  let kind: ChatActivityKind | null = null;
  if (event.type === 'approval_request') kind = 'approval';
  else if (event.type === 'input_request') kind = 'input';
  else if (event.type === 'status' && event.status === 'complete') kind = 'complete';

  if (!kind) return;
  notifyChatActivity({
    kind,
    target: {
      workspaceId: session.workspaceId,
      threadId: session.appThreadId,
      personaId: session.personaId,
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

function buildPendingRequestKey(sessionId: string, requestId: JsonRpcRequestId): string {
  return `${sessionId}:${typeof requestId}:${String(requestId)}`;
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
    providerThreadId: session.threadId ?? undefined,
    currentTurnId: session.turnId ?? undefined,
    resumable: !!session.threadId,
  };
}

function waitForThreadReady(threadReady: Promise<void>, sessionId: string): Promise<void> {
  return Promise.race([
    threadReady,
    new Promise<void>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Timed out waiting for Codex thread to start: ${sessionId}`));
      }, 20_000);
    }),
  ]);
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

export function resolvePersonaCodexPolicy(
  mode: CodexMode,
  personaId: string,
  options?: { planMode?: boolean },
): {
  approvalPolicy: 'on-request' | 'never';
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
} {
  const persona = getPersonaById(personaId);
  if (persona?.capabilities.canWriteFiles === false) {
    return { approvalPolicy: 'never', sandbox: 'read-only' };
  }
  if (options?.planMode) {
    return { approvalPolicy: 'on-request', sandbox: 'read-only' };
  }
  return codexModeToPolicy(mode);
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
