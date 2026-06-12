import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  BaFinding,
  BaFindingType,
  BaMessage,
  BaSession,
  CodexEvent,
  WorkItemCreateInput,
} from '../../shared/types';
import { extractFindings } from '../utils/finding-parser';

type BaStatus = 'idle' | 'starting' | 'ready' | 'busy' | 'error';

interface BaContextValue {
  session: BaSession | null;
  codexSessionId: string | null;
  status: BaStatus;
  findings: BaFinding[];
  messages: BaMessage[];
  streamingText: string;
  spikeDriftWarning: boolean;
  startSession: (workItemId: string, repoId: string) => Promise<void>;
  endSession: () => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  dismissFinding: (id: string) => Promise<void>;
  resolveFinding: (id: string) => Promise<void>;
  deleteFinding: (id: string) => Promise<void>;
  addManualFinding: (type: BaFindingType, content: string) => Promise<void>;
  createWorkItem: (findingId: string, input: WorkItemCreateInput) => Promise<BaFinding>;
}

const BaContext = createContext<BaContextValue | null>(null);

export function useBa(): BaContextValue {
  const ctx = useContext(BaContext);
  if (!ctx) throw new Error('useBa must be used within <BaProvider>');
  return ctx;
}

interface BaProviderProps {
  workItemId: string;
  children: ReactNode;
}

