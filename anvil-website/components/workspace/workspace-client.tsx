"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { LockKeyhole } from "lucide-react";

import { Button } from "@/components/ui/button";
import { WorkspaceRoute } from "@/components/workspace/workspace-route";
import type {
  WorkspaceActions,
  WorkspaceApproval,
  WorkspaceChange,
  WorkspaceExecutionControls,
  WorkspaceExecutionProvider,
  WorkspaceFile,
  WorkspaceMachineOption,
  WorkspacePermissionMode,
  WorkspacePreview,
  WorkspaceProviderId,
  WorkspaceRepository,
  WorkspaceSession,
  WorkspaceTerminal,
  WorkspaceTest,
  WorkspaceViewModel,
  WorkspaceWorkflow,
} from "@/components/workspace/types";
import {
  useBrowserWorkspace,
  type BrowserWorkspaceCommandInput,
} from "@/lib/browser-workspace";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function listValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

interface RawRepository {
  id: string;
  name: string;
  defaultBranch?: string;
  status?: string;
}

interface RawThread {
  id: string;
  title: string;
  personaId?: string;
  repoIds: string[];
  activeRepoId?: string;
  updatedAt?: string;
  preview?: string;
  summary?: string;
  attentionState?: string;
}

interface RawMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: string;
}

interface RawSession {
  id: string;
  status: string;
  provider?: WorkspaceProviderId;
  repoId?: string;
  startedAt?: string;
}

interface RawApproval {
  sessionId: string;
  requestKey: string;
  requestId?: string | number;
  kind?: string;
  reason?: string;
  command?: string;
  repoName?: string;
  policy?: string;
}

interface RawWorkflowRun {
  id: string;
  templateName?: string;
  templateId?: string;
  repoIds?: string[];
  kickoff?: string;
  status?: string;
  error?: string;
  updatedAt?: string;
  createdAt?: string;
}

interface RawExecutionOptions {
  target: { kind: "connected-machine"; displayName: string; chatAvailable: boolean; unavailableReason?: string };
  providers: WorkspaceExecutionProvider[];
  maximumPermissionMode: WorkspacePermissionMode;
}

const PROVIDER_IDS: readonly WorkspaceProviderId[] = ["codex", "openai", "azure", "cursor", "devin", "llmgateway"];
const PERMISSION_MODES: readonly WorkspacePermissionMode[] = ["read-only", "on-request", "workspace-auto", "full-access"];
const useSynchronousWorkspaceEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function parseExecutionOptions(value: unknown): RawExecutionOptions | null {
  const source = record(value);
  const target = record(source?.target);
  const displayName = stringValue(target?.displayName);
  const maximumPermissionMode = source?.maximumPermissionMode;
  if (
    target?.kind !== "connected-machine" ||
    !displayName ||
    typeof target.chatAvailable !== "boolean" ||
    !PERMISSION_MODES.includes(maximumPermissionMode as WorkspacePermissionMode)
  ) {
    return null;
  }
  const providers = listValue(source?.providers).flatMap((value): WorkspaceExecutionProvider[] => {
    const item = record(value);
    const provider = item?.provider;
    const defaultPermissionMode = item?.defaultPermissionMode;
    if (
      !item ||
      typeof provider !== "string" ||
      !PROVIDER_IDS.includes(provider as WorkspaceProviderId) ||
      typeof item?.enabled !== "boolean" ||
      typeof item?.available !== "boolean" ||
      !PERMISSION_MODES.includes(defaultPermissionMode as WorkspacePermissionMode)
    ) {
      return [];
    }
    const models = listValue(item.models).flatMap((model) => {
      const modelItem = record(model);
      const id = stringValue(modelItem?.id);
      const label = stringValue(modelItem?.label);
      return id && label ? [{ id, label }] : [];
    });
    const permissionModes = listValue(item.permissionModes).filter(
      (mode): mode is WorkspacePermissionMode => typeof mode === "string" && PERMISSION_MODES.includes(mode as WorkspacePermissionMode)
    );
    return [{
      provider: provider as WorkspaceProviderId,
      enabled: item.enabled,
      available: item.available,
      unavailableReason: stringValue(item.unavailableReason),
      defaultModel: stringValue(item.defaultModel),
      models,
      permissionModes,
      defaultPermissionMode: defaultPermissionMode as WorkspacePermissionMode,
    }];
  });

  return {
    target: {
      kind: "connected-machine",
      displayName,
      chatAvailable: target.chatAvailable,
      unavailableReason: stringValue(target.unavailableReason),
    },
    providers,
    maximumPermissionMode: maximumPermissionMode as WorkspacePermissionMode,
  };
}

function parseRepository(value: unknown): RawRepository | null {
  const item = record(value);
  const id = stringValue(item?.id);
  const name = stringValue(item?.name);
  if (!id || !name) return null;
  return { id, name, defaultBranch: stringValue(item?.defaultBranch), status: stringValue(item?.status) };
}

function parseThread(value: unknown): RawThread | null {
  const item = record(value);
  const id = stringValue(item?.id);
  if (!id) return null;
  const repoIds = listValue(item?.repoIds).filter((repoId): repoId is string => typeof repoId === "string");
  return {
    id,
    title: stringValue(item?.title) ?? "Untitled session",
    personaId: stringValue(item?.personaId),
    repoIds,
    activeRepoId: stringValue(item?.activeRepoId),
    updatedAt: stringValue(item?.updatedAt),
    preview: stringValue(item?.preview),
    summary: stringValue(item?.summary),
    attentionState: stringValue(item?.attentionState),
  };
}

function parseMessage(value: unknown): RawMessage | null {
  const item = record(value);
  const id = stringValue(item?.id);
  const content = typeof item?.content === "string" ? item.content : undefined;
  const event = record(item?.event);
  const role = item?.role === "system" && event?.type === "text"
    ? "assistant"
    : item?.role === "user" || item?.role === "assistant" || item?.role === "system" ? item.role : undefined;
  if (!id || content === undefined || !role) return null;
  return { id, role, content, timestamp: stringValue(item?.timestamp) };
}

function parseSession(value: unknown): RawSession | null {
  const item = record(value);
  const id = stringValue(item?.id);
  const status = stringValue(item?.status);
  if (!id || !status) return null;
  const provider = typeof item?.provider === "string" && PROVIDER_IDS.includes(item.provider as WorkspaceProviderId)
    ? item.provider as WorkspaceProviderId
    : undefined;
  return { id, status, provider, repoId: stringValue(item?.repoId), startedAt: stringValue(item?.startedAt) };
}

function parseApproval(value: unknown): RawApproval | null {
  const item = record(value);
  const sessionId = stringValue(item?.sessionId);
  const requestKey = stringValue(item?.requestKey);
  if (!sessionId || !requestKey) return null;
  return {
    sessionId,
    requestKey,
    requestId: typeof item?.requestId === "string" || typeof item?.requestId === "number" ? item.requestId : undefined,
    kind: stringValue(item?.kind),
    reason: stringValue(item?.reason),
    command: stringValue(item?.command),
    repoName: stringValue(item?.repoName),
    policy: stringValue(item?.policy),
  };
}

function parseWorkflow(value: unknown): RawWorkflowRun | null {
  const item = record(value);
  const id = stringValue(item?.id);
  if (!id) return null;
  const repoIds = listValue(item?.repoIds).filter((repoId): repoId is string => typeof repoId === "string");
  return { id, templateName: stringValue(item?.templateName), templateId: stringValue(item?.templateId), repoIds, kickoff: stringValue(item?.kickoff), status: stringValue(item?.status), error: stringValue(item?.error), updatedAt: stringValue(item?.updatedAt), createdAt: stringValue(item?.createdAt) };
}

