import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AgentUIPlanIntent, AgentUIQuestionIntent } from '../../../shared/agent-ui-intents';
import type {
  AgentProvider,
  ChatAttachment,
  ChatLayout,
  Persona,
  ReasoningEffort,
  UserRole,
} from '../../../shared/types';
import { ROLE_FEATURES, ROLE_RECOMMENDED_PERSONAS } from '../../../shared/types';
import { ChatInput, type ChatSlashCommand } from './ChatInput';
import { ChatThreadRail } from './ChatThreadRail';
import { WorkItemThreadRail } from './WorkItemThreadRail';
import { ChatHeader } from './ChatHeader';
import { ChatTranscript } from './ChatTranscript';
import { deriveChatPaneState, type ChatPaneKind } from './ChatPaneState';
import { ChatPersonaPicker } from './ChatPersonaPicker';
import { ChatSidePanels } from './ChatSidePanels';
import { buildFindingFollowUpPrompt } from './ChatFindingCard';
import { PendingQuestionPrompt, WorkflowActionConfirmation } from './ChatPromptOverlays';
import { useChatErrorRecovery } from './useChatErrorRecovery';
import { composeChatTurns } from './chat-turns';
import { useChatContext } from '../../contexts/ChatContext';
import { useWorkspace, repoIsMapped } from '../../contexts/WorkspaceContext';
import { WorkspaceReadinessStrip } from '../workspace/WorkspaceReadinessStrip';
import { getStarterPrompts } from '../../utils/starter-prompts';
import { DesignProvider } from '../../contexts/DesignContext';
import { RepoSelector } from '../shared/RepoSelector';
import { GovernanceSelector } from '../shared/GovernanceSelector';
import { extractFindings, type ExtractedFinding } from '../../utils/finding-parser';
import type { ExecutionStrategy } from '../../utils/execution-strategy';
import { SessionOwnershipChip } from './SessionOwnershipChip';
import { buildExecutionTopology } from '../../utils/execution-topology';
import { CHAT_PREFILL_EVENT } from './AgentUIIntentSurface';
import { resolveChatFastModeTarget } from '../../utils/chat-fast-mode';
import { useChatPanels, type ChatPanelId } from './useChatPanels';
import { useChatViewData } from './useChatViewData';
import { useChatRouteIntents } from './useChatRouteIntents';
import { useChatWorkflowAction } from './useChatWorkflowAction';
import { useThreadAccess } from './useThreadAccess';
import {
  chatAccessOptionsForProvider,
  expectedAcpAppliedMode,
  type ChatAccessOption,
} from './thread-access';
import { isAcpAgentProvider } from '../../../shared/agent-providers';
import { agentProviderLabel } from '../../utils/agent-display';
import {
  buildMessageReusePrefill,
  isNearChatBottom,
  shouldFocusChatComposerFromKey,
} from './chat-view-utils';

// Re-exported for the existing `../ChatView` import path used by tests.
export {
  buildMessageReusePrefill,
  clampCanvasZoom,
  getChatTurnLiveState,
  getNewChatThreadActionLabel,
  isNearChatBottom,
  shouldFocusChatComposerFromKey,
  shouldShowTurnActivityStatus,
} from './chat-view-utils';

const ITSM_PERSONA_IDS = new Set(ROLE_RECOMMENDED_PERSONAS.itsm ?? []);

/** H13 — slash-command copy names the agent the thread actually runs on. */
function buildSlashCommands(agentLabel: string): ChatSlashCommand[] {
  return [
    {
      id: 'new',
      command: '/new',
      label: 'New thread',
      description: 'Start a fresh chat thread.',
      insertText: '/new',
    },
    {
      id: 'plan',
      command: '/plan',
      label: 'Plan work item',
      description: `Ask ${agentLabel} to plan an ADO work item.`,
      insertText: '/plan ADO-',
    },
    {
      id: 'fix',
      command: '/fix',
      label: 'Fix work item',
      description: `Ask ${agentLabel} to implement an ADO work item.`,
      insertText: '/fix ADO-',
    },
    {
      id: 'review',
      command: '/review',
      label: 'Review work item',
      description: `Ask ${agentLabel} to review an ADO work item.`,
      insertText: '/review ADO-',
    },
  ];
}

interface ChatViewProps {
  userRole: UserRole;
}

