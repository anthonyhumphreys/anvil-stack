"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AlertCircle, Check, KeyRound, LockKeyhole, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { WorkspaceRoute } from "@/components/workspace/workspace-route";
import type {
  WorkspaceActions,
  WorkspaceApproval,
  WorkspaceChange,
  WorkspaceFile,
  WorkspacePreview,
  WorkspaceRepository,
  WorkspaceSession,
  WorkspaceTerminal,
  WorkspaceTest,
  WorkspaceViewModel,
  WorkspaceWorkflow,
} from "@/components/workspace/types";
import {
  useBrowserWorkspace,
  type BrowserWorkspaceAuth,
  type BrowserWorkspaceCommandInput,
  type BrowserWorkspaceRequestOptions,
} from "@/lib/browser-workspace";
import type { DashboardScope } from "@/lib/hosted/types";

const ACCESS_SCOPES: Array<{ value: DashboardScope; label: string; detail: string }> = [
  { value: "workspace-read", label: "Read workspace", detail: "Repositories, sessions, files, diffs, and results" },
  { value: "workspace-write", label: "Edit files", detail: "Guarded file writes with revision checks" },
  { value: "submit-task", label: "Send work", detail: "Create sessions, send messages, run workflows, cancel work" },
  { value: "approve-action", label: "Resolve approvals", detail: "Approve or reject Desktop requests" },
  { value: "terminal", label: "Use terminal", detail: "Open a scoped Desktop terminal" },
  { value: "preview", label: "Capture preview", detail: "Request an authenticated Desktop screenshot" },
];

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
  const role = item?.role === "user" || item?.role === "assistant" || item?.role === "system" ? item.role : undefined;
  if (!id || content === undefined || !role) return null;
  return { id, role, content, timestamp: stringValue(item?.timestamp) };
}