function statusToSessionState(status: string | undefined, attention?: string): WorkspaceSession["state"] {
  if (attention === "approval" || attention === "input") return "waiting";
  if (attention === "working") return "running";
  if (attention === "failed") return "failed";
  if (attention === "complete") return "completed";
  switch (status) {
    case "starting":
    case "busy":
      return "running";
    case "error":
      return "failed";
    case "ready":
      return "idle";
    default:
      return "idle";
  }
}

function workflowState(status: string | undefined): WorkspaceWorkflow["state"] {
  if (status === "queued" || status === "running" || status === "failed" || status === "cancelled") return status;
  if (status === "paused") return "queued";
  if (status === "completed") return "passed";
  return "unknown";
}

// PTY output is a raw byte stream: strip ANSI styling for the plain line
// view, normalize CR line endings, and bound what the panel renders.
const ANSI_ESCAPE = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-_])/g;
const TERMINAL_BUFFER_CHARS = 200_000;
const TERMINAL_LINE_LIMIT = 400;
const TERMINAL_POLL_MS = 1_500;

interface TerminalSessionState {
  repoId: string;
  terminalId: string;
  nextSequence: number;
  buffer: string;
  truncated: boolean;
  exited: boolean;
}

function terminalLines(session: TerminalSessionState | null): WorkspaceTerminal["lines"] {
  const buffer = session?.buffer ?? "";
  const rendered = buffer.replace(ANSI_ESCAPE, "").replace(/\r\n/g, "\n").split(/[\r\n]/);
  const lines = rendered.slice(-TERMINAL_LINE_LIMIT).map((text, index) => ({ id: `line-${index}`, text }));
  if (session?.truncated) {
    lines.unshift({ id: "truncated", text: "… earlier output was dropped at the relay bound …" });
  }
  return lines;
}

function previewUnavailableDetail(reason: string | undefined): string {
  if (reason === "repo-dev-server-not-found") {
    return "No running dev server was found for this repository on the approving Desktop.";
  }
  if (reason === "desktop-preview-blocked") {
    return "Desktop blocked the capture target; only the repository's own loopback dev server can be previewed.";
  }
  return "Preview capture is not configured on the approving Desktop.";
}

function scopeKey(accountScope: string, enrollmentId: string, workspaceId: string): string {
  return `anvil.browser-workspace.selection.v1:${accountScope}:${enrollmentId}:${workspaceId}`;
}

function commandPayload(operation: BrowserWorkspaceCommandInput["operation"], payload: JsonRecord): JsonRecord {
  return { operation, ...payload };
}