export function BaProvider({ workItemId, children }: BaProviderProps) {
  const [session, setSession] = useState<BaSession | null>(null);
  const [codexSessionId, setCodexSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<BaStatus>('idle');
  const [findings, setFindings] = useState<BaFinding[]>([]);
  const [messages, setMessages] = useState<BaMessage[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [spikeDriftWarning, setSpikeDriftWarning] = useState(false);

  // Use refs so event listeners always see latest values
  const sessionRef = useRef<BaSession | null>(null);
  sessionRef.current = session;

  const codexSessionIdRef = useRef<string | null>(null);
  codexSessionIdRef.current = codexSessionId;

  const streamingRef = useRef('');

  // Load existing findings on mount
  useEffect(() => {
    window.anvil.ba.listFindings(workItemId).then(setFindings).catch(console.error);
  }, [workItemId]);

  // Register BA event listener ONCE
  useEffect(() => {
    const cleanup = window.anvil.ba.onEvent((event: CodexEvent) => {
      if (event.type === 'text' && event.text) {
        streamingRef.current += event.text;
        setStreamingText(streamingRef.current);
      } else if (event.type === 'status' && event.status === 'complete') {
        const fullText = streamingRef.current;
        streamingRef.current = '';
        setStreamingText('');
        setStatus('ready');

        // Extract findings from the completed response
        const extracted = extractFindings(fullText);
        const sess = sessionRef.current;
        if (extracted.length > 0 && sess) {
          const persistFindings = async () => {
            const newFindings: BaFinding[] = [];
            for (const f of extracted) {
              try {
                const created = await window.anvil.ba.createFinding({
                  workItemId: sess.workItemId,
                  repoId: sess.repoId,
                  sessionId: sess.id,
                  type: f.type,
                  content: f.content,
                });
                newFindings.push(created);
              } catch (err) {
                console.error('Failed to persist finding:', err);
              }
            }
            if (newFindings.length > 0) {
              setFindings((prev) => [...prev, ...newFindings]);
            }
          };
          persistFindings();
        }

        // Save assistant message
        if (fullText.trim() && sess) {
          window.anvil.ba
            .saveMessage({
              sessionId: sess.id,
              role: 'assistant',
              content: fullText,
            })
            .then((msg) => {
              setMessages((prev) => [...prev, msg]);
            })
            .catch(console.error);
        }
      } else if (event.type === 'status' && event.status === 'error') {
        setStatus('error');
        streamingRef.current = '';
        setStreamingText('');
      }
    });
    return cleanup;
  }, []);

  // Register spike drift listener
  useEffect(() => {
    const cleanup = window.anvil.ba.onSpikeDrift((data) => {
      if (data.workItemId === workItemId) {
        setSpikeDriftWarning(true);
      }
    });
    return cleanup;
  }, [workItemId]);

  const startSession = useCallback(async (wiId: string, repoId: string) => {
    setStatus('starting');
    try {
      const result = await window.anvil.ba.startSession(wiId, repoId);
      setSession(result.session);
      setCodexSessionId(result.codexSession.id);
      setStatus('ready');

      // Save the repo link for next time
      await window.anvil.ba.setRepoLink(wiId, repoId).catch(console.error);

      // Load previous messages if resuming an existing session
      const prevMessages = await window.anvil.ba.loadMessages(result.session.id);
      if (prevMessages.length > 0) {
        setMessages(prevMessages);
      }
    } catch (err) {
      console.error('Failed to start BA session:', err);
      setStatus('error');
    }
  }, []);

  const endSession = useCallback(async () => {
    const sess = sessionRef.current;
    if (sess) {
      try {
        await window.anvil.ba.endSession(sess.id);
      } catch (err) {
        console.error('Failed to end BA session:', err);
      }
    }
    setSession(null);
    setCodexSessionId(null);
    setStatus('idle');
    setMessages([]);
    setStreamingText('');
    streamingRef.current = '';
  }, []);

  const sendMessage = useCallback(async (text: string) => {
    const sess = sessionRef.current;
    const cId = codexSessionIdRef.current;
    if (!sess || !cId) return;

    setStatus('busy');

    // Save user message
    try {
      const saved = await window.anvil.ba.saveMessage({
        sessionId: sess.id,
        role: 'user',
        content: text,
      });
      setMessages((prev) => [...prev, saved]);
    } catch (err) {
      console.error('Failed to save user message:', err);
    }

    // Send to Codex
    try {
      await window.anvil.chat.send(cId, text);
    } catch (err) {
      console.error('Failed to send to Codex:', err);
      setStatus('error');
    }
  }, []);

  const dismissFinding = useCallback(async (id: string) => {
    await window.anvil.ba.updateFinding(id, { status: 'dismissed' });
    setFindings((prev) =>
      prev.map((f) =>
        f.id === id
          ? { ...f, status: 'dismissed' as const, updatedAt: new Date().toISOString() }
          : f,
      ),
    );
  }, []);

  const resolveFinding = useCallback(async (id: string) => {
    await window.anvil.ba.updateFinding(id, { status: 'resolved' });
    setFindings((prev) =>
      prev.map((f) =>
        f.id === id
          ? { ...f, status: 'resolved' as const, updatedAt: new Date().toISOString() }
          : f,
      ),
    );
  }, []);

  const deleteFinding = useCallback(async (id: string) => {
    await window.anvil.ba.deleteFinding(id);
    setFindings((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const addManualFinding = useCallback(
    async (type: BaFindingType, content: string) => {
      const sess = sessionRef.current;
      const finding = await window.anvil.ba.createFinding({
        workItemId,
        repoId: sess?.repoId ?? '',
        sessionId: sess?.id,
        type,
        content,
      });
      setFindings((prev) => [...prev, finding]);
    },
    [workItemId],
  );

  const createWorkItem = useCallback(async (findingId: string, input: WorkItemCreateInput) => {
    const updated = await window.anvil.ba.createWorkItem(findingId, input);
    setFindings((prev) => prev.map((finding) => (finding.id === findingId ? updated : finding)));
    return updated;
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      const sess = sessionRef.current;
      if (sess) {
        window.anvil.ba.endSession(sess.id).catch(console.error);
      }
    };
  }, []);

  // Cleanup on beforeunload
  useEffect(() => {
    const handler = () => {
      const sess = sessionRef.current;
      if (sess) {
        window.anvil.ba.endSession(sess.id).catch(console.error);
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  return (
    <BaContext.Provider
      value={{
        session,
        codexSessionId,
        status,
        findings,
        messages,
        streamingText,
        spikeDriftWarning,
        startSession,
        endSession,
        sendMessage,
        dismissFinding,
        resolveFinding,
        deleteFinding,
        addManualFinding,
        createWorkItem,
      }}
    >
      {children}
    </BaContext.Provider>
  );
}
