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
import { AppState, Linking } from 'react-native';
import { router, type RelativePathString } from 'expo-router';
import type {
  ChatMessage,
  ChatAttachment,
  ChatAttachmentInput,
  ChatFileMentionSearchResult,
  CodexRegisteredSkill,
  MobileApprovalRequest,
  MobileChatThreadSummary,
  MobileOverview,
  MobileStartChatInput,
  MobileStartChatResult,
  MobileWorkspaceSignalDetail,
} from '../../src/shared/types';
import {
  activateConnection,
  clearConnection,
  fetchOverview,
  fetchChatSkills,
  fetchThreadHistory,
  fetchWorkspaceSignalDetail,
  interruptSession,
  loadConnectionState,
  openDesktop,
  pairWithDesktop,
  prepareChatAttachments,
  parsePairingPayload,
  removeConnection,
  resolveApproval,
  resolveApprovalByKey,
  saveConnection,
  searchChatFileMentions,
  sendThreadMessage,
  startWorkflow as startCompanionWorkflow,
  subscribeToCompanionEvents,
  type CompanionConnection,
} from '@/lib/anvil-api';
import {
  clearLiveActivitySnapshot,
  clearWidgetSnapshot,
  publishLiveActivitySnapshot,
  publishConnectionWidgetSnapshot,
  publishWidgetSnapshot,
  replyToWatchRequest,
  subscribeToWatchRequests,
  type WatchRequestEvent,
} from '@/lib/widget-bridge';
import { publishDriveModeState } from '@/lib/drive-mode-bridge';
import {
  loadCachedOverview,
  loadSelectedWorkspaceId,
  saveCachedOverview,
  saveSelectedWorkspaceId,
} from '@/lib/companion-cache';

interface CompanionContextValue {
  connection: CompanionConnection | null;
  connections: CompanionConnection[];
  overview: MobileOverview | null;
  selectedWorkspaceId: string | null;
  usingCachedOverview: boolean;
  threads: MobileChatThreadSummary[];
  selectedThreadId: string | null;
  selectedThreadHistory: ChatMessage[];
  loading: boolean;
  live: boolean;
  lastUpdatedAt: string | null;
  error: string | null;
  pairFromQr: (rawQrPayload: string, deviceName: string) => Promise<void>;
  setManualConnection: (
    connection: Pick<CompanionConnection, 'baseUrl' | 'token' | 'deviceName'> &
      Partial<CompanionConnection>,
  ) => Promise<void>;
  selectHost: (connectionId: string) => Promise<void>;
  forgetHost: (connectionId: string) => Promise<void>;
  disconnect: () => Promise<void>;
  refresh: () => Promise<void>;
  selectWorkspace: (workspaceId: string) => Promise<void>;
  followDesktopWorkspace: () => Promise<void>;
  selectThread: (threadId: string) => Promise<void>;
  startWorkflow: (input: MobileStartChatInput) => Promise<MobileStartChatResult | null>;
  sendMessage: (
    threadId: string,
    sessionId: string | undefined,
    input: string | Parameters<typeof sendThreadMessage>[3],
  ) => Promise<void>;
  prepareAttachments: (attachments: ChatAttachmentInput[]) => Promise<ChatAttachment[]>;
  searchFiles: (input: {
    repoIds: string[];
    query?: string;
    limit?: number;
  }) => Promise<ChatFileMentionSearchResult[]>;
  searchSkills: (query?: string) => Promise<CodexRegisteredSkill[]>;
  fetchSignalDetail: (signalId: string) => Promise<MobileWorkspaceSignalDetail | null>;
  resolve: (
    approval: MobileApprovalRequest,
    decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
  ) => Promise<void>;
  interrupt: (sessionId: string) => Promise<void>;
  openOnDesktop: () => Promise<void>;
}

const CompanionContext = createContext<CompanionContextValue | null>(null);

