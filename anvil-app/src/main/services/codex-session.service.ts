import { listDojoPrices, recordDojoExecutionEvent } from './dojo-analytics.service.js';
import { spawn, type ChildProcess } from 'node:child_process';

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  syncGatewayCodexIntegrations,
  writeGatewayCodexCatalog,
} from './llm-gateway-runtime.service.js';
import { app, BrowserWindow } from 'electron';
import type {
  AgentUIPlanPatch,
  AgentUIQuestionIntent,
  AgentUIQuestionResolution,
} from '../../shared/agent-ui-intents.js';
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
  sendCodexJsonRpcResult,
} from './codex-protocol.service.js';
import { emitCompanionEvent } from './companion-events.service.js';
import { normaliseCodexModel, normaliseReasoningEffort } from '../../shared/codex-models.js';
import { providerSpawnEnv } from './agent-spawn-env.js';
import { assertSessionTurnAllowed } from './mesh-ownership.service.js';
import { notifyChatActivity, type ChatActivityKind } from './notification.service.js';
import { getLlmGatewayCodexConfigArgs } from '../../shared/llm-gateway.js';
import { applyLlmGatewayEnvironment } from './llm-gateway.service.js';
import { resolveLlmGatewayModelConfig } from './llm-gateway.service.js';
import { resolveCodexRuntime } from './codex-runtime.service.js';
import { updateChatThreadAttention } from './chat-persistence.service.js';
import {
  dismissAgentUIIntent,
  expireAgentUIIntentsForSession,
  expireAgentUIIntentForRequest,
  getAgentUIIntent,
  getAgentUIIntentRecord,
  patchAgentUIPlan,
  recordAgentUIQuestionResolution,
  updateAgentUIIntentPresentation,
  restoreAgentUIIntent,
  upsertAgentUIIntent,
  validateAgentUIQuestionResolution,
} from './agent-ui-intent.service.js';
import {
  adaptProviderEventToAgentUIIntent,
  providerResponseFromAgentUIResolution,
} from './codex-agent-ui.adapter.js';
import { isAcpAgentProvider, type AcpAgentProvider } from '../../shared/agent-providers.js';

const ACP_PROVIDER_LABELS: Record<AcpAgentProvider, string> = {
  cursor: 'Cursor',
  devin: 'Devin',
};

const ACP_AUTH_METHODS: Record<AcpAgentProvider, string> = {
  cursor: 'cursor_login',
  devin: 'devin-browser',
};

