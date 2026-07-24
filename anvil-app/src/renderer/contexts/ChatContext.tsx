import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  ChatAttachment,
  ChatArtifact,
  ChatArtifactInput,
  ChatArtifactKind,
  ChatAssistantPhase,
  ChatCollaborationMode,
  ChatStartOptions,
  ChatGoalSnapshot,
  ChatLayout,
  ChatMessage,
  ChatPlanSnapshot,
  ChatThread,
  CodexEvent,
  CodexSession,
  DbInsightAnalysis,
  DbInsightArtifact,
  GovernanceDocument,
  Persona,
  ReasoningEffort,
  RepoInfo,
  WorkItem,
  WorkspaceScaffoldStatus,
} from '../../shared/types';
import {
  CODEX_REASONING_EFFORTS,
  DEFAULT_CODEX_MODEL,
  getCodexModelReasoningOptions,
  resolveCodexReasoningEffort,
} from '../../shared/codex-models';
import { useWorkspace } from './WorkspaceContext';
import { loadDesignModePreference } from '../utils/design-mode';
import { extractFigmaRefs, formatFigmaRefsForPrompt } from '../utils/figma-url';
import {
  CODEX_SELECTION_CHANGED_EVENT,
  type CodexSelectionChangedDetail,
} from '../utils/codex-selection';

export type ChatEntry =
  | { kind: 'user'; content: string; attachments?: ChatAttachment[]; id?: string }
  | {
      kind: 'assistant';
      content: string;
      id?: string;
      itemId?: string;
      phase?: ChatAssistantPhase;
    }
  | { kind: 'thinking'; content: string; id?: string }
  | { kind: 'event'; event: CodexEvent };

interface ChatContextValue {
  personas: Persona[];
  activePersona: Persona | null;
  session: CodexSession | null;
  entries: ChatEntry[];
  repos: RepoInfo[];
  activeRepo: RepoInfo | null;
  activeRepos: RepoInfo[];
  governanceDocs: GovernanceDocument[];
  selectedGovernanceDocs: GovernanceDocument[];
  scaffoldModeActive: boolean;
  scaffoldStatus: WorkspaceScaffoldStatus | null;
  busy: boolean;
  error: string | null;
  reasoningLevel: ReasoningEffort;
  reasoningOptions: ReasoningEffort[];
  threads: ChatThread[];
  activeThread: ChatThread | null;
  activeThreadId: string | null;
  liveThreadStatuses: Record<string, CodexSession['status']>;
  collaborationMode: ChatCollaborationMode;
  activePlan: ChatPlanSnapshot | null;
  activeGoal: ChatGoalSnapshot | null;
  activeArtifacts: ChatArtifact[];
  chatLayout: ChatLayout;
  setActiveRepo: (repo: RepoInfo) => void;
  setActiveRepos: (repos: RepoInfo[]) => void;
  setSelectedGovernanceDocs: (docs: GovernanceDocument[]) => void;
  send: (message: string, attachments?: ChatAttachment[], modelContext?: string) => Promise<void>;
  steer: (message: string, attachments?: ChatAttachment[]) => Promise<void>;
  switchPersona: (persona: Persona) => Promise<void>;
  interrupt: () => Promise<void>;
  startNewSession: () => Promise<void>;
  loadHistory: () => Promise<void>;
  clearHistory: () => Promise<void>;
  setReasoningLevel: (level: ReasoningEffort) => void;
  selectThread: (threadId: string) => Promise<void>;
  renameThread: (threadId: string, title: string) => Promise<void>;
  settleThread: (threadId: string, settled: boolean) => Promise<void>;
  deleteThread: (threadId: string) => Promise<void>;
  forkThread: (messageIndex: number) => Promise<void>;
  setCollaborationMode: (mode: ChatCollaborationMode) => void;
  setChatLayout: (layout: ChatLayout) => Promise<void>;
  selectWorkItemThread: (workItem: WorkItem) => Promise<void>;
  launchPreparedChat: (opts: {
    personaId: string;
    repoIds?: string[];
    message: string;
    reasoningLevel?: ReasoningEffort;
    threadTitle?: string;
    workItem?: WorkItem;
  }) => Promise<void>;
}

const ChatContext = createContext<ChatContextValue | null>(null);
const MAX_LIVE_COMMAND_OUTPUT_CHARS = 120_000;
const MAX_LIVE_DIFF_CHARS = 120_000;
const LIVE_STREAM_FLUSH_MS = 80;
const COLLABORATION_MODE_STORAGE_KEY = 'anvil:chat-collaboration-mode';
const CHAT_LAYOUT_CHANGED_EVENT = 'anvil:chat-layout-changed';

type LiveStreamEntryKind = Extract<ChatEntry, { kind: 'assistant' | 'thinking' }>['kind'];

interface LiveAssistantOutput {
  threadId: string;
  segments: LiveAssistantSegment[];
  activeLegacySegmentId?: string;
}

interface LiveAssistantSegment {
  id: string;
  itemId?: string;
  phase?: ChatAssistantPhase;
  content: string;
  persistedContent?: string;
  persistedPhase?: ChatAssistantPhase;
  createdAt: string;
}

