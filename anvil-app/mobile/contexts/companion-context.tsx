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
import type {
  ChatMessage,
  MobileApprovalRequest,
  MobileChatThreadSummary,
  MobileOverview,
  MobileStartChatInput,
  MobileStartChatResult,
} from '../../src/shared/types';
import {
  clearConnection,
  fetchOverview,
  fetchThreadHistory,
  interruptSession,
  loadConnection,
  openDesktop,
  pairWithDesktop,
  parsePairingPayload,
  resolveApproval,
  resolveApprovalByKey,
  saveConnection,
  sendThreadMessage,
  startWorkflow as startCompanionWorkflow,
  subscribeToCompanionEvents,
  type CompanionConnection,
} from '@/lib/anvil-api';
import {
  clearWidgetSnapshot,
  publishWidgetSnapshot,
  replyToWatchRequest,
  subscribeToWatchRequests,
  type WatchRequestEvent,
} from '@/lib/widget-bridge';
import { publishDriveModeState } from '@/lib/drive-mode-bridge';

interface CompanionContextValue {
  connection: CompanionConnection | null;
  overview: MobileOverview | null;
  threads: MobileChatThreadSummary[];
  selectedThreadId: string | null;
  selectedThreadHistory: ChatMessage[];
  loading: boolean;
  live: boolean;
  lastUpdatedAt: string | null;
  error: string | null;
  pairFromQr: (rawQrPayload: string, deviceName: string) => Promise<void>;
  setManualConnection: (connection: CompanionConnection) => Promise<void>;
  disconnect: () => Promise<void>;
  refresh: () => Promise<void>;
  selectThread: (threadId: string) => Promise<void>;
  startWorkflow: (input: MobileStartChatInput) => Promise<MobileStartChatResult | null>;
  sendMessage: (threadId: string, sessionId: string | undefined, message: string) => Promise<void>;
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
  const [overview, setOverview] = useState<MobileOverview | null>(null);
  const [threads, setThreads] = useState<MobileChatThreadSummary[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [selectedThreadHistory, setSelectedThreadHistory] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const overviewRef = useRef<MobileOverview | null>(null);

  const applyOverview = useCallback((nextOverview: MobileOverview) => {
    overviewRef.current = nextOverview;
    setOverview(nextOverview);
    setThreads(nextOverview.threads);
    setLastUpdatedAt(nextOverview.generatedAt);
    void publishWidgetSnapshot(nextOverview);
  }, []);

  const refresh = useCallback(async () => {
    if (!connection) {
      overviewRef.current = null;
      setOverview(null);
      setThreads([]);
      setLoading(false);
      setLive(false);
      void clearWidgetSnapshot();
      void publishDriveModeState(null);
      return;
    }

    setError(null);
    try {
      const nextOverview = await fetchOverview(connection);
      applyOverview(nextOverview);
      void publishDriveModeState(connection);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to reach Anvil on your Mac.');
    } finally {
      setLoading(false);
    }
  }, [applyOverview, connection]);

  useEffect(() => {
    let cancelled = false;
    loadConnection()
      .then((saved) => {
        if (!cancelled) setConnection(saved);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load pairing.');
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
      setConnection(nextConnection);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pairing failed.');
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const setManualConnection = useCallback(async (nextConnection: CompanionConnection) => {
    await saveConnection(nextConnection);
    setConnection(nextConnection);
  }, []);

  const disconnect = useCallback(async () => {
    await clearConnection();
    setConnection(null);
    overviewRef.current = null;
    setOverview(null);
    setThreads([]);
    setSelectedThreadId(null);
    setSelectedThreadHistory([]);
    setLastUpdatedAt(null);
    setLive(false);
    await clearWidgetSnapshot();
    await publishDriveModeState(null);
  }, []);

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
      const actionId = extractWorkflowActionId(url);
      if (actionId) void startWorkflow({ actionId });
    };

    void Linking.getInitialURL().then(handleUrl);
    const subscription = Linking.addEventListener('url', (event) => handleUrl(event.url));
    return () => subscription.remove();
  }, [connection, startWorkflow]);

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
        }
      },
      () => setLive(false),
    );
  }, [connection, refresh]);

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

        const nextOverview = await fetchOverview(connection);
        applyOverview(nextOverview);
        await replyToWatchRequest(event.requestId, nextOverview);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Watch relay failed.');
        await replyToWatchRequest(event.requestId, overviewRef.current);
      }
    },
    [applyOverview, connection],
  );

  useEffect(() => {
    if (!connection) return;
    return subscribeToWatchRequests(handleWatchRequest);
  }, [connection, handleWatchRequest]);

  const sendMessage = useCallback(
    async (threadId: string, sessionId: string | undefined, message: string) => {
      if (!connection) return;
      await sendThreadMessage(connection, threadId, sessionId, message);
      await Promise.all([refresh(), selectThread(threadId)]);
    },
    [connection, refresh, selectThread],
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
      overview,
      threads,
      selectedThreadId,
      selectedThreadHistory,
      loading,
      live,
      lastUpdatedAt,
      error,
      pairFromQr,
      setManualConnection,
      disconnect,
      refresh,
      selectThread,
      startWorkflow,
      sendMessage,
      resolve,
      interrupt,
      openOnDesktop,
    }),
    [
      connection,
      disconnect,
      error,
      interrupt,
      lastUpdatedAt,
      live,
      loading,
      openOnDesktop,
      overview,
      pairFromQr,
      refresh,
      resolve,
      selectThread,
      selectedThreadHistory,
      selectedThreadId,
      sendMessage,
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

function extractWorkflowActionId(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const parts = [parsed.hostname, ...parsed.pathname.split('/').filter(Boolean)].filter(Boolean);
    if (parts[0] !== 'workflow') return null;
    return parts[1] ?? null;
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
