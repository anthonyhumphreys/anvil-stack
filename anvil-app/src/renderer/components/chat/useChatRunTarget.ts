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
import { sharedPollingCache } from '../../utils/shared-polling-cache';

export const HOSTED_CHAT_TARGET = 'anvil-hosted-cloud';
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'paused', 'ended']);
const TERMINAL_MESH_JOBS = new Set(['completed', 'failed', 'cancelled', 'unknown-outcome']);
const CHAT_RECORDS_POLL_MS = 5_000;
const CHAT_RECORDS_MAX_STALE_MS = 20_000;
const DEVICE_ROSTER_POLL_MS = 15_000;
const DEVICE_ROSTER_MAX_STALE_MS = 30_000;
const AGENT_SETTINGS_POLL_MS = 15_000;
const AGENT_SETTINGS_MAX_STALE_MS = 30_000;
const MESH_JOB_POLL_MS = 5_000;
const MESH_JOB_MAX_STALE_MS = 15_000;
const MESH_STATUS_PUSH_MIN_INTERVAL_MS = 2_000;
const SYNC_SCOPE_POLL_MS = 5_000;
const SYNC_SCOPE_MAX_STALE_MS = 10_000;

interface ChatTargetSyncScope {
  backendId: string | null;
  accountId: string | null;
  datasetEpoch: string | null;
  enrollmentId: string | null;
  authState: string;
  needsIdentityReview: boolean;
  recovering: boolean;
}

interface MeshJobView {
  attemptId: string | null;
  approvals: ApprovalRecord[];
  terminal: boolean;
}

let activeSyncScopeFingerprint: string | null = null;
let activeSyncScopeRevision = 0;

