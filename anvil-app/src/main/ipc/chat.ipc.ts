import { ipcMain } from 'electron';
import type {
  ChatMessage,
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
  getSessionStatus,
  stopAllSessions,
  getSessionForRepo,
  listActiveCodexSessions,
  resolveApproval,
} from '../services/codex-session.service.js';
import { getPersonas } from '../services/persona.service.js';
import { detectCodexCli, getCodexInstallInstructions } from '../services/codex-bridge.service.js';
import {
  createChatThread,
  createChatSession,
  deleteChatThread,
  ensureWorkItemChatThread,
  getChatThreadProviderThreadId,
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

export function registerChatHandlers(): void {
  ipcMain.handle(
    'chat:start-session',
    async (
      _event,
      repoIds: string[],
      personaId: string,
      options?: ChatStartOptions,
    ): Promise<CodexSession> => {
      // Verify codex is installed
      const status = await detectCodexCli();
      if (!status.installed) {
        throw new Error(`Codex CLI is not installed.\n\n${getCodexInstallInstructions()}`);
      }

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
      const providerThreadId =
        options?.providerThreadId ?? getChatThreadProviderThreadId(options?.threadId);
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
    ): Promise<CodexSession> => {
      const status = await detectCodexCli();
      if (!status.installed) {
        throw new Error(`Codex CLI is not installed.\n\n${getCodexInstallInstructions()}`);
      }

      const codexSession = await startSession([rootPath], [], personaId, {
        scaffold: { workspaceId, rootPath },
      });

      createChatSession(null, null, personaId, codexSession.id, codexSession.providerThreadId);
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
      const sourceProviderThreadId = getChatThreadProviderThreadId(sourceThreadId);
      if (!sourceProviderThreadId) return null;

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
          forkFromProviderThreadId: sourceProviderThreadId,
        },
      );
      createChatSession(
        targetThreadId,
        targetThread.repoIds[0] ?? null,
        targetThread.personaId,
        codexSession.id,
        codexSession.providerThreadId ?? null,
      );
      stopSession(codexSession.id);
      if (codexSession.providerThreadId) {
        setChatThreadProviderThreadId(targetThreadId, codexSession.providerThreadId);
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

  ipcMain.handle(
    'chat:list-threads',
    (_event, workspaceId: string | null, personaId: string): ChatThread[] => {
      return listChatThreads(workspaceId, personaId);
    },
  );

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
