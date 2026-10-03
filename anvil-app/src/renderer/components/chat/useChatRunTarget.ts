import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentProvider,
  ChatAttachment,
  CodexMode,
  CodexSession,
  ReasoningEffort,
} from '../../../shared/types';
import type { RemoteChatRecord, RemoteCredentialChoice } from '../../../shared/remote-chat';
import type { CloudAgentProviderStatus } from '../../../shared/cloud-agent';
import type { ApprovalRecord, SyncAttemptActivity, SyncDevice } from '../../../shared/sync-runtime';

export const HOSTED_CHAT_TARGET = 'anvil-hosted-cloud';
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'paused', 'ended']);

export function useChatRunTarget(input: {
  workspaceId?: string;
  threadId: string | null;
  sourceSessionId?: string;
  provider: AgentProvider;
  model: string;
  permissionMode: CodexMode;
  reasoningEffort: ReasoningEffort;
  ensureThread: (firstPrompt?: string) => Promise<string>;
}) {
  const [target, updateTarget] = useState('local');
  const [devices, setDevices] = useState<SyncDevice[]>([]);
  const [providers, setProviders] = useState<CloudAgentProviderStatus[]>([]);
  const [records, setRecords] = useState<RemoteChatRecord[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credentialChoice, setCredentialChoice] =
    useState<RemoteCredentialChoice>('codex-host-auth');
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [activity, setActivity] = useState<SyncAttemptActivity[]>([]);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [legacyId, setLegacyId] = useState<string | null>(null);
  const [sessionLimitSeconds, setSessionLimitSeconds] = useState<number | null>(null);
  const pending = useRef<{ key: string; id: string } | null>(null);
  const scope = useRef(input.workspaceId);
  scope.current = input.workspaceId;
  const record = records.find(
    (row) =>
      (input.threadId && row.sourceThreadId === input.threadId) ||
      (input.sourceSessionId && row.sourceSessionId === input.sourceSessionId) ||
      row.id === legacyId,
  );
  const remote = target !== 'local' || record !== undefined || sending;
  const busy = sending || (record !== undefined && !TERMINAL.has(record.state));
  const hosted = target === HOSTED_CHAT_TARGET || record?.environmentId !== undefined;
  const provider = providers.find((item) => item.provider === input.provider);
  const providerReady =
    provider?.enabled === true && (input.provider === 'codex' || provider.connected);
  const setTarget = (next: string) => {
    updateTarget(next);
    setCredentialChoice(next === HOSTED_CHAT_TARGET ? 'codex-host-auth' : 'target-local');
  };

  useEffect(() => {
    let disposed = false;
    setSessionLimitSeconds(null);
    if (!hosted) return;
    void window.anvil.syncRuntime.getManagedEnvironmentLimits().then(
      (limits) => {
        if (!disposed) setSessionLimitSeconds(limits.maxTtlSeconds);
      },
      () => {
        // Launch reports sign-in and entitlement failures through its normal error path.
      },
    );
    return () => {
      disposed = true;
    };
  }, [hosted, input.workspaceId]);

  useEffect(() => {
    let disposed = false;
    let fetching = false;
    setRecords([]);
    setDevices([]);
    updateTarget('local');
    setError(null);
    pending.current = null;
    setLegacyId(null);
    if (!input.workspaceId) return;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const [chats, roster, settings] = await Promise.allSettled([
          window.anvil.syncRuntime.listRemoteChats(input.workspaceId),
          window.anvil.syncRuntime.listDevices(),
          window.anvil.cloudAgentSettings.get(),
        ]);
        if (disposed) return;
        if (chats.status === 'fulfilled') setRecords(chats.value);
        if (roster.status === 'fulfilled')
          setDevices(
            roster.value.filter(
              (device) =>
                !device.self &&
                !device.revoked &&
                device.trustState === 'trusted' &&
                device.enrollmentClass !== 'ephemeral',
            ),
          );
        if (settings.status === 'fulfilled') setProviders(settings.value.providers);
      } catch {
        // Local chat remains usable before the user signs into Sync & Mesh.
      } finally {
        fetching = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [input.workspaceId]);

  useEffect(() => setLegacyId(null), [input.threadId]);

  useEffect(() => {
    setError(null);
    if (sending && !record) return;
    updateTarget(
      record ? (record.environmentId ? HOSTED_CHAT_TARGET : record.targetEnrollmentId) : 'local',
    );
  }, [input.threadId, record?.id, record?.environmentId, record?.targetEnrollmentId, sending]);

  const jobId = record?.jobId ?? record?.prepareJobId;
  useEffect(() => {
    let disposed = false;
    let fetching = false;
    setApprovals([]);
    setAttemptId(null);
    if (!jobId) return;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const [job, requests] = await Promise.all([
          window.anvil.syncRuntime.getMeshJob(jobId),
          window.anvil.syncRuntime.getMeshApprovals(jobId),
        ]);
        if (!disposed) {
          setAttemptId(job.attempts.at(-1)?.id ?? null);
          setApprovals(requests.filter((item) => item.state === 'pending'));
        }
      } catch (cause) {
        if (!disposed) setError(String(cause));
      } finally {
        fetching = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [jobId]);

  useEffect(() => {
    setActivity([]);
    if (!attemptId) return;
    return window.anvil.syncRuntime.observeAttemptActivity(attemptId, (item) =>
      setActivity((items) => [...items, item].slice(-80)),
    );
  }, [attemptId]);

  const send = useCallback(
    async (prompt: string, attachments: ChatAttachment[] = []) => {
      const workspaceId = input.workspaceId;
      if (!workspaceId || busy || !prompt.trim()) return false;
      if (attachments.length) {
        setError('Remote chats cannot send attachments yet. Your draft has been kept.');
        return false;
      }
      setSending(true);
      setError(null);
      try {
        const threadId = record
          ? (input.threadId ?? record.sourceThreadId ?? record.id)
          : await input.ensureThread(prompt);
        if (scope.current !== workspaceId) return false;
        const key = JSON.stringify([
          threadId,
          record?.id,
          target,
          input.provider,
          input.model,
          input.permissionMode,
          input.reasoningEffort,
          credentialChoice,
          prompt,
        ]);
        if (pending.current?.key !== key) pending.current = { key, id: crypto.randomUUID() };
        const requestId = pending.current.id;
        const next = record
          ? await window.anvil.syncRuntime.sendRemoteChat({
              sessionId: record.id,
              requestId,
              prompt,
              permissionMode: input.permissionMode,
              reasoningEffort: input.reasoningEffort,
            })
          : await window.anvil.syncRuntime.createRemoteChat({
              workspaceId,
              sourceThreadId: threadId,
              target: hosted ? HOSTED_CHAT_TARGET : 'device',
              ...(hosted ? {} : { targetEnrollmentId: target }),
              provider: input.provider,
              model: input.model,
              permissionMode: input.permissionMode,
              reasoningEffort: input.reasoningEffort,
              credentialChoice: hosted
                ? input.provider === 'codex'
                  ? credentialChoice
                  : 'cloud-provider'
                : input.provider === 'codex'
                  ? credentialChoice
                  : 'target-local',
              prompt,
              requestId,
            });
        if (scope.current === workspaceId)
          setRecords((rows) => [next, ...rows.filter((row) => row.id !== next.id)]);
        pending.current = null;
        return true;
      } catch (cause) {
        if (scope.current === workspaceId) setError(String(cause));
        return false;
      } finally {
        setSending(false);
      }
    },
    [input, busy, record, target, hosted, credentialChoice],
  );

  const stop = async () => {
    if (!record) return;
    try {
      const next = await window.anvil.syncRuntime.cancelRemoteChat(record.id);
      setRecords((rows) => rows.map((row) => (row.id === next.id ? next : row)));
    } catch (cause) {
      setError(String(cause));
    }
  };
  const endSession = async () => {
    if (!record?.environmentId || busy) return;
    setSending(true);
    try {
      const next = await window.anvil.syncRuntime.endRemoteChat(record.id);
      if (scope.current === input.workspaceId)
        setRecords((rows) => rows.map((row) => (row.id === next.id ? next : row)));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSending(false);
    }
  };
  const decide = async (id: string, decision: 'approved' | 'denied') => {
    try {
      await window.anvil.syncRuntime.decideMeshApproval(id, decision);
      setApprovals((rows) => rows.filter((row) => row.id !== id));
    } catch (cause) {
      setError(String(cause));
    }
  };
  const threadStatuses: Record<string, CodexSession['status']> = {};
  for (const chat of records) {
    if (!chat.sourceThreadId) continue;
    threadStatuses[chat.sourceThreadId] =
      chat.state === 'failed' ? 'error' : TERMINAL.has(chat.state) ? 'ready' : 'busy';
  }
  return {
    target,
    setTarget,
    devices,
    providerReady,
    sessionLimitSeconds,
    record,
    legacyRecords: records.filter((chat) => !chat.sourceThreadId && !chat.sourceSessionId),
    legacyId,
    setLegacyId,
    remote,
    hosted,
    busy,
    sending,
    error,
    credentialChoice,
    setCredentialChoice,
    approvals,
    activity,
    threadStatuses,
    send,
    stop,
    endSession,
    decide,
  };
}