export function BrowserWorkspaceClient({
  accountScope,
  machines,
  discoveryDetail,
}: {
  accountScope: string;
  machines: WorkspaceMachineOption[];
  discoveryDetail?: string;
}) {
  const client = useBrowserWorkspace({
    accountScope,
    resumeStoredSession: true,
    meshHosts: machines.flatMap((machine) => machine.meshHost ? [machine.meshHost] : []),
  });
  const {
    auth,
    error: authError,
    execute,
    requestAccess,
    lock,
    disconnect,
    directStatus,
    subscribeMachineEvents,
  } = client;
  const workspaceId = auth.workspace?.workspaceId;
  const enrollmentId = auth.workspace?.enrollmentId;
  const [repositories, setRepositories] = useState<RawRepository[]>([]);
  const [threads, setThreads] = useState<RawThread[]>([]);
  const [sessions, setSessions] = useState<Record<string, RawSession>>({});
  const [history, setHistory] = useState<Record<string, RawMessage[]>>({});
  const [approvals, setApprovals] = useState<RawApproval[]>([]);
  const [workflows, setWorkflows] = useState<RawWorkflowRun[]>([]);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState<string>();
  const [selectedThreadId, setSelectedThreadId] = useState<string>();
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [changes, setChanges] = useState<WorkspaceChange[]>([]);
  const [preview, setPreview] = useState<WorkspacePreview>();
  const [terminalSession, setTerminalSession] = useState<TerminalSessionState | null>(null);
  const [loading, setLoading] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [selectedEnrollmentId, setSelectedEnrollmentId] = useState<string | undefined>(() => enrollmentId ?? machines[0]?.enrollmentId);
  const ready = auth.status === "ready" && workspaceId !== undefined && (!selectedEnrollmentId || selectedEnrollmentId === enrollmentId);
  const [executionOptions, setExecutionOptions] = useState<RawExecutionOptions | null>(null);
  const [executionGrantKey, setExecutionGrantKey] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<WorkspaceProviderId>();
  const [selectedModel, setSelectedModel] = useState<string>();
  const [selectedPermissionMode, setSelectedPermissionMode] = useState<WorkspacePermissionMode>();
  const [lastRefresh, setLastRefresh] = useState<string>();
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const historyReadInFlight = useRef(new Map<string, Promise<void>>());
  const activeChatPollInFlight = useRef(false);
  const executionOptionsInFlight = useRef<Promise<void> | null>(null);
  const lastHistoryPollAt = useRef(0);
  const lastApprovalPollAt = useRef(0);
  const workspaceGeneration = useRef(0);
  const sessionTransitions = useRef(new Map<string, number>());
  const deliveryInFlight = useRef<{ token: symbol; generation: number } | null>(null);
  const [loadedGrantKey, setLoadedGrantKey] = useState<string | null>(null);
  const [switchingSession, setSwitchingSession] = useState<{ threadId: string; scopeKey: string } | null>(null);
  const [pendingDelivery, setPendingDelivery] = useState<{ token: symbol; generation: number; scopeKey: string } | null>(null);
  const grantKey = ready && workspaceId && enrollmentId ? `${accountScope}:${enrollmentId}:${workspaceId}` : null;
  const selectedRepositoryRef = useRef(selectedRepositoryId);
  const selectedThreadRef = useRef(selectedThreadId);
  const selectedProviderRef = useRef(selectedProvider);
  const didSyncInitialTarget = useRef(false);
  // The terminal session is the ref's source of truth; state is the render mirror.
  const terminalSessionRef = useRef<TerminalSessionState | null>(null);

  useEffect(() => {
    selectedRepositoryRef.current = selectedRepositoryId;
    selectedThreadRef.current = selectedThreadId;
  }, [selectedRepositoryId, selectedThreadId]);

  useEffect(() => {
    selectedProviderRef.current = selectedProvider;
  }, [selectedProvider]);

  useEffect(() => {
    if (didSyncInitialTarget.current || auth.status !== "ready" || !enrollmentId) return;
    didSyncInitialTarget.current = true;
    setSelectedEnrollmentId(enrollmentId);
  }, [auth.status, enrollmentId]);

  useEffect(() => {
    if (selectedEnrollmentId && machines.some((machine) => machine.enrollmentId === selectedEnrollmentId)) return;
    const fallback = enrollmentId ?? machines[0]?.enrollmentId;
    if (fallback) queueMicrotask(() => setSelectedEnrollmentId(fallback));
  }, [enrollmentId, machines, selectedEnrollmentId]);

  useSynchronousWorkspaceEffect(() => {
    workspaceGeneration.current += 1;
    refreshInFlight.current = null;
    executionOptionsInFlight.current = null;
    activeChatPollInFlight.current = false;
    sessionTransitions.current.clear();
    deliveryInFlight.current = null;
    lastHistoryPollAt.current = 0;
    lastApprovalPollAt.current = 0;
    queueMicrotask(() => {
      setLoadedGrantKey(null);
      setRepositories([]);
      setThreads([]);
      setSessions({});
      setHistory({});
      setApprovals([]);
      setWorkflows([]);
      setSelectedRepositoryId(undefined);
      setSelectedThreadId(undefined);
      setFiles([]);
      setChanges([]);
      setExecutionOptions(null);
      setExecutionGrantKey(null);
      setSelectedProvider(undefined);
      setSelectedModel(undefined);
      setSelectedPermissionMode(undefined);
      setSwitchingSession(null);
      setPendingDelivery(null);
    });
  }, [accountScope, enrollmentId, ready, workspaceId]);

  const runCommand = useCallback(
    async <T,>(input: BrowserWorkspaceCommandInput): Promise<T | null> => {
      const generation = workspaceGeneration.current;
      try {
        const result = await execute<T>(input);
        if (generation !== workspaceGeneration.current) return null;
        if (!result.ok) {
          setCommandError(result.error?.message ?? "Desktop could not complete that command.");
          return null;
        }
        setCommandError(null);
        return result.data ?? null;
      } catch (error) {
        if (generation !== workspaceGeneration.current) return null;
        setCommandError(error instanceof Error ? error.message : "Desktop workspace command failed.");
        return null;
      }
    },
    [execute]
  );

  const refresh = useCallback(async () => {
    if (!workspaceId || !ready || !grantKey) return;
    if (refreshInFlight.current) return refreshInFlight.current;
    const generation = workspaceGeneration.current;
    const promise = (async () => {
      setLoading(true);
      const [repoData, threadData, workflowData] = await Promise.all([
        runCommand<unknown[]>({ operation: "repo.list", workspaceId, payload: commandPayload("repo.list", {}) }),
        runCommand<unknown[]>({ operation: "chat.thread.list", workspaceId, payload: commandPayload("chat.thread.list", {}) }),
        runCommand<JsonRecord>({ operation: "workflow.list", workspaceId, payload: commandPayload("workflow.list", {}) }),
      ]);
      if (generation !== workspaceGeneration.current || !ready || workspaceId !== auth.workspace?.workspaceId || enrollmentId !== auth.workspace?.enrollmentId) return;
      const nextRepositories = listValue(repoData).map(parseRepository).filter((value): value is RawRepository => value !== null);
      const nextThreads = listValue(threadData).map(parseThread).filter((value): value is RawThread => value !== null);
      const workflowRuns = listValue(record(workflowData)?.runs).map(parseWorkflow).filter((value): value is RawWorkflowRun => value !== null);
      setRepositories(nextRepositories);
      setThreads(nextThreads);
      setWorkflows(workflowRuns);
      setSelectedRepositoryId((current) => current && nextRepositories.some((repo) => repo.id === current) ? current : nextRepositories[0]?.id);
      setSelectedThreadId((current) => current && nextThreads.some((thread) => thread.id === current) ? current : nextThreads[0]?.id);
      setLastRefresh(new Date().toISOString());
      setLoadedGrantKey(grantKey);
    })().finally(() => {
      if (generation === workspaceGeneration.current) setLoading(false);
    });
    refreshInFlight.current = promise;
    try {
      await promise;
    } finally {
      if (refreshInFlight.current === promise) refreshInFlight.current = null;
    }
  }, [auth.workspace?.enrollmentId, auth.workspace?.workspaceId, enrollmentId, grantKey, ready, runCommand, workspaceId]);

  useEffect(() => {
    if (!ready) return;
    queueMicrotask(() => void refresh());
  }, [ready, refresh, workspaceId]);

  useEffect(() => {
    if (!ready || !workspaceId) return;
    const interval = window.setInterval(() => void refresh(), 20_000);
    return () => window.clearInterval(interval);
  }, [ready, refresh, workspaceId]);

  const loadExecutionOptions = useCallback(async () => {
    if (!ready || !workspaceId || !grantKey) return;
    if (executionOptionsInFlight.current) return executionOptionsInFlight.current;
    const generation = workspaceGeneration.current;
    const promise = (async () => {
      const data = await runCommand<unknown>({ operation: "chat.execution.options", workspaceId, payload: commandPayload("chat.execution.options", {}) });
      if (generation !== workspaceGeneration.current || !ready || workspaceId !== auth.workspace?.workspaceId || enrollmentId !== auth.workspace?.enrollmentId) return;
      const nextOptions = parseExecutionOptions(data);
      setExecutionOptions(nextOptions);
      setExecutionGrantKey(grantKey);
      const usableProviders = nextOptions?.providers.filter((provider) => provider.enabled && provider.available) ?? [];
      const firstProvider = usableProviders[0];
      setSelectedProvider((current) => {
        const currentOption = usableProviders.find((provider) => provider.provider === current);
        return currentOption?.provider ?? firstProvider?.provider;
      });
      const provider = usableProviders.find((item) => item.provider === selectedProviderRef.current) ?? firstProvider;
      setSelectedModel((current) => provider?.models.some((model) => model.id === current) ? current : provider?.defaultModel ?? provider?.models[0]?.id);
      setSelectedPermissionMode((current) => provider?.permissionModes.includes(current as WorkspacePermissionMode) ? current : provider?.defaultPermissionMode ?? nextOptions?.maximumPermissionMode);
    })().finally(() => {
      if (executionOptionsInFlight.current === promise) executionOptionsInFlight.current = null;
    });
    executionOptionsInFlight.current = promise;
    return promise;
  }, [auth.workspace?.enrollmentId, auth.workspace?.workspaceId, enrollmentId, grantKey, ready, runCommand, workspaceId]);

  useEffect(() => {
    if (!ready || !workspaceId) return;
    queueMicrotask(() => void loadExecutionOptions());
    const interval = window.setInterval(() => void loadExecutionOptions(), 60_000);
    return () => window.clearInterval(interval);
  }, [loadExecutionOptions, ready, workspaceId]);

  useEffect(() => {
    if (!ready || !workspaceId) return;
    if (!enrollmentId) return;
    const key = scopeKey(accountScope, enrollmentId, workspaceId);
    queueMicrotask(() => {
      try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return;
        const value = JSON.parse(raw) as { repositoryId?: unknown; threadId?: unknown };
        if (typeof value.repositoryId === "string") setSelectedRepositoryId(value.repositoryId);
        if (typeof value.threadId === "string") setSelectedThreadId(value.threadId);
      } catch {
        // A corrupt selection is equivalent to no selection.
      }
    });
  }, [accountScope, enrollmentId, ready, workspaceId]);

  useEffect(() => {
    if (!ready || !workspaceId || !enrollmentId || loadedGrantKey !== grantKey) return;
    try {
      window.localStorage.setItem(scopeKey(accountScope, enrollmentId, workspaceId), JSON.stringify({ repositoryId: selectedRepositoryId, threadId: selectedThreadId }));
    } catch {
      // Private browsing may deny storage. Data remains usable in memory.
    }
  }, [accountScope, enrollmentId, grantKey, loadedGrantKey, ready, selectedRepositoryId, selectedThreadId, workspaceId]);

  const loadThreadHistory = useCallback(async (threadId: string) => {
    if (!workspaceId || !ready || !grantKey) return;
    const readKey = `${grantKey}:${threadId}`;
    const existing = historyReadInFlight.current.get(readKey);
    if (existing) return existing;
    const generation = workspaceGeneration.current;
    const promise = (async () => {
      const data = await runCommand<JsonRecord>({ operation: "chat.history.read", workspaceId, payload: commandPayload("chat.history.read", { threadId }) });
      if (!data || generation !== workspaceGeneration.current || workspaceId !== auth.workspace?.workspaceId || enrollmentId !== auth.workspace?.enrollmentId) return;
      const messages = listValue(data.messages).map(parseMessage).filter((value): value is RawMessage => value !== null);
      setHistory((current) => ({ ...current, [threadId]: messages }));
    })().finally(() => {
      if (historyReadInFlight.current.get(readKey) === promise) historyReadInFlight.current.delete(readKey);
    });
    historyReadInFlight.current.set(readKey, promise);
    return promise;
  }, [auth.workspace?.enrollmentId, auth.workspace?.workspaceId, enrollmentId, grantKey, ready, runCommand, workspaceId]);

  useEffect(() => {
    if (selectedThreadId && !history[selectedThreadId]) queueMicrotask(() => void loadThreadHistory(selectedThreadId));
  }, [history, loadThreadHistory, selectedThreadId]);

  useEffect(() => {
    if (!ready || !workspaceId || !selectedThreadId || directStatus.state !== "live") return;
    let timer: number | null = null;
    let cancelled = false;
    const update = async () => {
      if (cancelled) return;
      await Promise.all([refresh(), loadThreadHistory(selectedThreadId)]);
    };
    const unsubscribe = subscribeMachineEvents([workspaceId], {
      onEvent: () => {
        if (timer !== null) window.clearTimeout(timer);
        timer = window.setTimeout(() => void update(), 250);
      },
      onResnapshot: () => update(),
    });
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      unsubscribe();
    };
  }, [directStatus.state, loadThreadHistory, ready, refresh, selectedThreadId, subscribeMachineEvents, workspaceId]);

  useEffect(() => {
    lastHistoryPollAt.current = 0;
    lastApprovalPollAt.current = 0;
  }, [selectedThreadId]);

  const pollActiveChat = useCallback(async () => {
    if (!workspaceId || !ready || !grantKey || !selectedThreadId || document.visibilityState !== "visible" || activeChatPollInFlight.current) return;
    activeChatPollInFlight.current = true;
    const generation = workspaceGeneration.current;
    const threadId = selectedThreadId;
    const session = sessions[threadId];
    const isBusy = session?.status === "busy" || session?.status === "starting";
    const now = Date.now();
    const historyDue = now - lastHistoryPollAt.current >= (isBusy ? 6_000 : 15_000);
    const approvalsDue = now - lastApprovalPollAt.current >= (isBusy ? 6_000 : 15_000);
    if (historyDue) lastHistoryPollAt.current = now;
    if (approvalsDue) lastApprovalPollAt.current = now;
    try {
      const [statusData, approvalData] = await Promise.all([
        session
          ? runCommand<JsonRecord>({ operation: "chat.status", workspaceId, payload: commandPayload("chat.status", { sessionId: session.id }) })
          : Promise.resolve(null),
        approvalsDue
          ? runCommand<unknown[]>({ operation: "chat.approvals.list", workspaceId, payload: commandPayload("chat.approvals.list", {}) })
          : Promise.resolve(null),
        historyDue ? loadThreadHistory(threadId) : Promise.resolve(),
      ]);
      if (generation !== workspaceGeneration.current || workspaceId !== auth.workspace?.workspaceId || enrollmentId !== auth.workspace?.enrollmentId) return;
      const nextSession = parseSession(statusData);
      if (nextSession) setSessions((current) => current[threadId]?.id === session?.id ? { ...current, [threadId]: nextSession } : current);
      if (approvalData) setApprovals(listValue(approvalData).map(parseApproval).filter((value): value is RawApproval => value !== null));
    } finally {
      activeChatPollInFlight.current = false;
    }
  }, [auth.workspace?.enrollmentId, auth.workspace?.workspaceId, enrollmentId, grantKey, loadThreadHistory, ready, runCommand, selectedThreadId, sessions, workspaceId]);

  useEffect(() => {
    if (!ready || !workspaceId || !selectedThreadId) return;
    const isBusy = sessions[selectedThreadId]?.status === "busy" || sessions[selectedThreadId]?.status === "starting";
    const interval = window.setInterval(() => void pollActiveChat(), isBusy ? 3_000 : 12_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void pollActiveChat();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [pollActiveChat, ready, selectedThreadId, sessions, workspaceId]);

  const loadRepositoryData = useCallback(async (repositoryId: string) => {
    if (!workspaceId || !ready || !grantKey) return;
    const generation = workspaceGeneration.current;
    const [fileData, statusData] = await Promise.all([
      runCommand<JsonRecord>({ operation: "file.list", workspaceId, repositoryId, payload: commandPayload("file.list", { repositoryId, maxEntries: 500 }) }),
      runCommand<JsonRecord>({ operation: "git.status", workspaceId, repositoryId, payload: commandPayload("git.status", { repositoryId }) }),
    ]);
    if (generation !== workspaceGeneration.current || repositoryId !== selectedRepositoryRef.current || workspaceId !== auth.workspace?.workspaceId || enrollmentId !== auth.workspace?.enrollmentId) return;
    const statusFiles = listValue(statusData?.files).map((entry) => record(entry)).filter((entry): entry is JsonRecord => entry !== null);
    const statusByPath = new Map(statusFiles.map((entry) => [stringValue(entry.path) ?? "", stringValue(entry.status)]));
    const entries = listValue(fileData?.entries);
    setFiles(entries.filter((entry) => record(entry)?.kind === "file").map((entry) => {
      const item = record(entry)!;
      const path = stringValue(item.path) ?? "";
      const gitStatus = statusByPath.get(path);
      const status: WorkspaceFile["status"] = gitStatus === "deleted" ? "deleted" : gitStatus === "added" || gitStatus === "untracked" ? "added" : gitStatus === "renamed" ? "renamed" : gitStatus === "modified" ? "modified" : "unmodified";
      return { path, status, editable: true } satisfies WorkspaceFile;
    }).filter((file) => file.path.length > 0));
    const nextChanges = statusFiles.map((entry) => {
      const status = stringValue(entry.status);
      return { path: stringValue(entry.path) ?? "", status: status === "deleted" ? "deleted" : status === "added" || status === "untracked" ? "added" : status === "renamed" ? "renamed" : "modified", additions: 0, deletions: 0 } satisfies WorkspaceChange;
    }).filter((change) => change.path.length > 0);
    const withDiffs = await Promise.all(nextChanges.slice(0, 40).map(async (change) => {
      const diffData = await runCommand<JsonRecord>({ operation: "git.diff", workspaceId, repositoryId, payload: commandPayload("git.diff", { repositoryId, relativePath: change.path }) });
      const diff = stringValue(diffData?.hunks) ?? "";
      return { ...change, diff, additions: diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++" )).length, deletions: diff.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---" )).length };
    }));
    if (generation !== workspaceGeneration.current || repositoryId !== selectedRepositoryRef.current || workspaceId !== auth.workspace?.workspaceId || enrollmentId !== auth.workspace?.enrollmentId) return;
    setChanges(withDiffs);
  }, [auth.workspace?.enrollmentId, auth.workspace?.workspaceId, enrollmentId, grantKey, ready, runCommand, workspaceId]);

  useEffect(() => {
    if (selectedRepositoryId) queueMicrotask(() => void loadRepositoryData(selectedRepositoryId));
  }, [loadRepositoryData, selectedRepositoryId]);

  const selectFile = useCallback(async (relativePath: string) => {
    if (!workspaceId || !ready || !selectedRepositoryId) return;
    const generation = workspaceGeneration.current;
    const data = await runCommand<JsonRecord>({ operation: "file.read", workspaceId, repositoryId: selectedRepositoryId, payload: commandPayload("file.read", { repositoryId: selectedRepositoryId, relativePath }) });
    if (!data || generation !== workspaceGeneration.current || selectedRepositoryId !== selectedRepositoryRef.current) return;
    setFiles((current) => current.map((file) => file.path === relativePath ? { ...file, content: typeof data.content === "string" ? data.content : "", revision: stringValue(data.revision) ?? null, editable: data.binary !== true } : file));
  }, [ready, runCommand, selectedRepositoryId, workspaceId]);

  const saveFile = useCallback(async (relativePath: string, content: string, expectedRevision?: string | null) => {
    if (!workspaceId || !ready || !selectedRepositoryId) return;
    const generation = workspaceGeneration.current;
    const data = await runCommand<JsonRecord>({ operation: "file.write", workspaceId, repositoryId: selectedRepositoryId, payload: commandPayload("file.write", { repositoryId: selectedRepositoryId, relativePath, content, expectedRevision: expectedRevision ?? null }) });
    if (data && generation === workspaceGeneration.current && selectedRepositoryId === selectedRepositoryRef.current) setFiles((current) => current.map((file) => file.path === relativePath ? { ...file, content, revision: stringValue(data.revision) ?? null } : file));
  }, [ready, runCommand, selectedRepositoryId, workspaceId]);

  const selectThread = useCallback(async (threadId: string) => {
    setSelectedThreadId(threadId);
    await loadThreadHistory(threadId);
  }, [loadThreadHistory]);

  const createThread = useCallback(async (): Promise<string | null> => {
    if (!workspaceId || !ready || loadedGrantKey !== grantKey || !auth.scopes.includes("submit-task")) return null;
    const generation = workspaceGeneration.current;
    const allowedRepositoryIds = repositories.map((repo) => repo.id).filter((repoId) => auth.workspace?.repoIds.includes(repoId));
    const repositoryIds = selectedRepositoryId && allowedRepositoryIds.includes(selectedRepositoryId) ? [selectedRepositoryId] : allowedRepositoryIds;
    if (repositoryIds.length === 0) throw new Error("The connected machine has no approved repositories for a chat.");
    const data = await runCommand<JsonRecord>({ operation: "chat.create", workspaceId, payload: commandPayload("chat.create", { personaId: "coder", repositoryIds, activeRepositoryId: repositoryIds.includes(selectedRepositoryId ?? "") ? selectedRepositoryId : repositoryIds[0] }) });
    if (generation !== workspaceGeneration.current) return null;
    const thread = parseThread(data);
    if (!thread) throw new Error("Desktop did not return the new workspace session.");
    setThreads((current) => [thread, ...current.filter((item) => item.id !== thread.id)]);
    setSelectedThreadId(thread.id);
    setHistory((current) => ({ ...current, [thread.id]: [] }));
    return thread.id;
  }, [auth.scopes, auth.workspace?.repoIds, grantKey, loadedGrantKey, ready, repositories, runCommand, selectedRepositoryId, workspaceId]);

  const ensureSession = useCallback(async (threadId: string, settings: Pick<WorkspaceExecutionControls, "provider" | "model" | "permissionMode">): Promise<RawSession | null> => {
    if (!workspaceId || !ready || !grantKey || loadedGrantKey !== grantKey) return null;
    const generation = workspaceGeneration.current;
    if (sessionTransitions.current.has(threadId)) throw new Error("A workspace session change is already in progress. Try again when it finishes.");
    sessionTransitions.current.set(threadId, generation);
    setSwitchingSession({ threadId, scopeKey: grantKey });
    try {
      let existing: RawSession | undefined = sessions[threadId];
      if (existing) {
        const existingId = existing.id;
        // The cache can lag behind a turn started in another view. Confirm the
        // exact session before using it, stopping it, or replacing it.
        let statusResult: { ok: boolean; data?: JsonRecord; error?: { code: string; message: string } };
        try {
          statusResult = await execute<JsonRecord>({ operation: "chat.status", workspaceId, payload: commandPayload("chat.status", { sessionId: existingId }) });
        } catch (error) {
          if (generation !== workspaceGeneration.current) return null;
          const message = error instanceof Error ? error.message : "Could not verify the current provider session.";
          setCommandError(message);
          throw new Error(message);
        }
        if (generation !== workspaceGeneration.current) return null;
        if (!statusResult.ok) {
          if (statusResult.error?.code !== "not-found") {
            const message = statusResult.error?.message ?? "Could not verify the current provider session.";
            setCommandError(message);
            throw new Error(message);
          }
          setCommandError(null);
          setSessions((cached) => {
            if (cached[threadId]?.id !== existingId) return cached;
            const next = { ...cached };
            delete next[threadId];
            return next;
          });
          existing = undefined;
        } else {
          setCommandError(null);
          const current = parseSession(statusResult.data);
          if (!current || current.id !== existingId || !current.provider) {
            const message = "Could not verify which provider is running. Refresh the session before switching providers.";
            setCommandError(message);
            throw new Error(message);
          }
          setSessions((cached) => cached[threadId]?.id === existingId ? { ...cached, [threadId]: current } : cached);
          if (current.status === "busy" || current.status === "starting") {
            if (current.provider === settings.provider) return current;
            throw new Error("Finish or cancel the current turn before switching providers.");
          }
          if (current.provider === settings.provider && current.status !== "error") return current;

          const stopped = await runCommand<JsonRecord>({ operation: "chat.cancel", workspaceId, payload: commandPayload("chat.cancel", { sessionId: current.id, mode: "stop" }) });
          if (!stopped) throw new Error("Desktop could not stop the current provider session. Your message was not sent.");
          if (generation !== workspaceGeneration.current) return null;
          setSessions((cached) => {
            if (cached[threadId]?.id !== current.id) return cached;
            const next = { ...cached };
            delete next[threadId];
            return next;
          });
        }
      }

      const thread = threads.find((item) => item.id === threadId);
      const repositoryId = thread?.activeRepoId ?? selectedRepositoryId;
      const data = await runCommand<JsonRecord>({ operation: "chat.session.start", workspaceId, payload: commandPayload("chat.session.start", { threadId, ...(repositoryId ? { repositoryId } : {}), ...settings }) });
      if (generation !== workspaceGeneration.current) return null;
      if (!data) throw new Error("Desktop could not start the workspace session.");
      const session = parseSession(data);
      if (!session || session.provider !== settings.provider) {
        const message = "Desktop did not start a session with the selected provider.";
        setCommandError(message);
        throw new Error(message);
      }
      setSessions((current) => ({ ...current, [threadId]: session }));
      return session;
    } finally {
      if (sessionTransitions.current.get(threadId) === generation) sessionTransitions.current.delete(threadId);
      if (generation === workspaceGeneration.current) setSwitchingSession((current) => current?.threadId === threadId && current.scopeKey === grantKey ? null : current);
    }
  }, [execute, grantKey, loadedGrantKey, ready, runCommand, selectedRepositoryId, sessions, setCommandError, threads, workspaceId]);

  const sendMessage = useCallback(async (message: string, settings?: Pick<WorkspaceExecutionControls, "provider" | "model" | "permissionMode">) => {
    if (!workspaceId || !ready || !grantKey || loadedGrantKey !== grantKey || !auth.scopes.includes("submit-task") || !settings?.provider || !settings.model || !settings.permissionMode) return;
    const generation = workspaceGeneration.current;
    if (deliveryInFlight.current) throw new Error("A message is already being delivered. Wait for it to finish before sending another.");
    const delivery = { token: Symbol("workspace-delivery"), generation, scopeKey: grantKey };
    deliveryInFlight.current = delivery;
    setPendingDelivery(delivery);
    try {
      let threadId = selectedThreadId;
      if (!threadId) threadId = (await createThread()) ?? undefined;
      if (generation !== workspaceGeneration.current) throw new Error("The selected machine changed before this chat could start.");
      if (!threadId) throw new Error("Choose a project before starting a chat.");
      const session = await ensureSession(threadId, settings);
      if (generation !== workspaceGeneration.current) throw new Error("The selected machine changed before this message could be sent.");
      if (!session) throw new Error("Desktop could not start the workspace session.");
      const result = await runCommand<JsonRecord>({ operation: "chat.send", workspaceId, payload: commandPayload("chat.send", { threadId, sessionId: session.id, message, ...settings }) });
      if (!result) throw new Error("Desktop did not accept the message.");
      if (generation !== workspaceGeneration.current) return;
      setHistory((current) => ({ ...current, [threadId]: [...(current[threadId] ?? []), { id: `browser:${Date.now()}`, role: "user", content: message, timestamp: new Date().toISOString() }] }));
      if (typeof result.effectivePermissionMode === "string" && PERMISSION_MODES.includes(result.effectivePermissionMode as WorkspacePermissionMode)) {
        setSelectedPermissionMode(result.effectivePermissionMode as WorkspacePermissionMode);
      }
      lastHistoryPollAt.current = 0;
      setTimeout(() => void loadThreadHistory(threadId), 800);
    } finally {
      if (deliveryInFlight.current?.token === delivery.token) {
        deliveryInFlight.current = null;
        if (generation === workspaceGeneration.current) setPendingDelivery((current) => current?.token === delivery.token ? null : current);
      }
    }
  }, [auth.scopes, createThread, ensureSession, grantKey, loadThreadHistory, loadedGrantKey, ready, runCommand, selectedThreadId, workspaceId]);

  const cancelSession = useCallback(async () => {
    if (!workspaceId || !ready || !selectedThreadId || !auth.scopes.includes("submit-task")) return;
    const session = sessions[selectedThreadId];
    if (!session) return;
    await runCommand({ operation: "chat.cancel", workspaceId, payload: commandPayload("chat.cancel", { sessionId: session.id, mode: "interrupt" }) });
    await refresh();
  }, [auth.scopes, ready, refresh, runCommand, selectedThreadId, sessions, workspaceId]);

  const decideApproval = useCallback(async (approvalId: string, decision: "accept" | "decline") => {
    if (!workspaceId || !ready || !auth.scopes.includes("approve-action")) return;
    const approval = approvals.find((item) => item.requestKey === approvalId);
    if (!approval) return;
    await runCommand({ operation: "chat.approve", workspaceId, payload: commandPayload("chat.approve", { sessionId: approval.sessionId, requestKey: approval.requestKey, decision }) });
    const next = await runCommand<unknown[]>({ operation: "chat.approvals.list", workspaceId, payload: commandPayload("chat.approvals.list", {}) });
    setApprovals(listValue(next).map(parseApproval).filter((value): value is RawApproval => value !== null));
  }, [approvals, auth.scopes, ready, runCommand, workspaceId]);

  const runWorkflow = useCallback(async (runId: string) => {
    if (!workspaceId || !ready || !auth.scopes.includes("submit-task")) return;
    const run = workflows.find((item) => item.id === runId);
    if (!run?.templateId) return;
    const repositoryIds = run.repoIds?.filter((repoId) => auth.workspace?.repoIds.includes(repoId)) ?? (selectedRepositoryId ? [selectedRepositoryId] : []);
    if (repositoryIds.length === 0) return;
    await runCommand({
      operation: "workflow.start",
      workspaceId,
      payload: commandPayload("workflow.start", {
        templateId: run.templateId,
        repositoryIds,
        kickoff: run.kickoff ?? `Browser rerun for ${run.templateName ?? run.templateId}`,
      }),
    });
    await refresh();
  }, [auth.scopes, auth.workspace?.repoIds, ready, refresh, runCommand, selectedRepositoryId, workflows, workspaceId]);

  const cancelWorkflow = useCallback(async (runId: string) => {
    if (!workspaceId || !ready || !auth.scopes.includes("submit-task")) return;
    await runCommand({ operation: "workflow.cancel", workspaceId, payload: commandPayload("workflow.cancel", { runId }) });
    await refresh();
  }, [auth.scopes, ready, refresh, runCommand, workspaceId]);

  const terminalPollInFlight = useRef(false);
  const pollTerminal = useCallback(async () => {
    const session = terminalSessionRef.current;
    if (!session || !workspaceId || !ready || terminalPollInFlight.current) return;
    terminalPollInFlight.current = true;
    try {
      const generation = workspaceGeneration.current;
      const data = await runCommand<JsonRecord>({
        operation: "terminal.read",
        workspaceId,
        repositoryId: session.repoId,
        payload: commandPayload("terminal.read", { repositoryId: session.repoId, terminalId: session.terminalId, afterSequence: session.nextSequence }),
      });
      if (data === null || generation !== workspaceGeneration.current) return;
      const terminal = record(data.terminal);
      const merged = terminalSessionRef.current;
      if (!terminal || !merged || merged.terminalId !== session.terminalId) return;
      let buffer = merged.buffer;
      let nextSequence = merged.nextSequence;
      for (const chunk of listValue(terminal.output)) {
        const item = record(chunk);
        if (!item || typeof item.data !== "string") continue;
        buffer += item.data;
        if (typeof item.sequence === "number" && item.sequence > nextSequence) nextSequence = item.sequence;
      }
      const updated: TerminalSessionState = {
        ...merged,
        buffer: buffer.length > TERMINAL_BUFFER_CHARS ? buffer.slice(-TERMINAL_BUFFER_CHARS) : buffer,
        nextSequence,
        truncated: merged.truncated || terminal.truncated === true,
        exited: merged.exited || stringValue(record(terminal.session)?.status) === "exited",
      };
      terminalSessionRef.current = updated;
      setTerminalSession(updated);
    } finally {
      terminalPollInFlight.current = false;
    }
  }, [ready, runCommand, workspaceId]);

  const sendTerminalCommand = useCallback(async (command: string) => {
    if (!workspaceId || !ready || !selectedRepositoryId || !auth.scopes.includes("terminal")) return;
    let session = terminalSessionRef.current;
    if (session && session.repoId !== selectedRepositoryId) {
      terminalSessionRef.current = null;
      setTerminalSession(null);
      void runCommand({
        operation: "terminal.close",
        workspaceId,
        repositoryId: session.repoId,
        payload: commandPayload("terminal.close", { repositoryId: session.repoId, terminalId: session.terminalId }),
      });
      session = null;
    }
    if (!session || session.exited) {
      const created = await runCommand<JsonRecord>({
        operation: "terminal.create",
        workspaceId,
        repositoryId: selectedRepositoryId,
        payload: commandPayload("terminal.create", { repositoryId: selectedRepositoryId }),
      });
      const summary = record(created?.terminal);
      const terminalId = stringValue(summary?.terminalId);
      if (!terminalId) throw new Error("Desktop did not open the scoped terminal.");
      // Desktop may reuse the repo's existing terminal; read from sequence 0
      // so the panel shows the full bounded buffer, not just new output.
      session = {
        repoId: selectedRepositoryId,
        terminalId,
        nextSequence: 0,
        buffer: "",
        truncated: false,
        exited: stringValue(summary?.status) === "exited",
      };
      terminalSessionRef.current = session;
      setTerminalSession(session);
    }
    const written = await runCommand<JsonRecord>({
      operation: "terminal.write",
      workspaceId,
      repositoryId: session.repoId,
      payload: commandPayload("terminal.write", { repositoryId: session.repoId, terminalId: session.terminalId, data: `${command}\r` }),
    });
    if (!written) throw new Error("Desktop did not accept the terminal input.");
    await pollTerminal();
  }, [auth.scopes, pollTerminal, ready, runCommand, selectedRepositoryId, workspaceId]);

  const capturePreview = useCallback(async (refreshFrame: boolean) => {
    if (!workspaceId || !ready || !selectedRepositoryId || !auth.scopes.includes("preview")) return;
    const generation = workspaceGeneration.current;
    setPreview({ state: "starting", detail: "Requesting a screenshot from the approving Desktop…" });
    const data = await runCommand<JsonRecord>({
      operation: "preview.screenshot",
      workspaceId,
      repositoryId: selectedRepositoryId,
      payload: commandPayload("preview.screenshot", { repositoryId: selectedRepositoryId, refresh: refreshFrame }),
    });
    if (generation !== workspaceGeneration.current || selectedRepositoryId !== selectedRepositoryRef.current) return;
    const result = record(data);
    if (!result) {
      setPreview({ state: "error", detail: "Desktop did not return a preview result." });
      return;
    }
    if (result.status === "available" && typeof result.data === "string") {
      setPreview({
        state: "ready",
        data: result.data,
        mimeType: "image/png",
        capturedAt: typeof result.capturedAt === "number" ? new Date(result.capturedAt).toISOString() : new Date().toISOString(),
        detail: "Captured by the approving Desktop.",
      });
      return;
    }
    setPreview({ state: "unavailable", detail: previewUnavailableDetail(stringValue(result.reason)) });
  }, [auth.scopes, ready, runCommand, selectedRepositoryId, workspaceId]);

  // Poll output while a live scoped terminal exists; stop once it exits. The
  // grant owner on Desktop closes the PTY on revocation, so no local close is
  // needed when the session ends.
  const terminalActive = terminalSession !== null && !terminalSession.exited;
  useEffect(() => {
    if (!ready || !terminalActive) return;
    const interval = window.setInterval(() => void pollTerminal(), TERMINAL_POLL_MS);
    return () => window.clearInterval(interval);
  }, [ready, terminalActive, pollTerminal]);

  // A terminal belongs to one repository binding; switching repositories
  // closes it explicitly rather than leaving a hidden PTY owned by the grant.
  useEffect(() => {
    const session = terminalSessionRef.current;
    if (!session || !selectedRepositoryId || session.repoId === selectedRepositoryId || !workspaceId || !ready) return;
    terminalSessionRef.current = null;
    queueMicrotask(() => setTerminalSession(null));
    void runCommand({
      operation: "terminal.close",
      workspaceId,
      repositoryId: session.repoId,
      payload: commandPayload("terminal.close", { repositoryId: session.repoId, terminalId: session.terminalId }),
    });
  }, [ready, runCommand, selectedRepositoryId, workspaceId]);

  // When the grant ends, Desktop has already revoked and closed owned PTYs;
  // drop the local mirrors.
  useEffect(() => {
    if (ready) return;
    queueMicrotask(() => {
      terminalSessionRef.current = null;
      setTerminalSession(null);
      setPreview(undefined);
    });
  }, [ready]);

  const model = useMemo<WorkspaceViewModel>(() => {
    const dataIsCurrent = ready && loadedGrantKey !== null && loadedGrantKey === grantKey;
    const currentRepositories = dataIsCurrent ? repositories : [];
    const currentThreads = dataIsCurrent ? threads : [];
    const repoModels: WorkspaceRepository[] = currentRepositories.map((repo) => ({ id: repo.id, name: repo.name, branch: repo.defaultBranch, dirty: repo.status === "dirty" || repo.status === "modified", authorized: auth.workspace?.repoIds.includes(repo.id) ?? false }));
    const threadModels: WorkspaceSession[] = currentThreads.filter((thread) => !selectedRepositoryId || thread.repoIds.length === 0 || thread.repoIds.includes(selectedRepositoryId)).map((thread) => ({ id: thread.id, repositoryId: thread.activeRepoId ?? selectedRepositoryId ?? "", title: thread.title, summary: thread.summary ?? thread.preview, updatedAt: thread.updatedAt, state: statusToSessionState(sessions[thread.id]?.status, thread.attentionState) }));
    const approvalModels: WorkspaceApproval[] = (dataIsCurrent ? approvals : []).map((approval) => ({ id: approval.requestKey, title: approval.kind ?? "Desktop approval", detail: approval.reason ?? approval.command ?? "Desktop requested permission for this session.", scope: approval.policy ?? approval.repoName, state: "pending" }));
    const workflowModels: WorkspaceWorkflow[] = (dataIsCurrent ? workflows : []).map((run) => ({ id: run.id, name: run.templateName ?? run.templateId ?? "Workflow", state: workflowState(run.status), detail: run.error, updatedAt: run.updatedAt ?? run.createdAt }));
    const activeThreadId = threadModels.some((thread) => thread.id === selectedThreadId) ? selectedThreadId : undefined;
    const activeRepositoryId = repoModels.some((repo) => repo.id === selectedRepositoryId) ? selectedRepositoryId : undefined;
    const messageModels = activeThreadId ? (history[activeThreadId] ?? []).map((message) => ({ id: message.id, role: message.role, content: message.content, createdAt: message.timestamp })) : [];
    const hasTerminalScope = auth.scopes.includes("terminal");
    const hasPreviewScope = auth.scopes.includes("preview");
    const terminalModel: WorkspaceTerminal | undefined = dataIsCurrent
      ? {
          lines: terminalLines(terminalSession),
          inputEnabled: hasTerminalScope && !(terminalSession?.exited ?? false),
          detail:
            terminalSession === null
              ? hasTerminalScope
                ? "Commands run in a scoped terminal on the approving Desktop."
                : "The current grant does not include terminal access."
              : terminalSession.exited
                ? "The scoped terminal exited; the next command opens a new one."
                : `Scoped terminal on ${currentRepositories.find((repo) => repo.id === terminalSession.repoId)?.name ?? terminalSession.repoId}.`,
        }
      : undefined;
    const previewModel: WorkspacePreview | undefined = dataIsCurrent
      ? (preview ?? {
          state: "unavailable",
          detail: hasPreviewScope
            ? "Capture a screenshot of the selected repository's running dev server."
            : "The current grant does not include preview access.",
        })
      : undefined;
    const connectedMachine = machines.find((machine) => machine.enrollmentId === enrollmentId);
    const desktopName = connectedMachine?.displayName ?? (auth.workspace ? `Anvil machine · ${auth.workspace.enrollmentId.slice(0, 8)}` : undefined);
    return {
      connection: {
        state: ready ? "connected" : auth.status === "pending" || (auth.status === "ready" && selectedEnrollmentId !== enrollmentId) ? "connecting" : auth.status === "ended" && auth.reason === "revoked" ? "permission-denied" : "unavailable",
        desktopName,
        targetEnrollmentId: enrollmentId,
        detail: commandError ?? (loading ? "Loading workspace…" : auth.status === "pending" ? "Waiting for approval in Anvil Desktop…" : ready && !dataIsCurrent ? "Loading workspace…" : authError ?? (ready ? directStatus.detail : undefined)),
        checkedAt: lastRefresh,
      },
      repositories: repoModels,
      sessions: threadModels,
      activeRepositoryId,
      activeSessionId: activeThreadId,
      messages: messageModels,
      approvals: approvalModels,
      files: dataIsCurrent ? files : [],
      changes: dataIsCurrent ? changes : [],
      tests: [] as WorkspaceTest[],
      workflows: workflowModels,
      terminal: terminalModel,
      preview: previewModel,
      canCreateSession: dataIsCurrent && repoModels.length > 0 && auth.scopes.includes("submit-task"),
      canWriteFiles: dataIsCurrent && auth.scopes.includes("workspace-write"),
      canSubmitTasks: dataIsCurrent && auth.scopes.includes("submit-task"),
      canApproveActions: dataIsCurrent && auth.scopes.includes("approve-action"),
    };
  }, [approvals, auth.reason, auth.scopes, auth.status, auth.workspace, authError, changes, commandError, directStatus.detail, enrollmentId, files, grantKey, history, lastRefresh, loadedGrantKey, loading, machines, preview, ready, repositories, selectedEnrollmentId, selectedRepositoryId, selectedThreadId, sessions, terminalSession, threads, workflows]);

  const actions: WorkspaceActions = useMemo(() => ({
    onSelectRepository: setSelectedRepositoryId,
    onSelectSession: selectThread,
    onCreateSession: async () => { await createThread(); },
    onSendMessage: sendMessage,
    onCancelSession: cancelSession,
    onApproveAction: (approvalId) => decideApproval(approvalId, "accept"),
    onRejectAction: (approvalId) => decideApproval(approvalId, "decline"),
    onSelectFile: selectFile,
    onSaveFile: saveFile,
    onRunTests: undefined,
    onRunWorkflow: runWorkflow,
    onCancelWorkflow: cancelWorkflow,
    onSendTerminalCommand: auth.scopes.includes("terminal") ? sendTerminalCommand : undefined,
    onStartPreview: auth.scopes.includes("preview") ? () => capturePreview(false) : undefined,
    onRefreshPreview: auth.scopes.includes("preview") ? () => capturePreview(true) : undefined,
  }), [auth.scopes, cancelSession, cancelWorkflow, capturePreview, createThread, decideApproval, runWorkflow, saveFile, selectFile, selectThread, sendMessage, sendTerminalCommand]);
  const requestMachine = useCallback(async (targetEnrollmentId: string) => {
    if (!machines.some((machine) => machine.enrollmentId === targetEnrollmentId)) {
      setRequestError("That machine is no longer available. Refresh the page and try again.");
      return;
    }
    setSelectedEnrollmentId(targetEnrollmentId);
    setRequestError(null);
    try {
      const result = await requestAccess({ targetEnrollmentId });
      if (!result.ok) setRequestError(result.message);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "Could not request Desktop approval.");
    }
  }, [machines, requestAccess]);

  const onboarding = useMemo(() => ({
    machines,
    currentEnrollmentId: enrollmentId,
    selectedEnrollmentId: selectedEnrollmentId ?? enrollmentId,
    requestPending: auth.status === "pending",
    renewing: auth.renewing,
    requestId: auth.requestId,
    verificationCode: auth.verificationCode,
    error: requestError ?? (auth.status === "ended" ? authError ?? `This machine's browser access ${auth.reason ?? "ended"}. Connect again to request approval.` : authError),
    discoveryDetail,
    onSelectMachine: (targetEnrollmentId: string) => {
      setSelectedEnrollmentId(targetEnrollmentId);
      setRequestError(null);
    },
    onRequestMachine: requestMachine,
  }), [auth.reason, auth.requestId, auth.renewing, auth.status, auth.verificationCode, authError, discoveryDetail, enrollmentId, machines, requestError, requestMachine, selectedEnrollmentId]);

  const currentMachine = machines.find((machine) => machine.enrollmentId === enrollmentId);
  const controls = useMemo<WorkspaceExecutionControls | undefined>(() => {
    if (!executionOptions || executionGrantKey !== grantKey || !ready) return undefined;
    const selectedOption = executionOptions.providers.find((provider) => provider.provider === selectedProvider);
    const activeSession = selectedThreadId ? sessions[selectedThreadId] : undefined;
    const providerSwitchBusy = activeSession?.status === "busy" || activeSession?.status === "starting";
    const sessionSwitching = switchingSession?.threadId === selectedThreadId && switchingSession?.scopeKey === grantKey;
    const deliveryPending = pendingDelivery?.scopeKey === grantKey;
    return {
      chatAvailable: executionOptions.target.chatAvailable,
      unavailableReason: executionOptions.target.unavailableReason,
      providers: executionOptions.providers,
      maximumPermissionMode: executionOptions.maximumPermissionMode,
      provider: selectedOption ? selectedProvider : undefined,
      model: selectedOption?.models.some((item) => item.id === selectedModel) ? selectedModel : undefined,
      permissionMode: selectedOption?.permissionModes.includes(selectedPermissionMode as WorkspacePermissionMode) ? selectedPermissionMode : undefined,
      deliveryPending,
      providerSwitchBlocked: providerSwitchBusy || sessionSwitching || deliveryPending,
      providerSwitchBlockedReason: providerSwitchBusy
        ? "Finish or cancel the current turn before switching providers."
        : sessionSwitching ? "Changing provider session…"
          : deliveryPending ? "Wait for the current message to finish sending before switching providers."
            : undefined,
      onProviderChange: (provider) => {
        const next = executionOptions.providers.find((item) => item.provider === provider);
        setSelectedProvider(provider);
        setSelectedModel(next?.defaultModel ?? next?.models[0]?.id);
        setSelectedPermissionMode(next?.defaultPermissionMode ?? executionOptions.maximumPermissionMode);
      },
      onModelChange: setSelectedModel,
      onPermissionModeChange: setSelectedPermissionMode,
    };
  }, [executionGrantKey, executionOptions, grantKey, pendingDelivery, ready, selectedModel, selectedPermissionMode, selectedProvider, selectedThreadId, sessions, switchingSession]);

  const headerControls = <>
    <Button type="button" variant="ghost" size="sm" title="Lock this browser on this device" onClick={() => void lock()}><LockKeyhole aria-hidden="true" /><span className="hidden sm:inline">Lock browser</span></Button>
    {auth.status === "ready" || auth.status === "pending" || auth.status === "ended" ? <Button type="button" variant="ghost" size="sm" onClick={() => void disconnect()}>Disconnect</Button> : null}
  </>;

  return (
    <WorkspaceRoute
      model={model}
      actions={actions}
      onboarding={onboarding}
      execution={controls}
      targetLabel={executionOptions?.target.displayName ?? currentMachine?.displayName}
      draftScope={`${accountScope}:${selectedEnrollmentId ?? enrollmentId ?? "unpaired"}`}
      headerSlot={headerControls}
    />
  );
}