function cacheKeyForSyncScope(scope: ChatTargetSyncScope | undefined): string | null {
  if (scope === undefined) {
    if (activeSyncScopeFingerprint !== null) {
      activeSyncScopeFingerprint = null;
      activeSyncScopeRevision += 1;
    }
    return null;
  }

  const fingerprint = JSON.stringify([
    scope.backendId,
    scope.accountId,
    scope.datasetEpoch,
    scope.enrollmentId,
    scope.authState,
    scope.needsIdentityReview,
    scope.recovering,
  ]);
  if (activeSyncScopeFingerprint !== fingerprint) {
    activeSyncScopeFingerprint = fingerprint;
    activeSyncScopeRevision += 1;
  }
  const authenticated =
    scope.backendId !== null &&
    scope.accountId !== null &&
    scope.datasetEpoch !== null &&
    scope.authState === 'signed-in' &&
    !scope.needsIdentityReview;
  return authenticated ? `${fingerprint}:${activeSyncScopeRevision}` : null;
}

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
  const [meshJobView, setMeshJobView] = useState<{ jobId: string; value: MeshJobView } | null>(
    null,
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credentialChoice, setCredentialChoice] =
    useState<RemoteCredentialChoice>('codex-host-auth');
  const [activity, setActivity] = useState<SyncAttemptActivity[]>([]);
  const [legacyId, setLegacyId] = useState<string | null>(null);
  const [sessionLimitSeconds, setSessionLimitSeconds] = useState<number | null>(null);
  const [hostedAgentsEnabled, setHostedAgentsEnabled] = useState(false);
  const [dismissedApprovalIds, setDismissedApprovalIds] = useState<string[]>([]);
  const [cacheScopeKey, setCacheScopeKey] = useState<string | null>(null);
  const pending = useRef<{ key: string; id: string } | null>(null);
  const workspaceScope = useRef(input.workspaceId);
  workspaceScope.current = input.workspaceId;
  const activeCacheScopeKey = useRef(cacheScopeKey);
  activeCacheScopeKey.current = cacheScopeKey;
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
    if (next === HOSTED_CHAT_TARGET && !hostedAgentsEnabled) return;
    updateTarget(next);
    setCredentialChoice(next === HOSTED_CHAT_TARGET ? 'codex-host-auth' : 'target-local');
  };

  useEffect(
    () =>
      sharedPollingCache.subscribe(
        'chat-run-target:sync-scope',
        async (): Promise<ChatTargetSyncScope> => {
          const [runtime, backend] = await Promise.all([
            window.anvil.syncRuntime.status(),
            window.anvil.syncBackend.status(),
          ]);
          return {
            backendId: backend.backendId,
            accountId: runtime.auth.accountId,
            datasetEpoch: runtime.datasetEpoch,
            enrollmentId: runtime.auth.enrollmentId,
            authState: runtime.auth.state,
            needsIdentityReview: runtime.backendIdentityReviewRequired,
            recovering: runtime.recovering,
          };
        },
        (snapshot) => {
          const current = snapshot.value;
          if (current === undefined) {
            const nextKey = cacheKeyForSyncScope(undefined);
            if (activeCacheScopeKey.current !== null) {
              setRecords([]);
              setDevices([]);
              setProviders([]);
              setHostedAgentsEnabled(false);
              setMeshJobView(null);
              setDismissedApprovalIds([]);
              setActivity([]);
              updateTarget('local');
              pending.current = null;
              setError(null);
            }
            activeCacheScopeKey.current = nextKey;
            setCacheScopeKey(nextKey);
            return;
          }
          const nextKey = cacheKeyForSyncScope(current);
          if (activeCacheScopeKey.current !== nextKey) {
            setRecords([]);
            setDevices([]);
            setProviders([]);
            setHostedAgentsEnabled(false);
            setMeshJobView(null);
            setDismissedApprovalIds([]);
            setActivity([]);
            updateTarget('local');
            pending.current = null;
            setError(null);
          }
          activeCacheScopeKey.current = nextKey;
          setCacheScopeKey(nextKey);
        },
        {
          pollIntervalMs: SYNC_SCOPE_POLL_MS,
          maxAgeMs: SYNC_SCOPE_POLL_MS,
          maxStaleMs: SYNC_SCOPE_MAX_STALE_MS,
        },
      ),
    [],
  );

  useEffect(() => {
    let disposed = false;
    setSessionLimitSeconds(null);
    if (!hosted || !cacheScopeKey) return;
    void window.anvil.syncRuntime.getManagedEnvironmentLimits().then(
      (limits) => {
        if (!disposed && activeCacheScopeKey.current === cacheScopeKey)
          setSessionLimitSeconds(limits.maxTtlSeconds);
      },
      () => {
        // Launch reports sign-in and entitlement failures through its normal error path.
      },
    );
    return () => {
      disposed = true;
    };
  }, [hosted, input.workspaceId, cacheScopeKey]);

  useEffect(() => {
    setRecords([]);
    setDevices([]);
    setProviders([]);
    setHostedAgentsEnabled(false);
    updateTarget('local');
    setError(null);
    pending.current = null;
    setLegacyId(null);
    if (!input.workspaceId || !cacheScopeKey) return;
    let disposed = false;
    const workspaceId = input.workspaceId;
    const cacheKeyPrefix = `chat-run-target:${cacheScopeKey}`;
    const stopRecords = sharedPollingCache.subscribe(
      `${cacheKeyPrefix}:records:${workspaceId}`,
      () => window.anvil.syncRuntime.listRemoteChats(workspaceId),
      (snapshot) => {
        if (disposed || activeCacheScopeKey.current !== cacheScopeKey) return;
        setRecords(snapshot.value ?? []);
      },
      {
        pollIntervalMs: CHAT_RECORDS_POLL_MS,
        maxAgeMs: CHAT_RECORDS_POLL_MS,
        maxStaleMs: CHAT_RECORDS_MAX_STALE_MS,
      },
    );
    const stopDevices = sharedPollingCache.subscribe(
      `${cacheKeyPrefix}:trusted-devices`,
      () => window.anvil.syncRuntime.listDevices(),
      (snapshot) => {
        if (disposed || activeCacheScopeKey.current !== cacheScopeKey) return;
        if (snapshot.value === undefined) {
          setDevices([]);
          return;
        }
        setDevices(
          snapshot.value.filter(
            (device) =>
              !device.self &&
              !device.revoked &&
              device.trustState === 'trusted' &&
              device.enrollmentClass !== 'ephemeral',
          ),
        );
      },
      {
        pollIntervalMs: DEVICE_ROSTER_POLL_MS,
        maxAgeMs: DEVICE_ROSTER_POLL_MS,
        maxStaleMs: DEVICE_ROSTER_MAX_STALE_MS,
      },
    );
    const stopAgentSettings = sharedPollingCache.subscribe(
      `${cacheKeyPrefix}:agent-settings`,
      () => window.anvil.cloudAgentSettings.get(),
      (snapshot) => {
        if (disposed || activeCacheScopeKey.current !== cacheScopeKey) return;
        if (snapshot.value === undefined) {
          setProviders([]);
          setHostedAgentsEnabled(false);
          return;
        }
        setProviders(snapshot.value.providers);
        // Hosted chat access is separately default-off. Provider settings do
        // not grant or turn on this target.
        setHostedAgentsEnabled(snapshot.value.anvilCloudAgentsEnabled === true);
      },
      {
        pollIntervalMs: AGENT_SETTINGS_POLL_MS,
        maxAgeMs: AGENT_SETTINGS_POLL_MS,
        maxStaleMs: AGENT_SETTINGS_MAX_STALE_MS,
      },
    );
    return () => {
      disposed = true;
      stopRecords();
      stopDevices();
      stopAgentSettings();
    };
  }, [input.workspaceId, cacheScopeKey]);

  useEffect(() => setLegacyId(null), [input.threadId]);

  useEffect(() => {
    setError(null);
    if (sending && !record) return;
    updateTarget(
      record ? (record.environmentId ? HOSTED_CHAT_TARGET : record.targetEnrollmentId) : 'local',
    );
  }, [input.threadId, record?.id, record?.environmentId, record?.targetEnrollmentId, sending]);

  useEffect(() => {
    if (!record && !hostedAgentsEnabled && target === HOSTED_CHAT_TARGET) updateTarget('local');
  }, [hostedAgentsEnabled, record?.id, target]);

  const jobId = record?.jobId ?? record?.prepareJobId;
  useEffect(() => {
    setMeshJobView(null);
    setDismissedApprovalIds([]);
    if (!jobId) return;
    if (!cacheScopeKey) return;
    const key = `chat-run-target:${cacheScopeKey}:mesh-job:${jobId}`;
    let disposed = false;
    const stop = sharedPollingCache.subscribe(
      key,
      async (): Promise<MeshJobView> => {
        const [job, requests] = await Promise.all([
          window.anvil.syncRuntime.getMeshJob(jobId),
          window.anvil.syncRuntime.getMeshApprovals(jobId),
        ]);
        return {
          attemptId: job.attempts.at(-1)?.id ?? null,
          approvals: requests.filter((item) => item.state === 'pending'),
          terminal: TERMINAL_MESH_JOBS.has(job.job.state),
        };
      },
      (snapshot) => {
        if (disposed || activeCacheScopeKey.current !== cacheScopeKey) return;
        if (snapshot.error !== undefined) setError(String(snapshot.error));
        if (snapshot.value === undefined) {
          setMeshJobView((current) => (current?.jobId === jobId ? null : current));
          return;
        }
        setMeshJobView({ jobId, value: snapshot.value });
      },
      {
        pollIntervalMs: (snapshot) => (snapshot.value?.terminal ? null : MESH_JOB_POLL_MS),
        maxAgeMs: MESH_JOB_POLL_MS,
        maxStaleMs: MESH_JOB_MAX_STALE_MS,
      },
    );
    return () => {
      disposed = true;
      stop();
    };
  }, [jobId, cacheScopeKey]);

  const meshJobViewForJob =
    meshJobView !== null && meshJobView.jobId === jobId ? meshJobView.value : null;
  const attemptId = meshJobViewForJob?.attemptId ?? null;
  const approvals = (meshJobViewForJob?.approvals ?? []).filter(
    (approval) => !dismissedApprovalIds.includes(approval.id),
  );

  useEffect(() => {
    setActivity([]);
    if (!attemptId) return;
    return window.anvil.syncRuntime.observeAttemptActivity(attemptId, (item) => {
      if (activeCacheScopeKey.current !== cacheScopeKey) return;
      setActivity((items) => [...items, item].slice(-80));
      if (item.kind === 'status' && jobId && cacheScopeKey)
        void sharedPollingCache.refresh(
          `chat-run-target:${cacheScopeKey}:mesh-job:${jobId}`,
          MESH_STATUS_PUSH_MIN_INTERVAL_MS,
        );
    });
  }, [attemptId, jobId, cacheScopeKey]);

  const send = useCallback(
    async (prompt: string, attachments: ChatAttachment[] = []) => {
      const workspaceId = input.workspaceId;
      if (!workspaceId || !cacheScopeKey || busy || !prompt.trim()) return false;
      if (
        !hostedAgentsEnabled &&
        (target === HOSTED_CHAT_TARGET || record?.environmentId !== undefined)
      ) {
        setError(
          'Anvil Cloud Agents are unavailable. You can still stop or end this existing chat.',
        );
        return false;
      }
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
        if (workspaceScope.current !== workspaceId || activeCacheScopeKey.current !== cacheScopeKey)
          return false;
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
        if (workspaceScope.current === workspaceId && activeCacheScopeKey.current === cacheScopeKey)
          setRecords((rows) => [next, ...rows.filter((row) => row.id !== next.id)]);
        if (cacheScopeKey)
          void sharedPollingCache.refresh(
            `chat-run-target:${cacheScopeKey}:records:${workspaceId}`,
          );
        pending.current = null;
        return true;
      } catch (cause) {
        if (workspaceScope.current === workspaceId && activeCacheScopeKey.current === cacheScopeKey)
          setError(String(cause));
        return false;
      } finally {
        setSending(false);
      }
    },
    [input, busy, record, target, hosted, hostedAgentsEnabled, credentialChoice, cacheScopeKey],
  );

  const stop = async () => {
    if (!record || !cacheScopeKey) return;
    const workspaceId = input.workspaceId;
    try {
      const next = await window.anvil.syncRuntime.cancelRemoteChat(record.id);
      if (workspaceScope.current === workspaceId && activeCacheScopeKey.current === cacheScopeKey)
        setRecords((rows) => rows.map((row) => (row.id === next.id ? next : row)));
      if (
        workspaceId &&
        workspaceScope.current === workspaceId &&
        activeCacheScopeKey.current === cacheScopeKey
      )
        void sharedPollingCache.refresh(`chat-run-target:${cacheScopeKey}:records:${workspaceId}`);
    } catch (cause) {
      if (activeCacheScopeKey.current === cacheScopeKey) setError(String(cause));
    }
  };
  const endSession = async () => {
    if (!record?.environmentId || busy || !cacheScopeKey) return;
    const workspaceId = input.workspaceId;
    setSending(true);
    try {
      const next = await window.anvil.syncRuntime.endRemoteChat(record.id);
      if (workspaceScope.current === workspaceId && activeCacheScopeKey.current === cacheScopeKey)
        setRecords((rows) => rows.map((row) => (row.id === next.id ? next : row)));
      if (
        workspaceId &&
        workspaceScope.current === workspaceId &&
        activeCacheScopeKey.current === cacheScopeKey
      )
        void sharedPollingCache.refresh(`chat-run-target:${cacheScopeKey}:records:${workspaceId}`);
    } catch (cause) {
      if (activeCacheScopeKey.current === cacheScopeKey) setError(String(cause));
    } finally {
      setSending(false);
    }
  };
  const decide = async (id: string, decision: 'approved' | 'denied') => {
    if (!cacheScopeKey) return;
    try {
      await window.anvil.syncRuntime.decideMeshApproval(id, decision);
      if (activeCacheScopeKey.current !== cacheScopeKey) return;
      setDismissedApprovalIds((ids) => [...ids, id]);
      if (jobId && cacheScopeKey)
        void sharedPollingCache.refresh(`chat-run-target:${cacheScopeKey}:mesh-job:${jobId}`);
    } catch (cause) {
      if (activeCacheScopeKey.current === cacheScopeKey) setError(String(cause));
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
    hostedAgentsEnabled,
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