export function ChatView({ userRole }: ChatViewProps) {
  const {
    personas,
    activePersona,
    session,
    entries,
    activeRepos,
    selectedGovernanceDocs,
    setSelectedGovernanceDocs,
    scaffoldModeActive,
    scaffoldStatus,
    busy,
    error,
    model,
    modelProvider,
    modelOptions,
    reasoningLevel,
    reasoningOptions,
    threads,
    activeThread,
    activeThreadId,
    liveThreadStatuses,
    collaborationMode,
    activePlan,
    agentUIIntents,
    activeGoal,
    activeArtifacts,
    discardArtifact,
    shareArtifact,
    unshareArtifact,
    chatLayout,
    send,
    steer,
    setActiveRepos,
    switchPersona,
    interrupt,
    stopSession,
    startNewSession,
    setModel,
    setReasoningLevel,
    selectThread,
    renameThread,
    settleThread,
    deleteThread,
    forkThread,
    setCollaborationMode,
    setChatLayout,
    selectWorkItemThread,
    startWorkItemThread,
  } = useChatContext();
  const {
    repos,
    featureAvailability,
    activeScaffoldSession,
    activeWorkspace,
    workspaceAccessDefault,
    setWorkspaceAccessDefault,
  } = useWorkspace();
  const navigate = useNavigate();

  const [showFindings, setShowFindings] = useState(true);
  const [dismissedFindings, setDismissedFindings] = useState<Set<number>>(new Set());
  const [composerPrefill, setComposerPrefill] = useState<{ id: string; text: string } | null>(null);
  const [executionStrategy, setExecutionStrategy] = useState<ExecutionStrategy>('auto');
  const [fastMode, setFastMode] = useState(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  // H2 — transient composer notice (queued-send ack / rejected send).
  const [sendNotice, setSendNotice] = useState<string | null>(null);
  const [designSidebarCollapsed, setDesignSidebarCollapsed] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const panelsGroupRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);
  const appliedItsmDefaultRef = useRef(false);

  const focusPanelsControl = useCallback(() => {
    window.requestAnimationFrame(() => {
      panelsGroupRef.current
        ?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"], [role="radio"]')
        ?.focus();
    });
  }, []);

  // --- Extracted hooks -------------------------------------------------------

  const isBaPersona = activePersona?.id === 'ba';
  const isDesignPersona = activePersona?.id === 'design';
  const isDbExpertPersona = activePersona?.id === 'db-expert';
  const isItsmPersona = activePersona ? ITSM_PERSONA_IDS.has(activePersona.id) : false;
  const isWorkItemLayout = chatLayout === 'workitems';
  const browserAvailable = ROLE_FEATURES[userRole].includes('browser');

  const planIntents = useMemo(
    () => agentUIIntents.filter((intent): intent is AgentUIPlanIntent => intent.kind === 'plan'),
    [agentUIIntents],
  );
  const visiblePlanIntent = planIntents.find(
    (intent) =>
      intent.lifecycle !== 'dismissed' &&
      intent.lifecycle !== 'expired' &&
      intent.payload.lifecycle !== 'archived' &&
      !intent.presentation.hidden,
  );

  const panels = useChatPanels({
    artifacts: activeArtifacts,
    hasVisiblePlanIntent: Boolean(visiblePlanIntent),
    planIntentCount: planIntents.length,
    hasGoal: Boolean(activeGoal),
  });

  const { recentRuns, activeSessions, executionSessionStates, setExecutionSessionStates } =
    useChatViewData(activeWorkspace?.id);

  const {
    pendingWorkflowAction,
    confirmingWorkflowAction,
    handleComposerSend,
    confirmWorkflowAction,
    keepWorkflowPromptInChat,
  } = useChatWorkflowAction({
    activeWorkspace,
    executionStrategy,
    fastMode,
    send,
    startNewSession,
  });

  // CH1 — per-thread access level, persisted per workspace. ST9: the
  // Settings → Workspace default applies to threads without an override.
  const threadAccess = useThreadAccess(activeWorkspace?.id, activeThreadId, {
    workspaceDefault: workspaceAccessDefault,
    onWorkspaceDefaultChange: setWorkspaceAccessDefault,
  });

  const handleSuggestionClick = useCallback((prompt: string) => {
    setComposerPrefill({ id: `suggestion-${Date.now()}`, text: prompt });
    setComposerFocusRequest((request) => request + 1);
  }, []);

  useChatRouteIntents({
    personas,
    activePersona,
    switchPersona,
    selectThread,
    onPrefill: (text) => setComposerPrefill({ id: `route-${Date.now()}`, text }),
    openPreview: panels.openPreview,
    threadCount: threads.length,
  });

  // --- Persona / layout derivations ------------------------------------------

  const fastModeTarget = useMemo(
    () => resolveChatFastModeTarget(modelProvider, model, modelOptions),
    [model, modelOptions, modelProvider],
  );
  const mentionRepoIds = useMemo(() => activeRepos.map((repo) => repo.id), [activeRepos]);

  useEffect(() => {
    if (!fastModeTarget.available && fastMode) setFastMode(false);
  }, [fastMode, fastModeTarget.available]);

  // ITSM role defaults to the service-desk persona once.
  useEffect(() => {
    if (userRole !== 'itsm') {
      appliedItsmDefaultRef.current = false;
      return;
    }
    if (appliedItsmDefaultRef.current || personas.length === 0 || !activePersona) return;
    appliedItsmDefaultRef.current = true;
    if (activePersona.id !== 'coder') return;
    const serviceDesk = personas.find((persona) => persona.id === 'service-desk');
    if (serviceDesk) void switchPersona(serviceDesk);
  }, [activePersona, personas, switchPersona, userRole]);

  // --- Findings (BA persona) --------------------------------------------------

  const findings = useMemo(() => {
    if (!isBaPersona) return [];
    const all: (ExtractedFinding & { idx: number })[] = [];
    let idx = 0;
    for (const entry of entries) {
      if (entry.kind === 'assistant') {
        for (const f of extractFindings(entry.content)) {
          all.push({ ...f, idx: idx++ });
        }
      }
    }
    return all;
  }, [entries, isBaPersona]);

  const openFindings = findings.filter((f) => !dismissedFindings.has(f.idx));
  const composedTurns = useMemo(() => composeChatTurns(entries, { active: busy }), [busy, entries]);

  // --- Scroll stickiness -------------------------------------------------------

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const updateStickiness = () => {
      const nearBottom = isNearChatBottom(container);
      shouldStickToBottomRef.current = nearBottom;
      setShowJumpToLatest(!nearBottom);
    };

    updateStickiness();
    container.addEventListener('scroll', updateStickiness);
    return () => container.removeEventListener('scroll', updateStickiness);
  }, []);

  useEffect(() => {
    if (!shouldStickToBottomRef.current) return;
    messagesEndRef.current?.scrollIntoView({
      behavior: busy ? 'auto' : 'smooth',
      block: 'end',
    });
  }, [busy, entries]);

  useEffect(() => {
    shouldStickToBottomRef.current = true;
    setShowJumpToLatest(false);
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [activeThreadId]);

  const handleJumpToLatest = useCallback(() => {
    shouldStickToBottomRef.current = true;
    setShowJumpToLatest(false);
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!shouldFocusChatComposerFromKey(event)) return;
      event.preventDefault();
      setComposerFocusRequest((request) => request + 1);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Agent-UI surfaces can prefill the composer via a window event.
  useEffect(() => {
    const handlePrefill = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: string }>).detail;
      if (!detail?.text) return;
      setComposerPrefill({ id: `agent-ui-${Date.now()}`, text: detail.text });
      setComposerFocusRequest((current) => current + 1);
    };
    window.addEventListener(CHAT_PREFILL_EVENT, handlePrefill);
    return () => window.removeEventListener(CHAT_PREFILL_EVENT, handlePrefill);
  }, []);

  // --- Handlers ---------------------------------------------------------------

  const handleSwitchPersona = (persona: Persona) => {
    panels.closeActivity();
    switchPersona(persona);
  };

  // H13 — label strings name the provider the session actually runs on.
  const agentProvider = session?.provider ?? modelProvider;
  const agentLabel = agentProviderLabel(agentProvider) ?? 'The agent';
  // H12 — goals are a Codex capability; when no session is live yet, fall back
  // to provider truth (ACP providers never support them).
  const goalsSupported = session?.capabilities?.goals ?? !isAcpAgentProvider(agentProvider);
  // H9 — provider-truthful access options and the applied provider-side mode.
  const accessOptions = useMemo(
    () => chatAccessOptionsForProvider(agentProvider, session?.capabilities?.accessModes),
    [agentProvider, session?.capabilities?.accessModes],
  );
  const appliedAccessMode =
    session?.appliedMode ??
    expectedAcpAppliedMode(agentProvider, threadAccess.level, collaborationMode);
  const slashCommands = useMemo(() => buildSlashCommands(agentLabel), [agentLabel]);

  const handleChatInputSend = useCallback(
    (message: string, attachments: ChatAttachment[] = []): Promise<boolean> => {
      if (busy) {
        // H2 — the mid-turn path awaits the provider's disposition: 'steered'
        // (Codex), 'sent' (ACP idle race), 'queued' (ACP busy), or null when
        // the session could not accept the message at all. Queue depth itself
        // renders from session.queuedSendCount below, so the notice only
        // carries rejections.
        return steer(message, attachments).then((result) => {
          if (!result) {
            setSendNotice(
              `${agentLabel} could not accept that message — the session may have finished or stopped. Try again.`,
            );
            return false;
          }
          setSendNotice(null);
          return true;
        });
      }
      handleComposerSend(message, attachments);
      setSendNotice(null);
      return Promise.resolve(true);
    },
    [busy, handleComposerSend, steer, agentLabel],
  );

  const handleAccessOptionSelect = useCallback(
    (option: ChatAccessOption) => {
      if (option.collaborationMode === 'plan') {
        if (collaborationMode !== 'plan') setCollaborationMode('plan');
        return;
      }
      // Leaving plan via the access chip must reset the collaboration mode —
      // otherwise the provider keeps applying 'plan' regardless of level.
      if (collaborationMode === 'plan') setCollaborationMode('default');
      if (option.level) threadAccess.setLevel(option.level);
    },
    [collaborationMode, setCollaborationMode, threadAccess],
  );

  const handleModelChange = useCallback(
    (nextModel: string, nextProvider: AgentProvider) => {
      setFastMode(false);
      setModel(nextModel, nextProvider);
    },
    [setModel],
  );

  const handleReasoningChange = useCallback(
    (nextLevel: ReasoningEffort) => {
      setReasoningLevel(nextLevel);
    },
    [setReasoningLevel],
  );

  const handleChatLayoutChange = useCallback(
    (layout: ChatLayout) => {
      void setChatLayout(layout);
    },
    [setChatLayout],
  );

  const handleFindingFollowUp = useCallback((finding: ExtractedFinding & { idx: number }) => {
    setComposerPrefill({
      id: `${finding.idx}-${Date.now()}`,
      text: buildFindingFollowUpPrompt(finding),
    });
  }, []);

  const handleSetGoal = useCallback(
    (objective: string, tokenBudget: string) => {
      if (!goalsSupported) return;
      const trimmedObjective = objective.trim();
      if (!trimmedObjective) return;

      const parsedBudget = Number.parseInt(tokenBudget, 10);
      const budgetText =
        Number.isFinite(parsedBudget) && parsedBudget > 0
          ? ` with a ${parsedBudget.toLocaleString()} token budget`
          : '';

      panels.setGoalPopoverOpen(false);
      void send(`Set a goal${budgetText}: ${trimmedObjective}`);
    },
    [panels, send, goalsSupported],
  );

  const handleCompleteGoal = useCallback(() => {
    if (!goalsSupported) return;
    panels.setGoalPopoverOpen(false);
    void send('Mark the active goal complete.');
  }, [panels, send, goalsSupported]);

  const handleBranch = useCallback(
    (messageIndex: number) => {
      void forkThread(messageIndex);
    },
    [forkThread],
  );

  const handleReuseMessage = useCallback((messageIndex: number, content: string) => {
    setComposerPrefill({
      id: `reuse-${messageIndex}-${Date.now()}`,
      text: buildMessageReusePrefill(content),
    });
    setComposerFocusRequest((prev) => prev + 1);
  }, []);

  // CH5 — classified error notice with retry / provider-switch recovery.
  const errorRecovery = useChatErrorRecovery({
    entries,
    modelOptions,
    modelProvider,
    onSend: handleChatInputSend,
    onModelChange: handleModelChange,
  });

  // --- Derived view state ------------------------------------------------------

  // C5 — fall back to the accent token, not a hard-coded red.
  const personaColour = activePersona?.colour ?? 'var(--color-accent)';
  // C2/3.5 — repo-grounded starter prompts once a repo is mapped; persona
  // suggestions stay as the fallback in ChatEmptyState.
  const starterPrompts = useMemo(
    () => (repos.some(repoIsMapped) ? getStarterPrompts({ repos, userRole }) : undefined),
    [repos, userRole],
  );
  const scaffoldBusy = scaffoldStatus === 'syncing' || scaffoldStatus === 'indexing';
  const workspaceChatReady = scaffoldModeActive || featureAvailability.chatEnabled;
  const chatInputDisabled =
    scaffoldBusy || !workspaceChatReady || (isWorkItemLayout && !activeThread?.workItemId);
  const composerDraftKey = [
    'anvil:chat-draft',
    activeThreadId ?? 'no-thread',
    isWorkItemLayout ? 'workitem-layout' : (activePersona?.id ?? 'no-persona'),
  ].join(':');

  const isEmpty = entries.length === 0 && !error;
  const pendingQuestions = useMemo(
    () =>
      agentUIIntents.filter(
        (intent): intent is AgentUIQuestionIntent =>
          intent.kind === 'question' &&
          (intent.lifecycle === 'pending' || intent.lifecycle === 'presented'),
      ),
    [agentUIIntents],
  );
  const selectedArtifact = panels.canvasPlanSelected
    ? null
    : (activeArtifacts.find((artifact) => artifact.id === panels.selectedArtifactId) ??
      activeArtifacts[0] ??
      null);
  const executionTopology = useMemo(
    () =>
      buildExecutionTopology({
        entries,
        sessions: session
          ? [session, ...activeSessions.filter((item) => item.id !== session.id)]
          : activeSessions,
        sessionStates: executionSessionStates,
        threadId: activeThreadId,
        rootLabel: activeThread?.title ?? 'New thread',
      }),
    [activeSessions, session, executionSessionStates, activeThread?.title, activeThreadId, entries],
  );
  const visibleSessionId = executionTopology.nodes.find(
    (node) => node.kind === 'session',
  )?.sessionId;

  // C4 — one enum drives every non-transcript pane state.
  const paneKind: ChatPaneKind = deriveChatPaneState({
    scaffoldModeActive,
    chatEnabled: featureAvailability.chatEnabled,
    isEmpty,
    hasError: Boolean(error),
    isWorkItemLayout,
    activeThreadHasWorkItem: Boolean(activeThread?.workItemId),
  });

  // §7 funnel — local-only activation events; never transmitted.
  const composerEnabledWorkspacesRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (chatInputDisabled) return;
    const key = activeWorkspace?.id ?? 'no-workspace';
    if (composerEnabledWorkspacesRef.current.has(key)) return;
    composerEnabledWorkspacesRef.current.add(key);
    void window.anvil.metrics
      .track('chat_composer_enabled', { workspaceId: activeWorkspace?.id ?? null })
      .catch(() => {});
  }, [chatInputDisabled, activeWorkspace?.id]);

  const prevPaneKindRef = useRef<ChatPaneKind | null>(null);
  useEffect(() => {
    if (paneKind === 'blocked' && prevPaneKindRef.current !== 'blocked') {
      void window.anvil.metrics
        .track('chat_blocked_shown', {
          workspaceId: activeWorkspace?.id ?? null,
          reason: featureAvailability.repoFeatureReason ?? null,
        })
        .catch(() => {});
    }
    prevPaneKindRef.current = paneKind;
  }, [paneKind, activeWorkspace?.id, featureAvailability.repoFeatureReason]);

  const showItsmWorkbench =
    userRole === 'itsm' && isItsmPersona && panels.itsmWorkbenchOpen && !panels.previewMode;
  const showPanelsCluster = !isDesignPersona && !isBaPersona;
  const showActivitySidebar =
    panels.activityOpen &&
    !scaffoldModeActive &&
    showPanelsCluster &&
    !showItsmWorkbench &&
    !panels.previewMode;
  const canvasHasContent =
    activeArtifacts.length > 0 ||
    Boolean(visiblePlanIntent) ||
    Boolean(activeGoal) ||
    (panels.showPlanHistory && planIntents.length > 0);
  const showCanvasSidebar =
    showPanelsCluster &&
    !showItsmWorkbench &&
    !panels.previewMode &&
    !panels.activityOpen &&
    panels.canvasOpen &&
    !panels.canvasExpanded &&
    !panels.canvasDetached &&
    canvasHasContent;

  const canvasSidebarProps = {
    artifacts: activeArtifacts,
    selectedArtifact,
    activePlan,
    planIntents,
    activeGoal,
    planSelected: panels.canvasPlanSelected,
    onSelectPlan: panels.selectPlan,
    onSelectArtifact: panels.selectArtifact,
    onDiscardArtifact: discardArtifact,
    onShareArtifact: shareArtifact,
    onUnshareArtifact: unshareArtifact,
    zoom: panels.canvasZoom,
    onZoomChange: panels.setCanvasZoom,
  } as const;

  const content = (
    <div className="flex h-full flex-col">
      {/* CH4 — title + PR chip + one segmented Panels control. */}
      <ChatHeader
        title={activeThread && !scaffoldModeActive ? activeThread.title : 'New thread'}
        workspaceName={activeWorkspace?.name ?? 'No workspace'}
        scaffoldModeActive={scaffoldModeActive}
        scaffoldStatus={scaffoldStatus}
        pullRequestThread={
          activeThread && !scaffoldModeActive
            ? {
                threadId: activeThread.id,
                preferredRepoId: activeThread.activeRepoId ?? undefined,
                repoIds: activeThread.repoIds ?? [],
              }
            : null
        }
        showPanels={showPanelsCluster}
        activePanel={
          showActivitySidebar
            ? 'activity'
            : panels.previewMode
              ? 'preview'
              : showCanvasSidebar || panels.canvasDetached || panels.canvasExpanded
                ? 'canvas'
                : null
        }
        onSelectPanel={(panel: ChatPanelId | null) => panels.setActivePanel(panel)}
        canvasAvailable={
          activeArtifacts.length > 0 || planIntents.length > 0 || Boolean(activeGoal)
        }
        canvasCount={activeArtifacts.length}
        canvasDetached={panels.canvasDetached}
        previewAvailable={browserAvailable}
        activityRunningCount={executionTopology.runningCount}
        showItsmToggle={userRole === 'itsm' && isItsmPersona}
        itsmWorkbenchActive={showItsmWorkbench}
        onToggleItsmWorkbench={panels.toggleItsmWorkbench}
        panelsGroupRef={panelsGroupRef}
      />

      {!scaffoldModeActive && visibleSessionId && (
        <SessionOwnershipChip key={visibleSessionId} sessionId={visibleSessionId} />
      )}

      <div className="flex flex-1 overflow-hidden">
        {!scaffoldModeActive &&
          (isWorkItemLayout ? (
            <WorkItemThreadRail
              threads={threads}
              activeThreadId={activeThreadId}
              liveThreadStatuses={liveThreadStatuses}
              onSelectWorkItem={(workItem) => void selectWorkItemThread(workItem)}
              onSelectThread={(threadId) => void selectThread(threadId)}
              onCreateThread={(workItem) => void startWorkItemThread(workItem)}
              onRenameThread={(threadId, title) => void renameThread(threadId, title)}
              onSettleThread={(threadId, settled) => void settleThread(threadId, settled)}
              onDeleteThread={(threadId) => void deleteThread(threadId)}
              chatLayout={chatLayout}
              onChatLayoutChange={handleChatLayoutChange}
              accessLevels={threadAccess.threadLevels}
              defaultAccessLevel={threadAccess.defaultLevel}
            />
          ) : (
            <ChatThreadRail
              personas={personas}
              repos={repos}
              threads={threads}
              activeThreadId={activeThreadId}
              liveThreadStatuses={liveThreadStatuses}
              onSelectThread={(threadId) => void selectThread(threadId)}
              onCreateThread={() => void startNewSession()}
              onRenameThread={(threadId, title) => void renameThread(threadId, title)}
              onSettleThread={(threadId, settled) => void settleThread(threadId, settled)}
              onDeleteThread={(threadId) => void deleteThread(threadId)}
              chatLayout={chatLayout}
              onChatLayoutChange={handleChatLayoutChange}
              accessLevels={threadAccess.threadLevels}
              defaultAccessLevel={threadAccess.defaultLevel}
            />
          ))}

        {/* Chat column */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Readiness where the user is (§3) — compact strip above the
            transcript while repos are being prepared. */}
          {!scaffoldModeActive && repos.length > 0 && (
            <WorkspaceReadinessStrip
              className="mx-4 mt-3 shrink-0 xl:mx-6"
              onOpenWorkspace={() => navigate('/workspace')}
            />
          )}
          <ChatTranscript
            paneKind={paneKind}
            scaffoldRootPath={activeScaffoldSession?.rootPath}
            blockedReason={
              featureAvailability.repoFeatureReason ?? 'Connect and index a repo first.'
            }
            onOpenWorkspace={() => navigate('/workspace')}
            personaId={activePersona?.id ?? 'coder'}
            hasRepos={activeRepos.length > 0}
            hasGovernanceDocs={selectedGovernanceDocs.length > 0}
            isDbExpertPersona={isDbExpertPersona}
            starterPrompts={starterPrompts}
            onSuggestionClick={handleSuggestionClick}
            scaffoldBusyMessage={
              scaffoldBusy
                ? scaffoldStatus === 'syncing'
                  ? 'Scaffold completion was detected. Anvil is connecting the new repositories to this workspace.'
                  : 'Repositories are being indexed now. Other views stay locked until indexing finishes, then the rest of the workspace will unlock.'
                : undefined
            }
            turns={composedTurns}
            activeThreadId={activeThreadId}
            busy={busy}
            isBaPersona={isBaPersona}
            personaName={activePersona?.name ?? 'Assistant'}
            personaColour={personaColour}
            onBranch={isWorkItemLayout ? undefined : handleBranch}
            onReuseMessage={handleReuseMessage}
            changesRepos={repos}
            changesPreferredRepoId={activeThread?.activeRepoId}
            error={error}
            errorProviders={errorRecovery.providers}
            onErrorRetry={errorRecovery.onRetry}
            onSwitchProvider={errorRecovery.onSwitchProvider}
            messagesContainerRef={messagesContainerRef}
            messagesEndRef={messagesEndRef}
            showJumpToLatest={showJumpToLatest}
            onJumpToLatest={handleJumpToLatest}
          />

          {/* Input */}
          {pendingQuestions[0] && (
            <PendingQuestionPrompt
              key={pendingQuestions[0].id}
              intent={pendingQuestions[0]}
              additionalCount={Math.max(0, pendingQuestions.length - 1)}
            />
          )}
          {pendingWorkflowAction && (
            <WorkflowActionConfirmation
              pending={pendingWorkflowAction}
              confirming={confirmingWorkflowAction}
              onConfirm={() => void confirmWorkflowAction()}
              onKeepInChat={keepWorkflowPromptInChat}
            />
          )}
          {/* H2 — live queue depth or a transient notice for rejected sends. */}
          {(() => {
            const queuedCount = session?.queuedSendCount ?? 0;
            const composerNotice =
              sendNotice ??
              (queuedCount > 0
                ? `Queued — ${agentLabel} will pick ${
                    queuedCount === 1 ? 'it' : `all ${queuedCount} messages`
                  } up when the current turn finishes.`
                : null);
            if (!composerNotice) return null;
            return (
              <div className="mx-auto w-full max-w-[1120px] px-4 pb-2 xl:px-6">
                <div className="flex items-center justify-between gap-3 rounded-lg border border-info/25 bg-info/5 px-3 py-2 text-xs text-text-secondary">
                  <span className="min-w-0">{composerNotice}</span>
                  <button
                    type="button"
                    onClick={() => setSendNotice(null)}
                    className="shrink-0 rounded-md px-1.5 py-0.5 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                    aria-label="Dismiss notice"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            );
          })()}
          <ChatInput
            onSend={handleChatInputSend}
            onStop={interrupt}
            disabled={chatInputDisabled || pendingWorkflowAction !== null}
            busy={busy}
            personaColour={personaColour}
            model={model}
            modelProvider={modelProvider}
            modelOptions={modelOptions}
            onModelChange={handleModelChange}
            reasoningLevel={reasoningLevel}
            reasoningOptions={reasoningOptions}
            onReasoningChange={handleReasoningChange}
            executionStrategy={executionStrategy}
            onExecutionStrategyChange={setExecutionStrategy}
            codexMode={isItsmPersona ? 'read-only' : threadAccess.level}
            onCodexModeChange={scaffoldModeActive ? undefined : threadAccess.setLevel}
            codexModeDisabled={isItsmPersona}
            accessOptions={accessOptions}
            accessAppliedMode={appliedAccessMode}
            onAccessOptionSelect={scaffoldModeActive ? undefined : handleAccessOptionSelect}
            collaborationMode={collaborationMode}
            onCollaborationModeChange={scaffoldModeActive ? undefined : setCollaborationMode}
            fastMode={fastMode}
            fastModeAvailable={fastModeTarget.available}
            onFastModeChange={scaffoldModeActive ? undefined : setFastMode}
            showSyntaxHint={isEmpty}
            leadingControls={
              !scaffoldModeActive ? (
                <ChatPersonaPicker
                  personas={personas}
                  activePersona={activePersona}
                  userRole={userRole}
                  personaColour={personaColour}
                  onSelect={handleSwitchPersona}
                />
              ) : undefined
            }
            contextControls={
              scaffoldModeActive ? null : (
                <>
                  <RepoSelector
                    variant="dropdown"
                    mode="multi"
                    placement="bottom"
                    selectedRepoIds={activeRepos.map((repo) => repo.id)}
                    onMultiSelect={setActiveRepos}
                  />
                  <GovernanceSelector
                    placement="bottom"
                    selectedDocIds={selectedGovernanceDocs.map((document) => document.id)}
                    onSelectionChange={setSelectedGovernanceDocs}
                  />
                </>
              )
            }
            prefill={composerPrefill}
            draftKey={composerDraftKey}
            mentionRepoIds={mentionRepoIds}
            slashCommands={slashCommands}
            focusRequest={composerFocusRequest}
          />
        </div>

        <ChatSidePanels
          previewMode={panels.previewMode}
          previewInitialUrl={panels.previewInitialUrl}
          onClosePreview={() => panels.setActivePanel(null)}
          isBaPersona={isBaPersona}
          hasFindings={findings.length > 0}
          openFindings={openFindings}
          showFindings={showFindings}
          onToggleFindings={() => setShowFindings((open) => !open)}
          onFindingFollowUp={handleFindingFollowUp}
          onDismissFinding={(idx) => setDismissedFindings((prev) => new Set(prev).add(idx))}
          isDesignPersona={isDesignPersona}
          designSidebarCollapsed={designSidebarCollapsed}
          onToggleDesignSidebar={() => setDesignSidebarCollapsed((c) => !c)}
          showItsmWorkbench={showItsmWorkbench}
          workspaceId={activeWorkspace?.id ?? null}
          onItsmPrompt={(prompt) => {
            setComposerPrefill({ id: `itsm-${Date.now()}`, text: prompt });
            setComposerFocusRequest((current) => current + 1);
          }}
          showActivitySidebar={showActivitySidebar}
          activity={{
            workspaceName: activeWorkspace?.name ?? 'workspace',
            runs: recentRuns,
            topology: executionTopology,
            activeGoal,
            busy,
            goalOpen: panels.goalPopoverOpen,
            onGoalOpenChange: panels.setGoalPopoverOpen,
            onSetGoal: handleSetGoal,
            onCompleteGoal: handleCompleteGoal,
            onClose: () => {
              panels.closeActivity();
              focusPanelsControl();
            },
            onOpenThread: (threadId) => void selectThread(threadId),
            onStop: (sessionId) => {
              setExecutionSessionStates((states) => ({ ...states, [sessionId]: 'stopped' }));
              void stopSession(sessionId);
            },
            goalsSupported,
            agentLabel,
          }}
          showCanvasSidebar={showCanvasSidebar}
          canvas={canvasSidebarProps}
          canvasExpanded={panels.canvasExpanded}
          canvasDetached={panels.canvasDetached}
          onExpandCanvas={() => panels.setCanvasExpanded(true)}
          onCollapseCanvas={() => panels.setCanvasExpanded(false)}
          onDetachCanvas={() => {
            panels.setCanvasExpanded(false);
            panels.setCanvasDetached(true);
          }}
          onDetachedCanvasClose={panels.handleDetachedCanvasClose}
          canvasOverlayAvailable={
            Boolean(selectedArtifact) || planIntents.length > 0 || Boolean(activeGoal)
          }
        />
      </div>
    </div>
  );

  if (isDesignPersona) {
    return <DesignProvider>{content}</DesignProvider>;
  }

  return content;
}
