"use client";

import {
  AlertCircle,
  ArrowUp,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleDot,
  Clock3,
  Code2,
  FileCode2,
  FileDiff,
  GitBranch,
  Laptop,
  Loader2,
  LockKeyhole,
  PanelRight,
  Play,
  Plus,
  RotateCcw,
  Save,
  Send,
  Square,
  TerminalSquare,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  WorkspaceActions,
  WorkspaceApproval,
  WorkspaceChange,
  WorkspaceConnectionState,
  WorkspacePreview,
  WorkspaceSession,
  WorkspaceShellProps,
  WorkspaceTest,
  WorkspaceView,
  WorkspaceViewModel,
  WorkspaceWorkflow,
} from "@/components/workspace/types";

const DRAFT_PREFIX = "anvil.browser-workspace.draft.v1";

const VIEW_LABELS: Record<WorkspaceView, string> = {
  conversation: "Conversation",
  files: "Files",
  changes: "Changes",
  runs: "Runs",
  terminal: "Terminal",
  preview: "Preview",
};

const VIEW_ICONS: Record<WorkspaceView, typeof Code2> = {
  conversation: CircleDot,
  files: FileCode2,
  changes: FileDiff,
  runs: Play,
  terminal: TerminalSquare,
  preview: PanelRight,
};

function isReady(model: WorkspaceViewModel): boolean {
  return model.connection.state === "connected";
}

function statusLabel(state: WorkspaceConnectionState): string {
  switch (state) {
    case "connected":
      return "Connected to Desktop";
    case "connecting":
      return "Connecting to Desktop";
    case "offline":
      return "Desktop is offline";
    case "permission-denied":
      return "Permission denied";
    case "unavailable":
      return "Desktop connection unavailable";
  }
}

function statusClass(state: WorkspaceConnectionState): string {
  switch (state) {
    case "connected":
      return "bg-accent";
    case "connecting":
      return "animate-pulse bg-accent";
    case "permission-denied":
      return "bg-destructive";
    default:
      return "bg-muted-foreground";
  }
}

function stateIcon(state: WorkspaceSession["state"] | WorkspaceTest["state"] | WorkspaceWorkflow["state"]) {
  if (state === "running") return <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />;
  if (state === "passed" || state === "completed") return <CheckCircle2 className="size-3.5 text-accent" aria-hidden="true" />;
  if (state === "failed") return <AlertCircle className="size-3.5 text-destructive" aria-hidden="true" />;
  if (state === "waiting") return <Clock3 className="size-3.5 text-accent" aria-hidden="true" />;
  return <Circle className="size-3.5 text-muted-foreground" aria-hidden="true" />;
}

function formatTimestamp(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  // Keep the first render identical between the server and browser. An
  // implicit locale/time zone makes hydration differ across machines.
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(date);
}

function getStorageKey(scope: string, sessionId?: string): string {
  return `${DRAFT_PREFIX}:${scope}:${sessionId ?? "new"}`;
}

function loadDraft(scope: string | null | undefined, sessionId?: string): string {
  if (!scope || typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(getStorageKey(scope, sessionId)) ?? "";
  } catch {
    return "";
  }
}

function saveDraft(scope: string | null | undefined, sessionId: string | undefined, draft: string): void {
  if (!scope || typeof window === "undefined") return;
  try {
    const key = getStorageKey(scope, sessionId);
    if (draft.length === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, draft);
  } catch {
    // Private browsing and storage quotas are safe reasons to lose a draft.
  }
}

