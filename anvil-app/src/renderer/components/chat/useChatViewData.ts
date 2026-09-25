import { useEffect, useState } from 'react';
import type { AgentRunSummary, CodexSession } from '../../../shared/types';
import { pollWhileVisible } from '../../utils/visible-polling';
import { applyExecutionLifecycle } from '../../utils/execution-topology';

/**
 * Data subscriptions for ChatView — extracted (Phase 5 split):
 * active session polling, recent agent-run polling, and the execution
 * lifecycle event reducer that feeds the Activity panel topology.
 */
export function useChatViewData(activeWorkspaceId: string | undefined) {
  const [recentRuns, setRecentRuns] = useState<AgentRunSummary[]>([]);
  const [activeSessions, setActiveSessions] = useState<CodexSession[]>([]);
  const [executionSessionStates, setExecutionSessionStates] = useState<
    Parameters<typeof applyExecutionLifecycle>[0]
  >({});

  useEffect(
    () =>
      window.anvil.chat.onEvent((event) => {
        setExecutionSessionStates((states) => applyExecutionLifecycle(states, event));
      }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      return window.anvil.chat
        .listActiveSessions()
        .then((sessions) => {
          if (!cancelled) setActiveSessions(sessions.filter((item) => item.status !== 'error'));
        })
        .catch(() => {
          if (!cancelled) setActiveSessions([]);
        });
    };
    const stop = pollWhileVisible(refresh, 5000);
    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  useEffect(() => {
    if (!activeWorkspaceId) {
      setRecentRuns([]);
      return;
    }

    let cancelled = false;
    const refresh = () => {
      return window.anvil.agentRuns
        .list(activeWorkspaceId, 20)
        .then((runs) => {
          if (!cancelled) setRecentRuns(runs);
        })
        .catch(() => {
          if (!cancelled) setRecentRuns([]);
        });
    };
    const stop = pollWhileVisible(refresh, 10_000);
    return () => {
      cancelled = true;
      stop();
    };
  }, [activeWorkspaceId]);

  return { recentRuns, activeSessions, executionSessionStates, setExecutionSessionStates };
}
