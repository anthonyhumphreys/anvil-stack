import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowDown,
  MessageSquare,
  MessageSquarePlus,
  Code,
  Building2,
  Shield,
  Eye,
  BookOpen,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  X,
  Palette,
  ClipboardList,
  Presentation,
  GraduationCap,
  Database,
  Hammer,
  ListChecks,
  Target,
  Circle,
  CheckCircle2,
  Loader2,
  Bot,
  FileText,
  Braces,
  PanelRightOpen,
  PanelRightClose,
  Copy,
  Check,
  ExternalLink,
  SlidersHorizontal,
  Maximize2,
  Minimize2,
  PictureInPicture2,
  Headphones,
  Wrench,
  Radio,
  SearchCheck,
  GitPullRequest,
  Gauge,
  LifeBuoy,
} from 'lucide-react';
import type {
  AgentRunSummary,
  ChatAttachment,
  ChatArtifact,
  ChatGoalSnapshot,
  ChatPlanSnapshot,
  ChatPlanStep,
  CodexMode,
  CodexSession,
  Persona,
  UserRole,
} from '../../../shared/types';
import { ROLE_RECOMMENDED_PERSONAS } from '../../../shared/types';
import { ChatInput, type ChatSlashCommand } from './ChatInput';
import { ChatThreadRail } from './ChatThreadRail';
import { WorkItemThreadRail } from './WorkItemThreadRail';
import {
  AssistantMessage,
  TurnActivityStatus,
  TurnWorkMessage,
  UserMessage,
  type TurnActivityState,
} from './ChatMessage';
import { composeChatTurns } from './chat-turns';
import { ChatEmptyState } from './ChatEmptyState';
import { ArtifactPreview } from './ArtifactPreview';
import { DetachedCanvasWindow } from './DetachedCanvasWindow';
import { useChatContext } from '../../contexts/ChatContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { DesignProvider } from '../../contexts/DesignContext';
import { RepoSelector } from '../shared/RepoSelector';
import { GovernanceSelector } from '../shared/GovernanceSelector';
import { WorkspaceGitActions } from '../shared/WorkspaceGitActions';
import {
  extractFindings,
  stripFindingMarkers,
  type ExtractedFinding,
} from '../../utils/finding-parser';
import { DesignSidebar } from '../design/DesignSidebar';
import { ResizableSidebarPanel } from '../layout/ResizableSidebarPanel';
import { isEditableShortcutTarget } from '../../utils/keyboard';
import {
  buildExecutionStrategyPrompt,
  type ExecutionStrategy,
} from '../../utils/execution-strategy';
import { parseWorkflowChatIntent } from '../../utils/workflow-chat-intent';
import { groupPersonasForRole } from '../../utils/persona-groups';
import { ItsmWorkbench } from './ItsmWorkbench';

const PERSONA_ICONS: Record<string, React.ReactNode> = {
  Code: <Code size={14} />,
  Building2: <Building2 size={14} />,
  Shield: <Shield size={14} />,
  Eye: <Eye size={14} />,
  BookOpen: <BookOpen size={14} />,
  ClipboardList: <ClipboardList size={14} />,
  Presentation: <Presentation size={14} />,
  Palette: <Palette size={14} />,
  GraduationCap: <GraduationCap size={14} />,
  Database: <Database size={14} />,
  Headphones: <Headphones size={14} />,
  Wrench: <Wrench size={14} />,
  Radio: <Radio size={14} />,
  SearchCheck: <SearchCheck size={14} />,
  GitPullRequest: <GitPullRequest size={14} />,
  Gauge: <Gauge size={14} />,
};

interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

const CHAT_BOTTOM_THRESHOLD_PX = 96;
const NEW_CHAT_THREAD_LABEL = 'New thread';
const ITSM_PERSONA_IDS = new Set(ROLE_RECOMMENDED_PERSONAS.itsm ?? []);

interface ChatViewProps {
  userRole: UserRole;
}

