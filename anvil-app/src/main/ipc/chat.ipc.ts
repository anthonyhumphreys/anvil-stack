import { ipcMain } from 'electron';
import type {
  AgentProvider,
  AgentUIIntentPresentationPatch,
  AgentUIPlanPatch,
  AgentUIQuestionResolution,
} from '../../shared/agent-ui-intents.js';
import type {
  ChatMessage,
  ChatArtifact,
  ChatArtifactAnnotation,
  ChatArtifactAnnotationInput,
  ChatArtifactAnnotationPatch,
  ChatArtifactFile,
  ChatArtifactInput,
  ChatAttachment,
  ChatAttachmentInput,
  ChatFileMentionSearchInput,
  ChatFileMentionSearchResult,
  ChatGoalSnapshot,
  ChatPlanSnapshot,
  ChatSendOptions,
  ChatStartOptions,
  ChatThread,
  ChatTurnSummary,
  CodexEvent,
  CodexInputResponse,
  CodexSession,
  Persona,
  WorkItemProvider,
} from '../../shared/types.js';
import { getDb } from '../db/database.js';
import {
  startSession,
  sendMessage,
  steerTurn,
  stopSession,
  interruptTurn,
  emitLocalAssistantTurn,
  getSessionStatus,
  stopAllSessions,
  getSessionForRepo,
  listActiveCodexSessions,
  resolveApproval,
  resolveInputRequest,
  dismissAgentUIIntentAndBroadcast,
  patchAgentUIPlanAndNotify,
  resolveAgentUIQuestion,
  restoreAgentUIIntentAndBroadcast,
  updateAgentUIIntentPresentationAndBroadcast,
} from '../services/codex-session.service.js';
import {
  callPreferredLocalModel,
  classifyPromptForLocalModel,
  isLikelyLocalModelRefusal,
} from '../services/local-llm.service.js';
import { getSettings } from '../services/settings.service.js';
import { getPersonas } from '../services/persona.service.js';
import { detectCodexCli, getCodexInstallInstructions } from '../services/codex-bridge.service.js';
import { detectCursorCli } from '../services/cursor-bridge.service.js';
import {
  createChatThread,
  createChatSession,
  deleteChatThread,
  ensureWorkItemChatThread,
  getChatThreadProviderBinding,
  listChatThreads,
  listWorkItemChatThreads,
  saveChatEntry,
  saveChatThreadGoal,
  saveChatThreadPlan,
  setChatThreadProviderThreadId,
  loadChatHistory,
  clearChatHistory,
  updateChatThread,
} from '../services/chat-persistence.service.js';
import {
  prepareChatAttachments,
  selectChatAttachmentFiles,
} from '../services/chat-attachment.service.js';
import { listChatTurnSummaries, saveChatEvent } from '../services/chat-evidence.service.js';
import { searchChatFileMentions } from '../services/chat-file-mention.service.js';
import {
  discardChatArtifact,
  listChatArtifacts,
  readChatArtifactFile,
  upsertChatArtifact,
} from '../services/chat-artifact.service.js';
import {
  createChatArtifactAnnotation,
  deleteChatArtifactAnnotation,
  listChatArtifactAnnotations,
  updateChatArtifactAnnotation,
} from '../services/chat-artifact-annotation.service.js';
import { listAgentUIIntents } from '../services/agent-ui-intent.service.js';

const LOCAL_LLM_CHAT_MAX_PROMPT_CHARS = 8_000;

async function assertChatProviderAvailable(provider: AgentProvider): Promise<void> {
  if (provider === 'cursor') {
    const status = await detectCursorCli();
    if (!status.installed) {
      throw new Error(
        'Cursor CLI is not installed. Install it and run `cursor-agent login` before starting a Cursor chat.',
      );
    }
    return;
  }

  const status = await detectCodexCli();
  if (!status.installed) {
    throw new Error(`Codex CLI is not installed.\n\n${getCodexInstallInstructions()}`);
  }
}