function parseSession(value: unknown): RawSession | null {
  const item = record(value);
  const id = stringValue(item?.id);
  const status = stringValue(item?.status);
  if (!id || !status) return null;
  return { id, status, repoId: stringValue(item?.repoId), startedAt: stringValue(item?.startedAt) };
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

function scopeKey(accountScope: string, workspaceId: string): string {
  return `anvil.browser-workspace.selection.v1:${accountScope}:${workspaceId}`;
}

function commandPayload(operation: BrowserWorkspaceCommandInput["operation"], payload: JsonRecord): JsonRecord {
  return { operation, ...payload };
}

export function BrowserWorkspaceClient({ accountScope }: { accountScope: string }) {
  const client = useBrowserWorkspace({ accountScope, resumeStoredSession: true });
  const { auth, error: authError, execute } = client;
  const workspaceId = auth.workspace?.workspaceId;
  const ready = auth.status === "ready" && workspaceId !== undefined;
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
  const [lastRefresh, setLastRefresh] = useState<string>();
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const historyInFlight = useRef<Promise<void> | null>(null);
  const repositoryInFlight = useRef<Promise<void> | null>(null);
  const workspaceGeneration = useRef(0);
  const selectedRepositoryRef = useRef(selectedRepositoryId);
  const selectedThreadRef = useRef(selectedThreadId);
  // The terminal session is the ref's source of truth; state is the render mirror.
  const terminalSessionRef = useRef<TerminalSessionState | null>(null);

  useEffect(() => {
    selectedRepositoryRef.current = selectedRepositoryId;
    selectedThreadRef.current = selectedThreadId;
  }, [selectedRepositoryId, selectedThreadId]);

  useEffect(() => {
    workspaceGeneration.current += 1;
    refreshInFlight.current = null;
    historyInFlight.current = null;
    repositoryInFlight.current = null;
  }, [accountScope, ready, workspaceId]);

  const runCommand = useCallback(
    async <T,>(input: BrowserWorkspaceCommandInput): Promise<T | null> => {
      try {
        const result = await execute<T>(input);
        if (!result.ok) {
          setCommandError(result.error?.message ?? "Desktop could not complete that command.");
          return null;
        }
        setCommandError(null);
        return result.data ?? null;
      } catch (error) {
        setCommandError(error instanceof Error ? error.message : "Desktop workspace command failed.");
        return null;
      }
    },
    [execute]
  );

  const refresh = useCallback(async () => {
    if (!workspaceId || !ready) return;
    if (refreshInFlight.current) return refreshInFlight.current;
    const generation = workspaceGeneration.current;
    const promise = (async () => {
      setLoading(true);
      const [repoData, threadData, approvalData, workflowData] = await Promise.all([
        runCommand<unknown[]>({ operation: "repo.list", workspaceId, payload: commandPayload("repo.list", {}) }),
        runCommand<unknown[]>({ operation: "chat.thread.list", workspaceId, payload: commandPayload("chat.thread.list", {}) }),
        runCommand<unknown[]>({ operation: "chat.approvals.list", workspaceId, payload: commandPayload("chat.approvals.list", {}) }),
        runCommand<JsonRecord>({ operation: "workflow.list", workspaceId, payload: commandPayload("workflow.list", {}) }),
      ]);
      if (generation !== workspaceGeneration.current || !ready || workspaceId !== auth.workspace?.workspaceId) return;
      const nextRepositories = listValue(repoData).map(parseRepository).filter((value): value is RawRepository => value !== null);
      const nextThreads = listValue(threadData).map(parseThread).filter((value): value is RawThread => value !== null);
      const nextApprovals = listValue(approvalData).map(parseApproval).filter((value): value is RawApproval => value !== null);
      const workflowRuns = listValue(record(workflowData)?.runs).map(parseWorkflow).filter((value): value is RawWorkflowRun => value !== null);
      setRepositories(nextRepositories);
      setThreads(nextThreads);
      setApprovals(nextApprovals);
      setWorkflows(workflowRuns);
      setSelectedRepositoryId((current) => current && nextRepositories.some((repo) => repo.id === current) ? current : nextRepositories[0]?.id);
      setSelectedThreadId((current) => current && nextThreads.some((thread) => thread.id === current) ? current : nextThreads[0]?.id);
      setLastRefresh(new Date().toISOString());
    })().finally(() => {
      if (generation === workspaceGeneration.current) setLoading(false);
    });
    refreshInFlight.current = promise;
    try {
      await promise;
    } finally {
      if (refreshInFlight.current === promise) refreshInFlight.current = null;
    }
  }, [auth.workspace?.workspaceId, ready, runCommand, workspaceId]);

  useEffect(() => {
    if (!ready) return;
    queueMicrotask(() => void refresh());
  }, [ready, refresh, workspaceId]);

  useEffect(() => {
    if (!ready || !workspaceId) return;
    const interval = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(interval);
  }, [ready, refresh, workspaceId]);

  useEffect(() => {
    if (!ready || !workspaceId) return;
    const key = scopeKey(accountScope, workspaceId);
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
  }, [accountScope, ready, workspaceId]);

  useEffect(() => {
    if (!ready || !workspaceId) return;
    try {
      window.localStorage.setItem(scopeKey(accountScope, workspaceId), JSON.stringify({ repositoryId: selectedRepositoryId, threadId: selectedThreadId }));
    } catch {
      // Private browsing may deny storage. Data remains usable in memory.
    }
  }, [accountScope, ready, selectedRepositoryId, selectedThreadId, workspaceId]);

  const loadThreadHistory = useCallback(async (threadId: string) => {
    if (!workspaceId || !ready) return;
    const data = await runCommand<JsonRecord>({ operation: "chat.history.read", workspaceId, payload: commandPayload("chat.history.read", { threadId }) });
    const messages = listValue(data?.messages).map(parseMessage).filter((value): value is RawMessage => value !== null);
    setHistory((current) => ({ ...current, [threadId]: messages }));
  }, [ready, runCommand, workspaceId]);

  useEffect(() => {
    if (selectedThreadId && !history[selectedThreadId]) queueMicrotask(() => void loadThreadHistory(selectedThreadId));
  }, [history, loadThreadHistory, selectedThreadId]);

  const loadRepositoryData = useCallback(async (repositoryId: string) => {
    if (!workspaceId || !ready) return;
    const [fileData, statusData] = await Promise.all([
      runCommand<JsonRecord>({ operation: "file.list", workspaceId, repositoryId, payload: commandPayload("file.list", { repositoryId, maxEntries: 500 }) }),
      runCommand<JsonRecord>({ operation: "git.status", workspaceId, repositoryId, payload: commandPayload("git.status", { repositoryId }) }),
    ]);
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
    setChanges(withDiffs);
  }, [ready, runCommand, workspaceId]);

  useEffect(() => {
    if (selectedRepositoryId) queueMicrotask(() => void loadRepositoryData(selectedRepositoryId));
  }, [loadRepositoryData, selectedRepositoryId]);

  const selectFile = useCallback(async (relativePath: string) => {
    if (!workspaceId || !ready || !selectedRepositoryId) return;
    const data = await runCommand<JsonRecord>({ operation: "file.read", workspaceId, repositoryId: selectedRepositoryId, payload: commandPayload("file.read", { repositoryId: selectedRepositoryId, relativePath }) });
    if (!data) return;
    setFiles((current) => current.map((file) => file.path === relativePath ? { ...file, content: typeof data.content === "string" ? data.content : "", revision: stringValue(data.revision) ?? null, editable: data.binary !== true } : file));
  }, [ready, runCommand, selectedRepositoryId, workspaceId]);

  const saveFile = useCallback(async (relativePath: string, content: string, expectedRevision?: string | null) => {
    if (!workspaceId || !ready || !selectedRepositoryId) return;
    const data = await runCommand<JsonRecord>({ operation: "file.write", workspaceId, repositoryId: selectedRepositoryId, payload: commandPayload("file.write", { repositoryId: selectedRepositoryId, relativePath, content, expectedRevision: expectedRevision ?? null }) });
    if (data) setFiles((current) => current.map((file) => file.path === relativePath ? { ...file, content, revision: stringValue(data.revision) ?? null } : file));
  }, [ready, runCommand, selectedRepositoryId, workspaceId]);

  const selectThread = useCallback(async (threadId: string) => {
    setSelectedThreadId(threadId);
    await loadThreadHistory(threadId);
  }, [loadThreadHistory]);

  const createThread = useCallback(async () => {
    if (!workspaceId || !ready || !auth.scopes.includes("submit-task")) return;
    const repositoryIds = selectedRepositoryId ? [selectedRepositoryId] : repositories.map((repo) => repo.id);
    const data = await runCommand<JsonRecord>({ operation: "chat.create", workspaceId, payload: commandPayload("chat.create", { personaId: "coder", repositoryIds, activeRepositoryId: selectedRepositoryId ?? null }) });
    const thread = parseThread(data);
    if (!thread) throw new Error("Desktop did not return the new workspace session.");
    setThreads((current) => [thread, ...current.filter((item) => item.id !== thread.id)]);
    setSelectedThreadId(thread.id);
    setHistory((current) => ({ ...current, [thread.id]: [] }));
  }, [auth.scopes, ready, repositories, runCommand, selectedRepositoryId, workspaceId]);

  const ensureSession = useCallback(async (threadId: string): Promise<RawSession | null> => {
    const existing = sessions[threadId];
    if (existing) return existing;
    if (!workspaceId || !ready) return null;
    const thread = threads.find((item) => item.id === threadId);
    const repositoryId = thread?.activeRepoId ?? selectedRepositoryId;
    const data = await runCommand<JsonRecord>({ operation: "chat.session.start", workspaceId, payload: commandPayload("chat.session.start", { threadId, ...(repositoryId ? { repositoryId } : {}) }) });
    const session = parseSession(data);
    if (session) setSessions((current) => ({ ...current, [threadId]: session }));
    return session;
  }, [ready, runCommand, selectedRepositoryId, sessions, threads, workspaceId]);

  const sendMessage = useCallback(async (message: string) => {
    if (!workspaceId || !ready || !selectedThreadId || !auth.scopes.includes("submit-task")) return;
    const session = await ensureSession(selectedThreadId);
    if (!session) throw new Error("Desktop could not start the workspace session.");
    const result = await runCommand<JsonRecord>({ operation: "chat.send", workspaceId, payload: commandPayload("chat.send", { threadId: selectedThreadId, sessionId: session.id, message }) });
    if (!result) throw new Error("Desktop did not accept the message.");
    setHistory((current) => ({ ...current, [selectedThreadId]: [...(current[selectedThreadId] ?? []), { id: `browser:${Date.now()}`, role: "user", content: message, timestamp: new Date().toISOString() }] }));
    setTimeout(() => void loadThreadHistory(selectedThreadId), 800);
  }, [auth.scopes, ensureSession, loadThreadHistory, ready, runCommand, selectedThreadId, workspaceId]);

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
    setPreview({ state: "starting", detail: "Requesting a screenshot from the approving Desktop…" });
    const data = await runCommand<JsonRecord>({
      operation: "preview.screenshot",
      workspaceId,
      repositoryId: selectedRepositoryId,
      payload: commandPayload("preview.screenshot", { repositoryId: selectedRepositoryId, refresh: refreshFrame }),
    });
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
    const repoModels: WorkspaceRepository[] = repositories.map((repo) => ({ id: repo.id, name: repo.name, branch: repo.defaultBranch, dirty: repo.status === "dirty" || repo.status === "modified", authorized: auth.workspace?.repoIds.includes(repo.id) ?? false }));
    const threadModels: WorkspaceSession[] = threads.filter((thread) => !selectedRepositoryId || thread.repoIds.length === 0 || thread.repoIds.includes(selectedRepositoryId)).map((thread) => ({ id: thread.id, repositoryId: thread.activeRepoId ?? selectedRepositoryId ?? "", title: thread.title, summary: thread.summary ?? thread.preview, updatedAt: thread.updatedAt, state: statusToSessionState(sessions[thread.id]?.status, thread.attentionState) }));
    const approvalModels: WorkspaceApproval[] = approvals.map((approval) => ({ id: approval.requestKey, title: approval.kind ?? "Desktop approval", detail: approval.reason ?? approval.command ?? "Desktop requested permission for this session.", scope: approval.policy ?? approval.repoName, state: "pending" }));
    const workflowModels: WorkspaceWorkflow[] = workflows.map((run) => ({ id: run.id, name: run.templateName ?? run.templateId ?? "Workflow", state: workflowState(run.status), detail: run.error, updatedAt: run.updatedAt ?? run.createdAt }));
    const messageModels = selectedThreadId ? (history[selectedThreadId] ?? []).map((message) => ({ id: message.id, role: message.role, content: message.content, createdAt: message.timestamp })) : [];
    const hasTerminalScope = auth.scopes.includes("terminal");
    const hasPreviewScope = auth.scopes.includes("preview");
    const terminalModel: WorkspaceTerminal | undefined = ready
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
                : `Scoped terminal on ${repositories.find((repo) => repo.id === terminalSession.repoId)?.name ?? terminalSession.repoId}.`,
        }
      : undefined;
    const previewModel: WorkspacePreview | undefined = ready
      ? (preview ?? {
          state: "unavailable",
          detail: hasPreviewScope
            ? "Capture a screenshot of the selected repository's running dev server."
            : "The current grant does not include preview access.",
        })
      : undefined;
    return {
      connection: { state: ready ? "connected" : auth.status === "pending" ? "connecting" : auth.status === "ended" && auth.reason === "revoked" ? "permission-denied" : "unavailable", desktopName: auth.workspace ? `Desktop · ${auth.workspace.enrollmentId.slice(0, 8)}` : undefined, detail: commandError ?? (loading ? "Loading authorized workspace data…" : authError ?? undefined), checkedAt: lastRefresh },
      repositories: repoModels,
      sessions: threadModels,
      activeRepositoryId: selectedRepositoryId,
      activeSessionId: selectedThreadId,
      messages: messageModels,
      approvals: approvalModels,
      files,
      changes,
      tests: [] as WorkspaceTest[],
      workflows: workflowModels,
      terminal: terminalModel,
      preview: previewModel,
      canCreateSession: ready && auth.scopes.includes("submit-task"),
      canWriteFiles: ready && auth.scopes.includes("workspace-write"),
      canSubmitTasks: ready && auth.scopes.includes("submit-task"),
      canApproveActions: ready && auth.scopes.includes("approve-action"),
    };
  }, [approvals, auth.reason, auth.scopes, auth.status, auth.workspace, authError, changes, commandError, files, history, lastRefresh, loading, preview, ready, repositories, selectedRepositoryId, selectedThreadId, sessions, terminalSession, threads, workflows]);

  const actions: WorkspaceActions = useMemo(() => ({
    onSelectRepository: setSelectedRepositoryId,
    onSelectSession: selectThread,
    onCreateSession: createThread,
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

  if (!ready) {
    return <WorkspaceAccessGate auth={auth} error={authError} onRequest={client.requestAccess} />;
  }

  return <WorkspaceRoute model={model} actions={actions} draftScope={`${accountScope}:${workspaceId}`} headerSlot={<Button type="button" variant="ghost" size="sm" onClick={() => void client.lock()}><LockKeyhole aria-hidden="true" />Lock</Button>} />;
}

function WorkspaceAccessGate({ auth, error, onRequest }: { auth: BrowserWorkspaceAuth; error: string | null; onRequest: (request: BrowserWorkspaceRequestOptions) => Promise<unknown> }) {
  const [workspaceId, setWorkspaceId] = useState("");
  const [repositoryIds, setRepositoryIds] = useState("");
  const [scopes, setScopes] = useState<DashboardScope[]>(["workspace-read"]);
  const [busy, setBusy] = useState(false);
  const toggleScope = (scope: DashboardScope) => setScopes((current) => current.includes(scope) ? current.filter((item) => item !== scope) : [...current, scope]);
  const requestedRepositoryIds = repositoryIds.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean);
  if (auth.status === "pending") {
    return (
      <AccessState title="Waiting for Desktop approval" detail={`Request ${auth.requestId ?? "pending"} is waiting for an enrolled Desktop to approve this browser.`}>
        <div className="grid gap-1.5 rounded-md border border-dashed px-3 py-2.5">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Verification code</p>
          <p className="font-mono text-lg tracking-widest">{auth.verificationCode ?? "…"}</p>
          <p className="text-xs leading-5 text-muted-foreground">Confirm this code matches the one shown beside this request in Anvil Desktop before approving.</p>
        </div>
      </AccessState>
    );
  }
  return (
    <div className="grid gap-6 rounded-lg border bg-background p-5 sm:p-7">
      <div className="grid gap-2">
        <div className="flex items-center gap-2"><KeyRound className="size-4 text-accent" aria-hidden="true" /><h1 className="text-xl font-semibold">Authorize a Desktop workspace</h1></div>
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">The browser does not discover repositories or hold device keys. Enter the workspace ID shown by Anvil Desktop, then choose the permissions this browser should request.</p>
      </div>
      {auth.status === "ended" ? <p role="status" className="rounded-md border border-dashed px-3 py-2.5 text-sm text-muted-foreground">The previous browser grant {auth.reason ?? "ended"}. Request a new grant to continue.</p> : null}
      {error ? <p role="alert" className="flex items-start gap-2 rounded-md border border-destructive/50 px-3 py-2.5 text-sm text-destructive"><AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{error}</p> : null}
      <form className="grid gap-5" onSubmit={(event) => { event.preventDefault(); if (!workspaceId.trim() || requestedRepositoryIds.length === 0 || scopes.length === 0) return; setBusy(true); void onRequest({ workspaceIds: [workspaceId.trim()], repositoryIds: requestedRepositoryIds, scopes }).finally(() => setBusy(false)); }}>
        <div className="grid gap-2"><label htmlFor="workspace-id" className="text-sm font-medium">Workspace ID</label><input id="workspace-id" value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)} required pattern="[A-Za-z0-9_-]{1,200}" className="min-h-11 rounded-md border bg-background px-3 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" placeholder="workspace-id" /><p className="text-xs text-muted-foreground">Use the ID shown by Anvil Desktop. The browser cannot discover workspaces.</p></div>
        <div className="grid gap-2"><label htmlFor="repository-ids" className="text-sm font-medium">Authorized repository IDs</label><input id="repository-ids" value={repositoryIds} onChange={(event) => setRepositoryIds(event.target.value)} required pattern="[A-Za-z0-9_-]+([\s,]+[A-Za-z0-9_-]+)*" className="min-h-11 rounded-md border bg-background px-3 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" placeholder="repo-id, another-repo-id" /><p className="text-xs text-muted-foreground">Enter the exact repository IDs selected in Desktop, separated by commas or spaces. Wildcards are not accepted.</p></div>
        <fieldset className="grid gap-2"><legend className="text-sm font-medium">Requested permissions</legend>{ACCESS_SCOPES.map((scope) => <label key={scope.value} className="flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 hover:bg-muted"><input type="checkbox" checked={scopes.includes(scope.value)} onChange={() => toggleScope(scope.value)} className="mt-1 size-4 accent-[oklch(var(--accent))]" /><span><span className="block text-sm font-medium">{scope.label}</span><span className="block text-xs leading-5 text-muted-foreground">{scope.detail}</span></span></label>)}</fieldset>
        <Button type="submit" disabled={busy || workspaceId.trim().length === 0 || requestedRepositoryIds.length === 0 || scopes.length === 0}>{busy ? <RefreshCw className="animate-spin" aria-hidden="true" /> : <Check aria-hidden="true" />}Request Desktop approval</Button>
      </form>
    </div>
  );
}

function AccessState({ title, detail, children }: { title: string; detail: string; children?: ReactNode }) {
  return <div className="grid gap-3 rounded-lg border bg-background p-5 sm:p-7"><div className="flex items-center gap-2"><LockKeyhole className="size-4 text-muted-foreground" aria-hidden="true" /><h1 className="text-xl font-semibold">{title}</h1></div><p className="text-sm leading-6 text-muted-foreground">{detail}</p>{children}</div>;
}