export function ChatView({ userRole }: ChatViewProps) {
  const {
    personas,
    activePersona,
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
    activeGoal,
    activeArtifacts,
    chatLayout,
    send,
    steer,
    setActiveRepos,
    switchPersona,
    interrupt,
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
  } = useChatContext();
  const { repos, featureAvailability, activeScaffoldSession, activeWorkspace } = useWorkspace();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [showPersonaDropdown, setShowPersonaDropdown] = useState(false);
  const [showContextSettings, setShowContextSettings] = useState(false);
  const [showFindings, setShowFindings] = useState(true);
  const [dismissedFindings, setDismissedFindings] = useState<Set<number>>(new Set());
  const [composerPrefill, setComposerPrefill] = useState<{ id: string; text: string } | null>(null);
  const [codexMode, setCodexMode] = useState<CodexMode>('on-request');
  const [goalPopoverOpen, setGoalPopoverOpen] = useState(false);
  const [workOpen, setWorkOpen] = useState(false);
  const [executionStrategy, setExecutionStrategy] = useState<ExecutionStrategy>('auto');
  const [canvasOpen, setCanvasOpen] = useState(true);
  const [canvasExpanded, setCanvasExpanded] = useState(false);
  const [canvasDetached, setCanvasDetached] = useState(false);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [recentRuns, setRecentRuns] = useState<AgentRunSummary[]>([]);
  const [activeSessions, setActiveSessions] = useState<CodexSession[]>([]);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const [itsmWorkbenchOpen, setItsmWorkbenchOpen] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);
  const appliedItsmDefaultRef = useRef(false);

  const isBaPersona = activePersona?.id === 'ba';
  const isDesignPersona = activePersona?.id === 'design';
  const isDbExpertPersona = activePersona?.id === 'db-expert';
  const isItsmPersona = activePersona ? ITSM_PERSONA_IDS.has(activePersona.id) : false;
  const isWorkItemLayout = chatLayout === 'workitems';
  const mentionRepoIds = useMemo(() => activeRepos.map((repo) => repo.id), [activeRepos]);
  const slashCommands = useMemo<ChatSlashCommand[]>(
    () => [
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
        description: 'Ask Codex to plan an ADO work item.',
        insertText: '/plan ADO-',
      },
      {
        id: 'fix',
        command: '/fix',
        label: 'Fix work item',
        description: 'Ask Codex to implement an ADO work item.',
        insertText: '/fix ADO-',
      },
      {
        id: 'review',
        command: '/review',
        label: 'Review work item',
        description: 'Ask Codex to review an ADO work item.',
        insertText: '/review ADO-',
      },
    ],
    [],
  );

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
  const [designSidebarCollapsed, setDesignSidebarCollapsed] = useState(false);

  useEffect(() => {
    window.anvil.settings
      .get()
      .then((settings) => setCodexMode(settings.codexMode ?? 'on-request'))
      .catch(console.error);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      window.anvil.chat
        .listActiveSessions()
        .then((sessions) => {
          if (!cancelled) setActiveSessions(sessions.filter((item) => item.status !== 'error'));
        })
        .catch(() => {
          if (!cancelled) setActiveSessions([]);
        });
    };
    refresh();
    const interval = window.setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (!activeWorkspace?.id) {
      setRecentRuns([]);
      return;
    }

    let cancelled = false;
    const refresh = () => {
      window.anvil.agentRuns
        .list(activeWorkspace.id, 20)
        .then((runs) => {
          if (!cancelled) setRecentRuns(runs);
        })
        .catch(() => {
          if (!cancelled) setRecentRuns([]);
        });
    };
    refresh();
    const interval = window.setInterval(refresh, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeWorkspace?.id]);

  useEffect(() => {
    const prompt = searchParams.get('prompt');
    const persona = searchParams.get('persona');
    if (!prompt && !persona) return;

    if (prompt) {
      setComposerPrefill({ id: `route-${Date.now()}`, text: prompt });
    }

    if (persona) {
      const target = personas.find((item) => item.id === persona);
      if (target && target.id !== activePersona?.id) {
        switchPersona(target);
      }
    }

    const next = new URLSearchParams(searchParams);
    next.delete('prompt');
    next.delete('persona');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, personas, activePersona, switchPersona]);

  useEffect(() => {
    const threadId = searchParams.get('thread');
    if (!threadId) return;
    if (!threads.some((thread) => thread.id === threadId)) return;

    void selectThread(threadId);
    const next = new URLSearchParams(searchParams);
    next.delete('thread');
    setSearchParams(next, { replace: true });
  }, [searchParams, selectThread, setSearchParams, threads]);

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

  const handleSwitchPersona = (persona: Persona) => {
    setShowPersonaDropdown(false);
    switchPersona(persona);
  };

  const handleComposerSend = useCallback(
    (message: string, attachments: ChatAttachment[] = []) => {
      if (attachments.length === 0 && message.trim().toLowerCase() === '/new') {
        void startNewSession();
        return;
      }

      const mayBeWorkflowIntent =
        /\bworkflow\b/i.test(message) &&
        /\b(?:use|run|start|launch|create|build|make|design|draft)\b/i.test(message);
      if (attachments.length === 0 && activeWorkspace && mayBeWorkflowIntent) {
        void window.anvil.workflow
          .listTemplates()
          .then(async (templates) => {
            const intent = parseWorkflowChatIntent(message, templates);
            if (!intent) {
              await send(
                message,
                attachments,
                buildExecutionStrategyPrompt(executionStrategy) ?? undefined,
              );
              return;
            }
            if (intent.kind === 'run') {
              const run = await window.anvil.workflow.startRun({
                templateId: intent.template.id,
                workspaceId: activeWorkspace.id,
                repoIds: activeWorkspace.repos.map((repo) => repo.id),
                kickoff: intent.kickoff,
              });
              navigate(`/workflows?run=${encodeURIComponent(run.id)}`);
              return;
            }
            const params = new URLSearchParams({ kickoff: intent.kickoff });
            if (intent.kind === 'draft') params.set('draft', intent.request);
            navigate(`/workflows?${params.toString()}`);
          })
          .catch(() => {
            void send(
              message,
              attachments,
              buildExecutionStrategyPrompt(executionStrategy) ?? undefined,
            );
          });
        return;
      }

      void send(message, attachments, buildExecutionStrategyPrompt(executionStrategy) ?? undefined);
    },
    [activeWorkspace, executionStrategy, navigate, send, startNewSession],
  );

  const handleChatInputSend = useCallback(
    (message: string, attachments: ChatAttachment[] = []) => {
      if (busy) {
        void steer(message, attachments);
        return;
      }
      handleComposerSend(message, attachments);
    },
    [busy, handleComposerSend, steer],
  );

  const handleCodexModeChange = useCallback(async (mode: CodexMode) => {
    setCodexMode(mode);
    try {
      await window.anvil.settings.update({ codexMode: mode });
    } catch (err) {
      console.error('[Chat] Failed to update Codex mode:', err);
    }
  }, []);

  const handleChatLayoutChange = useCallback(
    (layout: typeof chatLayout) => {
      void setChatLayout(layout);
    },
    [setChatLayout],
  );

  const handleSuggestionClick = useCallback((prompt: string) => {
    setComposerPrefill({ id: `suggestion-${Date.now()}`, text: prompt });
    setComposerFocusRequest((request) => request + 1);
  }, []);

  const handleFindingFollowUp = useCallback((finding: ExtractedFinding & { idx: number }) => {
    setComposerPrefill({
      id: `${finding.idx}-${Date.now()}`,
      text: buildFindingFollowUpPrompt(finding),
    });
  }, []);

  const handleSetGoal = useCallback(
    (objective: string, tokenBudget: string) => {
      const trimmedObjective = objective.trim();
      if (!trimmedObjective) return;

      const parsedBudget = Number.parseInt(tokenBudget, 10);
      const budgetText =
        Number.isFinite(parsedBudget) && parsedBudget > 0
          ? ` with a ${parsedBudget.toLocaleString()} token budget`
          : '';

      setGoalPopoverOpen(false);
      void send(`Set a goal${budgetText}: ${trimmedObjective}`);
    },
    [send],
  );

  const handleCompleteGoal = useCallback(() => {
    setGoalPopoverOpen(false);
    void send('Mark the active goal complete.');
  }, [send]);

  const personaColour = activePersona?.colour ?? '#b5121b';
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
  const showCenteredEmptyPane = isEmpty || (scaffoldModeActive && entries.length === 0 && !error);
  const selectedArtifact =
    activeArtifacts.find((artifact) => artifact.id === selectedArtifactId) ??
    activeArtifacts[0] ??
    null;
  const showItsmWorkbench = userRole === 'itsm' && isItsmPersona && itsmWorkbenchOpen;
  const showCanvasSidebar =
    !isDesignPersona &&
    !isBaPersona &&
    !showItsmWorkbench &&
    canvasOpen &&
    !canvasExpanded &&
    !canvasDetached &&
    (activeArtifacts.length > 0 || activePlan || activeGoal);

  useEffect(() => {
    if (activeArtifacts.length === 0) {
      setSelectedArtifactId(null);
      return;
    }
    setCanvasOpen(true);
    setSelectedArtifactId((current) =>
      current && activeArtifacts.some((artifact) => artifact.id === current)
        ? current
        : activeArtifacts[0].id,
    );
  }, [activeArtifacts]);

  useEffect(() => {
    if (activeArtifacts.length > 0 || activePlan || activeGoal) return;
    setCanvasExpanded(false);
    setCanvasDetached(false);
  }, [activeArtifacts.length, activeGoal, activePlan]);

  useEffect(() => {
    if (!canvasExpanded) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCanvasExpanded(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [canvasExpanded]);

  const handleDetachedCanvasClose = useCallback(() => {
    setCanvasDetached(false);
    setCanvasOpen(true);
  }, []);

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

  const content = (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="relative z-40 flex min-h-14 items-center gap-2 border-b border-border/60 bg-bg-secondary px-3 py-2 lg:px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="truncate text-sm font-semibold tracking-tight text-text-primary">
                {activeThread && !scaffoldModeActive ? activeThread.title : 'New conversation'}
              </h2>
            </div>
            <p className="truncate text-xs text-text-tertiary">
              {activeWorkspace?.name ?? 'No workspace'} · {activePersona?.name ?? 'Assistant'}
            </p>
          </div>

          <div className="relative ml-auto shrink-0">
            <button
              type="button"
              onClick={() => setShowContextSettings((open) => !open)}
              className="flex h-9 items-center gap-2 rounded-lg border border-border px-2.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              aria-expanded={showContextSettings}
              aria-label="Chat context and mode settings"
            >
              <SlidersHorizontal size={13} />
              <span className="hidden lg:inline">Context</span>
            </button>

            {showContextSettings && (
              <div className="absolute right-0 top-full z-50 mt-2 w-[min(680px,calc(100vw-2rem))] rounded-xl border border-border bg-bg-elevated p-3 shadow-2xl">
                <div className="flex flex-wrap items-center gap-2">
                  {/* Persona selector */}
                  <div className="relative">
                    <button
                      onClick={() => {
                        if (!scaffoldModeActive) setShowPersonaDropdown(!showPersonaDropdown);
                      }}
                      className="flex items-center gap-2 rounded-xl border border-border px-3 py-1.5 text-sm transition-all hover:bg-bg-tertiary hover:shadow-sm"
                      style={{ borderColor: personaColour + '40' }}
                      aria-label="Select persona"
                      aria-expanded={showPersonaDropdown}
                      disabled={scaffoldModeActive}
                    >
                      <span
                        className="inline-block h-2 w-2 rounded-full shadow-sm"
                        style={{ backgroundColor: personaColour }}
                      />
                      {activePersona ? PERSONA_ICONS[activePersona.icon] : null}
                      <span className="text-text-primary">
                        {activePersona?.name ?? 'Select persona'}
                      </span>
                      <ChevronDown size={12} className="text-text-tertiary" />
                    </button>

                    {showPersonaDropdown && !scaffoldModeActive && (
                      <div className="absolute left-0 top-full z-50 mt-1.5 max-h-[min(32rem,calc(100vh-8rem))] w-72 overflow-y-auto rounded-xl border border-border bg-bg-elevated shadow-2xl ring-1 ring-black/10">
                        <div className="p-1.5">
                          {groupPersonasForRole(personas, userRole).map((group, groupIndex) => (
                            <div
                              key={group.id}
                              className={
                                groupIndex > 0 ? 'mt-1 border-t border-border/60 pt-1' : ''
                              }
                            >
                              {group.label && (
                                <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-text-muted">
                                  {group.label}
                                </p>
                              )}
                              {group.personas.map((p) => (
                                <button
                                  key={p.id}
                                  onClick={() => handleSwitchPersona(p)}
                                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors hover:bg-bg-tertiary ${
                                    activePersona?.id === p.id ? 'bg-bg-tertiary' : ''
                                  }`}
                                >
                                  <span
                                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-full shadow-sm"
                                    style={{ backgroundColor: p.colour }}
                                  />
                                  <span className="shrink-0 text-text-secondary">
                                    {PERSONA_ICONS[p.icon]}
                                  </span>
                                  <div className="min-w-0">
                                    <div className="font-medium text-text-primary">{p.name}</div>
                                    <div className="truncate text-xs text-text-tertiary">
                                      {p.description}
                                    </div>
                                  </div>
                                </button>
                              ))}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Repo selector */}
                  {!scaffoldModeActive && (
                    <RepoSelector
                      variant="dropdown"
                      mode="multi"
                      selectedRepoIds={activeRepos.map((r) => r.id)}
                      onMultiSelect={setActiveRepos}
                    />
                  )}

                  {!scaffoldModeActive && (
                    <div className="flex items-center gap-1 rounded-xl border border-border bg-bg-primary/60 p-0.5">
                      <button
                        onClick={() => handleChatLayoutChange('classic')}
                        className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                          chatLayout === 'classic'
                            ? 'bg-accent/15 text-accent'
                            : 'text-text-tertiary hover:bg-bg-tertiary hover:text-text-secondary'
                        }`}
                        aria-pressed={chatLayout === 'classic'}
                        title="Classic chat threads"
                      >
                        <MessageSquare size={12} />
                        <span className="hidden 2xl:inline">Classic</span>
                      </button>
                      <button
                        onClick={() => handleChatLayoutChange('workitems')}
                        className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                          chatLayout === 'workitems'
                            ? 'bg-info/15 text-info'
                            : 'text-text-tertiary hover:bg-bg-tertiary hover:text-text-secondary'
                        }`}
                        aria-pressed={chatLayout === 'workitems'}
                        title="Work-item chat threads"
                      >
                        <ClipboardList size={12} />
                        <span className="hidden 2xl:inline">Tickets</span>
                      </button>
                    </div>
                  )}

                  {!scaffoldModeActive && (
                    <div className="flex items-center gap-1 rounded-xl border border-border bg-bg-primary/60 p-0.5">
                      <button
                        onClick={() => setCollaborationMode('default')}
                        className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                          collaborationMode === 'default'
                            ? 'bg-accent/15 text-accent'
                            : 'text-text-tertiary hover:bg-bg-tertiary hover:text-text-secondary'
                        }`}
                        aria-pressed={collaborationMode === 'default'}
                        title="Implementation mode"
                      >
                        <Hammer size={12} />
                        <span className="hidden xl:inline">Build</span>
                      </button>
                      <button
                        onClick={() => setCollaborationMode('plan')}
                        className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                          collaborationMode === 'plan'
                            ? 'bg-info/15 text-info'
                            : 'text-text-tertiary hover:bg-bg-tertiary hover:text-text-secondary'
                        }`}
                        aria-pressed={collaborationMode === 'plan'}
                        title="Planning mode"
                      >
                        <ListChecks size={12} />
                        <span className="hidden xl:inline">Plan</span>
                      </button>
                    </div>
                  )}

                  {/* Governance document selector */}
                  <GovernanceSelector
                    selectedDocIds={selectedGovernanceDocs.map((d) => d.id)}
                    onSelectionChange={setSelectedGovernanceDocs}
                  />

                  {!scaffoldModeActive && (
                    <WorkspaceGitActions
                      repos={repos}
                      onPullRequestCreated={(result) => {
                        const target =
                          result.pullRequestUrl ?? `${result.repoName} ${result.branch}`;
                        setComposerPrefill({
                          id: `pr-${Date.now()}`,
                          text: `Created PR for ${result.repoName}: ${target}`,
                        });
                      }}
                      onError={(message) => {
                        setComposerPrefill({ id: `git-error-${Date.now()}`, text: message });
                      }}
                    />
                  )}

                  {!scaffoldModeActive && (
                    <AgentWorkControl
                      open={workOpen}
                      runs={recentRuns}
                      sessions={activeSessions}
                      onOpenChange={setWorkOpen}
                      onOpenThread={(threadId) => void selectThread(threadId)}
                      onStop={(sessionId) => void window.anvil.chat.stopSession(sessionId)}
                    />
                  )}
                  {!scaffoldModeActive && (
                    <GoalControl
                      activeGoal={activeGoal}
                      busy={busy}
                      open={goalPopoverOpen}
                      onOpenChange={setGoalPopoverOpen}
                      onSetGoal={handleSetGoal}
                      onCompleteGoal={handleCompleteGoal}
                    />
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Session status */}
          {scaffoldModeActive && (
            <span className="rounded-full bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent">
              {scaffoldStatus === 'indexing'
                ? 'Indexing repos'
                : scaffoldStatus === 'syncing'
                  ? 'Syncing repos'
                  : scaffoldStatus === 'failed'
                    ? 'Scaffold needs attention'
                    : 'Scaffolding'}
            </span>
          )}
        </div>

        <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
          {!scaffoldModeActive && activeRepos.length > 0 && (
            <button
              type="button"
              onClick={() => navigate('/git?tab=pull_requests')}
              className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
              title="Browse and visualise pull requests"
            >
              <GitPullRequest size={13} />
              <span className="hidden xl:inline">PRs</span>
            </button>
          )}
          {!isWorkItemLayout && (
            <button
              onClick={() => void startNewSession()}
              disabled={scaffoldModeActive}
              className="flex items-center gap-1.5 rounded-xl border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
              title={getNewChatThreadActionLabel()}
              aria-label={getNewChatThreadActionLabel()}
            >
              <MessageSquarePlus size={13} />
              <span className="hidden xl:inline">{getNewChatThreadActionLabel()}</span>
            </button>
          )}

          {!isDesignPersona && !isBaPersona && (
            <>
              {userRole === 'itsm' && isItsmPersona && (
                <button
                  type="button"
                  onClick={() => {
                    if (!itsmWorkbenchOpen) setCanvasOpen(false);
                    setItsmWorkbenchOpen((open) => !open);
                  }}
                  className="flex items-center gap-1.5 rounded-xl border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  title={itsmWorkbenchOpen ? 'Hide ITSM workbench' : 'Show ITSM workbench'}
                  aria-pressed={showItsmWorkbench}
                >
                  <LifeBuoy size={13} />
                  <span className="hidden xl:inline">ITSM workbench</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  if (canvasDetached) {
                    setCanvasDetached(false);
                    setCanvasOpen(true);
                    setItsmWorkbenchOpen(false);
                    return;
                  }
                  if (!showCanvasSidebar) {
                    setItsmWorkbenchOpen(false);
                    setCanvasOpen(true);
                    return;
                  }
                  setCanvasOpen(false);
                }}
                disabled={activeArtifacts.length === 0 && !activePlan && !activeGoal}
                className="flex items-center gap-1.5 rounded-xl border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45"
                title={
                  canvasDetached
                    ? 'Reattach canvas'
                    : showCanvasSidebar
                      ? 'Hide canvas'
                      : 'Show canvas'
                }
                aria-label={
                  canvasDetached
                    ? 'Reattach canvas'
                    : showCanvasSidebar
                      ? 'Hide canvas'
                      : 'Show canvas'
                }
                aria-pressed={showCanvasSidebar}
              >
                {canvasDetached ? (
                  <PictureInPicture2 size={13} />
                ) : showCanvasSidebar ? (
                  <PanelRightClose size={13} />
                ) : (
                  <PanelRightOpen size={13} />
                )}
                <span className="hidden xl:inline">Canvas</span>
                {activeArtifacts.length > 0 && (
                  <span className="rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent">
                    {activeArtifacts.length}
                  </span>
                )}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {!scaffoldModeActive &&
          (isWorkItemLayout ? (
            <WorkItemThreadRail
              threads={threads}
              activeThreadId={activeThreadId}
              liveThreadStatuses={liveThreadStatuses}
              onSelectWorkItem={(workItem) => void selectWorkItemThread(workItem)}
            />
          ) : (
            <ChatThreadRail
              persona={activePersona}
              repos={repos}
              threads={threads}
              activeThreadId={activeThreadId}
              liveThreadStatuses={liveThreadStatuses}
              onSelectThread={(threadId) => void selectThread(threadId)}
              onCreateThread={() => void startNewSession()}
              onRenameThread={(threadId, title) => void renameThread(threadId, title)}
              onSettleThread={(threadId, settled) => void settleThread(threadId, settled)}
              onDeleteThread={(threadId) => void deleteThread(threadId)}
            />
          ))}

        {/* Chat column */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Messages area */}
          <div className="relative min-h-0 flex-1">
            <div
              ref={messagesContainerRef}
              className={`h-full overflow-y-auto ${showCenteredEmptyPane ? 'flex' : ''}`}
            >
              <div
                className={`mx-auto w-full max-w-[1120px] px-4 xl:px-6 ${
                  showCenteredEmptyPane
                    ? 'flex min-h-full flex-1 items-center justify-center py-6'
                    : 'flex flex-col pb-8 pt-6'
                }`}
              >
                {!scaffoldModeActive && !featureAvailability.chatEnabled && (
                  <div className="flex items-center justify-center py-8">
                    <div className="text-center">
                      <AlertTriangle size={24} className="mx-auto mb-2 text-warning" />
                      <p className="text-base text-text-secondary">
                        {featureAvailability.repoFeatureReason ?? 'Connect and index a repo first.'}
                      </p>
                    </div>
                  </div>
                )}

                {scaffoldModeActive && isEmpty && !error && (
                  <div className="flex items-center justify-center py-8">
                    <div className="max-w-xl text-center">
                      <MessageSquare size={32} className="mx-auto mb-3 text-text-tertiary" />
                      <p className="text-base text-text-secondary">
                        Anvil is setting up your workspace in scaffold mode.
                      </p>
                      <p className="mt-2 text-sm text-text-tertiary">
                        The coder persona will ask you to name the repositories it should create
                        under{' '}
                        <span className="font-mono text-text-secondary">
                          {activeScaffoldSession?.rootPath ?? 'the selected root folder'}
                        </span>
                        .
                      </p>
                    </div>
                  </div>
                )}

                {!scaffoldModeActive &&
                  isWorkItemLayout &&
                  !activeThread?.workItemId &&
                  isEmpty &&
                  !error && (
                    <div className="flex items-center justify-center py-8">
                      <div className="max-w-md text-center">
                        <ClipboardList size={32} className="mx-auto mb-3 text-text-tertiary" />
                        <p className="text-base font-medium text-text-primary">
                          Select a work item
                        </p>
                        <p className="mt-2 text-sm text-text-tertiary">
                          Each work item has one chat thread. Pick one from the left panel to
                          continue.
                        </p>
                      </div>
                    </div>
                  )}

                {!scaffoldModeActive &&
                  !isWorkItemLayout &&
                  activeRepos.length > 0 &&
                  isEmpty &&
                  !error && (
                    <ChatEmptyState
                      personaId={activePersona?.id ?? 'coder'}
                      personaName={activePersona?.name ?? 'Coder'}
                      personaColour={personaColour}
                      hasRepos={true}
                      hasGovernanceDocs={selectedGovernanceDocs.length > 0}
                      isDbExpertPersona={isDbExpertPersona}
                      onSuggestionClick={handleSuggestionClick}
                    />
                  )}

                {!scaffoldModeActive &&
                  !isWorkItemLayout &&
                  activeRepos.length === 0 &&
                  isEmpty &&
                  !error &&
                  featureAvailability.chatEnabled && (
                    <ChatEmptyState
                      personaId={activePersona?.id ?? 'coder'}
                      personaName={activePersona?.name ?? 'Coder'}
                      personaColour={personaColour}
                      hasRepos={false}
                      hasGovernanceDocs={selectedGovernanceDocs.length > 0}
                      isDbExpertPersona={isDbExpertPersona}
                      onSuggestionClick={handleSuggestionClick}
                    />
                  )}

                {scaffoldBusy && (
                  <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-info/20 bg-info/5 px-4 py-3">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0 text-info" />
                    <p className="text-sm text-text-primary leading-relaxed">
                      {scaffoldStatus === 'syncing'
                        ? 'Scaffold completion was detected. Anvil is connecting the new repositories to this workspace.'
                        : 'Repositories are being indexed now. Other views stay locked until indexing finishes, then the rest of the workspace will unlock.'}
                    </p>
                  </div>
                )}

                {composedTurns.length > 0 && (
                  <div className="w-full space-y-6">
                    {composedTurns.map((turn, turnIndex) => {
                      const liveState = getChatTurnLiveState({
                        busy,
                        isLatest: turnIndex === composedTurns.length - 1,
                        hasWork: turn.work.length > 0,
                        hasAnswer: Boolean(turn.answer),
                        hasTrailingWork: turn.trailingWork.length > 0,
                      });

                      return (
                        <section
                          key={`${activeThreadId ?? 'new'}:${turn.key}`}
                          className="w-full space-y-4"
                          aria-label={`Turn ${turnIndex + 1}`}
                        >
                          {turn.user && (
                            <UserMessage
                              content={turn.user.content}
                              attachments={turn.user.attachments}
                              onEdit={() =>
                                handleReuseMessage(turn.user!.sourceIndex, turn.user!.content)
                              }
                              onBranch={
                                isWorkItemLayout
                                  ? undefined
                                  : () => handleBranch(turn.user!.sourceIndex)
                              }
                            />
                          )}
                          {turn.work.length > 0 && (
                            <TurnWorkMessage items={turn.work} active={liveState !== null} />
                          )}
                          {turn.answer && (
                            <AssistantMessage
                              content={turn.answer.content}
                              transformContent={isBaPersona ? stripFindingMarkers : undefined}
                              label={activePersona?.name ?? 'Assistant'}
                              colour={personaColour}
                              active={liveState === 'responding'}
                              onBranch={
                                isWorkItemLayout
                                  ? undefined
                                  : () => handleBranch(turn.answer!.sourceIndex)
                              }
                            />
                          )}
                          {turn.trailingWork.length > 0 && (
                            <TurnWorkMessage
                              items={turn.trailingWork}
                              active={liveState !== null}
                            />
                          )}
                          {liveState && (
                            <TurnActivityStatus
                              state={liveState}
                              latestItem={
                                turn.trailingWork[turn.trailingWork.length - 1] ??
                                turn.work[turn.work.length - 1]
                              }
                            />
                          )}
                        </section>
                      );
                    })}
                  </div>
                )}

                {error && (
                  <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-error/20 bg-error/5 px-4 py-3">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0 text-error" />
                    <p className="text-sm text-error whitespace-pre-wrap leading-relaxed">
                      {error}
                    </p>
                  </div>
                )}
              </div>
              <div ref={messagesEndRef} />
            </div>
            {showJumpToLatest && composedTurns.length > 0 && (
              <button
                type="button"
                onClick={handleJumpToLatest}
                className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-bg-elevated/95 px-3 py-1.5 text-xs font-medium text-text-secondary shadow-lg backdrop-blur transition-colors hover:border-accent/40 hover:bg-bg-tertiary hover:text-text-primary"
              >
                {busy ? <Loader2 size={13} className="animate-spin" /> : <ArrowDown size={13} />}
                {busy ? 'Working · Latest' : 'Latest'}
              </button>
            )}
          </div>

          {/* Input */}
          <ChatInput
            onSend={handleChatInputSend}
            onStop={interrupt}
            disabled={chatInputDisabled}
            busy={busy}
            personaColour={personaColour}
            model={model}
            modelProvider={modelProvider}
            modelOptions={modelOptions}
            onModelChange={setModel}
            reasoningLevel={reasoningLevel}
            reasoningOptions={reasoningOptions}
            onReasoningChange={setReasoningLevel}
            executionStrategy={executionStrategy}
            onExecutionStrategyChange={setExecutionStrategy}
            codexMode={isItsmPersona ? 'read-only' : codexMode}
            onCodexModeChange={
              scaffoldModeActive ? undefined : (mode) => void handleCodexModeChange(mode)
            }
            codexModeDisabled={isItsmPersona}
            prefill={composerPrefill}
            draftKey={composerDraftKey}
            mentionRepoIds={mentionRepoIds}
            slashCommands={slashCommands}
            focusRequest={composerFocusRequest}
          />
        </div>

        {/* Findings sidebar - BA persona only */}
        {isBaPersona && findings.length > 0 && (
          <ResizableSidebarPanel
            storageKey="chat:findings"
            side="right"
            title="Findings"
            defaultWidth={380}
            minWidth={300}
            maxWidth={560}
            className="border-l border-border/60 bg-bg-secondary/50"
          >
            <div className="flex items-center justify-between border-b border-border/60 px-3 py-2.5">
              <div className="min-w-0">
                <button
                  onClick={() => setShowFindings(!showFindings)}
                  className="flex items-center gap-1.5 text-sm font-medium text-text-primary"
                >
                  {showFindings ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  Findings
                  <span className="rounded-full bg-warning/20 px-2 py-0.5 text-xs font-medium text-warning">
                    {openFindings.length}
                  </span>
                </button>
                <p className="mt-1 text-xs text-text-tertiary">
                  Scrollable. Use follow-up to drop a targeted prompt into the composer.
                </p>
              </div>
            </div>

            {showFindings && (
              <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
                <div className="space-y-2">
                  {openFindings.map((f) => (
                    <ChatFindingCard
                      key={f.idx}
                      finding={f}
                      onFollowUp={() => handleFindingFollowUp(f)}
                      onDismiss={() => setDismissedFindings((prev) => new Set(prev).add(f.idx))}
                    />
                  ))}
                  {openFindings.length === 0 && (
                    <p className="p-2 text-center text-sm text-text-tertiary">
                      All findings dismissed.
                    </p>
                  )}
                </div>
              </div>
            )}
          </ResizableSidebarPanel>
        )}

        {/* Design sidebar */}
        {isDesignPersona && (
          <DesignSidebar
            collapsed={designSidebarCollapsed}
            onToggleCollapse={() => setDesignSidebarCollapsed((c) => !c)}
          />
        )}

        {showItsmWorkbench && (
          <ResizableSidebarPanel
            storageKey="chat:itsm-workbench"
            side="right"
            title="ITSM workbench"
            defaultWidth={380}
            minWidth={320}
            maxWidth={560}
            collapsedWidth={0}
            className="border-l border-border/60 bg-bg-secondary/50"
          >
            <ItsmWorkbench
              workspaceId={activeWorkspace?.id ?? null}
              onPrompt={(prompt) => {
                setComposerPrefill({ id: `itsm-${Date.now()}`, text: prompt });
                setComposerFocusRequest((current) => current + 1);
              }}
            />
          </ResizableSidebarPanel>
        )}

        {showCanvasSidebar && (
          <ResizableSidebarPanel
            storageKey="chat:canvas"
            side="right"
            title="Canvas"
            defaultWidth={460}
            minWidth={360}
            maxWidth={720}
            collapsedWidth={0}
            className="border-l border-border/60 bg-bg-secondary/50"
          >
            <ChatCanvasSidebar
              artifacts={activeArtifacts}
              selectedArtifact={selectedArtifact}
              activePlan={activePlan}
              activeGoal={activeGoal}
              onSelectArtifact={setSelectedArtifactId}
              presentation="sidebar"
              onExpand={() => setCanvasExpanded(true)}
              onDetach={() => setCanvasDetached(true)}
            />
          </ResizableSidebarPanel>
        )}

        {canvasExpanded && !canvasDetached && (selectedArtifact || activePlan || activeGoal) && (
          <div className="fixed inset-3 z-50 flex min-h-0 overflow-hidden rounded-xl border border-border bg-bg-secondary shadow-2xl">
            <ChatCanvasSidebar
              artifacts={activeArtifacts}
              selectedArtifact={selectedArtifact}
              activePlan={activePlan}
              activeGoal={activeGoal}
              onSelectArtifact={setSelectedArtifactId}
              presentation="expanded"
              onExpand={() => setCanvasExpanded(false)}
              onDetach={() => {
                setCanvasExpanded(false);
                setCanvasDetached(true);
              }}
            />
          </div>
        )}

        {canvasDetached && (selectedArtifact || activePlan || activeGoal) && (
          <DetachedCanvasWindow title="Anvil Canvas" onClose={handleDetachedCanvasClose}>
            <ChatCanvasSidebar
              artifacts={activeArtifacts}
              selectedArtifact={selectedArtifact}
              activePlan={activePlan}
              activeGoal={activeGoal}
              onSelectArtifact={setSelectedArtifactId}
              presentation="detached"
              onExpand={handleDetachedCanvasClose}
              onDetach={handleDetachedCanvasClose}
            />
          </DetachedCanvasWindow>
        )}
      </div>
    </div>
  );

  if (isDesignPersona) {
    return <DesignProvider>{content}</DesignProvider>;
  }

  return content;
}

function AgentWorkControl({
  open,
  runs,
  sessions,
  onOpenChange,
  onOpenThread,
  onStop,
}: {
  open: boolean;
  runs: AgentRunSummary[];
  sessions: CodexSession[];
  onOpenChange: (open: boolean) => void;
  onOpenThread: (threadId: string) => void;
  onStop: (sessionId: string) => void;
}) {
  const [section, setSection] = useState<'active' | 'recent'>('active');
  const activeSessions = sessions.filter(
    (session) => session.status === 'starting' || session.status === 'busy',
  );
  const activeRuns = runs.filter((run) => run.status === 'queued' || run.status === 'running');
  const activeCount = Math.max(activeSessions.length, activeRuns.length);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors ${
          activeCount > 0
            ? 'border-accent/30 bg-accent/10 text-accent hover:bg-accent/15'
            : 'border-border text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary'
        }`}
        title="Agent work"
        aria-label="Agent work"
        aria-expanded={open}
      >
        <Bot size={13} />
        <span>Work</span>
        {activeCount > 0 && (
          <span className="rounded-full bg-bg-primary px-1.5 text-[10px] text-text-primary">
            {activeCount}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-[28rem] rounded-xl border border-border bg-bg-elevated p-2 shadow-xl">
          <div className="px-2 pb-2">
            <div className="text-sm font-semibold text-text-primary">Agent work</div>
            <div className="mt-1 text-xs text-text-tertiary">
              Live sessions and durable run history for this workspace.
            </div>
          </div>
          <div className="flex gap-1 border-b border-border-subtle px-2 pb-2" role="tablist">
            {(['active', 'recent'] as const).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={section === item}
                onClick={() => setSection(item)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors ${
                  section === item
                    ? 'bg-bg-tertiary text-text-primary'
                    : 'text-text-tertiary hover:text-text-primary'
                }`}
              >
                {item}
                {item === 'active' && activeCount > 0 ? ` ${activeCount}` : ''}
              </button>
            ))}
          </div>
          <div className="max-h-96 overflow-y-auto py-2">
            {section === 'active' && activeSessions.length === 0 ? (
              <div className="px-3 py-6 text-center">
                <Bot size={20} className="mx-auto text-text-muted" />
                <p className="mt-2 text-sm text-text-secondary">No work is running.</p>
                <p className="mt-1 text-xs text-text-tertiary">
                  Adaptive and parallel strategies can delegate bounded tasks when useful.
                </p>
              </div>
            ) : section === 'active' ? (
              activeSessions.map((session) => (
                <div
                  key={session.id}
                  className="mb-1 border-b border-border-subtle px-3 py-2.5 last:border-b-0"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                        <span className="truncate text-sm font-medium text-text-primary">
                          {session.personaId}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-text-tertiary">
                        {session.status} · {session.kind ?? 'session'}
                        {session.mode ? ` · ${session.mode}` : ''}
                      </div>
                      {session.providerThreadId && (
                        <div className="mt-1 truncate font-mono text-[10px] text-text-muted">
                          {session.providerThreadId}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => onStop(session.id)}
                      className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
                    >
                      Stop
                    </button>
                  </div>
                  {session.appThreadId && (
                    <button
                      type="button"
                      onClick={() => {
                        onOpenThread(session.appThreadId!);
                        onOpenChange(false);
                      }}
                      className="mt-2 text-xs font-medium text-accent hover:underline"
                    >
                      Open thread
                    </button>
                  )}
                </div>
              ))
            ) : runs.length === 0 ? (
              <p className="px-2 py-4 text-center text-sm text-text-tertiary">
                No run history captured yet.
              </p>
            ) : (
              runs.map((run) => (
                <div
                  key={run.id}
                  className="mb-1 border-b border-border-subtle px-3 py-2.5 last:border-b-0"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-text-primary">
                        {run.title}
                      </div>
                      <div className="mt-0.5 text-xs text-text-tertiary">
                        {formatAgentRunSource(run.source)} · {run.status} ·{' '}
                        {formatTimestamp(run.startedAt)}
                      </div>
                    </div>
                    <span className={`shrink-0 text-xs ${statusTone(run.status)}`}>
                      {run.status}
                    </span>
                  </div>
                  {run.summary && (
                    <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-text-secondary">
                      {run.summary}
                    </p>
                  )}
                  <div className="mt-2 flex items-center gap-2 text-[11px] text-text-tertiary">
                    <span>{run.changedFileCount} files</span>
                    <span>{run.evidenceCount} evidence</span>
                    {run.threadId && (
                      <button
                        type="button"
                        onClick={() => {
                          onOpenThread(run.threadId!);
                          onOpenChange(false);
                        }}
                        className="ml-auto font-medium text-accent hover:underline"
                      >
                        Open thread
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function formatAgentRunSource(source: AgentRunSummary['source']): string {
  switch (source) {
    case 'automation':
      return 'Automation';
    case 'code_review':
      return 'Code review';
    case 'chat':
    default:
      return 'Chat';
  }
}

function statusTone(status: AgentRunSummary['status']): string {
  switch (status) {
    case 'completed':
      return 'text-success';
    case 'failed':
      return 'text-error';
    case 'running':
    case 'queued':
      return 'text-accent';
    default:
      return 'text-text-tertiary';
  }
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function GoalControl({
  activeGoal,
  busy,
  open,
  onOpenChange,
  onSetGoal,
  onCompleteGoal,
}: {
  activeGoal: ChatGoalSnapshot | null;
  busy: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSetGoal: (objective: string, tokenBudget: string) => void;
  onCompleteGoal: () => void;
}) {
  const [objective, setObjective] = useState('');
  const [tokenBudget, setTokenBudget] = useState('');
  const hasActiveGoal = !!activeGoal && activeGoal.status !== 'complete';

  useEffect(() => {
    if (!open) return;
    setObjective(activeGoal?.status === 'complete' ? '' : (activeGoal?.objective ?? ''));
    setTokenBudget(activeGoal?.tokenBudget ? String(activeGoal.tokenBudget) : '');
  }, [activeGoal, open]);

  const canSubmit = objective.trim().length > 0 && !busy;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        className={`flex max-w-[260px] items-center gap-1.5 rounded-xl border px-3 py-1.5 text-sm transition-all hover:bg-bg-tertiary hover:shadow-sm ${
          hasActiveGoal
            ? 'border-success/30 bg-success/10 text-success'
            : 'border-border text-text-secondary hover:text-text-primary'
        }`}
        title={activeGoal ? activeGoal.objective : 'Set goal'}
        aria-expanded={open}
        aria-label={activeGoal ? `Active goal: ${activeGoal.objective}` : 'Set goal'}
      >
        <Target size={13} className="shrink-0" />
        <span className="min-w-0 truncate">{activeGoal ? activeGoal.objective : 'Set goal'}</span>
        {activeGoal && (
          <span className="shrink-0 rounded-full bg-bg-primary/70 px-1.5 py-0.5 text-[10px] uppercase tracking-normal text-text-tertiary">
            {formatGoalStatus(activeGoal.status)}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-96 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-bg-elevated p-3 shadow-2xl ring-1 ring-black/10">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-text-primary">
                {activeGoal ? 'Update goal' : 'Set goal'}
              </p>
              <p className="mt-0.5 text-xs text-text-tertiary">
                Stored on this thread when Codex confirms the goal update.
              </p>
            </div>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-lg p-1 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
              aria-label="Close goal popover"
            >
              <X size={14} />
            </button>
          </div>

          <label className="mt-3 block text-xs font-medium text-text-secondary" htmlFor="goal-text">
            Goal
          </label>
          <textarea
            id="goal-text"
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
            className="mt-1 min-h-24 w-full resize-y rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm leading-relaxed text-text-primary outline-none transition-colors placeholder:text-text-tertiary focus:border-accent"
            placeholder="Finish the refactor and verify the tests pass"
            disabled={busy}
          />

          <label
            className="mt-3 block text-xs font-medium text-text-secondary"
            htmlFor="goal-token-budget"
          >
            Token budget
          </label>
          <input
            id="goal-token-budget"
            value={tokenBudget}
            onChange={(event) => setTokenBudget(event.target.value)}
            className="mt-1 w-full rounded-xl border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none transition-colors placeholder:text-text-tertiary focus:border-accent"
            inputMode="numeric"
            pattern="[0-9]*"
            placeholder="Optional"
            disabled={busy}
          />

          {activeGoal && (
            <div className="mt-3 rounded-xl border border-border/70 bg-bg-secondary/70 px-3 py-2 text-xs text-text-tertiary">
              {activeGoal.tokensUsed.toLocaleString()} tokens
              {activeGoal.tokenBudget ? ` / ${activeGoal.tokenBudget.toLocaleString()}` : ''} used
            </div>
          )}

          <div className="mt-3 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={onCompleteGoal}
              disabled={!hasActiveGoal || busy}
              className="flex items-center gap-1.5 rounded-xl border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              <CheckCircle2 size={13} />
              Complete
            </button>
            <button
              type="button"
              onClick={() => onSetGoal(objective, tokenBudget)}
              disabled={!canSubmit}
              className="flex items-center gap-1.5 rounded-xl bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Target size={13} />
              {activeGoal ? 'Update' : 'Set'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ChatCanvasSidebar({
  artifacts,
  selectedArtifact,
  activePlan,
  activeGoal,
  onSelectArtifact,
  presentation,
  onExpand,
  onDetach,
}: {
  artifacts: ChatArtifact[];
  selectedArtifact: ChatArtifact | null;
  activePlan: ChatPlanSnapshot | null;
  activeGoal: ChatGoalSnapshot | null;
  onSelectArtifact: (artifactId: string) => void;
  presentation: 'sidebar' | 'expanded' | 'detached';
  onExpand: () => void;
  onDetach: () => void;
}) {
  const [mode, setMode] = useState<'preview' | 'source'>('preview');
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    if (!selectedArtifact) return;
    void navigator.clipboard.writeText(selectedArtifact.content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    });
  }, [selectedArtifact]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border/60 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-accent/20 bg-accent/10 text-accent">
            <Braces size={15} />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-semibold text-text-primary">Canvas</h3>
            <p className="truncate text-xs text-text-tertiary">
              {artifacts.length > 0
                ? `${artifacts.length} artifact${artifacts.length === 1 ? '' : 's'}`
                : 'Plan and goal context'}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={onExpand}
              className="rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              title={presentation === 'sidebar' ? 'Expand canvas' : 'Reattach canvas'}
              aria-label={presentation === 'sidebar' ? 'Expand canvas' : 'Reattach canvas'}
            >
              {presentation === 'sidebar' ? <Maximize2 size={14} /> : <Minimize2 size={14} />}
            </button>
            {presentation !== 'detached' && (
              <button
                type="button"
                onClick={onDetach}
                className="rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                title="Detach canvas"
                aria-label="Detach canvas"
              >
                <PictureInPicture2 size={14} />
              </button>
            )}
          </div>
        </div>
      </div>

      {artifacts.length > 0 && (
        <div className="border-b border-border/60 p-2">
          <div className="flex gap-1 overflow-x-auto pb-1">
            {artifacts.map((artifact) => (
              <button
                key={artifact.id}
                type="button"
                onClick={() => onSelectArtifact(artifact.id)}
                className={`flex max-w-48 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors ${
                  selectedArtifact?.id === artifact.id
                    ? 'border-accent/35 bg-accent/10 text-accent'
                    : 'border-border bg-bg-primary/60 text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
                }`}
                title={artifact.title}
              >
                <ArtifactIcon kind={artifact.kind} />
                <span className="truncate">{artifact.title}</span>
                <span className="shrink-0 text-[10px] opacity-70">v{artifact.version}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {selectedArtifact ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="border-b border-border/60 px-3 py-2">
            <div className="flex items-start gap-2">
              <ArtifactIcon kind={selectedArtifact.kind} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-text-primary">
                  {selectedArtifact.title}
                </div>
                <div className="mt-0.5 truncate font-mono text-[11px] text-text-tertiary">
                  {selectedArtifact.filePath ?? `.anvil/artifacts/${selectedArtifact.relativePath}`}
                </div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <ArtifactMetaChip label={selectedArtifact.status} />
                  <ArtifactMetaChip label={selectedArtifact.visibility} />
                  <ArtifactMetaChip label={selectedArtifact.source} />
                  {selectedArtifact.model && <ArtifactMetaChip label={selectedArtifact.model} />}
                  {selectedArtifact.reasoningEffort && (
                    <ArtifactMetaChip label={selectedArtifact.reasoningEffort} />
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => setMode('preview')}
                  className={`rounded-md p-1.5 transition-colors ${
                    mode === 'preview'
                      ? 'bg-accent/10 text-accent'
                      : 'text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary'
                  }`}
                  title="Preview"
                  aria-label="Preview artifact"
                  aria-pressed={mode === 'preview'}
                >
                  <Eye size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => setMode('source')}
                  className={`rounded-md p-1.5 transition-colors ${
                    mode === 'source'
                      ? 'bg-accent/10 text-accent'
                      : 'text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary'
                  }`}
                  title="Source"
                  aria-label="View artifact source"
                  aria-pressed={mode === 'source'}
                >
                  <Code size={13} />
                </button>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                  title={copied ? 'Copied' : 'Copy artifact'}
                  aria-label={copied ? 'Copied artifact' : 'Copy artifact'}
                >
                  {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
                </button>
                {selectedArtifact.filePath && (
                  <button
                    type="button"
                    onClick={() => window.open(`file://${selectedArtifact.filePath}`, '_blank')}
                    className="rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                    title="Open artifact file"
                    aria-label="Open artifact file"
                  >
                    <ExternalLink size={13} />
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto bg-bg-primary/40">
            <ArtifactBody artifact={selectedArtifact} mode={mode} />
          </div>
        </div>
      ) : (
        <PlanGoalSidebar activePlan={activePlan} activeGoal={activeGoal} />
      )}

      {selectedArtifact && (activePlan || activeGoal) && (
        <div className="max-h-60 overflow-auto border-t border-border/60">
          <PlanGoalSidebar activePlan={activePlan} activeGoal={activeGoal} compact />
        </div>
      )}
    </div>
  );
}

function ArtifactIcon({ kind }: { kind: ChatArtifact['kind'] }) {
  if (kind === 'markdown' || kind === 'text' || kind === 'docx' || kind === 'pdf') {
    return <FileText size={13} className="shrink-0" />;
  }
  if (kind === 'html' || kind === 'pptx') return <Eye size={13} className="shrink-0" />;
  if (kind === 'csv' || kind === 'xlsx') return <Database size={13} className="shrink-0" />;
  return <Braces size={13} className="shrink-0" />;
}

function ArtifactMetaChip({ label }: { label: string }) {
  return (
    <span className="rounded-full border border-border-subtle bg-bg-primary px-1.5 py-0.5 text-[10px] font-medium text-text-tertiary">
      {label}
    </span>
  );
}

function ArtifactBody({ artifact, mode }: { artifact: ChatArtifact; mode: 'preview' | 'source' }) {
  return <ArtifactPreview artifact={artifact} mode={mode} />;
}

function PlanGoalSidebar({
  activePlan,
  activeGoal,
  compact = false,
}: {
  activePlan: ChatPlanSnapshot | null;
  activeGoal: ChatGoalSnapshot | null;
  compact?: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
      {activeGoal && (
        <section
          className={`${compact ? 'mb-2' : 'mb-3'} rounded-xl border border-success/20 bg-success/5 p-3`}
        >
          <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
            <Target size={14} className="text-success" />
            Goal
            <span className="ml-auto rounded-full bg-success/10 px-2 py-0.5 text-xs text-success">
              {formatGoalStatus(activeGoal.status)}
            </span>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-text-secondary">{activeGoal.objective}</p>
          <p className="mt-2 text-xs text-text-tertiary">
            {activeGoal.tokensUsed.toLocaleString()} tokens
            {activeGoal.tokenBudget ? ` / ${activeGoal.tokenBudget.toLocaleString()}` : ''} used
          </p>
        </section>
      )}

      {activePlan && (
        <section className="rounded-xl border border-info/20 bg-info/5">
          <div className="border-b border-info/15 p-3">
            <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
              <ListChecks size={14} className="text-info" />
              Implementation Plan
              <span className="ml-auto text-xs text-text-tertiary">
                {activePlan.steps.filter((step) => step.status === 'completed').length}/
                {activePlan.steps.length}
              </span>
            </div>
            {activePlan.explanation && (
              <p className="mt-2 text-xs leading-relaxed text-text-secondary">
                {activePlan.explanation}
              </p>
            )}
          </div>
          <ol className="space-y-2 p-3">
            {activePlan.steps.map((step, index) => (
              <li key={`${index}-${step.step}`} className="flex items-start gap-2 text-sm">
                <SidebarPlanStepIcon status={step.status} />
                <span
                  className={
                    step.status === 'completed'
                      ? 'text-text-tertiary line-through'
                      : 'text-text-secondary'
                  }
                >
                  {step.step}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

function SidebarPlanStepIcon({ status }: { status: ChatPlanStep['status'] }) {
  if (status === 'completed') {
    return <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-success" />;
  }
  if (status === 'in_progress') {
    return <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin text-info" />;
  }
  return <Circle size={14} className="mt-0.5 shrink-0 text-text-tertiary" />;
}

export function isNearChatBottom(
  metrics: ScrollMetrics,
  thresholdPx = CHAT_BOTTOM_THRESHOLD_PX,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight < thresholdPx;
}

export function shouldFocusChatComposerFromKey(event: Pick<KeyboardEvent, 'key' | 'target'>) {
  if (event.key !== '/') return false;
  return !isEditableShortcutTarget(event.target);
}

export function getNewChatThreadActionLabel(): string {
  return NEW_CHAT_THREAD_LABEL;
}

export function buildMessageReusePrefill(content: string): string {
  return content.trimEnd();
}

export function getChatTurnLiveState({
  busy,
  isLatest,
  hasWork,
  hasAnswer,
  hasTrailingWork = false,
}: {
  busy: boolean;
  isLatest: boolean;
  hasWork: boolean;
  hasAnswer: boolean;
  hasTrailingWork?: boolean;
}): TurnActivityState | null {
  if (!busy || !isLatest) return null;
  if (hasTrailingWork) return 'working';
  if (hasAnswer) return 'responding';
  if (hasWork) return 'working';
  return 'thinking';
}

function formatGoalStatus(status: ChatGoalSnapshot['status']): string {
  switch (status) {
    case 'budgetLimited':
      return 'budget limited';
    case 'complete':
      return 'complete';
    default:
      return status;
  }
}

const FINDING_TYPE_STYLES: Record<
  string,
  { bg: string; border: string; text: string; label: string }
> = {
  compliance: {
    bg: 'bg-warning/5',
    border: 'border-warning/20',
    text: 'text-warning',
    label: 'Compliance',
  },
  feasibility: {
    bg: 'bg-info/5',
    border: 'border-info/20',
    text: 'text-info',
    label: 'Feasibility',
  },
  dependency: {
    bg: 'bg-warning/10',
    border: 'border-warning/25',
    text: 'text-warning',
    label: 'Dependency',
  },
  question: {
    bg: 'bg-text-tertiary/5',
    border: 'border-text-tertiary/20',
    text: 'text-text-tertiary',
    label: 'Question',
  },
  risk: { bg: 'bg-error/5', border: 'border-error/20', text: 'text-error', label: 'Risk' },
  security: { bg: 'bg-error/5', border: 'border-error/20', text: 'text-error', label: 'Security' },
};

function ChatFindingCard({
  finding,
  onFollowUp,
  onDismiss,
}: {
  finding: ExtractedFinding;
  onFollowUp: () => void;
  onDismiss: () => void;
}) {
  const style = FINDING_TYPE_STYLES[finding.type] ?? FINDING_TYPE_STYLES.question;
  return (
    <div className={`rounded-xl border ${style.border} ${style.bg} px-3 py-2.5`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <span
            className={`inline-block rounded-full px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide ${style.text}`}
          >
            {style.label}
          </span>
          <p className="mt-1.5 text-sm leading-relaxed text-text-secondary">{finding.content}</p>
        </div>
        <button
          onClick={onDismiss}
          className="shrink-0 rounded-lg p-1 text-text-tertiary hover:bg-bg-tertiary hover:text-text-primary"
          title="Dismiss finding"
        >
          <X size={13} />
        </button>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={onFollowUp}
          className="rounded-lg border border-border/70 px-2 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
        >
          Follow up
        </button>
      </div>
    </div>
  );
}

function buildFindingFollowUpPrompt(finding: ExtractedFinding): string {
  const label = FINDING_TYPE_STYLES[finding.type]?.label ?? 'Finding';

  return [
    `Let's follow up on this BA ${label.toLowerCase()} finding:`,
    finding.content,
    '',
    'Please expand on:',
    '- the evidence in the current repos or requirements that led to this finding',
    '- the concrete implementation or delivery impact',
    '- what has likely been overlooked or needs clarification',
    '- the recommended next action or decision',
  ].join('\n');
}