/**
 * When the local-model opt-in is enabled, classify the prompt and —
 * if it is simple enough — answer it locally instead of starting a Codex turn.
 * Returns true when the message was fully handled on-device.
 */
async function tryLocalLlmChatReply(sessionId: string, message: string): Promise<boolean> {
  if (getSettings().localLlmMode !== 'prefer-simple') return false;
  if (message.length > LOCAL_LLM_CHAT_MAX_PROMPT_CHARS) return false;

  const route = await classifyPromptForLocalModel(message);
  if (route !== 'local') return false;

  const result = await callPreferredLocalModel(message);
  const content = result.ok ? (result.content?.trim() ?? '') : '';
  if (!content || isLikelyLocalModelRefusal(content)) {
    console.warn('[Chat] Local model reply unusable; falling back to configured provider');
    return false;
  }

  console.log(`[Chat] Answered via local model (${content.length} chars)`);
  emitLocalAssistantTurn(sessionId, content);
  return true;
}

export function registerChatHandlers(): void {
  ipcMain.handle(
    'chat:start-session',
    async (
      _event,
      repoIds: string[],
      personaId: string,
      options?: ChatStartOptions,
    ): Promise<CodexSession> => {
      const provider = options?.provider ?? getSettings().llmProvider;
      await assertChatProviderAvailable(provider);

      // Get repo paths from DB
      const db = getDb();
      const repoPaths: string[] = [];
      for (const rid of repoIds) {
        const row = db.prepare('SELECT path FROM repos WHERE id = ?').get(rid) as
          | { path: string }
          | undefined;
        if (row) repoPaths.push(row.path);
      }
      if (repoPaths.length === 0 && !options?.scaffold && !options?.workspace) {
        throw new Error('No repos found');
      }

      // Use first repo's path as primary cwd; pass all paths for context
      const storedBinding = getChatThreadProviderBinding(options?.threadId);
      const providerThreadId =
        options?.providerThreadId ??
        (storedBinding?.provider === provider ? storedBinding.providerThreadId : undefined);
      const codexSession = await startSession(repoPaths, repoIds, personaId, {
        ...options,
        providerThreadId: options?.forkFromProviderThreadId
          ? undefined
          : (providerThreadId ?? undefined),
      });

      // Create persistence session — associate with first repo for history
      createChatSession(
        options?.threadId ?? null,
        repoIds[0] ?? null,
        personaId,
        codexSession.id,
        codexSession.providerThreadId ?? null,
        provider,
      );

      return codexSession;
    },
  );

  ipcMain.handle(
    'chat:start-scaffold-session',
    async (
      _event,
      workspaceId: string,
      rootPath: string,
      personaId: string,
      options?: Pick<ChatStartOptions, 'provider'>,
    ): Promise<CodexSession> => {
      const provider = options?.provider ?? getSettings().llmProvider;
      await assertChatProviderAvailable(provider);

      const codexSession = await startSession([rootPath], [], personaId, {
        provider,
        scaffold: { workspaceId, rootPath },
      });

      createChatSession(
        null,
        null,
        personaId,
        codexSession.id,
        codexSession.providerThreadId,
        provider,
      );
      return codexSession;
    },
  );

  ipcMain.handle(
    'chat:send',
    async (
      _event,
      sessionId: string,
      message: string,
      attachments?: ChatAttachment[],
      options?: ChatSendOptions,
    ): Promise<void> => {
      // Parse chat commands before sending
      const parsed = parseChatCommand(message);

      if (parsed.command === 'persona') {
        // Handled by chat:switch-persona instead
        throw new Error('Use the persona dropdown to switch personas');
      }

      if (parsed.command === 'new') {
        // Restart session — the renderer should call start-session again
        stopSession(sessionId);
        return;
      }

      // For plan/fix/review commands, enrich the message with work item context
      let enrichedMessage = message;
      if (parsed.command && parsed.workItemId) {
        // TODO: Fetch real work item from ADO in Phase 4
        enrichedMessage = `[Work Item ${parsed.workItemId}] ${parsed.command}: ${message}`;
      }

      // Plain messages without attachments may be answerable on-device.
      if (!parsed.command && (!attachments || attachments.length === 0)) {
        const handledLocally = await tryLocalLlmChatReply(sessionId, enrichedMessage);
        if (handledLocally) return;
      }

      await sendMessage(sessionId, enrichedMessage, attachments, options);
    },
  );

  ipcMain.handle('chat:stop-session', (_event, sessionId: string): void => {
    stopSession(sessionId);
  });

  ipcMain.handle('chat:interrupt', (_event, sessionId: string): void => {
    interruptTurn(sessionId);
  });

  ipcMain.handle(
    'chat:steer',
    (_event, sessionId: string, message: string, attachments?: ChatAttachment[]): Promise<void> => {
      return steerTurn(sessionId, message, attachments);
    },
  );

  ipcMain.handle(
    'chat:fork-provider-thread',
    async (_event, sourceThreadId: string, targetThreadId: string): Promise<ChatThread | null> => {
      const sourceBinding = getChatThreadProviderBinding(sourceThreadId);
      if (!sourceBinding) return null;

      const targetThread = updateChatThread(targetThreadId, {});
      if (!targetThread) return null;

      const db = getDb();
      const repoPaths: string[] = [];
      for (const rid of targetThread.repoIds) {
        const row = db.prepare('SELECT path FROM repos WHERE id = ?').get(rid) as
          | { path: string }
          | undefined;
        if (row) repoPaths.push(row.path);
      }

      const codexSession = await startSession(
        repoPaths,
        targetThread.repoIds,
        targetThread.personaId,
        {
          threadId: targetThreadId,
          workspace: targetThread.workspaceId
            ? { workspaceId: targetThread.workspaceId }
            : undefined,
          provider: sourceBinding.provider,
          forkFromProviderThreadId: sourceBinding.providerThreadId,
        },
      );
      createChatSession(
        targetThreadId,
        targetThread.repoIds[0] ?? null,
        targetThread.personaId,
        codexSession.id,
        codexSession.providerThreadId ?? null,
        sourceBinding.provider,
      );
      stopSession(codexSession.id);
      if (codexSession.providerThreadId) {
        setChatThreadProviderThreadId(
          targetThreadId,
          codexSession.providerThreadId,
          sourceBinding.provider,
        );
      }
      return updateChatThread(targetThreadId, {});
    },
  );

  ipcMain.handle(
    'chat:resolve-approval',
    (
      _event,
      sessionId: string,
      requestId: string | number,
      decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
    ): void => {
      resolveApproval(sessionId, requestId, decision);
    },
  );

  ipcMain.handle(
    'chat:resolve-input-request',
    (_event, sessionId: string, requestId: string | number, response: CodexInputResponse): void => {
      resolveInputRequest(sessionId, requestId, response);
    },
  );

  ipcMain.handle('chat:list-agent-ui-intents', (_event, threadId: string, includeInactive = true) =>
    listAgentUIIntents(threadId, { includeInactive }),
  );

  ipcMain.handle(
    'chat:resolve-agent-ui-question',
    (_event, intentId: string, resolution: AgentUIQuestionResolution) =>
      resolveAgentUIQuestion(intentId, resolution),
  );

  ipcMain.handle('chat:patch-agent-ui-plan', (_event, intentId: string, patch: AgentUIPlanPatch) =>
    patchAgentUIPlanAndNotify(intentId, patch),
  );

  ipcMain.handle(
    'chat:update-agent-ui-presentation',
    (_event, intentId: string, patch: AgentUIIntentPresentationPatch) =>
      updateAgentUIIntentPresentationAndBroadcast(intentId, patch),
  );

  ipcMain.handle('chat:dismiss-agent-ui-intent', (_event, intentId: string) =>
    dismissAgentUIIntentAndBroadcast(intentId),
  );

  ipcMain.handle('chat:restore-agent-ui-intent', (_event, intentId: string) =>
    restoreAgentUIIntentAndBroadcast(intentId),
  );

  ipcMain.handle(
    'chat:switch-persona',
    async (_event, repoId: string, personaId: string): Promise<CodexSession> => {
      // Kill existing session for this repo
      const existing = getSessionForRepo(repoId);
      if (existing) {
        stopSession(existing.id);
      }

      // Get repo path
      const db = getDb();
      const repoRow = db.prepare('SELECT path FROM repos WHERE id = ?').get(repoId) as
        | { path: string }
        | undefined;
      if (!repoRow) throw new Error(`Repo not found: ${repoId}`);

      return startSession([repoRow.path], [repoId], personaId);
    },
  );

  ipcMain.handle('chat:get-personas', (): Persona[] => {
    return getPersonas();
  });

  ipcMain.handle('chat:list-threads', (_event, workspaceId: string | null): ChatThread[] => {
    return listChatThreads(workspaceId);
  });

  ipcMain.handle(
    'chat:list-work-item-threads',
    (_event, workspaceId: string | null): ChatThread[] => {
      return listWorkItemChatThreads(workspaceId);
    },
  );

  ipcMain.handle(
    'chat:create-thread',
    (
      _event,
      input: {
        workspaceId?: string | null;
        personaId: string;
        title?: string;
        workItemId?: string;
        workItemProvider?: WorkItemProvider;
        workItemTitle?: string;
        repoIds?: string[];
        activeRepoId?: string | null;
        settled?: boolean;
        viewed?: boolean;
      },
    ): ChatThread => {
      return createChatThread(input);
    },
  );

  ipcMain.handle(
    'chat:ensure-work-item-thread',
    (
      _event,
      input: {
        workspaceId?: string | null;
        personaId: string;
        workItemId: string;
        workItemProvider: WorkItemProvider;
        workItemTitle: string;
        repoIds?: string[];
        activeRepoId?: string | null;
      },
    ): ChatThread => {
      return ensureWorkItemChatThread(input);
    },
  );

  ipcMain.handle(
    'chat:update-thread',
    (
      _event,
      threadId: string,
      updates: {
        title?: string;
        personaId?: string;
        workItemTitle?: string;
        repoIds?: string[];
        activeRepoId?: string | null;
      },
    ): ChatThread | null => {
      return updateChatThread(threadId, updates);
    },
  );

  ipcMain.handle('chat:delete-thread', (_event, threadId: string): void => {
    deleteChatThread(threadId);
  });

  ipcMain.handle('chat:session-status', (_event, sessionId: string): CodexSession['status'] => {
    return getSessionStatus(sessionId);
  });

  ipcMain.handle('chat:list-active-sessions', (): CodexSession[] => {
    return listActiveCodexSessions();
  });

  ipcMain.handle('chat:list-turn-summaries', (_event, threadId: string): ChatTurnSummary[] => {
    return listChatTurnSummaries(threadId);
  });

  ipcMain.handle('chat:list-artifacts', (_event, threadId: string): ChatArtifact[] => {
    return listChatArtifacts(threadId);
  });

  ipcMain.handle('chat:upsert-artifact', (_event, input: ChatArtifactInput): ChatArtifact => {
    return upsertChatArtifact(input);
  });

  ipcMain.handle('chat:discard-artifact', (_event, id: string): boolean => {
    return discardChatArtifact(id);
  });

  ipcMain.handle('chat:read-artifact-file', (_event, id: string): ChatArtifactFile => {
    return readChatArtifactFile(id);
  });

  ipcMain.handle(
    'chat:list-artifact-annotations',
    (_event, artifactId: string): ChatArtifactAnnotation[] =>
      listChatArtifactAnnotations(artifactId),
  );

  ipcMain.handle(
    'chat:create-artifact-annotation',
    (_event, input: ChatArtifactAnnotationInput): ChatArtifactAnnotation =>
      createChatArtifactAnnotation(input),
  );

  ipcMain.handle(
    'chat:update-artifact-annotation',
    (_event, id: string, patch: ChatArtifactAnnotationPatch): ChatArtifactAnnotation =>
      updateChatArtifactAnnotation(id, patch),
  );

  ipcMain.handle('chat:delete-artifact-annotation', (_event, id: string): boolean =>
    deleteChatArtifactAnnotation(id),
  );

  ipcMain.handle('chat:detect-codex', async () => {
    return detectCodexCli();
  });

  ipcMain.handle(
    'chat:prepare-attachments',
    (_event, inputs: ChatAttachmentInput[]): ChatAttachment[] => {
      return prepareChatAttachments(inputs);
    },
  );

  ipcMain.handle('chat:select-attachments', async (): Promise<ChatAttachment[]> => {
    return selectChatAttachmentFiles();
  });

  ipcMain.handle(
    'chat:search-file-mentions',
    (_event, input: ChatFileMentionSearchInput): Promise<ChatFileMentionSearchResult[]> => {
      return searchChatFileMentions(input);
    },
  );

  ipcMain.handle(
    'chat:save-entry',
    (
      _event,
      threadId: string,
      repoId: string | null,
      sessionId: string | null,
      entry: ChatMessage,
    ): void => {
      saveChatEntry(threadId, repoId, sessionId, entry);
    },
  );

  ipcMain.handle(
    'chat:save-event',
    (
      _event,
      threadId: string,
      repoId: string | null,
      sessionId: string | null,
      event: CodexEvent,
      timestamp: string,
    ): void => {
      saveChatEvent(threadId, repoId, sessionId, event, timestamp);
    },
  );

  ipcMain.handle('chat:load-history', (_event, threadId: string): ChatMessage[] => {
    return loadChatHistory(threadId);
  });

  ipcMain.handle('chat:clear-history', (_event, threadId: string): void => {
    clearChatHistory(threadId);
  });

  ipcMain.handle(
    'chat:save-thread-plan',
    (_event, threadId: string, plan: ChatPlanSnapshot): ChatThread | null => {
      return saveChatThreadPlan(threadId, plan);
    },
  );

  ipcMain.handle(
    'chat:save-thread-goal',
    (_event, threadId: string, goal: ChatGoalSnapshot | null): ChatThread | null => {
      return saveChatThreadGoal(threadId, goal);
    },
  );
}