export function WorkspaceShell({ model, actions = {}, draftScope, className, headerSlot }: WorkspaceShellProps) {
  const [activeView, setActiveView] = useState<WorkspaceView>("conversation");
  const draftKey = `${draftScope ?? ""}:${model.activeSessionId ?? "new"}`;
  const loadedDraftKey = useRef(draftKey);
  const [draft, setDraft] = useState(() => loadDraft(draftScope, model.activeSessionId));
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const activeRepository = model.repositories.find((repository) => repository.id === model.activeRepositoryId);
  const repoSessions = model.sessions.filter((session) => session.repositoryId === model.activeRepositoryId);
  const connected = isReady(model);

  useEffect(() => {
    if (loadedDraftKey.current === draftKey) return;
    loadedDraftKey.current = draftKey;
    queueMicrotask(() => setDraft(loadDraft(draftScope, model.activeSessionId)));
  }, [draftKey, draftScope, model.activeSessionId]);

  useEffect(() => {
    if (loadedDraftKey.current !== draftKey) return;
    saveDraft(draftScope, model.activeSessionId, draft);
  }, [draft, draftKey, draftScope, model.activeSessionId]);

  const sendMessage = useCallback(async () => {
    const content = draft.trim();
    if (!content || !actions.onSendMessage || !connected || !model.canSubmitTasks) return;
    try {
      await actions.onSendMessage(content);
      setDraft("");
    } catch {
      // Keep the draft visible when the relay rejects or loses the command.
      saveDraft(draftScope, model.activeSessionId, content);
    }
  }, [actions, connected, draft, draftScope, model.activeSessionId, model.canSubmitTasks]);

  const onComposerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void sendMessage();
      }
    },
    [sendMessage]
  );

  const onSelectSession = useCallback(
    async (sessionId: string) => {
      setActiveView("conversation");
      setMobileMenuOpen(false);
      await actions.onSelectSession?.(sessionId);
    },
    [actions]
  );

  const viewContent = useMemo(() => {
    switch (activeView) {
      case "files":
        return <FilesPanel model={model} actions={actions} />;
      case "changes":
        return <ChangesPanel changes={model.changes} />;
      case "runs":
        return <RunsPanel model={model} actions={actions} />;
      case "terminal":
        return <TerminalPanel terminal={model.terminal} actions={actions} ready={connected} />;
      case "preview":
        return <PreviewPanel preview={model.preview} actions={actions} ready={connected} />;
      case "conversation":
      default:
        return (
          <ConversationPanel
            model={model}
            actions={actions}
            draft={draft}
            setDraft={setDraft}
            onComposerKeyDown={onComposerKeyDown}
            onSend={sendMessage}
          />
        );
    }
  }, [actions, activeView, connected, draft, model, onComposerKeyDown, sendMessage]);

  return (
    <section aria-label="Browser workspace" className={cn("workspace-shell min-h-[min(52rem,calc(100dvh-7rem))] overflow-hidden rounded-lg border bg-background", className)}>
      <header className="flex min-h-14 items-center justify-between gap-3 border-b px-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Link href="/account" aria-label="Back to Account" title="Back to Account" className="inline-flex size-9 shrink-0 items-center justify-center rounded-md border text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <ArrowLeft className="size-4" aria-hidden="true" />
          </Link>
          <div className={cn("size-2 shrink-0 rounded-full", statusClass(model.connection.state))} aria-hidden="true" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{activeRepository?.name ?? "Workspace"}</p>
            <p className="truncate font-mono text-[0.6875rem] text-muted-foreground">
              {activeRepository?.path ?? "Desktop path withheld"}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
            <Laptop className="size-3.5" aria-hidden="true" />
            {model.connection.desktopName ?? statusLabel(model.connection.state)}
          </span>
          {headerSlot}
          <button
            type="button"
            className="inline-flex min-h-10 items-center gap-1.5 rounded-md border px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:hidden"
            aria-expanded={mobileMenuOpen}
            aria-controls="workspace-mobile-view-menu"
            onClick={() => setMobileMenuOpen((open) => !open)}
          >
            {VIEW_LABELS[activeView]}
            <ChevronDown className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="border-b lg:hidden">
        <WorkspaceMobileNav model={model} actions={actions} onSelectSession={onSelectSession} />
      </div>

      <div className="grid min-h-[calc(min(52rem,100dvh-7rem)-3.5rem)] lg:grid-cols-[14rem_minmax(0,1fr)_18rem]">
        <WorkspaceRail
          model={model}
          actions={actions}
          sessions={repoSessions}
          onSelectSession={onSelectSession}
          className="hidden lg:flex"
        />

        <section className="flex min-w-0 flex-col border-t lg:border-l lg:border-t-0" aria-label="Workspace content">
          <div
            id="workspace-mobile-view-menu"
            className={cn(
              "grid grid-cols-3 border-b bg-muted/20 p-1 lg:hidden",
              mobileMenuOpen ? "" : "hidden"
            )}
            role="tablist"
            aria-label="Workspace views"
          >
            {(Object.keys(VIEW_LABELS) as WorkspaceView[]).map((view) => (
              <ViewTab key={view} view={view} activeView={activeView} setActiveView={setActiveView} />
            ))}
          </div>
          <div className="hidden border-b bg-muted/20 px-3 py-1 lg:block">
            <div className="flex gap-1" role="tablist" aria-label="Workspace views">
              {(Object.keys(VIEW_LABELS) as WorkspaceView[]).map((view) => (
                <ViewTab key={view} view={view} activeView={activeView} setActiveView={setActiveView} />
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1">{viewContent}</div>
          <div className="border-t lg:hidden">
            <WorkspaceContext model={model} actions={actions} className="flex" />
          </div>
        </section>

        <WorkspaceContext model={model} actions={actions} className="hidden border-l lg:flex" />
      </div>
    </section>
  );
}

function ViewTab({
  view,
  activeView,
  setActiveView,
}: {
  view: WorkspaceView;
  activeView: WorkspaceView;
  setActiveView: (view: WorkspaceView) => void;
}) {
  const Icon = VIEW_ICONS[view];
  const active = activeView === view;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={cn(
        "flex min-h-10 items-center justify-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-3",
        active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:bg-background/70 hover:text-foreground"
      )}
      onClick={() => setActiveView(view)}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      <span>{VIEW_LABELS[view]}</span>
    </button>
  );
}

function WorkspaceRail({
  model,
  actions,
  sessions,
  onSelectSession,
  className,
}: {
  model: WorkspaceViewModel;
  actions: WorkspaceActions;
  sessions: WorkspaceSession[];
  onSelectSession: (sessionId: string) => void;
  className?: string;
}) {
  const ready = isReady(model);
  return (
    <aside className={cn("min-w-0 flex-col", className)} aria-label="Workspace navigation">
      <div className="flex items-center justify-between border-b px-3 py-2.5">
        <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Workspace</h2>
        <button
          type="button"
          className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          aria-label="Create session"
          title={ready && model.canCreateSession ? "Create session" : "Session creation unavailable"}
          disabled={!ready || !model.canCreateSession || !actions.onCreateSession}
          onClick={() => void actions.onCreateSession?.()}
        >
          <Plus className="size-4" aria-hidden="true" />
        </button>
      </div>

      <div className="grid gap-1 border-b p-2">
        <label htmlFor="workspace-repository" className="px-2 text-[0.6875rem] font-medium text-muted-foreground">
          Repository
        </label>
        {model.repositories.length > 0 ? (
          <select
            id="workspace-repository"
            value={model.activeRepositoryId ?? ""}
            disabled={!ready || !actions.onSelectRepository}
            onChange={(event) => void actions.onSelectRepository?.(event.target.value)}
            className="min-h-10 w-full rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
          >
            {model.repositories.map((repository) => (
              <option key={repository.id} value={repository.id} disabled={!repository.authorized}>
                {repository.name}
                {!repository.authorized ? " (not authorized)" : ""}
              </option>
            ))}
          </select>
        ) : (
          <p className="px-2 py-2 text-xs leading-5 text-muted-foreground">No authorized repositories are available.</p>
        )}
      </div>

      <div className="grid gap-1 p-2">
        <p className="px-2 py-1 text-[0.6875rem] font-medium text-muted-foreground">Sessions</p>
        {sessions.length > 0 ? (
          <ul className="grid gap-0.5" aria-label="Sessions">
            {sessions.map((session) => {
              const active = session.id === model.activeSessionId;
              return (
                <li key={session.id}>
                  <button
                    type="button"
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active && "bg-muted font-medium"
                    )}
                    onClick={() => void onSelectSession(session.id)}
                  >
                    <span className="shrink-0 text-muted-foreground">{stateIcon(session.state)}</span>
                    <span className="min-w-0 flex-1 truncate">{session.title || "Untitled session"}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="px-2 py-2 text-xs leading-5 text-muted-foreground">
            {model.repositories.length === 0 ? "Select an authorized repository to begin." : "No sessions in this repository."}
          </p>
        )}
      </div>

      <div className="mt-auto border-t px-3 py-3 text-[0.6875rem] leading-5 text-muted-foreground">
        <div className="flex items-start gap-2">
          <span className={cn("mt-1 size-1.5 shrink-0 rounded-full", statusClass(model.connection.state))} aria-hidden="true" />
          <span>{model.connection.detail ?? statusLabel(model.connection.state)}</span>
        </div>
      </div>
    </aside>
  );
}

function WorkspaceMobileNav({
  model,
  actions,
  onSelectSession,
}: {
  model: WorkspaceViewModel;
  actions: WorkspaceActions;
  onSelectSession: (sessionId: string) => void;
}) {
  const sessions = model.sessions.filter((session) => session.repositoryId === model.activeRepositoryId);
  return (
    <div className="grid gap-2 p-2">
      <div className="flex items-center gap-2">
        <label htmlFor="workspace-repository-mobile" className="sr-only">Repository</label>
        <select
          id="workspace-repository-mobile"
          value={model.activeRepositoryId ?? ""}
          disabled={!isReady(model) || !actions.onSelectRepository}
          onChange={(event) => void actions.onSelectRepository?.(event.target.value)}
          className="min-h-10 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
        >
          {model.repositories.length === 0 ? <option value="">No authorized repositories</option> : null}
          {model.repositories.map((repository) => <option key={repository.id} value={repository.id} disabled={!repository.authorized}>{repository.name}</option>)}
        </select>
        <button
          type="button"
          className="inline-flex size-10 shrink-0 items-center justify-center rounded-md border text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          aria-label="Create session"
          disabled={!isReady(model) || !model.canCreateSession || !actions.onCreateSession}
          onClick={() => void actions.onCreateSession?.()}
        >
          <Plus className="size-4" aria-hidden="true" />
        </button>
      </div>
      {sessions.length > 0 ? (
        <div className="flex gap-1 overflow-x-auto pb-0.5" role="list" aria-label="Sessions">
          {sessions.map((session) => {
            const active = session.id === model.activeSessionId;
            return <button key={session.id} type="button" role="listitem" aria-current={active ? "page" : undefined} className={cn("flex min-h-10 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", active && "bg-muted text-foreground")} onClick={() => void onSelectSession(session.id)}>{stateIcon(session.state)}<span className="max-w-40 truncate">{session.title || "Untitled session"}</span></button>;
          })}
        </div>
      ) : <p className="px-1 text-[0.6875rem] text-muted-foreground">No sessions in this repository.</p>}
    </div>
  );
}

function ConversationPanel({
  model,
  actions,
  draft,
  setDraft,
  onComposerKeyDown,
  onSend,
}: {
  model: WorkspaceViewModel;
  actions: WorkspaceActions;
  draft: string;
  setDraft: (draft: string) => void;
  onComposerKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void | Promise<void>;
}) {
  const activeSession = model.sessions.find((session) => session.id === model.activeSessionId);
  const ready = isReady(model);
  const canSend = Boolean(activeSession && ready && model.canSubmitTasks && actions.onSendMessage);
  const pendingApproval = model.approvals.some((approval) => approval.state === "pending");

  return (
    <div className="flex h-full min-h-[34rem] flex-col">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b px-4">
        <div className="min-w-0">
          <p className="max-h-10 overflow-hidden break-words text-sm font-medium leading-5">{activeSession?.title ?? "Conversation"}</p>
          {activeSession?.summary ? <p className="hidden truncate text-xs text-muted-foreground sm:block">{activeSession.summary}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {pendingApproval ? <button type="button" className="text-xs text-accent underline decoration-accent/50 underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => document.getElementById("workspace-context-approvals")?.scrollIntoView({ behavior: "smooth", block: "start" })}>Approval needed</button> : null}
          {activeSession?.state === "running" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!ready || !actions.onCancelSession}
              onClick={() => void actions.onCancelSession?.()}
            >
              <Square aria-hidden="true" />
              Cancel
            </Button>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        {!activeSession ? (
          <EmptyWorkspaceState
            icon={CircleDot}
            title="No session selected"
            description={
              model.repositories.length === 0
                ? "Authorize a repository in Anvil Desktop before starting browser work."
                : "Choose a session or create a new one to continue."
            }
            actionLabel="Create session"
            actionDisabled={!ready || !model.canCreateSession || !actions.onCreateSession}
            onAction={actions.onCreateSession}
          />
        ) : model.messages.length === 0 ? (
          <EmptyWorkspaceState
            icon={CircleDot}
            title="No messages yet"
            description="Send a request with the repository context attached. Desktop remains the executor."
          />
        ) : (
          <ol className="grid gap-5" aria-label="Conversation messages" aria-live="polite">
            {model.messages.map((message) => (
              <li key={message.id} className={cn("grid gap-1.5", message.role === "user" && "justify-items-end")}>
                <div className="flex items-center gap-2 text-[0.6875rem] text-muted-foreground">
                  <span className="font-medium capitalize">{message.role}</span>
                  {message.createdAt ? <time dateTime={message.createdAt}>{formatTimestamp(message.createdAt)}</time> : null}
                </div>
                <div
                  className={cn(
                    "max-w-[min(46rem,100%)] whitespace-pre-wrap rounded-md border px-3 py-2.5 text-sm leading-6",
                    message.role === "user" ? "bg-muted/50" : "bg-background",
                    message.pending && "opacity-70"
                  )}
                >
                  {message.content}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="border-t p-3 sm:p-4">
        {model.connection.state !== "connected" ? (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-dashed px-3 py-2.5 text-xs leading-5 text-muted-foreground" role="status">
            <LockKeyhole className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>{model.connection.detail ?? statusLabel(model.connection.state)}. Sending stays disabled until the authorized Desktop connection is ready.</span>
          </div>
        ) : null}
        <div className="relative rounded-md border bg-background focus-within:ring-2 focus-within:ring-ring">
          <label htmlFor="workspace-message" className="sr-only">Message Desktop</label>
          <textarea
            id="workspace-message"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onComposerKeyDown}
            placeholder={activeSession ? "Ask Desktop to inspect, change, or test this repository" : "Choose a session first"}
            disabled={!canSend}
            rows={3}
            className="block min-h-[5.5rem] w-full resize-y rounded-md border-0 bg-transparent px-3 py-3 pr-14 text-sm leading-6 outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
          />
          <button
            type="button"
            aria-label="Send message"
            title="Send message (⌘ Enter)"
            className="absolute bottom-2 right-2 inline-flex size-10 items-center justify-center rounded-md bg-primary text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-40"
            disabled={!canSend || draft.trim().length === 0}
            onClick={() => void onSend()}
          >
            <Send className="size-4" aria-hidden="true" />
          </button>
        </div>
        <p className="mt-2 text-[0.6875rem] text-muted-foreground">Cmd/Ctrl + Enter to send. Drafts stay in this account and workspace.</p>
      </div>
    </div>
  );
}

function FilesPanel({ model, actions }: { model: WorkspaceViewModel; actions: WorkspaceActions }) {
  const [selectedPath, setSelectedPath] = useState<string | undefined>(model.files[0]?.path);
  const selectedFile = model.files.find((file) => file.path === selectedPath) ?? model.files[0];
  const [content, setContent] = useState(selectedFile?.content ?? "");
  const ready = isReady(model);

  useEffect(() => {
    const nextFile = model.files.find((file) => file.path === selectedPath) ?? model.files[0];
    if (!nextFile) return;
    if (nextFile.path !== selectedPath) {
      queueMicrotask(() => {
        setSelectedPath(nextFile.path);
        setContent(nextFile.content ?? "");
      });
      return;
    }
    // A read arrives asynchronously after selecting a file. Do not replace a
    // user's edits; only hydrate the initially empty editor from that read.
    if (content.length === 0 && nextFile.content) queueMicrotask(() => setContent(nextFile.content ?? ""));
  }, [content, model.files, selectedPath]);

  if (model.files.length === 0) {
    return <EmptyWorkspaceState icon={FileCode2} title="No files available" description="Desktop has not returned files for this repository or session." />;
  }

  const canEdit = Boolean(selectedFile?.editable && ready && model.canWriteFiles && actions.onSaveFile);
  return (
    <div className="grid h-full min-h-[34rem] md:grid-cols-[13rem_minmax(0,1fr)]">
      <div className="border-b md:border-b-0 md:border-r">
        <div className="border-b px-3 py-2.5 text-xs font-semibold">Files</div>
        <ul className="grid max-h-64 gap-0.5 overflow-y-auto p-2 md:max-h-none" aria-label="Repository files">
          {model.files.map((file) => (
            <li key={file.path}>
              <button
                type="button"
                className={cn(
                  "flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-left font-mono text-[0.6875rem] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selectedPath === file.path && "bg-muted text-foreground"
                )}
                onClick={() => {
                  setSelectedPath(file.path);
                  setContent(file.content ?? "");
                  void actions.onSelectFile?.(file.path);
                }}
              >
                <FileCode2 className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{file.path}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex min-h-0 flex-col">
        <div className="flex min-h-12 items-center justify-between gap-3 border-b px-3 sm:px-4">
          <div className="flex min-w-0 items-center gap-2">
            <Code2 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate font-mono text-xs">{selectedFile?.path}</span>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!canEdit}
            title={!canEdit ? "File editing is unavailable for this scope" : undefined}
            onClick={() => {
              if (selectedFile && actions.onSaveFile) void actions.onSaveFile(selectedFile.path, content, selectedFile.revision);
            }}
          >
            <Save aria-hidden="true" />
            Save
          </Button>
        </div>
        <textarea
          aria-label={selectedFile ? `Edit ${selectedFile.path}` : "File editor"}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          readOnly={!canEdit}
          spellCheck={false}
          className="min-h-0 flex-1 resize-none bg-[oklch(var(--forge-bg))] p-4 font-mono text-xs leading-6 text-[oklch(var(--forge-text))] outline-none selection:bg-[oklch(var(--forge-ember)/0.22)]"
        />
        {!canEdit ? <p className="border-t px-4 py-2 text-[0.6875rem] text-muted-foreground">Read-only. Desktop must grant workspace-write for edits.</p> : null}
      </div>
    </div>
  );
}

function ChangesPanel({ changes }: { changes: WorkspaceChange[] }) {
  if (changes.length === 0) {
    return <EmptyWorkspaceState icon={FileDiff} title="No changes reported" description="Desktop has not returned a diff for this session." />;
  }
  return (
    <div className="grid gap-0">
      <div className="flex min-h-12 items-center justify-between border-b px-4">
        <h2 className="text-sm font-semibold">Changes</h2>
        <span className="font-mono text-[0.6875rem] text-muted-foreground">{changes.length} file{changes.length === 1 ? "" : "s"}</span>
      </div>
      <ul className="divide-y" aria-label="Changed files">
        {changes.map((change) => (
          <li key={change.path} className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <div className="flex min-w-0 items-center gap-2">
              <FileDiff className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="truncate font-mono text-xs">{change.path}</span>
              <span className="text-xs text-muted-foreground">{change.status}</span>
            </div>
            <div className="font-mono text-[0.6875rem] tabular-nums">
              <span className="text-accent">+{change.additions}</span>{" "}
              <span className="text-destructive">-{change.deletions}</span>
            </div>
            {change.diff ? <pre className="col-span-full max-h-72 overflow-auto rounded-md border bg-[oklch(var(--forge-bg))] p-3 font-mono text-[0.6875rem] leading-5 text-[oklch(var(--forge-text))]">{change.diff}</pre> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RunsPanel({ model, actions }: { model: WorkspaceViewModel; actions: WorkspaceActions }) {
  const ready = isReady(model);
  const hasRuns = model.tests.length > 0 || model.workflows.length > 0;
  return (
    <div className="grid gap-0">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b px-4">
        <div>
          <h2 className="text-sm font-semibold">Tests and workflows</h2>
          <p className="text-xs text-muted-foreground">Results returned by Desktop for this session.</p>
        </div>
        <Button type="button" size="sm" variant="outline" disabled={!ready || !model.canSubmitTasks || !actions.onRunTests} onClick={() => void actions.onRunTests?.()}>
          <RotateCcw aria-hidden="true" />
          Run tests
        </Button>
      </div>
      {!hasRuns ? <EmptyWorkspaceState icon={Play} title="No runs yet" description="Run tests when Desktop is connected and task submission is authorized." /> : null}
      {model.tests.length > 0 ? (
        <RunGroup title="Tests">
          {model.tests.map((test) => <RunRow key={test.id} title={test.name} state={test.state} detail={test.detail} />)}
        </RunGroup>
      ) : null}
      {model.workflows.length > 0 ? (
        <RunGroup title="Workflows">
          {model.workflows.map((workflow) => (
            <li key={workflow.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="flex min-w-0 items-center gap-2">
                {stateIcon(workflow.state)}
                <span className="truncate text-sm">{workflow.name}</span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-xs text-muted-foreground">{workflow.state}</span>
                {workflow.state === "queued" || workflow.state === "failed" ? (
                  <button type="button" className="inline-flex min-h-8 items-center rounded-md border px-2 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" disabled={!ready || !actions.onRunWorkflow} onClick={() => void actions.onRunWorkflow?.(workflow.id)}>Run</button>
                ) : workflow.state === "running" ? (
                  <button type="button" className="inline-flex min-h-8 items-center rounded-md border px-2 text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" disabled={!ready || !actions.onCancelWorkflow} onClick={() => void actions.onCancelWorkflow?.(workflow.id)}>Cancel</button>
                ) : null}
              </div>
            </li>
          ))}
        </RunGroup>
      ) : null}
    </div>
  );
}

function RunGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b">
      <h3 className="border-b px-4 py-2 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">{title}</h3>
      <ul className="divide-y">{children}</ul>
    </section>
  );
}

function RunRow({ title, state, detail }: { title: string; state: WorkspaceTest["state"]; detail?: string }) {
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="flex min-w-0 items-center gap-2">
        {stateIcon(state)}
        <span className="truncate text-sm">{title}</span>
      </div>
      <span className="shrink-0 text-xs text-muted-foreground">{detail ?? state}</span>
    </li>
  );
}

function TerminalPanel({ terminal, actions, ready }: { terminal?: WorkspaceViewModel["terminal"]; actions: WorkspaceActions; ready: boolean }) {
  const [command, setCommand] = useState("");
  const inputEnabled = Boolean(terminal?.inputEnabled && ready && actions.onSendTerminalCommand);
  if (!terminal) {
    return <EmptyWorkspaceState icon={TerminalSquare} title="No terminal output" description="Desktop has not attached a terminal to this session." />;
  }
  return (
    <div className="flex h-full min-h-[34rem] flex-col bg-[oklch(var(--forge-bg))] text-[oklch(var(--forge-text))]">
      <div className="forge-window-bar"><span className="dot dot--ember" /><span className="dot" /><span className="dot" /><span className="ml-2 font-mono text-[0.6875rem] text-[oklch(var(--forge-dim))]">Desktop terminal</span></div>
      {terminal.detail ? <p className="border-b border-[oklch(var(--forge-line))] px-4 py-2 font-mono text-[0.6875rem] text-[oklch(var(--forge-dim))]">{terminal.detail}</p> : null}
      <pre className="terminal-body min-h-0 flex-1 overflow-auto p-4" aria-label="Terminal output">
        {terminal.lines.map((line) => <span key={line.id} className={cn("terminal-line", line.tone === "muted" && "text-[oklch(var(--forge-dim))]", line.tone === "success" && "text-[oklch(var(--forge-ember))]", line.tone === "warning" && "text-amber-300", line.tone === "error" && "text-red-300")}>{line.text}</span>)}
      </pre>
      <form
        className="flex items-center gap-2 border-t border-[oklch(var(--forge-line))] p-3"
        onSubmit={(event) => {
          event.preventDefault();
          const value = command.trim();
          if (!value || !actions.onSendTerminalCommand) return;
          setCommand("");
          void actions.onSendTerminalCommand(value);
        }}
      >
        <span className="font-mono text-xs text-[oklch(var(--forge-ember))]" aria-hidden="true">$</span>
        <label htmlFor="workspace-terminal-command" className="sr-only">Terminal command</label>
        <input id="workspace-terminal-command" value={command} onChange={(event) => setCommand(event.target.value)} disabled={!inputEnabled} placeholder={inputEnabled ? "Scoped command" : "Terminal input is not authorized"} className="min-h-10 min-w-0 flex-1 bg-transparent font-mono text-xs text-[oklch(var(--forge-text))] outline-none placeholder:text-[oklch(var(--forge-dim))] disabled:cursor-not-allowed disabled:opacity-60" />
        <button type="submit" aria-label="Run terminal command" className="inline-flex size-10 shrink-0 items-center justify-center rounded-md border border-[oklch(var(--forge-line))] text-[oklch(var(--forge-text))] hover:bg-[oklch(var(--forge-raised))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[oklch(var(--forge-ember))] disabled:pointer-events-none disabled:opacity-40" disabled={!inputEnabled || command.trim().length === 0}><ArrowUp className="size-4" aria-hidden="true" /></button>
      </form>
    </div>
  );
}

function PreviewPanel({ preview, actions, ready }: { preview?: WorkspacePreview; actions: WorkspaceActions; ready: boolean }) {
  if (!preview) {
    return <EmptyWorkspaceState icon={PanelRight} title="No preview attached" description="Desktop has not returned a preview for this session." />;
  }
  const canStart = ready && actions.onStartPreview && (preview.state === "stopped" || preview.state === "unavailable" || preview.state === "error");
  const canRefresh = ready && actions.onRefreshPreview && preview.state === "ready";
  return (
    <div className="flex h-full min-h-[34rem] flex-col">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b px-4">
        <div>
          <h2 className="text-sm font-semibold">Preview</h2>
          <p className="text-xs text-muted-foreground">Authenticated development preview from Desktop.</p>
        </div>
        <div className="flex gap-2">
          {canRefresh ? <Button type="button" size="sm" variant="outline" onClick={() => void actions.onRefreshPreview?.()}><RotateCcw aria-hidden="true" /> Refresh screenshot</Button> : null}
          {canStart ? <Button type="button" size="sm" variant="outline" onClick={() => void actions.onStartPreview?.()}><Play aria-hidden="true" /> Capture screenshot</Button> : null}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        {preview.state === "ready" && preview.data ? (
          <div className="flex h-full w-full flex-col overflow-hidden rounded-md border">
            <div className="flex min-h-10 items-center gap-2 border-b px-3 font-mono text-[0.6875rem] text-muted-foreground"><LockKeyhole className="size-3.5" aria-hidden="true" />{preview.detail ?? "Approved Desktop screenshot"}{preview.capturedAt ? ` · ${formatTimestamp(preview.capturedAt)}` : ""}</div>
            <img src={`data:${preview.mimeType ?? "image/png"};base64,${preview.data}`} alt="Authenticated development preview captured by Desktop" className="min-h-[28rem] w-full flex-1 bg-white object-contain object-top" />
          </div>
        ) : (
          <EmptyWorkspaceState icon={PanelRight} title={preview.state === "starting" ? "Preview is starting" : "Preview unavailable"} description={preview.detail ?? "Desktop has not made an authenticated preview available."} />
        )}
      </div>
    </div>
  );
}

function WorkspaceContext({ model, actions, className }: { model: WorkspaceViewModel; actions: WorkspaceActions; className?: string }) {
  return (
    <aside className={cn("min-w-0 flex-col", className)} aria-label="Workspace context">
      <div className="border-b px-3 py-2.5"><h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">Context</h2></div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ContextSection title="Repository">
          {model.repositories.find((repository) => repository.id === model.activeRepositoryId) ? (
            <RepositoryFacts repository={model.repositories.find((repository) => repository.id === model.activeRepositoryId)!} />
          ) : <p className="text-xs leading-5 text-muted-foreground">No repository selected.</p>}
        </ContextSection>
        <ContextSection id="workspace-context-approvals" title="Approvals" count={model.approvals.filter((approval) => approval.state === "pending").length}>
          {model.approvals.length === 0 ? <p className="text-xs leading-5 text-muted-foreground">No pending approvals.</p> : <ApprovalList approvals={model.approvals} actions={actions} ready={isReady(model)} canApprove={model.canApproveActions} />}
        </ContextSection>
        <ContextSection title="Connection">
          <div className="grid gap-2 text-xs">
            <div className="flex items-center gap-2"><span className={cn("size-1.5 rounded-full", statusClass(model.connection.state))} aria-hidden="true" /><span>{statusLabel(model.connection.state)}</span></div>
            {model.connection.checkedAt ? <p className="font-mono text-[0.6875rem] text-muted-foreground">checked {formatTimestamp(model.connection.checkedAt)}</p> : null}
            <p className="leading-5 text-muted-foreground">Browser commands use the authorized Desktop connection. Cloud execution is not selected implicitly.</p>
          </div>
        </ContextSection>
      </div>
    </aside>
  );
}

function ContextSection({ id, title, count, children }: { id?: string; title: string; count?: number; children: React.ReactNode }) {
  return <section id={id} className="border-b px-3 py-3"><div className="mb-2 flex items-center justify-between gap-2"><h3 className="text-xs font-semibold">{title}</h3>{typeof count === "number" && count > 0 ? <span className="font-mono text-[0.6875rem] text-accent">{count}</span> : null}</div>{children}</section>;
}

function RepositoryFacts({ repository }: { repository: WorkspaceViewModel["repositories"][number] }) {
  return <dl className="grid gap-2 text-xs"><div><dt className="text-muted-foreground">Path</dt><dd className="mt-0.5 break-all font-mono text-[0.6875rem]">{repository.path ?? "Desktop path withheld"}</dd></div>{repository.branch ? <div><dt className="text-muted-foreground">Branch</dt><dd className="mt-0.5 flex items-center gap-1 font-mono text-[0.6875rem]"><GitBranch className="size-3" aria-hidden="true" />{repository.branch}</dd></div> : null}<div><dt className="text-muted-foreground">Access</dt><dd className="mt-0.5">{repository.authorized ? "Authorized" : "Not authorized"}{repository.dirty ? " · local changes" : ""}</dd></div></dl>;
}

function ApprovalList({ approvals, actions, ready, canApprove }: { approvals: WorkspaceApproval[]; actions: WorkspaceActions; ready: boolean; canApprove: boolean }) {
  const pending = approvals.filter((approval) => approval.state === "pending");
  if (pending.length === 0) return <p className="text-xs leading-5 text-muted-foreground">No pending approvals.</p>;
  return <ul className="grid gap-3">{pending.map((approval) => <li key={approval.id} className="grid gap-2 border-t pt-2 first:border-t-0 first:pt-0"><p className="text-xs font-medium">{approval.title}</p><p className="text-[0.6875rem] leading-5 text-muted-foreground">{approval.detail}</p>{approval.scope ? <p className="font-mono text-[0.625rem] text-muted-foreground">scope: {approval.scope}</p> : null}<div className="flex gap-2"><button type="button" className="inline-flex min-h-8 items-center gap-1 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50" disabled={!ready || !canApprove || !actions.onApproveAction} onClick={() => void actions.onApproveAction?.(approval.id)}><Check className="size-3.5" aria-hidden="true" />Approve</button><button type="button" className="inline-flex min-h-8 items-center gap-1 rounded-md border px-2.5 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50" disabled={!ready || !canApprove || !actions.onRejectAction} onClick={() => void actions.onRejectAction?.(approval.id)}><X className="size-3.5" aria-hidden="true" />Reject</button></div></li>)}</ul>;
}

function EmptyWorkspaceState({ icon: Icon, title, description, actionLabel, actionDisabled, onAction }: { icon: typeof CircleDot; title: string; description: string; actionLabel?: string; actionDisabled?: boolean; onAction?: () => void | Promise<void> }) {
  return <div className="flex min-h-[22rem] items-center justify-center px-6 py-12"><div className="grid max-w-sm justify-items-center gap-3 text-center"><Icon className="size-5 text-muted-foreground" aria-hidden="true" /><h2 className="text-sm font-semibold">{title}</h2><p className="text-sm leading-6 text-muted-foreground">{description}</p>{actionLabel ? <Button type="button" size="sm" variant="outline" disabled={actionDisabled} onClick={() => void onAction?.()}>{actionLabel}</Button> : null}</div></div>;
}
