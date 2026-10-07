"use client";

import {
  AlertCircle,
  ArrowUp,
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
import { Children } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { ChatEmptyState } from "../../../anvil-app/src/renderer/components/chat/ChatEmptyState";
import { WorkspaceStart } from "@/components/workspace/workspace-start";
import { WorkspaceMessageContent } from "@/components/workspace/workspace-message-content";
import { cn } from "@/lib/utils";
import {
  ChatAssistantMessageBody,
  ChatAssistantMessageFrame,
  ChatAssistantMessageHeader,
  ChatComposerEditor,
  ChatComposerFooter,
  ChatComposerFrame,
  ChatComposerSurface,
  ChatEmptyStateFrame,
  ChatMessageRow,
  ChatThreadItemButton,
  ChatThreadItemFrame,
  ChatUserMessageFrame,
  ChatUserMessageHeader,
  ChatUserMessageSurface,
} from "../../../anvil-app/src/renderer/components/chat/shared/ChatPresentation";
import type {
  WorkspaceActions,
  WorkspaceApproval,
  WorkspaceChange,
  WorkspaceConnectionState,
  WorkspaceExecutionControls,
  WorkspaceOnboardingState,
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
  context: "Approvals",
};

const VIEW_ICONS: Record<WorkspaceView, typeof Code2> = {
  conversation: CircleDot,
  files: FileCode2,
  changes: FileDiff,
  runs: Play,
  terminal: TerminalSquare,
  preview: PanelRight,
  context: LockKeyhole,
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

export function WorkspaceShell({ model, actions = {}, onboarding, execution, targetLabel, draftScope, className, headerSlot }: WorkspaceShellProps) {
  const [selectedView, setActiveView] = useState<WorkspaceView>("conversation");
  const draftKey = `${draftScope ?? ""}:${model.activeSessionId ?? "new"}`;
  const [draftState, setDraftState] = useState(() => ({
    key: draftKey,
    text: loadDraft(draftScope, model.activeSessionId),
  }));
  const draft = draftState.key === draftKey ? draftState.text : "";
  const setDraft = useCallback((text: string) => {
    setDraftState({ key: draftKey, text });
  }, [draftKey]);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const activeRepository = model.repositories.find((repository) => repository.id === model.activeRepositoryId);
  const repoSessions = model.sessions.filter((session) => session.repositoryId === model.activeRepositoryId);
  const connected = isReady(model);
  const activeView = connected ? selectedView : "conversation";

  useEffect(() => {
    if (draftState.key === draftKey) return;
    queueMicrotask(() => setDraft(loadDraft(draftScope, model.activeSessionId)));
  }, [draftKey, draftScope, draftState.key, model.activeSessionId, setDraft]);

  useEffect(() => {
    if (draftState.key !== draftKey) return;
    saveDraft(draftScope, model.activeSessionId, draft);
  }, [draft, draftKey, draftScope, draftState.key, model.activeSessionId]);

  const sendMessage = useCallback(async () => {
    const submittedDraft = draft;
    const content = draft.trim();
    const submissionDraftKey = draftKey;
    const submissionScope = draftScope;
    const submissionSessionId = model.activeSessionId;
    const targetMatches = !onboarding || onboarding.selectedEnrollmentId === onboarding.currentEnrollmentId;
    if (
      !content ||
      !actions.onSendMessage ||
      !connected ||
      !targetMatches ||
      (!model.activeSessionId && !model.canCreateSession) ||
      !model.canSubmitTasks ||
      !execution?.chatAvailable ||
      !execution.provider ||
      !execution.model ||
      !execution.permissionMode
    ) return;
    try {
      await actions.onSendMessage(content, {
        provider: execution.provider,
        model: execution.model,
        permissionMode: execution.permissionMode,
      });
      if (loadDraft(submissionScope, submissionSessionId) === submittedDraft) {
        saveDraft(submissionScope, submissionSessionId, "");
      }
      setDraftState((current) => current.key === submissionDraftKey && current.text === submittedDraft
        ? { ...current, text: "" }
        : current);
    } catch {
      // The keyed draft stays saved, including any newer typing, if delivery fails.
    }
  }, [actions, connected, draft, draftKey, draftScope, execution, model.activeSessionId, model.canCreateSession, model.canSubmitTasks, onboarding]);

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

  const panelContent = useMemo(() => {
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
      case "context":
        return <WorkspaceContext model={model} actions={actions} className="flex" />;
      default:
        return null;
    }
  }, [actions, activeView, connected, model]);

  const currentMachineId = model.connection.targetEnrollmentId;
  const currentMachine = onboarding?.machines.find((machine) => machine.enrollmentId === currentMachineId);
  const title = activeRepository?.name ?? (connected ? "Workspace" : "Anvil");

  return (
    <section aria-label="Anvil workspace" className={cn("workspace-shell anvil-chat-theme flex h-dvh min-h-[32rem] flex-col overflow-hidden bg-background", className)}>
      <header className="flex min-h-14 items-center justify-between gap-3 border-b px-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-3">
          <Link href="/account/workspace" aria-label="Anvil workspace home" className="inline-flex min-h-10 shrink-0 items-center gap-2 rounded-md px-2 font-semibold tracking-[-0.02em] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <span className="size-2.5 rounded-[2px] bg-accent" aria-hidden="true" />Anvil
          </Link>
          <span className="hidden h-6 w-px bg-border sm:block" aria-hidden="true" />
          <div className="hidden min-w-0 sm:block">
            <p className="truncate text-sm font-medium">{title}</p>
            <p className="truncate font-mono text-[0.6875rem] text-muted-foreground">
              {activeRepository?.branch ? `${activeRepository.branch} · ` : ""}{activeRepository?.path ?? (connected ? "Connected workspace" : "Choose a paired machine to begin")}
            </p>
          </div>
        </div>
        <div className="flex min-w-0 shrink-0 items-center gap-2">
          {onboarding && onboarding.machines.length > 0 && connected ? (
            <span className="hidden max-w-52 items-center gap-1.5 truncate text-xs text-muted-foreground sm:flex">
              <Laptop className="size-3.5 shrink-0" aria-hidden="true" />{targetLabel ?? currentMachine?.displayName ?? model.connection.desktopName ?? "Connected machine"}
            </span>
          ) : connected ? (
            <span className="hidden max-w-52 items-center gap-1.5 truncate text-xs text-muted-foreground sm:flex">
              <Laptop className="size-3.5 shrink-0" aria-hidden="true" />{targetLabel ?? model.connection.desktopName ?? "Connected machine"}
            </span>
          ) : null}
          <Link href="/account/devices" aria-label="Manage paired machines" title="Manage paired machines" className="inline-flex size-10 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Laptop className="size-4" aria-hidden="true" />
          </Link>
          {headerSlot ? <div className="flex items-center gap-1">{Children.toArray(headerSlot)}</div> : null}
          {connected ? <button
            type="button"
            className="inline-flex min-h-10 items-center gap-1.5 rounded-md border px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
            aria-expanded={mobileMenuOpen}
            aria-controls="workspace-mobile-view-menu"
            onClick={() => setMobileMenuOpen((open) => !open)}
          >
            {VIEW_LABELS[activeView]}
            <ChevronDown className="size-3.5" aria-hidden="true" />
          </button> : null}
        </div>
      </header>

      <div className={cn("grid min-h-0 flex-1", activeView === "conversation" ? "lg:grid-cols-[15rem_minmax(0,1fr)]" : "lg:grid-cols-[13rem_minmax(0,1fr)_minmax(20rem,0.42fr)]")}>
        <WorkspaceRail
          model={model}
          actions={actions}
          onboarding={onboarding}
          sessions={repoSessions}
          onSelectSession={onSelectSession}
          className="hidden lg:flex"
        />

        <section className="flex min-h-0 min-w-0 flex-col lg:border-l" aria-label="Workspace content">
          {connected ? <div className="border-b lg:hidden">
            <WorkspaceMobileNav model={model} actions={actions} onSelectSession={onSelectSession} />
          </div> : null}
          {connected ? <div
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
          </div> : null}
          {connected ? <div className="hidden min-h-10 items-center justify-end border-b px-2 lg:flex">
            <div className="flex gap-0.5" role="tablist" aria-label="Workspace tools">
              {(Object.keys(VIEW_LABELS) as WorkspaceView[]).filter((view) => view !== "conversation").map((view) => (
                <ViewTab key={view} view={view} activeView={activeView} setActiveView={setActiveView} />
              ))}
              <button type="button" role="tab" aria-selected={activeView === "conversation"} onClick={() => setActiveView("conversation")} className="sr-only">Conversation</button>
            </div>
          </div> : null}

          <div className={cn("min-h-0 flex-1", activeView !== "conversation" && "hidden lg:flex lg:min-h-0 lg:flex-col")}>
            <ConversationPanel
              model={model}
              actions={actions}
              draft={draft}
              setDraft={setDraft}
              onComposerKeyDown={onComposerKeyDown}
              onSend={sendMessage}
              execution={execution}
              onboarding={onboarding}
              targetLabel={targetLabel ?? currentMachine?.displayName ?? model.connection.desktopName}
              onShowApprovals={() => setActiveView("context")}
            />
          </div>
          {activeView !== "conversation" ? (
            <div className="min-h-0 flex-1 lg:hidden">{panelContent}</div>
          ) : null}
        </section>

        {activeView !== "conversation" ? (
          <aside className="hidden min-h-0 min-w-0 flex-col border-l lg:flex" aria-label={`${VIEW_LABELS[activeView]} panel`}>
            <div className="flex min-h-10 items-center justify-between border-b px-3">
              <h2 className="text-xs font-semibold">{VIEW_LABELS[activeView]}</h2>
              <button type="button" className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Close tool panel" onClick={() => setActiveView("conversation")}>
                <PanelRight className="size-4" aria-hidden="true" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">{panelContent}</div>
          </aside>
        ) : null}
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
  onboarding,
  sessions,
  onSelectSession,
  className,
}: {
  model: WorkspaceViewModel;
  actions: WorkspaceActions;
  onboarding?: WorkspaceOnboardingState;
  sessions: WorkspaceSession[];
  onSelectSession: (sessionId: string) => void;
  className?: string;
}) {
  const ready = isReady(model);
  if (!ready) {
    return (
      <aside className={cn("min-w-0 flex-col border-r", className)} aria-label="Workspace navigation">
        <div className="border-b px-3 py-3"><h2 className="text-xs font-semibold">Projects</h2></div>
        <p className="px-4 py-4 text-xs leading-5 text-muted-foreground">Projects and chats appear here after you connect a machine.</p>
        <div className="mt-auto border-t px-3 py-3">
          <Link href="/account/devices" className="inline-flex min-h-9 items-center gap-1.5 text-xs text-muted-foreground underline decoration-border underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Laptop className="size-3.5" aria-hidden="true" />Manage machines
          </Link>
        </div>
      </aside>
    );
  }
  return (
    <aside className={cn("min-w-0 flex-col", className)} aria-label="Workspace navigation">
      <div className="flex items-center justify-between border-b px-3 py-2.5">
        <h2 className="text-xs font-semibold">Projects</h2>
        <button
          type="button"
          className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          aria-label="New chat"
          title={ready && model.canCreateSession ? "New chat" : "New chat unavailable"}
          disabled={!ready || !model.canCreateSession || !actions.onCreateSession}
          onClick={() => void actions.onCreateSession?.()}
        >
          <Plus className="size-4" aria-hidden="true" />
        </button>
      </div>

      <div className="grid gap-1 border-b p-2">
        <label htmlFor="workspace-repository" className="px-2 text-[0.6875rem] font-medium text-muted-foreground">
          Project
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
          <p className="px-2 py-2 text-xs leading-5 text-muted-foreground">{onboarding?.machines.length ? "Choose a machine to load its projects." : "No project is open."}</p>
        )}
      </div>

      <div className="grid gap-1 p-2">
        <p className="px-2 py-1 text-[0.6875rem] font-medium text-muted-foreground">Chats</p>
        {sessions.length > 0 ? (
          <ul className="grid gap-0.5" aria-label="Sessions">
            {sessions.map((session) => {
              const active = session.id === model.activeSessionId;
              return (
                <li key={session.id}>
                  <ChatThreadItemFrame active={active}>
                    <ChatThreadItemButton
                      type="button"
                      compact
                      aria-current={active ? "page" : undefined}
                      onClick={() => void onSelectSession(session.id)}
                    >
                      <span className="mt-0.5 shrink-0 text-text-tertiary">{stateIcon(session.state)}</span>
                      <span className="min-w-0 flex-1 truncate text-sm text-text-primary">{session.title || "Untitled session"}</span>
                    </ChatThreadItemButton>
                  </ChatThreadItemFrame>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="px-2 py-2 text-xs leading-5 text-muted-foreground">
            {model.repositories.length === 0 ? "Choose a machine to load its projects." : "No chats in this project yet."}
          </p>
        )}
      </div>

      <div className="mt-auto border-t px-3 py-3 text-[0.6875rem] leading-5 text-muted-foreground">
        <div className="flex items-start gap-2">
          <span className={cn("mt-1 size-1.5 shrink-0 rounded-full", statusClass(model.connection.state))} aria-hidden="true" />
          <span>{model.connection.detail ?? statusLabel(model.connection.state)}</span>
        </div>
        {onboarding?.machines.length ? (
          <Link href="/account/devices" className="mt-2 inline-flex min-h-9 items-center gap-1.5 text-xs underline decoration-border underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Laptop className="size-3.5" aria-hidden="true" />Manage machines
          </Link>
        ) : null}
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
  execution,
  onboarding,
  targetLabel,
  draft,
  setDraft,
  onComposerKeyDown,
  onSend,
  onShowApprovals,
}: {
  model: WorkspaceViewModel;
  actions: WorkspaceActions;
  execution?: WorkspaceExecutionControls;
  onboarding?: WorkspaceOnboardingState;
  targetLabel?: string;
  draft: string;
  setDraft: (draft: string) => void;
  onComposerKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: () => void | Promise<void>;
  onShowApprovals: () => void;
}) {
  const activeSession = model.sessions.find((session) => session.id === model.activeSessionId);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const lastTranscriptKey = useRef<string | undefined>(undefined);
  const transcriptKey = `${model.connection.targetEnrollmentId ?? ""}:${model.activeSessionId ?? ""}`;
  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    if (lastTranscriptKey.current !== transcriptKey || followOutput.current) {
      transcript.scrollTop = transcript.scrollHeight;
      followOutput.current = true;
    }
    lastTranscriptKey.current = transcriptKey;
  }, [transcriptKey, model.messages]);
  const ready = isReady(model);
  const selectedTargetIsConnected = !onboarding || onboarding.currentEnrollmentId === onboarding.selectedEnrollmentId;
  const canSend = Boolean(
    ready &&
    selectedTargetIsConnected &&
    (activeSession || model.canCreateSession) &&
    model.canSubmitTasks &&
    actions.onSendMessage &&
    execution?.chatAvailable &&
    !execution.deliveryPending &&
    execution.provider &&
    execution.model &&
    execution.permissionMode
  );
  const pendingApproval = model.approvals.some((approval) => approval.state === "pending");

  return (
    <div className="flex h-full min-h-[34rem] flex-col">
      <div className="flex min-h-12 items-center justify-between gap-3 border-b px-4">
        <div className="min-w-0">
          <p className="max-h-10 overflow-hidden break-words text-sm font-medium leading-5">{activeSession?.title ?? "What should we work on?"}</p>
          {activeSession?.summary ? <p className="hidden truncate text-xs text-muted-foreground sm:block">{activeSession.summary}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {pendingApproval ? <button type="button" className="text-xs text-accent underline decoration-accent/50 underline-offset-4 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={onShowApprovals}>Approval needed</button> : null}
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

      <div
        ref={transcriptRef}
        onScroll={(event) => {
          const transcript = event.currentTarget;
          followOutput.current = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 96;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6"
      >
        {!ready && onboarding ? (
          <WorkspaceStart {...onboarding} />
        ) : !activeSession || model.messages.length === 0 ? (
          <ChatEmptyState
            personaId="coder"
            hasRepos={model.repositories.length > 0}
            hasGovernanceDocs={false}
            isDbExpertPersona={false}
            onSuggestionClick={setDraft}
          />
        ) : (
          <ol className="mx-auto grid w-full max-w-[1040px] gap-5" aria-label="Conversation messages" aria-live="polite">
            {model.messages.map((message) => (
              <li key={message.id} className={cn(message.pending && "opacity-70")}>
                {message.role !== "user" ? (
                  <ChatMessageRow align="start">
                    <ChatAssistantMessageFrame>
                      <ChatAssistantMessageHeader>
                        <span className="size-1.5 rounded-full bg-text-tertiary" aria-hidden="true" />
                        <span>{message.role === "system" ? "Activity" : "Anvil"}</span>
                        {message.createdAt ? <time dateTime={message.createdAt}>{formatTimestamp(message.createdAt)}</time> : null}
                      </ChatAssistantMessageHeader>
                      <ChatAssistantMessageBody>
                        <WorkspaceMessageContent content={message.content} />
                      </ChatAssistantMessageBody>
                    </ChatAssistantMessageFrame>
                  </ChatMessageRow>
                ) : (
                  <ChatMessageRow align="end">
                    <ChatUserMessageFrame>
                      <ChatUserMessageHeader>
                        You
                        {message.createdAt ? <time dateTime={message.createdAt}>{formatTimestamp(message.createdAt)}</time> : null}
                      </ChatUserMessageHeader>
                      <ChatUserMessageSurface>
                        <p className="whitespace-pre-wrap break-words leading-relaxed [overflow-wrap:anywhere]">{message.content}</p>
                      </ChatUserMessageSurface>
                    </ChatUserMessageFrame>
                  </ChatMessageRow>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>

      <ChatComposerFrame className="shrink-0">
        <ChatComposerSurface hasContent={draft.trim().length > 0} disabled={!ready || !selectedTargetIsConnected}>
          {ready && !selectedTargetIsConnected ? <p role="status" className="px-4 pt-2 text-xs text-text-tertiary">Connect to {onboarding?.machines.find((machine) => machine.enrollmentId === onboarding.selectedEnrollmentId)?.displayName ?? "the selected machine"} to continue.</p> : null}
          {ready && execution && !execution.chatAvailable ? <p role="status" className="px-4 pt-2 text-xs text-text-tertiary">{execution.unavailableReason ?? "Chat is unavailable on this machine."}</p> : null}
          <label htmlFor="workspace-message" className="sr-only">Message Anvil</label>
          <ChatComposerEditor
            id="workspace-message"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onComposerKeyDown}
            placeholder="Message Anvil"
            disabled={!ready || !selectedTargetIsConnected}
            rows={1}
          />
          <ChatComposerFooter>
            <div className="min-w-0 flex-1">
              {ready && (execution || onboarding) ? <ExecutionControlsBar controls={execution} onboarding={onboarding} targetLabel={targetLabel} /> : null}
              <p className="px-1 pt-1 text-[0.6875rem] text-text-tertiary">Cmd/Ctrl + Enter to send.</p>
            </div>
            <button
              type="button"
              aria-label="Send message"
              title="Send message (⌘ Enter)"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent text-bg-primary transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg-secondary disabled:pointer-events-none disabled:opacity-40"
          disabled={!canSend || draft.trim().length === 0}
              onClick={() => void onSend()}
            >
              <Send className="size-4" aria-hidden="true" />
            </button>
          </ChatComposerFooter>
        </ChatComposerSurface>
      </ChatComposerFrame>
    </div>
  );
}

const PROVIDER_LABELS: Record<WorkspaceExecutionControls["providers"][number]["provider"], string> = {
  codex: "Codex",
  openai: "OpenAI API",
  azure: "Azure Foundry",
  cursor: "Cursor",
  devin: "Devin",
  llmgateway: "LLM Gateway",
};

const PERMISSION_MODE_LABELS: Record<WorkspaceExecutionControls["maximumPermissionMode"], string> = {
  "read-only": "Read only",
  "on-request": "Ask for access",
  "workspace-auto": "Workspace access",
  "full-access": "Full access",
};

function ExecutionControlsBar({ controls, onboarding, targetLabel }: { controls?: WorkspaceExecutionControls; onboarding?: WorkspaceOnboardingState; targetLabel?: string }) {
  const provider = controls?.providers.find((item) => item.provider === controls.provider);
  const modelValue = controls?.model ?? provider?.defaultModel ?? "";
  const modeValue = controls?.permissionMode ?? provider?.defaultPermissionMode ?? "";
  const usableProviders = controls?.providers.filter((item) => item.enabled && item.available) ?? [];
  const selectedMachineId = onboarding?.selectedEnrollmentId;
  const targetNeedsConnect = Boolean(selectedMachineId && onboarding?.currentEnrollmentId !== selectedMachineId);

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {onboarding && onboarding.machines.length > 0 ? (
        <label className="flex min-h-9 max-w-[18rem] flex-1 items-center gap-1.5 rounded-md border px-2 text-[0.6875rem] font-medium focus-within:ring-2 focus-within:ring-ring">
          <span className="shrink-0 text-muted-foreground">Run on</span>
          <select
            aria-label="Run on machine"
            value={onboarding.selectedEnrollmentId ?? ""}
            onChange={(event) => onboarding.onSelectMachine?.(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-foreground outline-none"
          >
            {onboarding.machines.map((machine) => <option key={machine.enrollmentId} value={machine.enrollmentId}>{machine.displayName}</option>)}
          </select>
          {targetNeedsConnect ? (
            <button type="button" className="min-h-8 shrink-0 rounded px-2 text-[0.6875rem] font-semibold text-accent hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => selectedMachineId && void onboarding.onRequestMachine?.(selectedMachineId)}>Connect</button>
          ) : null}
        </label>
      ) : (
        <label className="flex min-h-9 max-w-[18rem] flex-1 items-center gap-1.5 rounded-md border px-2 text-[0.6875rem] font-medium text-muted-foreground">
          <span className="shrink-0">Run on</span>
          <span className="truncate text-foreground">{targetLabel ?? "No machine selected"}</span>
        </label>
      )}
      <label className="flex min-h-9 max-w-[14rem] flex-1 items-center gap-1 rounded-md border px-2 text-[0.6875rem] font-medium focus-within:ring-2 focus-within:ring-ring">
        <span className="shrink-0 text-muted-foreground">Provider</span>
        <select
          aria-label="Model provider"
          value={controls?.provider ?? ""}
          onChange={(event) => controls?.onProviderChange?.(event.target.value as WorkspaceExecutionControls["providers"][number]["provider"])}
          disabled={!controls?.chatAvailable || !controls.onProviderChange || usableProviders.length === 0 || controls.providerSwitchBlocked}
          className="min-w-0 flex-1 bg-transparent text-foreground outline-none disabled:cursor-not-allowed disabled:opacity-60"
        >
          {controls?.providers.map((item) => (
            <option key={item.provider} value={item.provider} disabled={!item.enabled || !item.available}>
              {PROVIDER_LABELS[item.provider]}{!item.enabled ? " · disabled in Desktop" : !item.available ? " · unavailable" : ""}
            </option>
          ))}
          {!controls || controls.providers.length === 0 ? <option value="">Loading providers…</option> : null}
        </select>
      </label>
      <label className="flex min-h-9 max-w-[14rem] flex-1 items-center gap-1 rounded-md border px-2 text-[0.6875rem] font-medium focus-within:ring-2 focus-within:ring-ring">
        <span className="shrink-0 text-muted-foreground">Model</span>
        <select
          aria-label="Model"
          value={modelValue}
          onChange={(event) => controls?.onModelChange?.(event.target.value)}
          disabled={!controls?.chatAvailable || !provider || !provider.available || provider.models.length === 0 || !controls.onModelChange}
          className="min-w-0 flex-1 bg-transparent text-foreground outline-none disabled:cursor-not-allowed disabled:opacity-60"
        >
          {provider?.models.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          {!provider?.models.length ? <option value="">No models available</option> : null}
        </select>
      </label>
      <label className="flex min-h-9 max-w-[13rem] flex-1 items-center gap-1 rounded-md border px-2 text-[0.6875rem] font-medium focus-within:ring-2 focus-within:ring-ring">
        <span className="shrink-0 text-muted-foreground">Access</span>
        <select
          aria-label="Access mode"
          value={modeValue}
          onChange={(event) => controls?.onPermissionModeChange?.(event.target.value as WorkspaceExecutionControls["maximumPermissionMode"])}
          disabled={!controls?.chatAvailable || !provider || !provider.available || provider.permissionModes.length === 0 || !controls.onPermissionModeChange}
          className="min-w-0 flex-1 bg-transparent text-foreground outline-none disabled:cursor-not-allowed disabled:opacity-60"
        >
          {provider?.permissionModes.map((mode) => <option key={mode} value={mode}>{PERMISSION_MODE_LABELS[mode]}</option>)}
          {!provider?.permissionModes.length ? <option value="">Unavailable</option> : null}
        </select>
      </label>
      {provider?.unavailableReason ? <p className="w-full text-[0.6875rem] leading-5 text-muted-foreground">{provider.unavailableReason}</p> : null}
      {controls?.providerSwitchBlockedReason ? <p className="w-full text-[0.6875rem] leading-5 text-muted-foreground">{controls.providerSwitchBlockedReason}</p> : null}
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
    <div className="flex h-full min-h-[30rem] flex-col">
      <div className="flex min-h-12 items-center gap-2 border-b px-3">
        <Code2 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <label htmlFor="workspace-file-path" className="sr-only">File</label>
        <select
          id="workspace-file-path"
          value={selectedFile?.path ?? ""}
          onChange={(event) => {
            const file = model.files.find((item) => item.path === event.target.value);
            if (!file) return;
            setSelectedPath(file.path);
            setContent(file.content ?? "");
            void actions.onSelectFile?.(file.path);
          }}
          className="min-h-10 min-w-0 flex-1 bg-transparent font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {model.files.map((file) => <option key={file.path} value={file.path}>{file.path}</option>)}
        </select>
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
            <span className="hidden sm:inline">Save</span>
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
      {!canEdit ? <p className="border-t px-3 py-2 text-[0.6875rem] text-muted-foreground">Read only · Desktop must grant workspace-write to edit</p> : null}
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
              <p className="leading-5 text-muted-foreground">Workspace commands run on the selected Anvil Desktop machine.</p>
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
  return <ChatEmptyStateFrame className="min-h-[22rem]"><div className="grid max-w-sm justify-items-center gap-3 text-center"><Icon className="size-5 text-text-tertiary" aria-hidden="true" /><h2 className="text-sm font-semibold text-text-primary">{title}</h2><p className="text-sm leading-6 text-text-tertiary">{description}</p>{actionLabel ? <Button type="button" size="sm" variant="outline" disabled={actionDisabled} onClick={() => void onAction?.()}>{actionLabel}</Button> : null}</div></ChatEmptyStateFrame>;
}