/** Clean up on app quit */
export function cleanupChatSessions(): void {
  stopAllSessions();
}

// --- Chat command parsing ---

interface ParsedCommand {
  command: 'plan' | 'fix' | 'review' | 'persona' | 'switch' | 'new' | null;
  workItemId?: string;
  argument?: string;
}

function parseChatCommand(message: string): ParsedCommand {
  const trimmed = message.trim();

  // /new — restart session
  if (trimmed === '/new') {
    return { command: 'new' };
  }

  // /persona <name>
  const personaMatch = trimmed.match(/^\/persona\s+(\S+)/i);
  if (personaMatch) {
    return { command: 'persona', argument: personaMatch[1] };
  }

  // /switch <repo>
  const switchMatch = trimmed.match(/^\/switch\s+(\S+)/i);
  if (switchMatch) {
    return { command: 'switch', argument: switchMatch[1] };
  }

  // /plan ADO-XXXX
  const planMatch = trimmed.match(/^\/?plan\s+(ADO-\d+)/i);
  if (planMatch) {
    return { command: 'plan', workItemId: planMatch[1] };
  }

  // /fix ADO-XXXX
  const fixMatch = trimmed.match(/^\/?fix\s+(ADO-\d+)/i);
  if (fixMatch) {
    return { command: 'fix', workItemId: fixMatch[1] };
  }

  // /review ADO-XXXX
  const reviewMatch = trimmed.match(/^\/?review\s+(ADO-\d+)/i);
  if (reviewMatch) {
    return { command: 'review', workItemId: reviewMatch[1] };
  }

  return { command: null };
}