export function useChatContext(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChatContext must be used within <ChatProvider>');
  return ctx;
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const { repos, activeWorkspace, activeScaffoldSession, refreshWorkspaces } = useWorkspace();
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [activePersona, setActivePersona] = useState<Persona | null>(null);
  const [session, setSession] = useState<CodexSession | null>(null);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [activeRepoState, setActiveRepoState] = useState<RepoInfo | null>(null);
  const [activeReposState, setActiveReposState] = useState<RepoInfo[]>([]);
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [liveThreadStatuses, setLiveThreadStatuses] = useState<
    Record<string, CodexSession['status']>
  >({});
  const [governanceDocs, setGovernanceDocs] = useState<GovernanceDocument[]>([]);
  const [selectedGovernanceDocs, setSelectedGovernanceDocs] = useState<GovernanceDocument[]>([]);
  const [dbInsightArtifacts, setDbInsightArtifacts] = useState<DbInsightArtifact[]>([]);
  const [dbInsightAnalysis, setDbInsightAnalysis] = useState<DbInsightAnalysis | null>(null);
  const [activeArtifacts, setActiveArtifacts] = useState<ChatArtifact[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasoningLevel, setReasoningLevel] = useState<ReasoningEffort>('medium');
  const [reasoningOptions, setReasoningOptions] =
    useState<ReasoningEffort[]>(CODEX_REASONING_EFFORTS);
  const reasoningLevelRef = useRef<ReasoningEffort>('medium');
  const [collaborationMode, setCollaborationModeState] = useState<ChatCollaborationMode>(() =>
    loadCollaborationMode(),
  );
  const [chatLayout, setChatLayoutState] = useState<ChatLayout>('classic');

  const scaffoldModeActive =
    !!activeScaffoldSession &&
    activeScaffoldSession.status !== 'completed' &&
    activeScaffoldSession.status !== 'cancelled';
  const scaffoldStatus = activeScaffoldSession?.status ?? null;
  const workspaceChatCwd = deriveWorkspaceChatCwd([
    ...selectedGovernanceDocs.map((doc) => doc.filePath),
    ...(activePersona?.id === 'db-expert'
      ? dbInsightArtifacts.map((artifact) => artifact.filePath)
      : []),
  ]);
  const canStartWorkspaceChat = !!activeWorkspace;
  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId) ?? null,
    [threads, activeThreadId],
  );
  const activePlan = activeThread?.activePlan ?? null;
  const activeGoal = activeThread?.activeGoal ?? null;

  const sessionRef = useRef<CodexSession | null>(null);
  sessionRef.current = session;
  reasoningLevelRef.current = reasoningLevel;
  const entriesRef = useRef<ChatEntry[]>([]);
  entriesRef.current = entries;
  const threadsRef = useRef<ChatThread[]>([]);
  threadsRef.current = threads;
  const activeThreadRef = useRef<ChatThread | null>(null);
  activeThreadRef.current = activeThread;
  const lastSelectedThreadIdsRef = useRef<Record<string, string>>(loadThreadSelectionPreferences());
  const liveSessionsByThreadIdRef = useRef<Record<string, CodexSession>>({});
  const liveOutputBySessionIdRef = useRef<Record<string, LiveAssistantOutput>>({});
  const livePersistQueueBySessionIdRef = useRef<Record<string, Promise<void>>>({});
  const threadLoadVersionRef = useRef(0);
  const suppressNextThreadBootstrapRef = useRef(false);
  const pendingStreamEntryRef = useRef<{
    kind: LiveStreamEntryKind;
    content: string;
    itemId?: string;
    phase?: ChatAssistantPhase;
  } | null>(null);
  const pendingStreamFlushRef = useRef<number | null>(null);

  const clearPendingStreamFlush = useCallback(() => {
    if (!pendingStreamFlushRef.current) return;
    window.clearTimeout(pendingStreamFlushRef.current);
    pendingStreamFlushRef.current = null;
  }, []);

  const discardPendingStreamEntry = useCallback(() => {
    pendingStreamEntryRef.current = null;
    clearPendingStreamFlush();
  }, [clearPendingStreamFlush]);

  const flushPendingStreamEntry = useCallback(() => {
    const pending = pendingStreamEntryRef.current;
    if (!pending) return;

    pendingStreamEntryRef.current = null;
    clearPendingStreamFlush();
    setEntries((prev) => appendLiveStreamEntry(prev, pending.kind, pending.content, pending));
  }, [clearPendingStreamFlush]);

  const schedulePendingStreamFlush = useCallback(() => {
    if (pendingStreamFlushRef.current) return;
    pendingStreamFlushRef.current = window.setTimeout(() => {
      pendingStreamFlushRef.current = null;
      flushPendingStreamEntry();
    }, LIVE_STREAM_FLUSH_MS);
  }, [flushPendingStreamEntry]);

  const queueStreamEntry = useCallback(
    (
      kind: LiveStreamEntryKind,
      content: string,
      metadata?: { itemId?: string; phase?: ChatAssistantPhase },
    ) => {
      if (!content) return;

      const pending = pendingStreamEntryRef.current;
      if (
        pending?.kind === kind &&
        (kind !== 'assistant' ||
          (pending.itemId === metadata?.itemId && pending.phase === metadata?.phase))
      ) {
        pending.content += content;
      } else {
        flushPendingStreamEntry();
        pendingStreamEntryRef.current = { kind, content, ...metadata };
      }

      schedulePendingStreamFlush();
    },
    [flushPendingStreamEntry, schedulePendingStreamFlush],
  );

  const setCollaborationMode = useCallback((mode: ChatCollaborationMode) => {
    setCollaborationModeState(mode);
    try {
      window.localStorage.setItem(COLLABORATION_MODE_STORAGE_KEY, mode);
    } catch {
      // Storage is a convenience, not a hill worth dying on.
    }
  }, []);

  const applyChatLayout = useCallback((layout: ChatLayout) => {
    setChatLayoutState(layout);
    window.dispatchEvent(new CustomEvent(CHAT_LAYOUT_CHANGED_EVENT, { detail: layout }));
  }, []);

  const setChatLayout = useCallback(
    async (layout: ChatLayout) => {
      applyChatLayout(layout);
      await window.anvil.settings.update({ chatLayout: layout });
    },
    [applyChatLayout],
  );

  useEffect(() => {
    let cancelled = false;
    window.anvil.settings
      .get()
      .then((settings) => {
        if (!cancelled) setChatLayoutState(settings.chatLayout ?? 'classic');
      })
      .catch(console.error);

    const handleLayoutChanged = (event: Event) => {
      const nextLayout = (event as CustomEvent<ChatLayout>).detail;
      if (nextLayout === 'classic' || nextLayout === 'workitems') {
        setChatLayoutState(nextLayout);
      }
    };

    window.addEventListener(CHAT_LAYOUT_CHANGED_EVENT, handleLayoutChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(CHAT_LAYOUT_CHANGED_EVENT, handleLayoutChanged);
    };
  }, []);

  useEffect(() => {
    return () => {
      discardPendingStreamEntry();
    };
  }, [discardPendingStreamEntry]);

  const applyThreadState = useCallback((thread: ChatThread) => {
    setThreads((prev) => upsertThread(prev, thread));
  }, []);

  const setLiveThreadStatus = useCallback(
    (threadId: string, status: CodexSession['status'] | null) => {
      setLiveThreadStatuses((prev) => {
        if (status === null) {
          const next = { ...prev };
          delete next[threadId];
          return next;
        }
        return { ...prev, [threadId]: status };
      });
    },
    [],
  );

  const findThreadIdForSession = useCallback((sessionId: string): string | null => {
    for (const [threadId, liveSession] of Object.entries(liveSessionsByThreadIdRef.current)) {
      if (liveSession.id === sessionId) return threadId;
    }
    return null;
  }, []);

  const getLiveAssistantOutput = useCallback(
    (sessionId: string, threadId: string): LiveAssistantOutput => {
      const existing = liveOutputBySessionIdRef.current[sessionId];
      if (existing) {
        if (existing.threadId !== threadId) {
          return { ...existing, threadId };
        }
        return existing;
      }

      return {
        threadId,
        segments: [],
      };
    },
    [],
  );

  const rememberLiveSession = useCallback(
    (threadId: string, liveSession: CodexSession) => {
      liveSessionsByThreadIdRef.current[threadId] = liveSession;
      liveOutputBySessionIdRef.current[liveSession.id] = getLiveAssistantOutput(
        liveSession.id,
        threadId,
      );
      setLiveThreadStatus(threadId, liveSession.status);
    },
    [getLiveAssistantOutput, setLiveThreadStatus],
  );

  const forgetLiveSession = useCallback(
    (sessionId: string) => {
      for (const [threadId, liveSession] of Object.entries(liveSessionsByThreadIdRef.current)) {
        if (liveSession.id === sessionId) {
          delete liveSessionsByThreadIdRef.current[threadId];
          setLiveThreadStatus(threadId, null);
        }
      }
      delete liveOutputBySessionIdRef.current[sessionId];
      delete livePersistQueueBySessionIdRef.current[sessionId];
    },
    [setLiveThreadStatus],
  );

  const updateThreadContext = useCallback(
    async (threadId: string, selectedRepos: RepoInfo[], primaryRepo: RepoInfo | null) => {
      const updated = await window.anvil.chat.updateThread(threadId, {
        repoIds: selectedRepos.map((repo) => repo.id),
        activeRepoId: primaryRepo?.id ?? selectedRepos[0]?.id ?? null,
      });
      if (updated) {
        applyThreadState(updated);
      }
    },
    [applyThreadState],
  );

  const setActiveRepo = useCallback(
    (repo: RepoInfo) => {
      setActiveRepoState(repo);
      setActiveReposState((prev) =>
        prev.some((candidate) => candidate.id === repo.id) ? prev : [repo, ...prev],
      );
      if (activeThreadRef.current && !scaffoldModeActive) {
        const nextRepos = activeReposState.some((candidate) => candidate.id === repo.id)
          ? activeReposState
          : [repo, ...activeReposState];
        void updateThreadContext(activeThreadRef.current.id, nextRepos, repo);
      }
    },
    [activeReposState, scaffoldModeActive, updateThreadContext],
  );

  const setActiveRepos = useCallback(
    (selectedRepos: RepoInfo[]) => {
      const nextPrimary =
        selectedRepos.find((repo) => repo.id === activeRepoState?.id) ?? selectedRepos[0] ?? null;
      setActiveReposState(selectedRepos);
      setActiveRepoState(nextPrimary);
      if (activeThreadRef.current && !scaffoldModeActive) {
        void updateThreadContext(activeThreadRef.current.id, selectedRepos, nextPrimary);
      }
    },
    [activeRepoState?.id, scaffoldModeActive, updateThreadContext],
  );

  const loadThreadIntoState = useCallback(
    async (threadId: string, availableThreads?: ChatThread[]) => {
      const loadVersion = ++threadLoadVersionRef.current;
      discardPendingStreamEntry();
      const thread = (availableThreads ?? threadsRef.current).find(
        (candidate) => candidate.id === threadId,
      );
      if (!thread || !threadBelongsToWorkspace(thread, activeWorkspace?.id ?? null)) return;

      const [history, artifacts] = await Promise.all([
        window.anvil.chat.loadHistory(threadId),
        window.anvil.chat.listArtifacts(threadId),
      ]);
      if (loadVersion !== threadLoadVersionRef.current) return;

      const resolvedRepos = (thread.repoIds ?? [])
        .map((repoId) => repos.find((repo) => repo.id === repoId))
        .filter((repo): repo is RepoInfo => Boolean(repo));
      const primaryRepo =
        resolvedRepos.find((repo) => repo.id === thread.activeRepoId) ?? resolvedRepos[0] ?? null;

      setActiveThreadId(thread.id);
      const nextEntries = chatMessagesToEntries(history);
      const liveSession = liveSessionsByThreadIdRef.current[thread.id];
      const liveOutput = liveSession ? liveOutputBySessionIdRef.current[liveSession.id] : null;
      for (const segment of liveOutput?.segments ?? []) {
        if (!segment.content.trim()) continue;
        const existingLiveEntryIndex = nextEntries.findIndex(
          (entry) => entry.kind === 'assistant' && entry.id === segment.id,
        );
        const liveEntry: ChatEntry = {
          kind: 'assistant',
          content: segment.content,
          id: segment.id,
          itemId: segment.itemId,
          phase: segment.phase,
        };
        if (existingLiveEntryIndex >= 0) {
          nextEntries[existingLiveEntryIndex] = liveEntry;
        } else {
          nextEntries.push(liveEntry);
        }
      }

      setEntries(nextEntries);
      setActiveArtifacts(artifacts);
      setActiveReposState(resolvedRepos);
      setActiveRepoState(primaryRepo);
      setError(null);

      if (liveSession) {
        const liveStatus = await window.anvil.chat.getSessionStatus(liveSession.id);
        if (loadVersion !== threadLoadVersionRef.current) return;

        if (liveStatus === 'error') {
          delete liveSessionsByThreadIdRef.current[thread.id];
          delete liveOutputBySessionIdRef.current[liveSession.id];
          setLiveThreadStatus(thread.id, null);
          setSession(null);
          setBusy(false);
        } else {
          const restoredSession = { ...liveSession, status: liveStatus };
          liveSessionsByThreadIdRef.current[thread.id] = restoredSession;
          setLiveThreadStatus(thread.id, liveStatus);
          setSession(restoredSession);
          setBusy(liveStatus === 'busy' || liveStatus === 'starting');
        }
      } else {
        setSession(null);
        setBusy(false);
      }

      const threadPreferenceKey = thread.workItemId
        ? getWorkItemThreadPreferenceKey(activeWorkspace?.id ?? null)
        : getThreadPreferenceKey(activeWorkspace?.id ?? null, thread.personaId);
      rememberThreadSelection(lastSelectedThreadIdsRef.current, threadPreferenceKey, thread.id);
    },
    [activeWorkspace?.id, discardPendingStreamEntry, repos, setLiveThreadStatus],
  );

  const createThreadRecord = useCallback(
    async (opts?: {
      persona?: Persona | null;
      title?: string;
      repoSelection?: RepoInfo[];
      primaryRepo?: RepoInfo | null;
    }) => {
      const persona = opts?.persona ?? activePersona;
      if (!persona) return null;

      const repoSelection = opts?.repoSelection ?? activeReposState;
      const primaryRepo = opts?.primaryRepo ?? activeRepoState ?? repoSelection[0] ?? null;
      const created = await window.anvil.chat.createThread({
        workspaceId: activeWorkspace?.id ?? null,
        personaId: persona.id,
        title: opts?.title,
        repoIds: repoSelection.map((repo) => repo.id),
        activeRepoId: primaryRepo?.id ?? null,
      });

      threadLoadVersionRef.current += 1;
      applyThreadState(created);
      setActiveThreadId(created.id);
      setActiveReposState(repoSelection);
      setActiveRepoState(primaryRepo);
      rememberThreadSelection(
        lastSelectedThreadIdsRef.current,
        getThreadPreferenceKey(activeWorkspace?.id ?? null, persona.id),
        created.id,
      );

      return created;
    },
    [activePersona, activeRepoState, activeReposState, activeWorkspace?.id, applyThreadState],
  );

  const renameThread = useCallback(
    async (threadId: string, title: string) => {
      const updated = await window.anvil.chat.updateThread(threadId, { title });
      if (updated) {
        applyThreadState(updated);
      }
    },
    [applyThreadState],
  );

  const bumpThreadSummary = useCallback(
    (threadId: string, content: string, timestamp: string, incrementMessageCount = true) => {
      setThreads((prev) =>
        sortThreads(
          prev.map((thread) =>
            thread.id === threadId
              ? {
                  ...thread,
                  updatedAt: timestamp,
                  lastMessageAt: timestamp,
                  preview: content.trim(),
                  messageCount: incrementMessageCount
                    ? thread.messageCount + 1
                    : thread.messageCount,
                }
              : thread,
          ),
        ),
      );
    },
    [],
  );

  const persistArtifactsForAssistantMessage = useCallback(
    async (threadId: string, repoId: string | null, sourceMessageId: string, content: string) => {
      const settings = await window.anvil.settings.get().catch(() => null);
      const artifactInputs = extractChatArtifactInputs(content, {
        threadId,
        repoId,
        sourceMessageId,
        model: settings?.openaiModel,
        reasoningEffort: reasoningLevelRef.current,
      });
      if (artifactInputs.length === 0) return;

      const saved = await Promise.all(
        artifactInputs.map((artifact) => window.anvil.chat.upsertArtifact(artifact)),
      );

      setActiveArtifacts((prev) => {
        if (activeThreadRef.current?.id !== threadId) return prev;
        return sortArtifactsByUpdatedAt(upsertArtifacts(prev, saved));
      });
    },
    [],
  );

  const persistAssistantForSession = useCallback(
    (sessionId: string, options?: { final?: boolean }) => {
      const liveOutput = liveOutputBySessionIdRef.current[sessionId];
      const currentSession =
        sessionRef.current?.id === sessionId
          ? sessionRef.current
          : Object.values(liveSessionsByThreadIdRef.current).find(
              (candidate) => candidate.id === sessionId,
            );
      const threadId = liveOutput?.threadId ?? currentSession?.appThreadId;
      if (!currentSession || !threadId || !liveOutput || liveOutput.segments.length === 0) return;

      const resolvedSegments = resolveAssistantSegmentPhases(liveOutput.segments, !!options?.final);
      const changedSegments = resolvedSegments.filter((segment) => {
        const content = segment.content.trim();
        return (
          content &&
          (segment.persistedContent !== content || segment.persistedPhase !== segment.phase)
        );
      });
      if (changedSegments.length === 0) return;

      liveOutputBySessionIdRef.current[sessionId] = {
        ...liveOutput,
        segments: resolvedSegments.map((segment) => ({
          ...segment,
          persistedContent: segment.content.trim(),
          persistedPhase: segment.phase,
        })),
      };

      const artifactRepoId =
        currentSession.repoId ??
        threadsRef.current.find((thread) => thread.id === threadId)?.activeRepoId ??
        threadsRef.current.find((thread) => thread.id === threadId)?.repoIds[0] ??
        null;
      const persistTask = (livePersistQueueBySessionIdRef.current[sessionId] ?? Promise.resolve())
        .catch(() => {
          // Keep later snapshots moving even if an earlier write failed.
        })
        .then(async () => {
          for (const segment of changedSegments) {
            const content = segment.content.trim();
            const phase = segment.phase ?? 'progress';
            await window.anvil.chat.saveEntry(
              threadId,
              currentSession.repoId ?? null,
              currentSession.id,
              {
                id: segment.id,
                role: phase === 'final' ? 'assistant' : 'system',
                content,
                timestamp: segment.createdAt,
                personaId: currentSession.personaId,
                threadId,
                event: {
                  type: 'text',
                  text: content,
                  itemId: segment.itemId,
                  assistantPhase: phase,
                },
              },
            );

            if (phase === 'final') {
              await persistArtifactsForAssistantMessage(
                threadId,
                artifactRepoId,
                segment.id,
                content,
              );
              bumpThreadSummary(
                threadId,
                content,
                segment.createdAt,
                segment.persistedPhase !== 'final',
              );
            }
          }
        })
        .catch(console.error);

      livePersistQueueBySessionIdRef.current[sessionId] = persistTask;

      if (
        options?.final &&
        currentSession.kind === 'scaffold' &&
        activeWorkspace?.id &&
        activeScaffoldSession?.status === 'active'
      ) {
        const finalContent =
          [...resolvedSegments]
            .reverse()
            .find((segment) => segment.phase === 'final')
            ?.content.trim() ?? '';
        persistTask
          .then(() =>
            window.anvil.workspaceScaffold.maybeComplete(activeWorkspace.id, finalContent),
          )
          .then((result) => {
            if (result.triggered) {
              void refreshWorkspaces();
            }
          })
          .catch(console.error);
      }
    },
    [
      activeScaffoldSession?.status,
      activeWorkspace?.id,
      bumpThreadSummary,
      persistArtifactsForAssistantMessage,
      refreshWorkspaces,
    ],
  );

  const detachLiveSession = useCallback(() => {
    const currentSession = sessionRef.current;
    if (currentSession) {
      persistAssistantForSession(currentSession.id);
    }
    discardPendingStreamEntry();
    setSession(null);
    setBusy(false);
  }, [discardPendingStreamEntry, persistAssistantForSession]);

  const stopThreadLiveSession = useCallback(
    async (threadId: string) => {
      const liveSession = liveSessionsByThreadIdRef.current[threadId];
      if (!liveSession) return;
      discardPendingStreamEntry();
      forgetLiveSession(liveSession.id);
      await window.anvil.chat.stopSession(liveSession.id).catch(console.error);
      if (sessionRef.current?.id === liveSession.id) {
        setSession(null);
        setBusy(false);
      }
    },
    [discardPendingStreamEntry, forgetLiveSession],
  );

  useEffect(() => {
    window.anvil.chat.getPersonas().then((loadedPersonas) => {
      setPersonas(loadedPersonas);
      if (loadedPersonas.length > 0) {
        const coderPersona = loadedPersonas.find((persona) => persona.id === 'coder');
        setActivePersona(
          scaffoldModeActive ? (coderPersona ?? loadedPersonas[0]) : loadedPersonas[0],
        );
      }
    });
  }, [scaffoldModeActive]);

  useEffect(() => {
    if (!scaffoldModeActive || personas.length === 0) return;
    const coderPersona = personas.find((persona) => persona.id === 'coder');
    if (coderPersona && activePersona?.id !== coderPersona.id) {
      setActivePersona(coderPersona);
    }
  }, [scaffoldModeActive, personas, activePersona?.id]);

  useEffect(() => {
    const applySelection = async (selection?: CodexSelectionChangedDetail) => {
      const [settings, codexStatus] = await Promise.all([
        window.anvil.settings.get(),
        window.anvil.settings.getCodexStatus().catch(() => null),
      ]);
      const model = selection?.model ?? settings.openaiModel ?? DEFAULT_CODEX_MODEL;
      const effort = resolveCodexReasoningEffort(
        model,
        selection?.reasoningEffort ?? settings.reasoningLevel,
        codexStatus?.models,
      );
      setReasoningOptions(
        getCodexModelReasoningOptions(model, codexStatus?.models).supportedReasoningEfforts,
      );
      setReasoningLevel(effort);
    };
    const handleSelectionChanged = (event: Event) => {
      void applySelection((event as CustomEvent<CodexSelectionChangedDetail>).detail).catch(
        console.error,
      );
    };

    void applySelection().catch(console.error);
    window.addEventListener(CODEX_SELECTION_CHANGED_EVENT, handleSelectionChanged);
    return () => window.removeEventListener(CODEX_SELECTION_CHANGED_EVENT, handleSelectionChanged);
  }, []);

  const updateReasoningLevel = useCallback((level: ReasoningEffort) => {
    setReasoningLevel(level);
    void window.anvil.settings.update({ reasoningLevel: level }).catch(console.error);
  }, []);

  useEffect(() => {
    if (!activeWorkspace) {
      setGovernanceDocs([]);
      setSelectedGovernanceDocs([]);
      setDbInsightArtifacts([]);
      setDbInsightAnalysis(null);
      return;
    }
    void Promise.all([
      window.anvil.governance.listDocuments(activeWorkspace.id),
      window.anvil.dbInsights.listArtifacts(activeWorkspace.id),
      window.anvil.dbInsights.getLatestAnalysis(activeWorkspace.id),
    ])
      .then(([docs, artifacts, latestAnalysis]) => {
        setGovernanceDocs(docs);
        setDbInsightArtifacts(artifacts);
        setDbInsightAnalysis(latestAnalysis);
        setSelectedGovernanceDocs((prev) =>
          prev.filter((doc) => docs.some((candidate) => candidate.id === doc.id)),
        );
      })
      .catch((err) => {
        console.error('Failed to load workspace chat context:', err);
      });
  }, [activeWorkspace]);

  useEffect(() => {
    if (scaffoldModeActive) {
      setActiveReposState([]);
      setActiveRepoState(null);
      setThreads([]);
      setActiveThreadId(null);
      setActiveArtifacts([]);
      return;
    }

    if (activeThread) {
      const threadRepos = activeThread.repoIds
        .map((repoId) => repos.find((repo) => repo.id === repoId))
        .filter((repo): repo is RepoInfo => Boolean(repo));
      if (threadRepos.length > 0) {
        const nextPrimary =
          threadRepos.find((repo) => repo.id === activeThread.activeRepoId) ??
          threadRepos[0] ??
          null;
        const nextRepoIds = threadRepos.map((repo) => repo.id);

        setActiveReposState((current) =>
          sameIdList(
            current.map((repo) => repo.id),
            nextRepoIds,
          )
            ? current
            : threadRepos,
        );
        setActiveRepoState((current) =>
          current?.id === nextPrimary?.id && current === nextPrimary ? current : nextPrimary,
        );
        return;
      }
    }

    const indexed = repos.filter((repo) => repo.status === 'indexed');
    setActiveReposState((current) => {
      if (current.length === 0 && indexed.length > 0) {
        return indexed;
      }

      const validRepos = current.filter((repo) =>
        repos.some((candidate) => candidate.id === repo.id),
      );
      if (validRepos.length !== current.length) {
        return validRepos.length > 0 ? validRepos : indexed;
      }

      return current;
    });
    setActiveRepoState((current) => {
      if (!current) return indexed[0] ?? null;
      return repos.find((repo) => repo.id === current.id) ?? indexed[0] ?? null;
    });
  }, [repos, scaffoldModeActive, activeThread]);

  useEffect(() => {
    if (!scaffoldModeActive || !activeWorkspace || !activeScaffoldSession || !activePersona) return;
    if (activeScaffoldSession.status !== 'active') return;
    if (session?.kind === 'scaffold') return;

    let cancelled = false;
    void (async () => {
      try {
        const started = await window.anvil.chat.startScaffoldSession(
          activeWorkspace.id,
          activeScaffoldSession.rootPath,
          activePersona.id,
        );
        if (!cancelled) {
          setSession(started);
          setEntries([]);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to start scaffold session');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    scaffoldModeActive,
    activeWorkspace?.id,
    activeScaffoldSession?.id,
    activeScaffoldSession?.rootPath,
    activeScaffoldSession?.status,
    activePersona?.id,
    session?.kind,
  ]);

  useEffect(() => {
    if (session?.kind !== 'scaffold') return;
    if (activeScaffoldSession?.status !== 'completed') return;

    void window.anvil.chat.stopSession(session.id).catch(console.error);
    setSession(null);
    setBusy(false);
  }, [session, activeScaffoldSession?.status]);

  useEffect(() => {
    if (!session) return;

    const sessionStillMatchesWorkspace =
      session.kind === 'scaffold'
        ? !!activeWorkspace && session.workspaceId === activeWorkspace.id
        : session.kind === 'workspace'
          ? !!activeWorkspace && session.workspaceId === activeWorkspace.id
          : !!session.repoId && repos.some((repo) => repo.id === session.repoId);

    if (sessionStillMatchesWorkspace) return;

    detachLiveSession();
  }, [activeWorkspace, detachLiveSession, repos, session]);

  useEffect(() => {
    const knownRepoIds = new Set(repos.map((repo) => repo.id));
    for (const [threadId, liveSession] of Object.entries(liveSessionsByThreadIdRef.current)) {
      const workspaceMatches =
        liveSession.kind === 'scaffold' || liveSession.kind === 'workspace'
          ? !activeWorkspace ||
            !liveSession.workspaceId ||
            liveSession.workspaceId === activeWorkspace.id
          : !liveSession.repoId || knownRepoIds.has(liveSession.repoId);

      if (workspaceMatches) continue;

      if (sessionRef.current?.id === liveSession.id) {
        detachLiveSession();
      }
      setLiveThreadStatus(threadId, liveSession.status);
    }
  }, [activeWorkspace, detachLiveSession, repos, setLiveThreadStatus]);

  useEffect(() => {
    if (!activePersona || scaffoldModeActive) return;
    if (chatLayout !== 'classic') return;
    if (suppressNextThreadBootstrapRef.current) {
      suppressNextThreadBootstrapRef.current = false;
      return;
    }

    let cancelled = false;
    const requestedWorkspaceId = activeWorkspace?.id ?? null;
    setThreads([]);
    setActiveThreadId(null);
    setEntries([]);
    setActiveArtifacts([]);
    void (async () => {
      try {
        threadLoadVersionRef.current += 1;
        detachLiveSession();
        const listedThreads = await window.anvil.chat.listThreads(
          requestedWorkspaceId,
          activePersona.id,
        );
        if (cancelled) return;

        const nextThreads = sortThreads(
          listedThreads.filter((thread) => threadBelongsToWorkspace(thread, requestedWorkspaceId)),
        );
        const listedThreadIds = new Set(nextThreads.map((thread) => thread.id));
        let activeSessions: CodexSession[] = [];
        try {
          activeSessions = await window.anvil.chat.listActiveSessions();
        } catch (err) {
          console.error('Failed to restore active chat sessions:', err);
        }
        if (cancelled) return;

        for (const activeSession of activeSessions) {
          if (
            activeSession.appThreadId &&
            listedThreadIds.has(activeSession.appThreadId) &&
            activeSession.status !== 'error'
          ) {
            rememberLiveSession(activeSession.appThreadId, activeSession);
          }
        }

        setThreads(nextThreads);
        setError(null);

        const preferredThreadId =
          lastSelectedThreadIdsRef.current[
            getThreadPreferenceKey(activeWorkspace?.id ?? null, activePersona.id)
          ];
        const nextThreadId =
          (preferredThreadId && nextThreads.some((thread) => thread.id === preferredThreadId)
            ? preferredThreadId
            : nextThreads[0]?.id) ?? null;

        if (!nextThreadId) {
          setActiveThreadId(null);
          setEntries([]);
          setActiveArtifacts([]);
          return;
        }

        await loadThreadIntoState(nextThreadId, nextThreads);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load chat threads');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    activePersona?.id,
    activeWorkspace?.id,
    chatLayout,
    scaffoldModeActive,
    detachLiveSession,
    loadThreadIntoState,
    rememberLiveSession,
  ]);

  useEffect(() => {
    if (scaffoldModeActive || chatLayout !== 'workitems') return;
    if (suppressNextThreadBootstrapRef.current) {
      suppressNextThreadBootstrapRef.current = false;
      return;
    }

    let cancelled = false;
    const requestedWorkspaceId = activeWorkspace?.id ?? null;
    setThreads([]);
    setActiveThreadId(null);
    setEntries([]);
    setActiveArtifacts([]);
    void (async () => {
      try {
        threadLoadVersionRef.current += 1;
        detachLiveSession();
        const listedThreads = await window.anvil.chat.listWorkItemThreads(requestedWorkspaceId);
        if (cancelled) return;

        const nextThreads = sortThreads(
          listedThreads.filter((thread) => threadBelongsToWorkspace(thread, requestedWorkspaceId)),
        );
        const listedThreadIds = new Set(nextThreads.map((thread) => thread.id));
        let activeSessions: CodexSession[] = [];
        try {
          activeSessions = await window.anvil.chat.listActiveSessions();
        } catch (err) {
          console.error('Failed to restore active work item chat sessions:', err);
        }
        if (cancelled) return;

        for (const activeSession of activeSessions) {
          if (
            activeSession.appThreadId &&
            listedThreadIds.has(activeSession.appThreadId) &&
            activeSession.status !== 'error'
          ) {
            rememberLiveSession(activeSession.appThreadId, activeSession);
          }
        }

        setThreads(nextThreads);
        setError(null);

        const preferredThreadId =
          lastSelectedThreadIdsRef.current[
            getWorkItemThreadPreferenceKey(activeWorkspace?.id ?? null)
          ];
        const nextThreadId =
          (preferredThreadId && nextThreads.some((thread) => thread.id === preferredThreadId)
            ? preferredThreadId
            : nextThreads[0]?.id) ?? null;

        if (!nextThreadId) {
          setActiveThreadId(null);
          setEntries([]);
          setActiveArtifacts([]);
          setSession(null);
          setBusy(false);
          return;
        }

        await loadThreadIntoState(nextThreadId, nextThreads);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load work item chat threads');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    activeWorkspace?.id,
    chatLayout,
    scaffoldModeActive,
    detachLiveSession,
    loadThreadIntoState,
    rememberLiveSession,
  ]);

  const persistThreadPlan = useCallback(
    (threadId: string, plan: ChatPlanSnapshot) => {
      window.anvil.chat
        .saveThreadPlan(threadId, plan)
        .then((updated) => {
          if (updated) applyThreadState(updated);
        })
        .catch(console.error);
    },
    [applyThreadState],
  );

  const persistThreadGoal = useCallback(
    (threadId: string, goal: ChatGoalSnapshot | null) => {
      window.anvil.chat
        .saveThreadGoal(threadId, goal)
        .then((updated) => {
          if (updated) applyThreadState(updated);
        })
        .catch(console.error);
    },
    [applyThreadState],
  );

  useEffect(() => {
    const cleanup = window.anvil.chat.onEvent((rawEvent) => {
      const event = boundEventPayload(
        rawEvent as CodexEvent & { sessionId?: string; appThreadId?: string },
      );
      const eventSessionId = event.sessionId;
      const eventThreadId =
        (eventSessionId ? findThreadIdForSession(eventSessionId) : null) ??
        event.appThreadId ??
        null;
      const isActiveSession = !!eventSessionId && eventSessionId === sessionRef.current?.id;
      const eventSession =
        eventSessionId && sessionRef.current?.id === eventSessionId
          ? sessionRef.current
          : eventSessionId
            ? Object.values(liveSessionsByThreadIdRef.current).find(
                (candidate) => candidate.id === eventSessionId,
              )
            : null;

      if (eventSessionId && !isActiveSession && !eventThreadId) return;

      if (eventThreadId && shouldPersistEvidenceEvent(event)) {
        window.anvil.chat
          .saveEvent(
            eventThreadId,
            eventSession?.repoId ?? null,
            eventSessionId ?? null,
            event,
            new Date().toISOString(),
          )
          .catch(console.error);
      }

      if (eventThreadId && event.type === 'subagent_update') {
        const result = getCompletedSubagentResult(event);
        if (result) {
          void persistArtifactsForAssistantMessage(
            eventThreadId,
            eventSession?.repoId ?? null,
            `subagent-${event.subagent?.id ?? generateId()}`,
            result,
          ).catch(console.error);
        }
      }

      if (eventSessionId && eventThreadId) {
        const attentionUpdate = getThreadAttentionUpdate(event);
        if (attentionUpdate) {
          setThreads((prev) =>
            sortThreads(
              prev.map((thread) =>
                thread.id === eventThreadId
                  ? {
                      ...thread,
                      ...attentionUpdate,
                      settledAt: attentionUpdate.settledAt,
                    }
                  : thread,
              ),
            ),
          );
        }
        if (event.type === 'status') {
          const nextStatus: CodexSession['status'] =
            event.status === 'complete' ? 'ready' : event.status === 'error' ? 'error' : 'busy';
          setLiveThreadStatus(eventThreadId, nextStatus);
          const liveSession = liveSessionsByThreadIdRef.current[eventThreadId];
          if (liveSession) {
            liveSessionsByThreadIdRef.current[eventThreadId] = {
              ...liveSession,
              status: nextStatus,
            };
          }
          if (isActiveSession) {
            setSession((prev) =>
              prev?.id === eventSessionId ? { ...prev, status: nextStatus } : prev,
            );
          }
        } else if (event.type === 'text' && event.text) {
          const liveOutput = getLiveAssistantOutput(eventSessionId, eventThreadId);
          liveOutputBySessionIdRef.current[eventSessionId] = appendLiveAssistantSegment(
            liveOutput,
            event,
          );
        } else {
          const liveOutput = liveOutputBySessionIdRef.current[eventSessionId];
          if (liveOutput?.activeLegacySegmentId) {
            liveOutputBySessionIdRef.current[eventSessionId] = {
              ...liveOutput,
              activeLegacySegmentId: undefined,
            };
          }
        }
      }

      if (eventSessionId && !isActiveSession) {
        if (event.type === 'status' && event.status === 'complete') {
          persistAssistantForSession(eventSessionId, { final: true });
          const completedOutput = liveOutputBySessionIdRef.current[eventSessionId];
          if (completedOutput) {
            liveOutputBySessionIdRef.current[eventSessionId] = {
              ...completedOutput,
              activeLegacySegmentId: undefined,
            };
          }
        } else if (event.type === 'plan_update' && event.plan && eventThreadId) {
          persistThreadPlan(eventThreadId, event.plan);
        } else if (event.type === 'goal_update' && event.goal && eventThreadId) {
          persistThreadGoal(eventThreadId, event.goal);
        } else if (event.type === 'goal_cleared' && eventThreadId) {
          persistThreadGoal(eventThreadId, null);
        }
        return;
      }

      if (event.type === 'status' && event.status === 'complete') {
        flushPendingStreamEntry();
        setEntries((prev) => resolveCompletedAssistantEntries(prev));
        setBusy(false);
        if (eventSessionId) {
          persistAssistantForSession(eventSessionId, { final: true });
          const completedOutput = liveOutputBySessionIdRef.current[eventSessionId];
          if (completedOutput) {
            liveOutputBySessionIdRef.current[eventSessionId] = {
              ...completedOutput,
              activeLegacySegmentId: undefined,
            };
          }
        }
      } else if (event.type === 'status' && event.status === 'error') {
        flushPendingStreamEntry();
        setBusy(false);
        setError(event.errorMessage ?? 'Codex could not complete this turn.');
      } else if (event.type === 'status') {
        // Ignore intermediate status events.
      } else if (event.type === 'thinking' && event.text) {
        queueStreamEntry('thinking', event.text);
      } else if (event.type === 'text' && event.text) {
        queueStreamEntry('assistant', event.text, {
          itemId: event.itemId,
          phase: event.assistantPhase,
        });
      } else if (event.type === 'plan_update' && event.plan) {
        flushPendingStreamEntry();
        const targetThreadId = eventThreadId ?? activeThreadRef.current?.id;
        if (targetThreadId) persistThreadPlan(targetThreadId, event.plan);
        setEntries((prev) => [...prev, { kind: 'event', event }]);
      } else if (event.type === 'goal_update' && event.goal) {
        flushPendingStreamEntry();
        const targetThreadId = eventThreadId ?? activeThreadRef.current?.id;
        if (targetThreadId) persistThreadGoal(targetThreadId, event.goal);
        setEntries((prev) => [...prev, { kind: 'event', event }]);
      } else if (event.type === 'goal_cleared') {
        flushPendingStreamEntry();
        const targetThreadId = eventThreadId ?? activeThreadRef.current?.id;
        if (targetThreadId) persistThreadGoal(targetThreadId, null);
        setEntries((prev) => [...prev, { kind: 'event', event }]);
      } else if (event.type === 'command_exec' && event.command) {
        flushPendingStreamEntry();
        setEntries((prev) => {
          const last = prev[prev.length - 1];
          if (
            last?.kind === 'event' &&
            last.event.type === 'command_exec' &&
            last.event.command === event.command
          ) {
            const updated = [...prev];
            updated[updated.length - 1] = {
              kind: 'event',
              event: {
                ...last.event,
                ...event,
                output: event.output || last.event.output,
              },
            };
            return updated;
          }
          return [...prev, { kind: 'event', event }];
        });
      } else if (event.type === 'command_exec' && event.output && !event.command) {
        const output = event.output;
        flushPendingStreamEntry();
        setEntries((prev) => {
          const last = prev[prev.length - 1];
          if (last?.kind === 'event' && last.event.type === 'command_exec') {
            const updated = [...prev];
            updated[updated.length - 1] = {
              kind: 'event',
              event: {
                ...last.event,
                output: appendBoundedTail(last.event.output ?? '', output),
              },
            };
            return updated;
          }
          return [...prev, { kind: 'event', event }];
        });
      } else if (event.type === 'file_edit') {
        flushPendingStreamEntry();
        setEntries((prev) => {
          const last = prev[prev.length - 1];
          if (
            last?.kind === 'event' &&
            last.event.type === 'file_edit' &&
            last.event.filePath === event.filePath
          ) {
            const updated = [...prev];
            updated[updated.length - 1] = { kind: 'event', event };
            return updated;
          }
          return [...prev, { kind: 'event', event }];
        });
      } else if (event.type === 'subagent_update' && event.subagent) {
        flushPendingStreamEntry();
        setEntries((prev) => upsertSubagentEntry(prev, event));
      } else if (event.type === 'thread_status') {
        flushPendingStreamEntry();
        setEntries((prev) => upsertThreadStatusEntry(prev, event));
      } else if (event.type === 'request_resolved' && event.resolvedRequestId !== undefined) {
        flushPendingStreamEntry();
        setEntries((prev) => removeResolvedRequestEntry(prev, event.resolvedRequestId));
      } else {
        flushPendingStreamEntry();
        setEntries((prev) => [...prev, { kind: 'event', event }]);
      }
    });
    return cleanup;
  }, [
    findThreadIdForSession,
    flushPendingStreamEntry,
    getLiveAssistantOutput,
    persistAssistantForSession,
    persistArtifactsForAssistantMessage,
    persistThreadGoal,
    persistThreadPlan,
    queueStreamEntry,
    setLiveThreadStatus,
  ]);

  const buildEnrichedMessage = useCallback(
    (
      message: string,
      overrides?: {
        artifacts?: DbInsightArtifact[];
        analysis?: DbInsightAnalysis | null;
        personaId?: string;
      },
    ): string => {
      const sections: string[] = [];
      const nextArtifacts = overrides?.artifacts ?? dbInsightArtifacts;
      const nextAnalysis = overrides?.analysis ?? dbInsightAnalysis;
      const personaId = overrides?.personaId ?? activePersona?.id;

      if (selectedGovernanceDocs.length > 0) {
        const docList = selectedGovernanceDocs
          .map((doc) => `- ${doc.fileName}: ${doc.filePath}`)
          .join('\n');
        sections.push(
          `[Governance context — read these files if relevant to your answer]\n${docList}`,
        );
      }

      if (personaId === 'db-expert') {
        const artifactList =
          nextArtifacts.length > 0
            ? nextArtifacts
                .map((artifact) => `- ${artifact.fileName}: ${artifact.filePath}`)
                .join('\n')
            : 'No DB export files are currently attached to this workspace.';

        const analysisSummary = nextAnalysis
          ? [
              `[DB Insights context — prefer this analysis and these source exports]`,
              `Summary: ${nextAnalysis.summary}`,
              `Counts: ${nextAnalysis.tableCount} table(s), ${nextAnalysis.procedureCount} stored procedure(s), ${nextAnalysis.viewCount} view(s), ${nextAnalysis.functionCount} function(s).`,
              nextAnalysis.tables.length > 0
                ? `Key tables:\n${nextAnalysis.tables
                    .slice(0, 8)
                    .map((table) => `- ${table.qualifiedName} (${table.columnCount} columns)`)
                    .join('\n')}`
                : 'Key tables:\n- None detected yet.',
              nextAnalysis.storedProcedures.length > 0
                ? `Key stored procedures:\n${nextAnalysis.storedProcedures
                    .slice(0, 8)
                    .map((procedure) => `- ${procedure.qualifiedName}`)
                    .join('\n')}`
                : 'Key stored procedures:\n- None detected yet.',
              `Source exports:\n${artifactList}`,
            ].join('\n')
          : `[DB Insights context]\nNo completed DB Insights analysis is available yet.\nSource exports:\n${artifactList}`;

        sections.push(analysisSummary);
      }

      if (personaId === 'design') {
        const figmaContext = formatFigmaRefsForPrompt(extractFigmaRefs(message));
        if (figmaContext) {
          sections.push(figmaContext);
        }
      }

      const activeThread = activeThreadRef.current;
      sections.push(buildArtifactCanvasPrompt(activeThread?.title));

      if (activeThread?.workItemId) {
        const providerLabel = activeThread.workItemProvider
          ? activeThread.workItemProvider.toUpperCase()
          : 'Work item';
        sections.push(
          [
            '[Work item context]',
            `${providerLabel} ${activeThread.workItemId}: ${
              activeThread.workItemTitle ?? activeThread.title
            }`,
            'Treat this chat as the working thread for that work item unless the user explicitly changes scope.',
          ].join('\n'),
        );
      }

      if (collaborationMode === 'plan') {
        sections.push(
          [
            '[Collaboration mode: Plan]',
            'Work in planning mode for this turn. Use the plan tool to create or update a concrete implementation plan. Do not make file edits or run implementation commands unless the user explicitly asks to implement.',
          ].join('\n'),
        );
      } else if (activeThreadRef.current?.activePlan?.steps.length) {
        const plan = activeThreadRef.current.activePlan;
        sections.push(
          [
            '[Saved implementation plan]',
            plan.explanation ? `Context: ${plan.explanation}` : null,
            ...plan.steps.map((step) => `- [${formatPlanStatus(step.status)}] ${step.step}`),
            'When the user asks to implement, use this plan as the working checklist and update progress as steps complete.',
          ]
            .filter((line): line is string => Boolean(line))
            .join('\n'),
        );
      }

      if (sections.length === 0) return message;
      return `${sections.join('\n\n')}\n\n${message}`;
    },
    [
      selectedGovernanceDocs,
      activePersona?.id,
      dbInsightArtifacts,
      dbInsightAnalysis,
      collaborationMode,
    ],
  );

  const send = useCallback(
    async (message: string, attachments: ChatAttachment[] = [], modelContext?: string) => {
      const displayMessage = normaliseOutgoingMessage(message, attachments);
      const attachmentPrompt = buildAttachmentPrompt(displayMessage, attachments);
      const modelMessage = modelContext
        ? `${modelContext}\n\n${attachmentPrompt}`
        : attachmentPrompt;
      let nextArtifacts = dbInsightArtifacts;
      let nextAnalysis = dbInsightAnalysis;

      if (activePersona?.id === 'db-expert' && activeWorkspace) {
        try {
          const [latestArtifacts, latestAnalysis] = await Promise.all([
            window.anvil.dbInsights.listArtifacts(activeWorkspace.id),
            window.anvil.dbInsights.getLatestAnalysis(activeWorkspace.id),
          ]);
          nextArtifacts = latestArtifacts;
          nextAnalysis = latestAnalysis;
          setDbInsightArtifacts(latestArtifacts);
          setDbInsightAnalysis(latestAnalysis);
        } catch (err) {
          console.error('Failed to refresh DB Insights chat context:', err);
        }
      }

      if (!activePersona) return;

      const enriched = buildEnrichedMessage(modelMessage, {
        artifacts: nextArtifacts,
        analysis: nextAnalysis,
      });

      let thread = activeThreadRef.current;
      if (!thread) {
        thread = await createThreadRecord({
          title: buildThreadTitle(displayMessage, activePersona.name),
        });
      }
      if (!thread) return;

      const primaryRepo = activeRepoState ?? activeReposState[0] ?? null;
      const selectedRepoIds = activeReposState.map((repo) => repo.id);
      if (
        thread.activeRepoId !== (primaryRepo?.id ?? undefined) ||
        !sameIdList(thread.repoIds, selectedRepoIds)
      ) {
        const updatedThread = await window.anvil.chat.updateThread(thread.id, {
          repoIds: selectedRepoIds,
          activeRepoId: primaryRepo?.id ?? null,
        });
        if (updatedThread) {
          thread = updatedThread;
          applyThreadState(updatedThread);
        }
      }

      if (thread.messageCount === 0) {
        const title = buildThreadTitle(displayMessage, activePersona.name);
        if (thread.title !== title) {
          const renamedThread = await window.anvil.chat.updateThread(thread.id, { title });
          if (renamedThread) {
            thread = renamedThread;
            applyThreadState(renamedThread);
          }
        }
      }

      const timestamp = new Date().toISOString();
      const userEntry: ChatEntry = {
        kind: 'user',
        content: displayMessage,
        attachments,
        id: generateId(),
      };
      const threadLiveSession = liveSessionsByThreadIdRef.current[thread.id] ?? null;
      const renderedSessionThreadId = session ? findThreadIdForSession(session.id) : null;
      const renderedSessionBelongsToThread =
        session?.appThreadId === thread.id || renderedSessionThreadId === thread.id;
      const liveOrRenderedSessionForThread =
        threadLiveSession ?? (renderedSessionBelongsToThread ? session : null);
      const currentSessionForThread =
        liveOrRenderedSessionForThread?.personaId === activePersona.id
          ? liveOrRenderedSessionForThread
          : null;

      if (!currentSessionForThread) {
        try {
          const designOptions = buildDesignChatStartOptions(activePersona.id, modelMessage);
          const workspaceOptions = activeWorkspace
            ? {
                workspace: {
                  workspaceId: activeWorkspace.id,
                  ...(activeReposState.length === 0 && workspaceChatCwd
                    ? { cwd: workspaceChatCwd }
                    : {}),
                },
                threadId: thread.id,
                ...designOptions,
              }
            : { threadId: thread.id, ...designOptions };
          const startedSession =
            scaffoldModeActive && activeWorkspace && activeScaffoldSession
              ? await window.anvil.chat.startScaffoldSession(
                  activeWorkspace.id,
                  activeScaffoldSession.rootPath,
                  activePersona.id,
                )
              : activeReposState.length > 0
                ? await window.anvil.chat.startSession(
                    activeReposState.map((repo) => repo.id),
                    activePersona.id,
                    workspaceOptions,
                  )
                : canStartWorkspaceChat && activeWorkspace
                  ? await window.anvil.chat.startSession([], activePersona.id, {
                      workspace: {
                        workspaceId: activeWorkspace.id,
                        cwd: workspaceChatCwd,
                      },
                      threadId: thread.id,
                      ...designOptions,
                    })
                  : null;

          if (!startedSession) return;

          rememberLiveSession(thread.id, startedSession);
          setSession(startedSession);
          setEntries((prev) => [...prev, userEntry]);
          setBusy(true);
          setLiveThreadStatus(thread.id, 'busy');
          setError(null);

          await window.anvil.chat.saveEntry(
            thread.id,
            startedSession.repoId ?? null,
            startedSession.id,
            {
              id: userEntry.id!,
              role: 'user',
              content: displayMessage,
              timestamp,
              personaId: activePersona.id,
              threadId: thread.id,
              attachments,
            },
          );
          bumpThreadSummary(thread.id, buildThreadPreview(displayMessage, attachments), timestamp);

          await window.anvil.chat.send(startedSession.id, enriched, attachments, {
            collaborationMode,
            reasoningEffort: reasoningLevel,
          });
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Failed to start session');
          setBusy(false);
        }
        return;
      }

      if (session?.id !== currentSessionForThread.id) {
        setSession(currentSessionForThread);
      }
      setEntries((prev) => [...prev, userEntry]);
      setBusy(true);
      setLiveThreadStatus(thread.id, 'busy');
      setError(null);

      try {
        await window.anvil.chat.saveEntry(
          thread.id,
          currentSessionForThread.repoId ?? null,
          currentSessionForThread.id,
          {
            id: userEntry.id!,
            role: 'user',
            content: displayMessage,
            timestamp,
            personaId: currentSessionForThread.personaId,
            threadId: thread.id,
            attachments,
          },
        );
        bumpThreadSummary(thread.id, buildThreadPreview(displayMessage, attachments), timestamp);
        await window.anvil.chat.send(currentSessionForThread.id, enriched, attachments, {
          collaborationMode,
          reasoningEffort: reasoningLevel,
        });
      } catch (err) {
        setBusy(false);
        setError(err instanceof Error ? err.message : 'Send failed');
      }
    },
    [
      session,
      activePersona,
      activeRepoState,
      activeReposState,
      activeScaffoldSession,
      activeWorkspace,
      applyThreadState,
      buildEnrichedMessage,
      bumpThreadSummary,
      canStartWorkspaceChat,
      collaborationMode,
      createThreadRecord,
      dbInsightArtifacts,
      dbInsightAnalysis,
      findThreadIdForSession,
      reasoningLevel,
      rememberLiveSession,
      scaffoldModeActive,
      setLiveThreadStatus,
      workspaceChatCwd,
    ],
  );

  const steer = useCallback(
    async (message: string, attachments: ChatAttachment[] = []) => {
      const currentSession = sessionRef.current;
      if (!currentSession) return;

      const displayMessage = normaliseOutgoingMessage(message, attachments);
      const modelMessage = buildAttachmentPrompt(displayMessage, attachments);
      const enriched = buildEnrichedMessage(modelMessage);
      const threadId = findThreadIdForSession(currentSession.id) ?? currentSession.appThreadId;

      if (threadId) {
        const timestamp = new Date().toISOString();
        const userEntry: ChatEntry = {
          kind: 'user',
          content: `[steer] ${displayMessage}`,
          attachments,
          id: generateId(),
        };
        setEntries((prev) => [...prev, userEntry]);
        await window.anvil.chat.saveEntry(
          threadId,
          currentSession.repoId ?? null,
          currentSession.id,
          {
            id: userEntry.id!,
            role: 'user',
            content: `[steer] ${displayMessage}`,
            timestamp,
            personaId: currentSession.personaId,
            threadId,
            attachments,
          },
        );
        bumpThreadSummary(threadId, `[steer] ${displayMessage}`, timestamp);
      }

      await window.anvil.chat.steer(currentSession.id, enriched, attachments);
    },
    [buildEnrichedMessage, bumpThreadSummary, findThreadIdForSession],
  );

  const switchPersona = useCallback(
    async (persona: Persona) => {
      if (scaffoldModeActive) return;
      if (chatLayout === 'workitems') {
        detachLiveSession();
        setActivePersona(persona);
        setError(null);
        return;
      }
      threadLoadVersionRef.current += 1;
      detachLiveSession();
      setActivePersona(persona);
      setEntries([]);
      setActiveArtifacts([]);
      setError(null);
    },
    [chatLayout, detachLiveSession, scaffoldModeActive],
  );

  const selectWorkItemThread = useCallback(
    async (workItem: WorkItem) => {
      if (scaffoldModeActive || !activePersona) return;

      try {
        threadLoadVersionRef.current += 1;
        detachLiveSession();
        setBusy(false);
        setError(null);

        const primaryRepo = activeRepoState ?? activeReposState[0] ?? null;
        const thread = await window.anvil.chat.ensureWorkItemThread({
          workspaceId: activeWorkspace?.id ?? null,
          personaId: activePersona.id,
          workItemId: workItem.id,
          workItemProvider: workItem.provider,
          workItemTitle: workItem.title,
          repoIds: activeReposState.map((repo) => repo.id),
          activeRepoId: primaryRepo?.id ?? null,
        });

        const listedThreads = await window.anvil.chat.listWorkItemThreads(
          activeWorkspace?.id ?? null,
        );
        const nextThreads = sortThreads([
          thread,
          ...listedThreads.filter((candidate) => candidate.id !== thread.id),
        ]);
        setThreads(nextThreads);
        applyThreadState(thread);
        rememberThreadSelection(
          lastSelectedThreadIdsRef.current,
          getWorkItemThreadPreferenceKey(activeWorkspace?.id ?? null),
          thread.id,
        );
        await loadThreadIntoState(thread.id, nextThreads);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to open work item thread');
      }
    },
    [
      activePersona,
      activeRepoState,
      activeReposState,
      activeWorkspace?.id,
      applyThreadState,
      detachLiveSession,
      loadThreadIntoState,
      scaffoldModeActive,
    ],
  );

  const interrupt = useCallback(async () => {
    if (!session) return;
    try {
      await window.anvil.chat.interrupt(session.id);
      setBusy(false);
    } catch (err) {
      console.error('Interrupt failed:', err);
    }
  }, [session]);

  const startNewSession = useCallback(async () => {
    if (scaffoldModeActive || !activePersona || chatLayout === 'workitems') return;
    threadLoadVersionRef.current += 1;
    detachLiveSession();
    setEntries([]);
    setActiveArtifacts([]);
    setBusy(false);
    setError(null);
    await createThreadRecord({
      title: buildEmptyThreadLabel(activePersona.name),
    });
  }, [activePersona, chatLayout, createThreadRecord, detachLiveSession, scaffoldModeActive]);

  const selectThread = useCallback(
    async (threadId: string) => {
      if (scaffoldModeActive) return;
      const viewedAt = new Date().toISOString();
      setThreads((prev) =>
        prev.map((thread) =>
          thread.id === threadId ? { ...thread, lastViewedAt: viewedAt } : thread,
        ),
      );
      void window.anvil.chat
        .updateThread(threadId, { viewed: true })
        .then((updated) => {
          if (updated) applyThreadState(updated);
        })
        .catch((error) => console.error('Failed to mark thread as viewed:', error));
      await loadThreadIntoState(threadId);
    },
    [applyThreadState, loadThreadIntoState, scaffoldModeActive],
  );

  const settleThread = useCallback(
    async (threadId: string, settled: boolean) => {
      const updated = await window.anvil.chat.updateThread(threadId, { settled });
      if (!updated) return;

      const nextThreads = sortThreads([
        updated,
        ...threadsRef.current.filter((thread) => thread.id !== threadId),
      ]);
      setThreads(nextThreads);

      if (!settled || activeThreadRef.current?.id !== threadId) return;
      const nextActiveThread = nextThreads.find((thread) => !thread.settledAt);
      if (nextActiveThread) {
        await loadThreadIntoState(nextActiveThread.id, nextThreads);
      }
    },
    [loadThreadIntoState],
  );

  const deleteThread = useCallback(
    async (threadId: string) => {
      const remainingThreads = threadsRef.current.filter((thread) => thread.id !== threadId);
      await stopThreadLiveSession(threadId);
      await window.anvil.chat.deleteThread(threadId);
      setThreads(remainingThreads);

      if (activeThreadRef.current?.id !== threadId) {
        return;
      }

      setEntries([]);
      setActiveArtifacts([]);
      setBusy(false);
      setError(null);

      const nextThread = remainingThreads[0] ?? null;
      if (!nextThread) {
        setActiveThreadId(null);
        setActiveArtifacts([]);
        return;
      }

      await loadThreadIntoState(nextThread.id, remainingThreads);
    },
    [loadThreadIntoState, stopThreadLiveSession],
  );

  const forkThread = useCallback(
    async (messageIndex: number) => {
      if (scaffoldModeActive || !activePersona || chatLayout === 'workitems') return;

      const ancestorEntries = entriesRef.current
        .slice(0, messageIndex + 1)
        .filter(
          (entry): entry is Extract<ChatEntry, { kind: 'user' | 'assistant' }> =>
            entry.kind === 'user' || entry.kind === 'assistant',
        );
      if (ancestorEntries.length === 0) return;

      threadLoadVersionRef.current += 1;
      detachLiveSession();
      setBusy(false);
      setError(null);

      const forkedThread = await createThreadRecord({
        title: buildForkThreadTitle(
          activeThreadRef.current?.title,
          ancestorEntries[ancestorEntries.length - 1]?.content,
        ),
      });
      if (!forkedThread) return;
      const sourceThreadId = activeThreadRef.current?.id;

      const primaryRepo = activeRepoState ?? activeReposState[0] ?? null;
      const forkTimestampBase = Date.now();
      for (const [index, entry] of ancestorEntries.entries()) {
        await window.anvil.chat.saveEntry(forkedThread.id, primaryRepo?.id ?? null, null, {
          id: generateId(),
          role: entry.kind === 'assistant' && entry.phase === 'progress' ? 'system' : entry.kind,
          content: entry.content,
          timestamp: new Date(forkTimestampBase + index).toISOString(),
          personaId: activePersona.id,
          threadId: forkedThread.id,
          ...(entry.kind === 'user' && entry.attachments ? { attachments: entry.attachments } : {}),
          ...(entry.kind === 'assistant'
            ? {
                event: {
                  type: 'text' as const,
                  text: entry.content,
                  itemId: entry.itemId,
                  assistantPhase: entry.phase,
                },
              }
            : {}),
        });
      }

      const refreshedThread = await window.anvil.chat.updateThread(forkedThread.id, {});
      if (refreshedThread) {
        applyThreadState({
          ...refreshedThread,
          preview: ancestorEntries[ancestorEntries.length - 1]?.content,
          messageCount: ancestorEntries.length,
          lastMessageAt: new Date(forkTimestampBase + ancestorEntries.length - 1).toISOString(),
        });
      }

      if (sourceThreadId) {
        window.anvil.chat
          .forkProviderThread(sourceThreadId, forkedThread.id)
          .then((providerForkedThread) => {
            if (providerForkedThread) applyThreadState(providerForkedThread);
          })
          .catch(console.error);
      }

      setEntries(ancestorEntries.map((entry) => ({ ...entry })));
      setSession(null);
    },
    [
      activePersona,
      activeRepoState,
      activeReposState,
      applyThreadState,
      createThreadRecord,
      detachLiveSession,
      chatLayout,
      scaffoldModeActive,
    ],
  );

  const launchPreparedChat = useCallback(
    async (opts: {
      personaId: string;
      repoIds?: string[];
      message: string;
      reasoningLevel?: ReasoningEffort;
      threadTitle?: string;
      workItem?: WorkItem;
    }) => {
      if (scaffoldModeActive) return;

      const targetPersona = personas.find((persona) => persona.id === opts.personaId);
      if (!targetPersona) {
        setError(`Persona not found: ${opts.personaId}`);
        return;
      }

      const selectedRepos =
        opts.repoIds && opts.repoIds.length > 0
          ? repos.filter((repo) => opts.repoIds?.includes(repo.id))
          : [];

      threadLoadVersionRef.current += 1;
      detachLiveSession();

      suppressNextThreadBootstrapRef.current = shouldSuppressPreparedChatBootstrap(
        activePersona?.id ?? null,
        targetPersona.id,
      );
      setSession(null);
      setEntries([]);
      setBusy(false);
      setError(null);
      setActivePersona(targetPersona);
      setReasoningLevel(opts.reasoningLevel ?? reasoningLevel);

      const useWorkItemThread = chatLayout === 'workitems' && !!opts.workItem;
      const createdThread = useWorkItemThread
        ? await window.anvil.chat.ensureWorkItemThread({
            workspaceId: activeWorkspace?.id ?? null,
            personaId: targetPersona.id,
            workItemId: opts.workItem!.id,
            workItemProvider: opts.workItem!.provider,
            workItemTitle: opts.workItem!.title,
            repoIds: selectedRepos.map((repo) => repo.id),
            activeRepoId: selectedRepos[0]?.id ?? null,
          })
        : await window.anvil.chat.createThread({
            workspaceId: activeWorkspace?.id ?? null,
            personaId: targetPersona.id,
            title: opts.threadTitle ?? buildThreadTitle(opts.message, targetPersona.name),
            repoIds: selectedRepos.map((repo) => repo.id),
            activeRepoId: selectedRepos[0]?.id ?? null,
          });

      const listedThreads = useWorkItemThread
        ? await window.anvil.chat.listWorkItemThreads(activeWorkspace?.id ?? null)
        : await window.anvil.chat.listThreads(activeWorkspace?.id ?? null, targetPersona.id);
      const nextThreads = sortThreads(listedThreads);
      setThreads(nextThreads);
      setActiveThreadId(createdThread.id);
      setActiveReposState(selectedRepos);
      setActiveRepoState(selectedRepos[0] ?? null);
      rememberThreadSelection(
        lastSelectedThreadIdsRef.current,
        createdThread.workItemId
          ? getWorkItemThreadPreferenceKey(activeWorkspace?.id ?? null)
          : getThreadPreferenceKey(activeWorkspace?.id ?? null, targetPersona.id),
        createdThread.id,
      );

      const enrichedMessage = buildEnrichedMessage(opts.message, {
        personaId: targetPersona.id,
      });

      try {
        const designOptions = buildDesignChatStartOptions(targetPersona.id, opts.message);
        const nextSession =
          selectedRepos.length > 0
            ? await window.anvil.chat.startSession(
                selectedRepos.map((repo) => repo.id),
                targetPersona.id,
                {
                  workspace: activeWorkspace ? { workspaceId: activeWorkspace.id } : undefined,
                  threadId: createdThread.id,
                  ...designOptions,
                },
              )
            : canStartWorkspaceChat && activeWorkspace
              ? await window.anvil.chat.startSession([], targetPersona.id, {
                  workspace: {
                    workspaceId: activeWorkspace.id,
                    ...(workspaceChatCwd ? { cwd: workspaceChatCwd } : {}),
                  },
                  threadId: createdThread.id,
                  ...designOptions,
                })
              : null;

        if (!nextSession) {
          setError('Unable to start chat for this request.');
          return;
        }

        const timestamp = new Date().toISOString();
        const userEntryId = generateId();
        rememberLiveSession(createdThread.id, nextSession);
        setSession(nextSession);
        setEntries([{ kind: 'user', content: opts.message, id: userEntryId }]);
        setBusy(true);
        setLiveThreadStatus(createdThread.id, 'busy');

        await window.anvil.chat.saveEntry(
          createdThread.id,
          nextSession.repoId ?? null,
          nextSession.id,
          {
            id: userEntryId,
            role: 'user',
            content: opts.message,
            timestamp,
            personaId: targetPersona.id,
            threadId: createdThread.id,
          },
        );
        bumpThreadSummary(createdThread.id, opts.message, timestamp);

        await window.anvil.chat.send(nextSession.id, enrichedMessage, [], {
          collaborationMode,
          reasoningEffort: opts.reasoningLevel ?? reasoningLevel,
        });
      } catch (err) {
        setBusy(false);
        setError(err instanceof Error ? err.message : 'Failed to launch chat');
      }
    },
    [
      activePersona?.id,
      activeWorkspace,
      buildEnrichedMessage,
      bumpThreadSummary,
      canStartWorkspaceChat,
      chatLayout,
      collaborationMode,
      personas,
      rememberLiveSession,
      repos,
      scaffoldModeActive,
      setLiveThreadStatus,
      detachLiveSession,
      workspaceChatCwd,
    ],
  );

  const loadHistoryFn = useCallback(async () => {
    if (!activeThreadId || scaffoldModeActive) return;
    await loadThreadIntoState(activeThreadId);
  }, [activeThreadId, loadThreadIntoState, scaffoldModeActive]);

  const clearHistoryFn = useCallback(async () => {
    if (!activeThreadId || scaffoldModeActive) return;
    try {
      await window.anvil.chat.clearHistory(activeThreadId);
      setEntries([]);
      setActiveArtifacts([]);
      setThreads((prev) =>
        prev.map((thread) =>
          thread.id === activeThreadId
            ? { ...thread, preview: undefined, lastMessageAt: undefined, messageCount: 0 }
            : thread,
        ),
      );
    } catch (err) {
      console.error('Failed to clear history:', err);
    }
  }, [activeThreadId, scaffoldModeActive]);

  return (
    <ChatContext.Provider
      value={{
        personas,
        activePersona,
        session,
        entries,
        repos,
        activeRepo: activeRepoState,
        activeRepos: activeReposState,
        governanceDocs,
        selectedGovernanceDocs,
        scaffoldModeActive,
        scaffoldStatus,
        busy,
        error,
        reasoningLevel,
        reasoningOptions,
        threads,
        activeThread,
        activeThreadId,
        liveThreadStatuses,
        collaborationMode,
        activePlan,
        activeGoal,
        activeArtifacts,
        chatLayout,
        setActiveRepo,
        setActiveRepos,
        setSelectedGovernanceDocs,
        send,
        steer,
        switchPersona,
        interrupt,
        startNewSession,
        loadHistory: loadHistoryFn,
        clearHistory: clearHistoryFn,
        setReasoningLevel: updateReasoningLevel,
        selectThread,
        renameThread,
        settleThread,
        deleteThread,
        forkThread,
        setCollaborationMode,
        setChatLayout,
        selectWorkItemThread,
        launchPreparedChat,
      }}
    >
      {children}
    </ChatContext.Provider>
  );
}

function boundEventPayload<T extends CodexEvent>(event: T): T {
  if (event.type === 'command_exec' && event.output) {
    return { ...event, output: limitTail(event.output, MAX_LIVE_COMMAND_OUTPUT_CHARS) };
  }

  if (event.type === 'file_edit' && event.diff) {
    return { ...event, diff: limitMiddle(event.diff, MAX_LIVE_DIFF_CHARS) };
  }

  return event;
}

function shouldPersistEvidenceEvent(event: CodexEvent): boolean {
  if (event.type === 'command_exec') return !!event.command || !!event.output;
  if (event.type === 'subagent_update') {
    return event.subagent?.status === 'completed' || event.subagent?.status === 'failed';
  }
  return (
    event.type === 'file_read' ||
    event.type === 'file_edit' ||
    event.type === 'tool_call' ||
    event.type === 'approval_request' ||
    event.type === 'input_request' ||
    event.type === 'request_resolved' ||
    event.type === 'plan_update' ||
    event.type === 'goal_update' ||
    event.type === 'goal_cleared' ||
    event.type === 'error'
  );
}

function upsertSubagentEntry(entries: ChatEntry[], event: CodexEvent): ChatEntry[] {
  const subagentId = event.subagent?.id;
  if (!subagentId) return [...entries, { kind: 'event', event }];
  const existingIndex = entries.findIndex(
    (entry) =>
      entry.kind === 'event' &&
      entry.event.type === 'subagent_update' &&
      entry.event.subagent?.id === subagentId,
  );
  if (existingIndex < 0) return [...entries, { kind: 'event', event }];
  const updated = [...entries];
  updated[existingIndex] = { kind: 'event', event };
  return updated;
}

function upsertThreadStatusEntry(entries: ChatEntry[], event: CodexEvent): ChatEntry[] {
  const filtered = entries.filter(
    (entry) =>
      !(
        entry.kind === 'event' &&
        entry.event.type === 'thread_status' &&
        entry.event.protocolThreadId === event.protocolThreadId
      ),
  );
  if (!event.threadActiveFlags || event.threadActiveFlags.length === 0) return filtered;
  return [...filtered, { kind: 'event', event }];
}

function getCompletedSubagentResult(event: CodexEvent): string | null {
  if (
    event.type !== 'subagent_update' ||
    (event.subagent?.status !== 'completed' && event.subagent?.status !== 'failed')
  ) {
    return null;
  }
  const messages = event.subagent.agents
    .map((agent) => agent.message?.trim())
    .filter((message): message is string => Boolean(message));
  return messages.length > 0 ? messages.join('\n\n') : null;
}

function removeResolvedRequestEntry(entries: ChatEntry[], requestId: string | number): ChatEntry[] {
  return entries.filter(
    (entry) =>
      !(
        entry.kind === 'event' &&
        ((entry.event.type === 'approval_request' && entry.event.approvalRequestId === requestId) ||
          (entry.event.type === 'input_request' && entry.event.inputRequestId === requestId))
      ),
  );
}

export function chatMessagesToEntries(history: ChatMessage[]): ChatEntry[] {
  const entries: ChatEntry[] = [];

  for (const message of history) {
    if (
      message.event?.type === 'request_resolved' &&
      message.event.resolvedRequestId !== undefined
    ) {
      const remaining = removeResolvedRequestEntry(entries, message.event.resolvedRequestId);
      entries.splice(0, entries.length, ...remaining);
      continue;
    }

    if (message.role === 'user') {
      entries.push({
        kind: 'user',
        content: message.content,
        attachments: message.attachments,
        id: message.id,
      });
      continue;
    }

    if (message.event?.type === 'text') {
      entries.push({
        kind: 'assistant',
        content: message.event.text ?? message.content,
        id: message.id,
        itemId: message.event.itemId,
        phase: message.event.assistantPhase,
      });
      continue;
    }

    if (message.role === 'assistant') {
      // Legacy history was persisted as one flattened assistant row without metadata.
      entries.push({ kind: 'assistant', content: message.content, id: message.id });
      continue;
    }

    if (message.event) entries.push({ kind: 'event', event: message.event });
  }

  return entries;
}

function appendLiveStreamEntry(
  entries: ChatEntry[],
  kind: LiveStreamEntryKind,
  content: string,
  metadata?: { itemId?: string; phase?: ChatAssistantPhase },
): ChatEntry[] {
  const last = entries[entries.length - 1];
  if (
    last?.kind === kind &&
    (kind !== 'assistant' ||
      (last.kind === 'assistant' &&
        last.itemId === metadata?.itemId &&
        last.phase === metadata?.phase))
  ) {
    const updated = [...entries];
    updated[updated.length - 1] = { ...last, content: last.content + content };
    return updated;
  }

  return [
    ...entries,
    kind === 'assistant'
      ? { kind, content, itemId: metadata?.itemId, phase: metadata?.phase }
      : { kind, content },
  ];
}

function appendLiveAssistantSegment(
  output: LiveAssistantOutput,
  event: CodexEvent,
): LiveAssistantOutput {
  const itemId = event.itemId;
  const existingIndex = itemId
    ? output.segments.findIndex((segment) => segment.itemId === itemId)
    : output.activeLegacySegmentId
      ? output.segments.findIndex((segment) => segment.id === output.activeLegacySegmentId)
      : -1;

  if (existingIndex >= 0) {
    const segments = [...output.segments];
    const existing = segments[existingIndex];
    segments[existingIndex] = {
      ...existing,
      phase: event.assistantPhase ?? existing.phase,
      content: existing.content + (event.text ?? ''),
    };
    return { ...output, segments };
  }

  const segment: LiveAssistantSegment = {
    id: generateId(),
    itemId,
    phase: event.assistantPhase,
    content: event.text ?? '',
    createdAt: new Date().toISOString(),
  };
  return {
    ...output,
    segments: [...output.segments, segment],
    activeLegacySegmentId: itemId ? output.activeLegacySegmentId : segment.id,
  };
}

function resolveAssistantSegmentPhases(
  segments: LiveAssistantSegment[],
  completed: boolean,
): LiveAssistantSegment[] {
  if (!completed || segments.length === 0) return segments;

  const firstUnresolvedIndex = segments.findIndex((segment) => !segment.phase);
  if (firstUnresolvedIndex < 0) return segments;

  const hasExplicitFinalAfterUnresolved = segments.some(
    (segment, index) => index > firstUnresolvedIndex && segment.phase === 'final',
  );
  let fallbackFinalIndex = -1;
  if (!hasExplicitFinalAfterUnresolved) {
    for (let index = segments.length - 1; index >= firstUnresolvedIndex; index -= 1) {
      if (!segments[index].phase) {
        fallbackFinalIndex = index;
        break;
      }
    }
  }

  return segments.map((segment, index) => ({
    ...segment,
    phase: segment.phase ?? (index === fallbackFinalIndex ? 'final' : 'progress'),
  }));
}

function resolveCompletedAssistantEntries(entries: ChatEntry[]): ChatEntry[] {
  let turnStart = entries.length - 1;
  while (turnStart >= 0 && entries[turnStart].kind !== 'user') turnStart -= 1;

  const turnEntries = entries.slice(turnStart + 1);
  const hasFinal = turnEntries.some(
    (entry) => entry.kind === 'assistant' && entry.phase === 'final',
  );
  if (hasFinal) return entries;

  const lastAssistantOffset = turnEntries.findLastIndex((entry) => entry.kind === 'assistant');
  if (lastAssistantOffset < 0) return entries;

  return entries.map((entry, index) => {
    if (index <= turnStart || entry.kind !== 'assistant' || entry.phase) return entry;
    return {
      ...entry,
      phase: index === turnStart + 1 + lastAssistantOffset ? 'final' : 'progress',
    };
  });
}

function appendBoundedTail(current: string, addition: string): string {
  return limitTail(current + addition, MAX_LIVE_COMMAND_OUTPUT_CHARS);
}

function limitMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const marker = `\n... truncated ${text.length - maxChars} chars ...\n`;
  const available = Math.max(maxChars - marker.length, 0);
  const headLength = Math.ceil(available * 0.65);
  const tailLength = available - headLength;
  return `${text.slice(0, headLength)}${marker}${tailLength > 0 ? text.slice(-tailLength) : ''}`;
}

function limitTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  const marker = `\n... truncated ${text.length - maxChars} chars ...\n`;
  const available = Math.max(maxChars - marker.length, 0);
  return `${marker}${text.slice(-available)}`;
}

let counter = 0;
function generateId(): string {
  return `${Date.now()}-${++counter}`;
}

function deriveWorkspaceChatCwd(paths: string[]): string | undefined {
  const validPaths = paths.filter((value): value is string => value.length > 0);

  if (validPaths.length === 0) return undefined;

  const directories = validPaths.map((value) => value.replace(/[\\/][^\\/]+$/, ''));
  if (directories.length === 1) return directories[0];

  const splitPaths = directories.map((value) => value.split(/[\\/]+/).filter(Boolean));
  const commonParts: string[] = [];

  for (let index = 0; index < splitPaths[0].length; index += 1) {
    const segment = splitPaths[0][index];
    if (splitPaths.every((parts) => parts[index] === segment)) {
      commonParts.push(segment);
      continue;
    }
    break;
  }

  if (commonParts.length === 0) {
    return directories[0];
  }

  const prefix = directories[0].startsWith('/') ? '/' : '';
  return `${prefix}${commonParts.join('/')}`;
}

function upsertThread(threads: ChatThread[], thread: ChatThread): ChatThread[] {
  return sortThreads([thread, ...threads.filter((candidate) => candidate.id !== thread.id)]);
}

function sortThreads(threads: ChatThread[]): ChatThread[] {
  return [...threads].sort((left, right) => {
    if (Boolean(left.settledAt) !== Boolean(right.settledAt)) {
      return left.settledAt ? 1 : -1;
    }

    if (left.settledAt && right.settledAt) {
      const settledDifference = Date.parse(right.settledAt) - Date.parse(left.settledAt);
      if (settledDifference !== 0) return settledDifference;
    }

    const createdTimeDifference = Date.parse(right.createdAt) - Date.parse(left.createdAt);
    if (createdTimeDifference !== 0) return createdTimeDifference;
    return right.id.localeCompare(left.id);
  });
}

function getThreadAttentionUpdate(
  event: CodexEvent,
): Partial<
  Pick<ChatThread, 'attentionState' | 'attentionUpdatedAt' | 'activeTurnStartedAt' | 'settledAt'>
> | null {
  const now = new Date().toISOString();
  if (event.type === 'approval_request') {
    return {
      attentionState: 'approval',
      attentionUpdatedAt: now,
      activeTurnStartedAt: undefined,
      settledAt: undefined,
    };
  }
  if (event.type === 'input_request') {
    return {
      attentionState: 'input',
      attentionUpdatedAt: now,
      activeTurnStartedAt: undefined,
      settledAt: undefined,
    };
  }
  if (event.type === 'error' || (event.type === 'status' && event.status === 'error')) {
    return {
      attentionState: 'failed',
      attentionUpdatedAt: now,
      activeTurnStartedAt: undefined,
    };
  }
  if (event.type === 'status' && (event.status === 'thinking' || event.status === 'executing')) {
    return {
      attentionState: 'working',
      attentionUpdatedAt: now,
      activeTurnStartedAt: now,
      settledAt: undefined,
    };
  }
  if (event.type === 'status' && event.status === 'complete') {
    return {
      attentionState: 'complete',
      attentionUpdatedAt: now,
      activeTurnStartedAt: undefined,
    };
  }
  if (event.type === 'thread_status') {
    if (event.threadActiveFlags?.includes('waitingOnApproval')) {
      return {
        attentionState: 'approval',
        attentionUpdatedAt: now,
        activeTurnStartedAt: undefined,
        settledAt: undefined,
      };
    }
    if (event.threadActiveFlags?.includes('waitingOnUserInput')) {
      return {
        attentionState: 'input',
        attentionUpdatedAt: now,
        activeTurnStartedAt: undefined,
        settledAt: undefined,
      };
    }
  }
  return null;
}

function sameIdList(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function getThreadPreferenceKey(workspaceId: string | null, personaId: string): string {
  return `${workspaceId ?? 'global'}:${personaId}`;
}

function getWorkItemThreadPreferenceKey(workspaceId: string | null): string {
  return `${workspaceId ?? 'global'}:workitems`;
}

const THREAD_SELECTION_STORAGE_KEY = 'anvil.chat.last-selected-threads';

function loadThreadSelectionPreferences(): Record<string, string> {
  try {
    const parsed = JSON.parse(
      window.localStorage.getItem(THREAD_SELECTION_STORAGE_KEY) ?? '{}',
    ) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}

function rememberThreadSelection(
  preferences: Record<string, string>,
  preferenceKey: string,
  threadId: string,
): void {
  preferences[preferenceKey] = threadId;
  try {
    window.localStorage.setItem(THREAD_SELECTION_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Thread continuity is useful, but storage failure should not break chat selection.
  }
}

export function threadBelongsToWorkspace(
  thread: Pick<ChatThread, 'workspaceId'>,
  workspaceId: string | null,
): boolean {
  return (thread.workspaceId ?? null) === workspaceId;
}

export function shouldSuppressPreparedChatBootstrap(
  activePersonaId: string | null,
  targetPersonaId: string,
): boolean {
  return activePersonaId !== targetPersonaId;
}

function normaliseOutgoingMessage(message: string, attachments: ChatAttachment[]): string {
  const trimmed = message.trim();
  if (trimmed) return trimmed;
  if (attachments.length === 0) return '';
  if (attachments.length === 1) return `Review ${attachments[0].name}`;
  return `Review ${attachments.length} attached files`;
}

function buildThreadPreview(message: string, attachments: ChatAttachment[]): string {
  if (attachments.length === 0) return message;
  const names = attachments.map((attachment) => attachment.name).join(', ');
  return message.trim() ? `${message.trim()} [${names}]` : `Attached: ${names}`;
}

function buildAttachmentPrompt(message: string, attachments: ChatAttachment[]): string {
  if (attachments.length === 0) return message;

  const manifest = attachments
    .map((attachment, index) =>
      [
        `${index + 1}. ${attachment.name}`,
        `kind: ${attachment.kind}`,
        `type: ${attachment.mimeType}`,
        `size: ${formatAttachmentBytes(attachment.size)}`,
        `path: ${attachment.path}`,
      ].join(' | '),
    )
    .join('\n');

  return `[Attached files]\n${manifest}\n\n${message}`;
}

function buildArtifactCanvasPrompt(threadTitle?: string): string {
  return [
    '[Canvas artifacts]',
    'When you create substantial reusable output, put it in an artifact fence so Anvil can persist it to the repo canvas.',
    'Use this exact format:',
    '```artifact:path/to/name.md kind=markdown title="Short title"',
    'content here',
    '```',
    'Supported kinds: markdown, mermaid, html, docx, pptx, pdf, csv, xlsx, code, data, text.',
    'Use artifacts for plans, review packs, diagrams, HTML prototypes, dashboards, documents, presentations, spreadsheets, specs, migration notes, and handover documents.',
    'For a binary docx, pptx, pdf, or xlsx already created under .anvil/artifacts, add encoding=file to the fence header and put a short description inside the fence. Do not inline binary data.',
    'Keep ordinary commentary outside artifact fences.',
    threadTitle ? `Current thread: ${threadTitle}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

function buildDesignChatStartOptions(
  personaId: string,
  message: string,
): Partial<ChatStartOptions> {
  if (personaId !== 'design') return {};

  const figmaContext = formatFigmaRefsForPrompt(extractFigmaRefs(message));
  return {
    designMode: loadDesignModePreference(),
    ...(figmaContext ? { figmaContext } : {}),
  };
}

function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${kilobytes.toFixed(1)} KB`;
  return `${(kilobytes / 1024).toFixed(1)} MB`;
}

function buildThreadTitle(message: string, personaName: string): string {
  const firstLine = message
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return buildEmptyThreadLabel(personaName);
  return truncate(firstLine, 56);
}

function buildEmptyThreadLabel(personaName: string): string {
  return `New ${personaName} Thread`;
}

function buildForkThreadTitle(
  currentTitle: string | undefined,
  content: string | undefined,
): string {
  if (content?.trim()) {
    return `Fork: ${truncate(content.trim(), 44)}`;
  }
  if (currentTitle) {
    return `Fork: ${truncate(currentTitle, 44)}`;
  }
  return 'Forked Thread';
}

function loadCollaborationMode(): ChatCollaborationMode {
  try {
    const stored = window.localStorage.getItem(COLLABORATION_MODE_STORAGE_KEY);
    return stored === 'plan' || stored === 'default' ? stored : 'default';
  } catch {
    return 'default';
  }
}

interface ArtifactExtractionContext {
  threadId: string;
  repoId: string | null;
  sourceMessageId: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

type ArtifactContentEncoding = NonNullable<ChatArtifactInput['contentEncoding']>;

function extractChatArtifactInputs(
  content: string,
  context: ArtifactExtractionContext,
): ChatArtifactInput[] {
  const artifacts: ChatArtifactInput[] = [];
  const fencePattern = /```artifact(?::([^\s`]+))?([^\n`]*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = fencePattern.exec(content)) !== null) {
    const headerPath = match[1]?.trim();
    const metadata = parseArtifactMetadata(match[2] ?? '');
    const artifactContent = match[3]?.replace(/\s+$/, '') ?? '';
    const relativePath = metadata.path ?? headerPath ?? buildDefaultArtifactPath(artifacts.length);
    const kind = metadata.kind ?? inferArtifactKind(relativePath);
    const title = metadata.title ?? buildArtifactTitle(relativePath);

    if (!artifactContent.trim()) continue;

    artifacts.push({
      threadId: context.threadId,
      repoId: context.repoId,
      sourceMessageId: context.sourceMessageId,
      title,
      kind,
      relativePath,
      content: artifactContent,
      contentEncoding: metadata.encoding,
      status: 'draft',
      visibility: 'local',
      source: 'assistant',
      model: context.model,
      reasoningEffort: context.reasoningEffort,
    });
  }

  return artifacts;
}

function parseArtifactMetadata(value: string): {
  path?: string;
  title?: string;
  kind?: ChatArtifactKind;
  encoding?: ArtifactContentEncoding;
} {
  const metadata: {
    path?: string;
    title?: string;
    kind?: ChatArtifactKind;
    encoding?: ArtifactContentEncoding;
  } = {};
  const tokenPattern = /(\w+)=(?:"([^"]+)"|'([^']+)'|([^\s]+))/g;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(value)) !== null) {
    const key = match[1];
    const tokenValue = match[2] ?? match[3] ?? match[4] ?? '';
    if (key === 'path') metadata.path = tokenValue;
    if (key === 'title') metadata.title = tokenValue;
    if (key === 'kind' && isChatArtifactKind(tokenValue)) metadata.kind = tokenValue;
    if (key === 'encoding' && isArtifactContentEncoding(tokenValue)) {
      metadata.encoding = tokenValue;
    }
  }

  return metadata;
}

function isChatArtifactKind(value: string): value is ChatArtifactKind {
  return (
    value === 'markdown' ||
    value === 'mermaid' ||
    value === 'code' ||
    value === 'html' ||
    value === 'docx' ||
    value === 'pptx' ||
    value === 'pdf' ||
    value === 'csv' ||
    value === 'xlsx' ||
    value === 'diagram' ||
    value === 'data' ||
    value === 'text'
  );
}

function isArtifactContentEncoding(value: string): value is ArtifactContentEncoding {
  return value === 'utf8' || value === 'base64' || value === 'file';
}

function inferArtifactKind(relativePath: string): ChatArtifactKind {
  const lower = relativePath.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.mdx')) return 'markdown';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  if (lower.endsWith('.mmd') || lower.endsWith('.mermaid')) return 'mermaid';
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.pptx')) return 'pptx';
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.xlsx')) return 'xlsx';
  if (lower.endsWith('.json') || lower.endsWith('.yaml')) return 'data';
  if (/\.(ts|tsx|js|jsx|css|sql|py|go|rs|java|cs)$/.test(lower)) return 'code';
  return 'text';
}

function buildDefaultArtifactPath(index: number): string {
  return `artifact-${index + 1}.md`;
}

function buildArtifactTitle(relativePath: string): string {
  const fileName = relativePath.split('/').filter(Boolean).pop() ?? relativePath;
  return fileName.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
}

function upsertArtifacts(existing: ChatArtifact[], nextArtifacts: ChatArtifact[]): ChatArtifact[] {
  const byId = new Map(existing.map((artifact) => [artifact.id, artifact]));
  for (const artifact of nextArtifacts) {
    byId.set(artifact.id, artifact);
  }
  return [...byId.values()];
}

function sortArtifactsByUpdatedAt(artifacts: ChatArtifact[]): ChatArtifact[] {
  return [...artifacts].sort((left, right) => {
    const leftTime = Date.parse(left.updatedAt);
    const rightTime = Date.parse(right.updatedAt);
    return rightTime - leftTime;
  });
}

function formatPlanStatus(status: ChatPlanSnapshot['steps'][number]['status']): string {
  switch (status) {
    case 'completed':
      return 'done';
    case 'in_progress':
      return 'doing';
    case 'pending':
    default:
      return 'todo';
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1).trimEnd()}…` : value;
}