interface ManagedSession {
  id: string;
  repoId?: string;
  workspaceId?: string;
  appThreadId?: string;
  kind: 'repo' | 'workspace' | 'scaffold';
  personaId: string;
  mode: CodexMode;
  process: ChildProcess;
  provider: 'codex' | AcpAgentProvider;
  agentProvider: AgentProvider;
  gatewayModels?: import('../../shared/types.js').LlmGatewayModel[];
  model?: string;
  systemPrompt?: string;
  /** Display name passed to the protocol layer for ACP event labels. */
  agentLabel?: string;
  /** True once the persona prompt has been delivered to an ACP session. */
  acpSystemPromptDelivered?: boolean;
  /** True after one handshake auth retry so we never loop on auth failures. */
  acpAuthRetried?: boolean;
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

export interface CodexTurnSteerParams extends Record<string, unknown> {
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
      kind: 'user_input' | 'mcp_elicitation' | 'cursor_ask_question' | 'cursor_create_plan';
    };

const pendingServerRequests = new Map<string, PendingServerRequest>();
const pendingApprovalDetails = new Map<string, MobileApprovalRequest>();
const pendingPlanFeedback = new Map<string, string[]>();

export function resolveSessionModel(provider: AgentProvider, configuredModel: string): string {
  if (isAcpAgentProvider(provider)) return configuredModel.trim() || 'auto';
  if (provider === 'llmgateway') return configuredModel.trim();
  return normaliseCodexModel(configuredModel);
}

/** Build a provider-scoped environment without changing the user's Codex state. */
export async function buildCodexProcessEnvironment(
  provider: AgentProvider,
  settings: ReturnType<typeof getSettings>,
): Promise<Record<string, string>> {
  const env: Record<string, string> = providerSpawnEnv();
  if (provider === 'openai' && settings.openaiApiKey) env.OPENAI_API_KEY = settings.openaiApiKey;
  if (provider === 'llmgateway') {
    applyLlmGatewayEnvironment(env, settings.llmGatewayApiKey);
    const gatewayHome = path.join(app.getPath('userData'), 'codex', 'llmgateway');
    await syncGatewayCodexIntegrations(
      gatewayHome,
      process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    );
    delete env.OPENAI_API_KEY;
    delete env.OPENAI_BASE_URL;
    env.CODEX_HOME = gatewayHome;
  }
  return env;
}

/**
 * Map Anvil's sandbox/collaboration modes onto each ACP agent's mode ids.
 * Cursor exposes agent/plan/ask; Devin exposes accept-edits/smart/ask/plan/
 * bypass, where `smart` auto-approves safe operations and `bypass` never asks.
 */
export function resolveAcpSessionMode(
  provider: AcpAgentProvider,
  codexMode: CodexMode,
  collaborationMode?: ChatSendOptions['collaborationMode'],
): string {
  if (provider === 'devin') {
    if (collaborationMode === 'plan') return 'plan';
    switch (codexMode) {
      case 'read-only':
        return 'ask';
      case 'workspace-auto':
        return 'smart';
      case 'full-access':
        return 'bypass';
      default:
        return 'accept-edits';
    }
  }
  if (collaborationMode === 'plan') return 'plan';
  return codexMode === 'read-only' ? 'ask' : 'agent';
}

/**
 * Translate Anvil's stored model value into the provider's configOption value.
 * 'auto' maps to Cursor's `default[]` option; for Devin it means "leave the
 * session default" (Adaptive), so no set_config_option call is made.
 */
export function resolveAcpModelValue(provider: AcpAgentProvider, model: string): string | null {
  const trimmed = model.trim();
  if (!trimmed || trimmed === 'auto') {
    return provider === 'cursor' ? 'default[]' : null;
  }
  return trimmed;
}

function acpProviderLabel(provider: ManagedSession['provider']): string {
  return isAcpAgentProvider(provider) ? ACP_PROVIDER_LABELS[provider] : 'Codex';
}

function acpProcessLabel(provider: ManagedSession['provider']): string {
  if (provider === 'cursor') return 'cursor-agent acp';
  if (provider === 'devin') return 'devin acp';
  return 'codex app-server';
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
  const agentProvider = options?.provider ?? settings.llmProvider;
  const enabledProviders = settings.enabledLlmProviders?.length
    ? settings.enabledLlmProviders
    : [settings.llmProvider];
  if (!enabledProviders.includes(agentProvider)) {
    throw new Error(
      `${agentProvider} is not enabled. Activate it in Settings before starting a chat.`,
    );
  }
  const mode = settings.codexMode ?? 'on-request';
  const configuredModel = resolveSessionModel(agentProvider, settings.openaiModel);
  const gatewayConfig =
    agentProvider === 'llmgateway'
      ? await resolveLlmGatewayModelConfig(configuredModel, settings.reasoningLevel)
      : undefined;
  const model = gatewayConfig?.model ?? configuredModel;
  const codexPolicy = resolvePersonaCodexPolicy(mode, personaId);
  const systemPrompt = options?.scaffold
    ? buildScaffoldSystemPrompt(personaId, options.scaffold.rootPath)
    : personaId === 'design'
      ? buildDesignSystemPrompt(repoIds, options?.designMode ?? 'design', options?.figmaContext)
      : buildSystemPrompt(personaId, repoIds, options?.workspace?.workspaceId);
  const cwd = resolveSessionCwd(repoPaths, options, app.getPath('userData'));

  // Build environment — allowlisted, never a full process.env copy
  // (SESSION-01: ambient tokens must not leak into agent subprocesses).
  const provider: ManagedSession['provider'] = isAcpAgentProvider(agentProvider)
    ? agentProvider
    : 'codex';
  const command =
    provider === 'cursor'
      ? 'cursor-agent'
      : provider === 'devin'
        ? 'devin'
        : agentProvider === 'llmgateway'
          ? await resolveCodexRuntime()
          : 'codex';
  const args = isAcpAgentProvider(provider)
    ? ['acp']
    : agentProvider === 'azure'
      ? ['app-server', '-c', 'model_provider="azure"']
      : agentProvider === 'openai'
        ? ['app-server', '-c', 'model_provider="openai"']
        : agentProvider === 'llmgateway'
          ? getLlmGatewayCodexConfigArgs()
          : ['app-server'];

  // Azure AI Foundry: Codex reads config from ~/.codex/config.toml (set up by user).
  // OpenAI: pass the API key via environment.
  const env = await buildCodexProcessEnvironment(agentProvider, settings);
  if (gatewayConfig)
    args.push(...(await writeGatewayCodexCatalog(env.CODEX_HOME, gatewayConfig.models)));

  let proc: ChildProcess;
  try {
    proc = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw new Error(
      `Failed to spawn ${acpProcessLabel(provider)}: ${err instanceof Error ? err.message : err}`,
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
    agentProvider,
    gatewayModels: gatewayConfig?.models,
    model,
    systemPrompt,
    agentLabel: isAcpAgentProvider(provider) ? ACP_PROVIDER_LABELS[provider] : undefined,
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
    for (const intent of expireAgentUIIntentsForSession(id)) {
      broadcastAgentUIIntent(intent, id);
    }
    if (session.stopping) {
      setSessionThreadAttention(session, 'idle');
      return;
    }
    session.status = 'error';
    session.rejectThreadReady?.(
      new Error(
        `${acpProcessLabel(provider)} exited before the session was ready (code=${code}, signal=${signal})`,
      ),
    );
    session.rejectThreadReady = null;
    setSessionThreadAttention(session, 'failed');
    broadcastEvent(id, {
      type: 'status',
      status: 'error',
      errorMessage: `${acpProcessLabel(provider)} exited (code=${code}, signal=${signal}).`,
    });
  });

  proc.on('error', (err) => {
    console.error(`[Codex:${id.slice(0, 8)}] process error:`, err);
    session.status = 'error';
    session.rejectThreadReady?.(err);
    session.rejectThreadReady = null;
    setSessionThreadAttention(session, 'failed');
    broadcastEvent(id, {
      type: 'error',
      errorMessage: `${acpProviderLabel(provider)} process error: ${err.message}`,
    });
  });

  if (isAcpAgentProvider(provider)) {
    sendCodexJsonRpc(proc, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: buildAcpClientCapabilities(),
      clientInfo: { name: 'anvil', version: app.getVersion() },
    });
    // Cursor requires an explicit authenticate call; Devin reads stored
    // `devin auth login` credentials, so authenticate is only sent after an
    // auth-related failure (see onRequestError) — never eagerly, since
    // devin-browser opens a browser window.
    if (provider === 'cursor') {
      sendCodexJsonRpc(proc, 'authenticate', { methodId: ACP_AUTH_METHODS.cursor });
    }
    sendCodexJsonRpc(proc, 'session/new', {
      cwd,
      mcpServers: [],
      _meta: { systemPrompt },
    });
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
  // SESSION-03: a session whose ownership moved to another device fails
  // closed — the durable relinquish marker outlives restarts.
  assertSessionTurnAllowed(sessionId);
  if (!session.process.stdin?.writable) throw new Error('Session stdin not writable');

  // Wait for thread to be ready before sending
  await session.threadReady;

  const settings = getSettings();
  const configuredModel = resolveSessionModel(
    session.agentProvider,
    options?.model ?? settings.openaiModel,
  );
  const gatewayConfig =
    session.agentProvider === 'llmgateway'
      ? await resolveLlmGatewayModelConfig(
          configuredModel,
          options?.reasoningEffort ?? settings.reasoningLevel,
          session.gatewayModels,
        )
      : undefined;
  const model = gatewayConfig?.model ?? configuredModel;

  session.status = 'busy';
  setSessionThreadAttention(session, 'working');
  broadcastEvent(sessionId, { type: 'status', status: 'thinking' });

  const mode = settings.codexMode ?? session.mode;
  session.model = model;
  const codexPolicy = resolvePersonaCodexPolicy(mode, session.personaId, {
    planMode: options?.collaborationMode === 'plan',
  });
  session.mode = codexPolicy.sandbox === 'read-only' ? 'read-only' : mode;

  if (isAcpAgentProvider(session.provider)) {
    if (!session.threadId) {
      throw new Error(`${acpProviderLabel(session.provider)} ACP session is not ready.`);
    }
    // Mode changes go through the standard `session/set_mode`; model selection
    // uses `session/set_config_option` against the agent's `model` config
    // option. Both agents reject the legacy `session/set_config` method.
    sendCodexJsonRpc(session.process, 'session/set_mode', {
      sessionId: session.threadId,
      modeId: resolveAcpSessionMode(session.provider, mode, options?.collaborationMode),
    });
    const acpModel = resolveAcpModelValue(session.provider, model);
    if (acpModel) {
      sendCodexJsonRpc(session.process, 'session/set_config_option', {
        sessionId: session.threadId,
        configId: 'model',
        value: acpModel,
      });
    }
    sendCodexJsonRpc(session.process, 'session/prompt', {
      sessionId: session.threadId,
      prompt: buildAcpPrompt(session.provider, session, message, attachments),
    });
    session.acpSystemPromptDelivered = true;
    return;
  }

  const effort = gatewayConfig
    ? gatewayConfig.effort
    : normaliseReasoningEffort(options?.reasoningEffort ?? settings.reasoningLevel);
  sendCodexJsonRpc(session.process, 'turn/start', {
    threadId: session.threadId,
    input: buildUserInput(message, attachments),
    approvalPolicy: codexPolicy.approvalPolicy,
    sandboxPolicy: sandboxModeToTurnPolicy(codexPolicy.sandbox, session.cwd),
    model,
    ...(options?.serviceTier !== undefined ? { serviceTier: options.serviceTier } : {}),
    ...(effort ? { effort } : {}),
    collaborationMode: buildCodexCollaborationMode(options?.collaborationMode, model, effort),
  });
}

export function buildCodexCollaborationMode(
  mode: ChatSendOptions['collaborationMode'],
  model: string,
  effort: ReturnType<typeof normaliseReasoningEffort> | undefined,
) {
  return {
    // Send default explicitly so switching back from Plan also resets the provider.
    mode: mode ?? 'default',
    settings: {
      model,
      reasoning_effort: effort ?? null,
      developer_instructions: null,
    },
  };
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

function buildAcpPrompt(
  provider: AcpAgentProvider,
  session: ManagedSession,
  message: string,
  attachments: ChatAttachment[],
): Array<Record<string, unknown>> {
  return buildUserInput(
    message,
    attachments,
    provider,
    session.acpSystemPromptDelivered ? undefined : session.systemPrompt,
  ).map((item) => {
    if (item.type === 'text') return { type: 'text', text: item.text };
    if (item.type === 'localImage') return { type: 'resource_link', uri: `file://${item.path}` };
    return { type: 'resource_link', uri: `file://${item.path}`, name: item.name };
  });
}

function buildUserInput(
  message: string,
  attachments: ChatAttachment[],
  provider?: ManagedSession['provider'],
  systemPrompt?: string,
): CodexUserInput[] {
  const text =
    provider && isAcpAgentProvider(provider) && systemPrompt?.trim()
      ? `[System instructions]\n${systemPrompt.trim()}\n\n${message}`
      : message;
  const input: CodexUserInput[] = [{ type: 'text', text, text_elements: [] }];

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
  broadcastEvent(sessionId, { type: 'turn_outcome', turnOutcome: 'completed', model: 'on-device' });
  broadcastEvent(sessionId, { type: 'status', status: 'complete' });
  emitCompanionEvent('sessions');
}

export function interruptTurn(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (!session.threadId) return;
  broadcastEvent(sessionId, { type: 'turn_outcome', turnOutcome: 'interrupted' });
  if (isAcpAgentProvider(session.provider)) {
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
  pendingPlanFeedback.delete(sessionId);
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
  optionId?: string,
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
    optionId,
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

export function resolveAgentUIQuestion(
  intentId: string,
  resolution: AgentUIQuestionResolution,
): AgentUIQuestionIntent {
  const record = getAgentUIIntentRecord(intentId);
  if (!record || record.intent.kind !== 'question') {
    throw new Error(`Question intent not found: ${intentId}`);
  }
  validateAgentUIQuestionResolution(record.intent, resolution);
  const binding = record.binding;
  if (!binding?.sessionId || binding.requestId === undefined || !binding.responseKind) {
    throw new Error('Question is no longer connected to an active provider request.');
  }
  const session = sessions.get(binding.sessionId);
  if (!session) throw new Error('The provider session is no longer active.');
  const requestKey = buildPendingRequestKey(binding.sessionId, binding.requestId);
  const pending = pendingServerRequests.get(requestKey);
  if (!pending || pending.kind !== binding.responseKind) {
    const current = getAgentUIIntent(intentId);
    if (current?.kind === 'question' && current.lifecycle === 'resolved') return current;
    throw new Error('Question is no longer awaiting an answer.');
  }

  const response = providerResponseFromAgentUIResolution(
    record.intent,
    resolution,
    binding.responseKind,
  );
  sendCodexJsonRpcResult(session.process, binding.requestId, buildInputResponse(response));
  pendingServerRequests.delete(requestKey);
  const resolved = recordAgentUIQuestionResolution(record.intent, resolution);
  setSessionThreadAttention(session, 'working');
  broadcastEvent(session.id, { type: 'agent_ui_intent_resolved', agentUIIntentId: intentId });
  return resolved;
}

export async function patchAgentUIPlanAndNotify(
  intentId: string,
  patch: AgentUIPlanPatch,
): Promise<ReturnType<typeof patchAgentUIPlan>> {
  const updated = patchAgentUIPlan(intentId, patch);
  const record = getAgentUIIntentRecord(intentId);
  const session = record?.binding?.sessionId ? sessions.get(record.binding.sessionId) : undefined;
  if (session) {
    const payload = JSON.stringify({
      type: 'anvil.agent_ui.plan_patch',
      protocolVersion: updated.protocolVersion,
      intentId,
      patch,
      plan: updated.payload,
    });
    const delivery = resolvePlanFeedbackDelivery(session.provider, session.status, session.turnId);
    if (delivery === 'steer') {
      await steerTurn(session.id, payload);
    } else if (delivery === 'prompt') {
      await sendMessage(session.id, payload);
    } else if (delivery === 'queue') {
      const queued = pendingPlanFeedback.get(session.id) ?? [];
      queued.push(payload);
      pendingPlanFeedback.set(session.id, queued);
    }
  }
  broadcastAgentUIIntent(updated, record?.binding?.sessionId);
  return updated;
}

export function updateAgentUIIntentPresentationAndBroadcast(
  intentId: string,
  patch: Parameters<typeof updateAgentUIIntentPresentation>[1],
) {
  const updated = updateAgentUIIntentPresentation(intentId, patch);
  const record = getAgentUIIntentRecord(intentId);
  broadcastAgentUIIntent(updated, record?.binding?.sessionId);
  return updated;
}

export function dismissAgentUIIntentAndBroadcast(intentId: string) {
  const dismissed = dismissAgentUIIntent(intentId);
  const record = getAgentUIIntentRecord(intentId);
  broadcastAgentUIIntent(dismissed, record?.binding?.sessionId);
  return dismissed;
}

export function restoreAgentUIIntentAndBroadcast(intentId: string) {
  const restored = restoreAgentUIIntent(intentId);
  const record = getAgentUIIntentRecord(intentId);
  broadcastAgentUIIntent(restored, record?.binding?.sessionId);
  return restored;
}

export function buildApprovalResponse(
  kind: 'command' | 'file_change' | 'permissions',
  permissions: Record<string, unknown> | undefined,
  decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
  optionId?: string,
): Record<string, unknown> {
  if (kind !== 'permissions') return { decision };
  const acpOptions = Array.isArray(permissions?.options) ? permissions.options : [];
  if (decision === 'cancel' && acpOptions.length > 0) {
    return { outcome: { outcome: 'cancelled' } };
  }
  const explicitlySelectedOption =
    typeof optionId === 'string'
      ? acpOptions.find(
          (option) =>
            typeof option === 'object' &&
            option !== null &&
            (option as { optionId?: unknown }).optionId === optionId,
        )
      : undefined;
  const optionKinds =
    decision === 'decline'
      ? ['reject_once', 'reject_always']
      : decision === 'acceptForSession'
        ? ['allow_always', 'allow_once']
        : ['allow_once', 'allow_always'];
  const acpOption =
    explicitlySelectedOption ??
    optionKinds
      .map((kind) =>
        acpOptions.find(
          (option) =>
            typeof option === 'object' &&
            option !== null &&
            (option as { kind?: unknown }).kind === kind,
        ),
      )
      .find(
        (option): option is { optionId?: unknown } => typeof option === 'object' && option !== null,
      );
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
  if (response.kind === 'cursor_ask_question') {
    return {
      outcome:
        response.action === 'submit'
          ? { outcome: 'answered', answers: response.answers }
          : response.action === 'skip'
            ? { outcome: 'skipped' }
            : { outcome: 'cancelled' },
    };
  }
  if (response.kind === 'cursor_create_plan') {
    return {
      outcome:
        response.action === 'submit'
          ? { outcome: 'accepted' }
          : response.action === 'skip'
            ? { outcome: 'rejected' }
            : { outcome: 'cancelled' },
    };
  }
  return {
    action: response.action,
    content: response.content ?? null,
    _meta: null,
  };
}

export function buildAcpClientCapabilities(): Record<string, unknown> {
  return {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
    elicitation: { form: {} },
    _meta: { parameterizedModelPicker: true },
  };
}

export function resolvePlanFeedbackDelivery(
  provider: ManagedSession['provider'],
  status: ManagedSession['status'],
  turnId: string | null,
): 'steer' | 'prompt' | 'queue' | 'none' {
  if (status === 'ready') return 'prompt';
  if (status !== 'busy') return 'none';
  // ACP has no mid-turn steer; queue plan feedback for the next prompt.
  if (isAcpAgentProvider(provider)) return 'queue';
  return turnId ? 'steer' : 'none';
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
      void flushPendingPlanFeedback(session);
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
        if (
          kind === 'user_input' ||
          kind === 'mcp_elicitation' ||
          kind === 'cursor_ask_question' ||
          kind === 'cursor_create_plan'
        ) {
          pendingServerRequests.set(buildPendingRequestKey(session.id, event.inputRequestId), {
            sessionId: session.id,
            requestId: event.inputRequestId,
            kind,
          });
        }
      }
      let deliveredEvent = event;
      if (session.appThreadId) {
        const currentPlan = getAgentUIIntent(`plan:${session.appThreadId}`);
        const adapted = adaptProviderEventToAgentUIIntent(
          event,
          {
            appThreadId: session.appThreadId,
            workspaceId: session.workspaceId,
            providerThreadId: session.threadId ?? undefined,
            sessionId: session.id,
            provider: session.provider,
          },
          currentPlan?.kind === 'plan' ? currentPlan : null,
        );
        if (adapted) {
          const intent = upsertAgentUIIntent(adapted);
          deliveredEvent = { type: 'agent_ui_intent', agentUIIntent: intent };
        }
      }
      if (event.type === 'approval_request') {
        setSessionThreadAttention(session, 'approval');
      } else if (
        deliveredEvent.type === 'agent_ui_intent' &&
        deliveredEvent.agentUIIntent?.kind === 'question'
      ) {
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
      broadcastEvent(session.id, deliveredEvent);
      notifyForChatEvent(session, deliveredEvent);
    },
    onLog: (message) => {
      console.log(`[Codex:${session.id.slice(0, 8)}] ${message}`);
    },
    onRequestError: (error) => {
      // Devin only needs `authenticate` when stored credentials are missing or
      // expired. Retry the handshake once via devin-browser, which opens a
      // browser sign-in — triggered by failure, never eagerly.
      if (
        session.provider === 'devin' &&
        !session.threadId &&
        !session.acpAuthRetried &&
        isAcpAuthError(error.message)
      ) {
        session.acpAuthRetried = true;
        sendCodexJsonRpc(session.process, 'authenticate', {
          methodId: ACP_AUTH_METHODS.devin,
        });
        sendCodexJsonRpc(session.process, 'session/new', {
          cwd: session.cwd,
          mcpServers: [],
          _meta: { systemPrompt: session.systemPrompt },
        });
        return true;
      }
      return false;
    },
    onServerRequestResolved: (requestId) => {
      const requestKey = buildPendingRequestKey(session.id, requestId);
      pendingServerRequests.delete(requestKey);
      pendingApprovalDetails.delete(requestKey);
      const expiredIntent = expireAgentUIIntentForRequest(session.id, requestId);
      if (expiredIntent) broadcastAgentUIIntent(expiredIntent, session.id);
      if (session.status === 'busy') {
        setSessionThreadAttention(session, 'working');
      }
      emitCompanionEvent('approvals');
    },
  });
}

async function flushPendingPlanFeedback(session: ManagedSession): Promise<void> {
  const queued = pendingPlanFeedback.get(session.id);
  if (!queued?.length || session.status !== 'ready') return;
  pendingPlanFeedback.delete(session.id);
  try {
    await sendMessage(session.id, queued.join('\n'));
  } catch (error) {
    pendingPlanFeedback.set(session.id, [
      ...queued,
      ...(pendingPlanFeedback.get(session.id) ?? []),
    ]);
    console.warn(
      `[Codex:${session.id.slice(0, 8)}] Failed to deliver queued plan feedback:`,
      error,
    );
  }
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
  else if (event.type === 'agent_ui_intent' && event.agentUIIntent?.kind === 'question')
    kind = 'input';
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
  if (
    session?.appThreadId &&
    ['usage', 'usage_context', 'turn_outcome', 'context_compaction', 'status'].includes(event.type)
  ) {
    try {
      const model = event.model ?? session.model;
      const usagePrice =
        event.type === 'usage'
          ? listDojoPrices().find(
              (price) => price.provider === session.agentProvider && price.model === model,
            )
          : undefined;
      recordDojoExecutionEvent(
        sessionId,
        { ...event, model, usagePrice },
        new Date().toISOString(),
      );
    } catch (error) {
      console.error('[Dojo] Could not persist execution telemetry:', error);
    }
  }
  if (['usage', 'usage_context', 'turn_outcome', 'context_compaction'].includes(event.type)) return;
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('chat:event', {
      sessionId,
      appThreadId: session?.appThreadId,
      ...event,
    });
  }
}

function broadcastAgentUIIntent(
  intent: NonNullable<CodexEvent['agentUIIntent']>,
  sessionId?: string,
): void {
  if (sessionId && sessions.has(sessionId)) {
    broadcastEvent(sessionId, { type: 'agent_ui_intent', agentUIIntent: intent });
    return;
  }
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('chat:event', {
      appThreadId: intent.scope.threadId,
      type: 'agent_ui_intent',
      agentUIIntent: intent,
    });
  }
}

function buildPendingRequestKey(sessionId: string, requestId: JsonRpcRequestId): string {
  return `${sessionId}:${typeof requestId}:${String(requestId)}`;
}

function isAcpAuthError(message: string): boolean {
  return /auth|login|sign.?in|credential|unauthorized|401|forbidden|403/i.test(message);
}

function sessionToPublic(session: ManagedSession): CodexSession {
  return {
    id: session.id,
    repoId: session.repoId,
    workspaceId: session.workspaceId,
    appThreadId: session.appThreadId,
    kind: session.kind,
    personaId: session.personaId,
    provider: session.agentProvider,
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