export function CompanionProvider({ children }: { children: ReactNode }) {
  const [connection, setConnection] = useState<CompanionConnection | null>(null);
  const [connections, setConnections] = useState<CompanionConnection[]>([]);
  const [overview, setOverview] = useState<MobileOverview | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [usingCachedOverview, setUsingCachedOverview] = useState(false);
  const [threads, setThreads] = useState<MobileChatThreadSummary[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [selectedThreadHistory, setSelectedThreadHistory] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const overviewRef = useRef<MobileOverview | null>(null);

  const publishPairedHostSnapshot = useCallback(
    (
      nextConnection: CompanionConnection | null = connection,
      nextConnectionCount = connections.length,
    ) => {
      if (nextConnection || nextConnectionCount > 0) {
        void publishConnectionWidgetSnapshot(nextConnection, nextConnectionCount);
        return;
      }
      void clearWidgetSnapshot();
    },
    [connection, connections.length],
  );

  const applyOverview = useCallback((nextOverview: MobileOverview, cached = false) => {
    overviewRef.current = nextOverview;
    setOverview(nextOverview);
    setThreads(nextOverview.threads);
    setLastUpdatedAt(nextOverview.generatedAt);
    setUsingCachedOverview(cached);
    void publishWidgetSnapshot(nextOverview);
    void publishLiveActivitySnapshot(nextOverview);
  }, []);

  const refresh = useCallback(async () => {
    if (!connection) {
      overviewRef.current = null;
      setOverview(null);
      setThreads([]);
      setLoading(false);
      setLive(false);
      publishPairedHostSnapshot(null, connections.length);
      void clearLiveActivitySnapshot();
      void publishDriveModeState(null);
      return;
    }

    setError(null);
    try {
      const nextOverview = await fetchOverview(connection, selectedWorkspaceId);
      applyOverview(nextOverview);
      void saveCachedOverview(connection.id, nextOverview);
      void publishDriveModeState(connection);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to reach Anvil on your Mac.');
      if (!overviewRef.current) {
        const cached = await loadCachedOverview(connection.id);
        if (cached) applyOverview(cached, true);
      }
      publishPairedHostSnapshot(connection, connections.length);
    } finally {
      setLoading(false);
    }
  }, [
    applyOverview,
    connection,
    connections.length,
    publishPairedHostSnapshot,
    selectedWorkspaceId,
  ]);

  useEffect(() => {
    if (!connection) {
      setSelectedWorkspaceId(null);
      return;
    }
    let cancelled = false;
    void loadSelectedWorkspaceId(connection.id).then((workspaceId) => {
      if (!cancelled) setSelectedWorkspaceId(workspaceId);
    });
    return () => {
      cancelled = true;
    };
  }, [connection]);

  const selectWorkspace = useCallback(
    async (workspaceId: string) => {
      if (!connection || workspaceId === selectedWorkspaceId) return;
      setSelectedWorkspaceId(workspaceId);
      await saveSelectedWorkspaceId(connection.id, workspaceId);
    },
    [connection, selectedWorkspaceId],
  );

  const followDesktopWorkspace = useCallback(async () => {
    if (!connection || selectedWorkspaceId === null) return;
    setSelectedWorkspaceId(null);
    await saveSelectedWorkspaceId(connection.id, null);
  }, [connection, selectedWorkspaceId]);

  useEffect(() => {
    let cancelled = false;
    loadConnectionState()
      .then((state) => {
        if (cancelled) return;
        const activeConnection =
          state.connections.find((candidate) => candidate.id === state.activeConnectionId) ?? null;
        setConnections(state.connections);
        setConnection(activeConnection);
        if (state.connections.length > 0) {
          void publishConnectionWidgetSnapshot(activeConnection, state.connections.length);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load pairings.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void refresh();
    if (!connection) return;
    const health = overview?.workflow?.health;
    const intervalMs = health === 'busy' || health === 'needs-approval' ? 2_500 : 12_000;
    const interval = setInterval(() => void refresh(), intervalMs);
    return () => clearInterval(interval);
  }, [connection, overview?.workflow?.health, refresh]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  const pairFromQr = useCallback(async (rawQrPayload: string, deviceName: string) => {
    setLoading(true);
    setError(null);
    try {
      const payload = parsePairingPayload(rawQrPayload);
      const nextConnection = await pairWithDesktop(payload, deviceName);
      const state = await loadConnectionState();
      setConnections(state.connections);
      setConnection(nextConnection);
      await publishConnectionWidgetSnapshot(nextConnection, state.connections.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pairing failed.');
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const setManualConnection = useCallback(
    async (
      nextConnection: Pick<CompanionConnection, 'baseUrl' | 'token' | 'deviceName'> &
        Partial<CompanionConnection>,
    ) => {
      await saveConnection(nextConnection);
      const state = await loadConnectionState();
      const activeConnection =
        state.connections.find((candidate) => candidate.id === state.activeConnectionId) ?? null;
      setConnections(state.connections);
      setConnection(activeConnection);
      await publishConnectionWidgetSnapshot(activeConnection, state.connections.length);
    },
    [],
  );

  const resetHostState = useCallback(
    async (
      nextConnection: CompanionConnection | null = connection,
      nextConnectionCount = connections.length,
    ) => {
      overviewRef.current = null;
      setOverview(null);
      setThreads([]);
      setSelectedThreadId(null);
      setSelectedThreadHistory([]);
      setLastUpdatedAt(null);
      setLive(false);
      if (nextConnection || nextConnectionCount > 0) {
        await publishConnectionWidgetSnapshot(nextConnection, nextConnectionCount);
      } else {
        await clearWidgetSnapshot();
      }
      await clearLiveActivitySnapshot();
      await publishDriveModeState(null);
    },
    [connection, connections.length],
  );

  const selectHost = useCallback(
    async (connectionId: string) => {
      const nextConnection = await activateConnection(connectionId);
      const state = await loadConnectionState();
      setConnections(state.connections);
      setConnection(nextConnection);
      await resetHostState(nextConnection, state.connections.length);
    },
    [resetHostState],
  );

  const forgetHost = useCallback(
    async (connectionId: string) => {
      const nextState = await removeConnection(connectionId);
      const activeConnection =
        nextState.connections.find((candidate) => candidate.id === nextState.activeConnectionId) ??
        null;
      setConnections(nextState.connections);
      setConnection(activeConnection);
      if (connection?.id === connectionId)
        await resetHostState(activeConnection, nextState.connections.length);
    },
    [connection?.id, resetHostState],
  );

  const disconnect = useCallback(async () => {
    await clearConnection();
    const state = await loadConnectionState();
    const activeConnection =
      state.connections.find((candidate) => candidate.id === state.activeConnectionId) ?? null;
    setConnections(state.connections);
    setConnection(activeConnection);
    await resetHostState(activeConnection, state.connections.length);
  }, [resetHostState]);

  const selectThread = useCallback(
    async (threadId: string) => {
      if (!connection) return;
      setSelectedThreadId(threadId);
      setError(null);
      try {
        setSelectedThreadHistory(await fetchThreadHistory(connection, threadId));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load chat history.');
      }
    },
    [connection],
  );

  const startWorkflow = useCallback(
    async (input: MobileStartChatInput): Promise<MobileStartChatResult | null> => {
      if (!connection) return null;
      setLoading(true);
      setError(null);
      try {
        const result = await startCompanionWorkflow(connection, input);
        await refresh();
        setSelectedThreadId(result.thread.id);
        setSelectedThreadHistory(await fetchThreadHistory(connection, result.thread.id));
        return result;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to start remote workflow.');
        return null;
      } finally {
        setLoading(false);
      }
    },
    [connection, refresh],
  );

  useEffect(() => {
    if (!connection) return;

    const handleUrl = (url: string | null) => {
      const action = parseCompanionUrl(url);
      if (!action) return;
      if (action.type === 'workflow') {
        void startWorkflow({
          actionId: action.actionId,
          workspaceId: action.workspaceId ?? selectedWorkspaceId ?? undefined,
        });
        return;
      }
      router.navigate(action.route);
    };

    void Linking.getInitialURL().then(handleUrl);
    const subscription = Linking.addEventListener('url', (event) => handleUrl(event.url));
    return () => subscription.remove();
  }, [connection, selectedWorkspaceId, startWorkflow]);

  useEffect(() => {
    if (!connection) {
      setLive(false);
      return;
    }

    return subscribeToCompanionEvents(
      connection,
      (event) => {
        setLive(true);
        if (event.type !== 'ready' && event.type !== 'heartbeat') {
          void refresh();
          if (selectedThreadId) void selectThread(selectedThreadId);
        }
      },
      () => setLive(false),
    );
  }, [connection, refresh, selectThread, selectedThreadId]);

  const handleWatchRequest = useCallback(
    async (event: WatchRequestEvent) => {
      if (!connection) {
        await replyToWatchRequest(event.requestId, null);
        return;
      }

      try {
        const message = event.message ?? {};
        if (message.type === 'resolveApproval') {
          const sessionId = stringValue(message.sessionId);
          const requestKey = stringValue(message.requestKey);
          const decision = watchDecision(message.decision);
          if (sessionId && requestKey && decision) {
            await resolveApprovalByKey(connection, sessionId, requestKey, decision);
          }
        } else if (message.type === 'sendMessage') {
          const threadId = stringValue(message.threadId);
          const text = stringValue(message.message);
          if (threadId && text) {
            await sendThreadMessage(
              connection,
              threadId,
              stringValue(message.activeSessionId),
              text,
            );
          }
        } else if (message.type === 'interrupt') {
          const sessionId = stringValue(message.sessionId);
          if (sessionId) await interruptSession(connection, sessionId);
        }

        const nextOverview = await fetchOverview(connection, selectedWorkspaceId);
        applyOverview(nextOverview);
        await replyToWatchRequest(event.requestId, nextOverview);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Watch relay failed.');
        await replyToWatchRequest(event.requestId, overviewRef.current);
      }
    },
    [applyOverview, connection, selectedWorkspaceId],
  );

  useEffect(() => {
    if (!connection) return;
    return subscribeToWatchRequests(handleWatchRequest);
  }, [connection, handleWatchRequest]);

  const sendMessage = useCallback(
    async (
      threadId: string,
      sessionId: string | undefined,
      input: string | Parameters<typeof sendThreadMessage>[3],
    ) => {
      if (!connection) return;
      setError(null);
      try {
        await sendThreadMessage(connection, threadId, sessionId, input);
        await Promise.all([refresh(), selectThread(threadId)]);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to send message.');
        throw err;
      }
    },
    [connection, refresh, selectThread],
  );

  const prepareAttachments = useCallback(
    async (attachments: ChatAttachmentInput[]): Promise<ChatAttachment[]> => {
      if (!connection) return [];
      return prepareChatAttachments(connection, attachments);
    },
    [connection],
  );

  const searchFiles = useCallback(
    async (input: {
      repoIds: string[];
      query?: string;
      limit?: number;
    }): Promise<ChatFileMentionSearchResult[]> => {
      if (!connection) return [];
      return searchChatFileMentions(connection, input);
    },
    [connection],
  );

  const searchSkills = useCallback(
    async (query = ''): Promise<CodexRegisteredSkill[]> => {
      if (!connection) return [];
      return fetchChatSkills(connection, query);
    },
    [connection],
  );

  const fetchSignalDetail = useCallback(
    async (signalId: string): Promise<MobileWorkspaceSignalDetail | null> => {
      if (!connection) return null;
      try {
        return await fetchWorkspaceSignalDetail(connection, signalId);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load signal detail.');
        return null;
      }
    },
    [connection],
  );

  const resolve = useCallback(
    async (
      approval: MobileApprovalRequest,
      decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
    ) => {
      if (!connection) return;
      await resolveApproval(connection, approval, decision);
      await refresh();
    },
    [connection, refresh],
  );

  const interrupt = useCallback(
    async (sessionId: string) => {
      if (!connection) return;
      await interruptSession(connection, sessionId);
      await refresh();
    },
    [connection, refresh],
  );

  const openOnDesktop = useCallback(async () => {
    if (!connection) return;
    await openDesktop(connection);
  }, [connection]);

  const value = useMemo(
    () => ({
      connection,
      connections,
      overview,
      selectedWorkspaceId,
      usingCachedOverview,
      threads,
      selectedThreadId,
      selectedThreadHistory,
      loading,
      live,
      lastUpdatedAt,
      error,
      pairFromQr,
      setManualConnection,
      selectHost,
      forgetHost,
      disconnect,
      refresh,
      selectWorkspace,
      followDesktopWorkspace,
      selectThread,
      startWorkflow,
      sendMessage,
      prepareAttachments,
      searchFiles,
      searchSkills,
      fetchSignalDetail,
      resolve,
      interrupt,
      openOnDesktop,
    }),
    [
      connection,
      connections,
      disconnect,
      error,
      fetchSignalDetail,
      interrupt,
      lastUpdatedAt,
      live,
      loading,
      openOnDesktop,
      overview,
      selectedWorkspaceId,
      usingCachedOverview,
      pairFromQr,
      refresh,
      resolve,
      forgetHost,
      followDesktopWorkspace,
      selectThread,
      selectHost,
      selectWorkspace,
      selectedThreadHistory,
      selectedThreadId,
      sendMessage,
      prepareAttachments,
      searchFiles,
      searchSkills,
      setManualConnection,
      startWorkflow,
      threads,
    ],
  );

  return <CompanionContext.Provider value={value}>{children}</CompanionContext.Provider>;
}

export function useCompanion(): CompanionContextValue {
  const value = useContext(CompanionContext);
  if (!value) throw new Error('useCompanion must be used inside CompanionProvider');
  return value;
}

function parseCompanionUrl(url: string | null):
  | { type: 'workflow'; actionId: string; workspaceId?: string }
  | {
      type: 'route';
      route: RelativePathString | '/(tabs)' | '/(tabs)/approvals' | '/(tabs)/settings';
    }
  | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const parts = [parsed.hostname, ...parsed.pathname.split('/').filter(Boolean)].filter(Boolean);
    if (parts[0] === 'workflow' && parts[1]) {
      return {
        type: 'workflow',
        actionId: parts[1],
        workspaceId: parsed.searchParams.get('workspaceId') ?? undefined,
      };
    }
    if (parts[0] === 'approvals') return { type: 'route', route: '/(tabs)/approvals' };
    if (parts[0] === 'chats' && parts[1]) {
      return {
        type: 'route',
        route: `/(tabs)/chats/${encodeURIComponent(parts[1])}` as RelativePathString,
      };
    }
    if (parts[0] === 'chats')
      return { type: 'route', route: '/(tabs)/chats' as RelativePathString };
    if (parts[0] === 'health' && parts[1]) {
      return {
        type: 'route',
        route: `/(tabs)/health/${encodeURIComponent(parts[1])}` as RelativePathString,
      };
    }
    if (parts[0] === 'settings') return { type: 'route', route: '/(tabs)/settings' };
    if (parts[0] === 'work')
      return {
        type: 'route',
        route: '/(tabs)',
      };
    return null;
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function watchDecision(
  value: unknown,
): 'accept' | 'acceptForSession' | 'decline' | 'cancel' | undefined {
  return value === 'accept' ||
    value === 'acceptForSession' ||
    value === 'decline' ||
    value === 'cancel'
    ? value
    : undefined;
}
