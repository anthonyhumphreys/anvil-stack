import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
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
  Sparkles,
  Hammer,
  ListChecks,
  Target,
  Circle,
  CheckCircle2,
  Loader2,
  Bot,
  SendHorizontal,
  FileText,
  Braces,
  PanelRightOpen,
  PanelRightClose,
  Copy,
  Check,
  ExternalLink,
} from 'lucide-react';
import type {
  AgentRunSummary,
  ChatAttachment,
  ChatArtifact,
  ChatGoalSnapshot,
  ChatPlanSnapshot,
  ChatPlanStep,
  CodexEvent,
  CodexMode,
  CodexSession,
  Persona,
} from '../../../shared/types';
import { ChatInput, type ChatQuickPrompt, type ChatSlashCommand } from './ChatInput';
import { ChatThreadRail } from './ChatThreadRail';
import { WorkItemThreadRail } from './WorkItemThreadRail';
import {
  ActivityGroupMessage,
  AssistantMessage,
  ChatEventRenderer,
  ThinkingMessage,
  UserMessage,
} from './ChatMessage';
import { ChatEmptyState } from './ChatEmptyState';
import { ChatStatusBar } from './ChatStatusBar';
import { MarkdownRenderer } from './MarkdownRenderer';
import { useChatContext, type ChatEntry } from '../../contexts/ChatContext';
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
};

interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

const CHAT_BOTTOM_THRESHOLD_PX = 96;
const NEW_CHAT_THREAD_LABEL = 'New thread';

export function ChatView() {
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
    setReasoningLevel,
    selectThread,
    renameThread,
    deleteThread,
    forkThread,
    setCollaborationMode,
    setChatLayout,
    selectWorkItemThread,
  } = useChatContext();
  const { repos, featureAvailability, activeScaffoldSession, activeWorkspace } = useWorkspace();
  const [searchParams, setSearchParams] = useSearchParams();

  const [showPersonaDropdown, setShowPersonaDropdown] = useState(false);
  const [showFindings, setShowFindings] = useState(true);
  const [dismissedFindings, setDismissedFindings] = useState<Set<number>>(new Set());
  const [composerPrefill, setComposerPrefill] = useState<{ id: string; text: string } | null>(null);
  const [codexMode, setCodexMode] = useState<CodexMode>('on-request');
  const [goalPopoverOpen, setGoalPopoverOpen] = useState(false);
  const [workOpen, setWorkOpen] = useState(false);
  const [executionStrategy, setExecutionStrategy] = useState<ExecutionStrategy>('adaptive');
  const [canvasOpen, setCanvasOpen] = useState(true);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [recentRuns, setRecentRuns] = useState<AgentRunSummary[]>([]);
  const [activeSessions, setActiveSessions] = useState<CodexSession[]>([]);
  const [steerDraft, setSteerDraft] = useState('');
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [composerFocusRequest, setComposerFocusRequest] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);

  const isBaPersona = activePersona?.id === 'ba';
  const isDesignPersona = activePersona?.id === 'design';
  const isDbExpertPersona = activePersona?.id === 'db-expert';
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
  const quickPrompts = useMemo<ChatQuickPrompt[]>(() => {
    const repoContext =
      activeRepos.length > 0
        ? `the selected repo${activeRepos.length === 1 ? '' : 's'}: ${activeRepos
            .map((repo) => repo.name)
            .join(', ')}`
        : 'the active workspace';

    return [
      {
        id: 'review-diff',
        label: 'Review diff',
        prompt: `Review the current changes in ${repoContext}. Focus on correctness, regressions, missing tests, security risks, and developer workflow issues. Cite files and lines where possible.`,
      },
      {
        id: 'plan-change',
        label: 'Plan change',
        prompt: `Help me plan the next implementation in ${repoContext}. Identify the files likely to change, risky assumptions, and the smallest useful verification loop.`,
      },
      {
        id: 'write-tests',
        label: 'Write tests',
        prompt: `Find the most important missing tests for ${repoContext}. Prioritise behavior that could regress and suggest focused test cases before implementation.`,
      },
      {
        id: 'map-code',
        label: 'Map code',
        prompt: `Map ${repoContext}. Summarise the main modules, runtime entry points, data flow, and the first files a developer should read.`,
      },
    ];
  }, [activeRepos]);
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
  const displayEntries = useMemo(() => groupChatEntries(entries), [entries]);

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
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [entries]);

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

      void send(message, attachments, buildExecutionStrategyPrompt(executionStrategy) ?? undefined);
    },
    [executionStrategy, send, startNewSession],
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

  const handleSuggestionClick = useCallback(
    (prompt: string) => {
      send(prompt);
    },
    [send],
  );

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

  const handleSteerSubmit = useCallback(() => {
    const message = steerDraft.trim();
    if (!message) return;
    setSteerDraft('');
    void steer(message);
  }, [steer, steerDraft]);

  const personaColour = activePersona?.colour ?? '#b5121b';
  const scaffoldBusy = scaffoldStatus === 'syncing' || scaffoldStatus === 'indexing';
  const workspaceChatReady = scaffoldModeActive || featureAvailability.chatEnabled;
  const chatInputDisabled =
    busy || scaffoldBusy || !workspaceChatReady || (isWorkItemLayout && !activeThread?.workItemId);
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
  const showCanvasSidebar =
    !isDesignPersona &&
    !isBaPersona &&
    canvasOpen &&
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
      <div className="relative z-40 flex flex-wrap items-center gap-2 border-b border-border/60 bg-bg-secondary/90 px-4 py-2.5 shadow-sm backdrop-blur-sm">
        <div className="flex min-w-[360px] flex-1 flex-wrap items-center gap-2 lg:gap-3">
          <div
            className="flex h-8 w-8 items-center justify-center rounded-xl shadow-sm"
            style={{ backgroundColor: `${personaColour}15` }}
          >
            <MessageSquare size={16} style={{ color: personaColour }} className="shrink-0" />
          </div>
          <div className="min-w-0">
            <h2 className="shrink-0 text-base font-semibold tracking-tight">Chat</h2>
            {activeThread && !scaffoldModeActive && (
              <p className="truncate text-xs text-text-tertiary">{activeThread.title}</p>
            )}
          </div>

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
              <span className="text-text-primary">{activePersona?.name ?? 'Select persona'}</span>
              <ChevronDown size={12} className="text-text-tertiary" />
            </button>

            {showPersonaDropdown && !scaffoldModeActive && (
              <div className="absolute left-0 top-full z-50 mt-1.5 w-72 overflow-hidden rounded-xl border border-border bg-bg-elevated shadow-2xl ring-1 ring-black/10">
                <div className="p-1.5">
                  {personas.map((p) => (
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
                      <span className="shrink-0 text-text-secondary">{PERSONA_ICONS[p.icon]}</span>
                      <div className="min-w-0">
                        <div className="font-medium text-text-primary">{p.name}</div>
                        <div className="truncate text-xs text-text-tertiary">{p.description}</div>
                      </div>
                    </button>
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

          {!scaffoldModeActive && (
            <label className="flex items-center gap-2 rounded-xl border border-border px-2.5 py-1.5 text-sm text-text-secondary">
              <span className="hidden text-xs text-text-tertiary xl:inline">Mode</span>
              <select
                value={codexMode}
                onChange={(event) => void handleCodexModeChange(event.target.value as CodexMode)}
                className="max-w-28 bg-transparent text-sm text-text-primary outline-none xl:max-w-none"
                aria-label="Codex mode"
              >
                <option value="read-only">Read Only</option>
                <option value="on-request">Ask First</option>
                <option value="workspace-auto">Auto</option>
                <option value="full-access">Full Access</option>
              </select>
            </label>
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
                const target = result.pullRequestUrl ?? `${result.repoName} ${result.branch}`;
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
          {session && (
            <span
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
                busy ? 'bg-warning/10 text-warning' : 'bg-success/10 text-success'
              }`}
            >
              {busy && <Sparkles size={10} className="animate-pulse" />}
              {busy ? 'Working' : 'Ready'}
            </span>
          )}
        </div>

        <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
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

          {!isWorkItemLayout && (
            <button
              onClick={() => void startNewSession()}
              disabled={scaffoldModeActive}
              className="flex items-center gap-1.5 rounded-xl border border-border px-3 py-1.5 text-sm text-text-secondary transition-all hover:bg-bg-tertiary hover:text-text-primary hover:shadow-sm disabled:opacity-50"
              title={getNewChatThreadActionLabel()}
              aria-label={getNewChatThreadActionLabel()}
            >
              <MessageSquarePlus size={13} />
              <span className="hidden xl:inline">{getNewChatThreadActionLabel()}</span>
            </button>
          )}

          {!isDesignPersona && !isBaPersona && (
            <button
              type="button"
              onClick={() => setCanvasOpen((open) => !open)}
              disabled={activeArtifacts.length === 0 && !activePlan && !activeGoal}
              className="flex items-center gap-1.5 rounded-xl border border-border px-3 py-1.5 text-sm text-text-secondary transition-all hover:bg-bg-tertiary hover:text-text-primary hover:shadow-sm disabled:cursor-not-allowed disabled:opacity-45"
              title={canvasOpen ? 'Hide canvas' : 'Show canvas'}
              aria-label={canvasOpen ? 'Hide canvas' : 'Show canvas'}
              aria-pressed={canvasOpen}
            >
              {canvasOpen ? <PanelRightClose size={13} /> : <PanelRightOpen size={13} />}
              <span className="hidden xl:inline">Canvas</span>
              {activeArtifacts.length > 0 && (
                <span className="rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent">
                  {activeArtifacts.length}
                </span>
              )}
            </button>
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
              threads={threads}
              activeThreadId={activeThreadId}
              liveThreadStatuses={liveThreadStatuses}
              onSelectThread={(threadId) => void selectThread(threadId)}
              onCreateThread={() => void startNewSession()}
              onRenameThread={(threadId, title) => void renameThread(threadId, title)}
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
                className={`w-full px-3 lg:px-4 ${
                  showCenteredEmptyPane
                    ? 'flex min-h-full flex-1 items-center justify-center py-6'
                    : 'flex flex-col pb-4 pt-5'
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

                {displayEntries.length > 0 && (
                  <div className="space-y-5">
                    {displayEntries.map((entry, i) =>
                      entry.kind === 'user' ? (
                        <UserMessage
                          key={`msg-${i}`}
                          content={entry.content}
                          attachments={entry.attachments}
                          onEdit={() => handleReuseMessage(entry.sourceIndex, entry.content)}
                          onBranch={
                            isWorkItemLayout ? undefined : () => handleBranch(entry.sourceIndex)
                          }
                        />
                      ) : entry.kind === 'assistant' ? (
                        <AssistantMessage
                          key={`msg-${i}`}
                          content={entry.content}
                          transformContent={isBaPersona ? stripFindingMarkers : undefined}
                          onBranch={
                            isWorkItemLayout ? undefined : () => handleBranch(entry.sourceIndex)
                          }
                        />
                      ) : entry.kind === 'thinking' ? (
                        <ThinkingMessage key={`think-${i}`} content={entry.content} />
                      ) : entry.kind === 'activity-group' ? (
                        <ActivityGroupMessage key={`act-${i}`} events={entry.events} />
                      ) : (
                        <div key={`evt-${i}`} className="flex justify-start">
                          <div className="w-full max-w-4xl">
                            <ChatEventRenderer event={entry.event} />
                          </div>
                        </div>
                      ),
                    )}
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
            {showJumpToLatest && displayEntries.length > 0 && (
              <button
                type="button"
                onClick={handleJumpToLatest}
                className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-bg-elevated/95 px-3 py-1.5 text-xs font-medium text-text-secondary shadow-lg backdrop-blur transition-colors hover:border-accent/40 hover:bg-bg-tertiary hover:text-text-primary"
              >
                <ArrowDown size={13} />
                Latest
              </button>
            )}
          </div>

          {/* Status bar */}
          <ChatStatusBar
            events={entries
              .filter((e) => e.kind === 'event')
              .map((e) => (e as { event: CodexEvent }).event)}
            isBusy={busy}
          />

          {busy && session && (
            <div className="border-t border-border/60 bg-bg-secondary/80 px-3 py-2">
              <div className="flex items-center gap-2 rounded-xl border border-warning/25 bg-warning/5 px-3 py-2">
                <Sparkles size={14} className="shrink-0 text-warning" />
                <input
                  value={steerDraft}
                  onChange={(event) => setSteerDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      handleSteerSubmit();
                    }
                  }}
                  placeholder="Steer the active turn..."
                  className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-tertiary"
                />
                <button
                  type="button"
                  onClick={handleSteerSubmit}
                  disabled={!steerDraft.trim()}
                  className="flex items-center gap-1.5 rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-1 text-xs font-medium text-warning transition-colors hover:bg-warning/15 disabled:cursor-not-allowed disabled:opacity-40"
                  title="Send steering input to the current Codex turn"
                >
                  <SendHorizontal size={13} />
                  Steer
                </button>
              </div>
            </div>
          )}

          {/* Input */}
          <ChatInput
            onSend={handleComposerSend}
            onStop={interrupt}
            disabled={chatInputDisabled}
            busy={busy}
            personaColour={personaColour}
            reasoningLevel={reasoningLevel}
            reasoningOptions={reasoningOptions}
            onReasoningChange={setReasoningLevel}
            executionStrategy={executionStrategy}
            onExecutionStrategyChange={setExecutionStrategy}
            prefill={composerPrefill}
            draftKey={composerDraftKey}
            mentionRepoIds={mentionRepoIds}
            quickPrompts={quickPrompts}
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

        {showCanvasSidebar && (
          <ResizableSidebarPanel
            storageKey="chat:canvas"
            side="right"
            title="Canvas"
            defaultWidth={460}
            minWidth={360}
            maxWidth={720}
            className="border-l border-border/60 bg-bg-secondary/50"
          >
            <ChatCanvasSidebar
              artifacts={activeArtifacts}
              selectedArtifact={selectedArtifact}
              activePlan={activePlan}
              activeGoal={activeGoal}
              onSelectArtifact={setSelectedArtifactId}
            />
          </ResizableSidebarPanel>
        )}
      </div>
    </div>
  );

  if (isDesignPersona) {
    return <DesignProvider>{content}</DesignProvider>;
  }

  return content;
}

type SourceIndexedEntry<T extends ChatEntry> = T & { sourceIndex: number };
type EventEntry = SourceIndexedEntry<Extract<ChatEntry, { kind: 'event' }>>;
type ActivityGroupEntry = {
  kind: 'activity-group';
  events: CodexEvent[];
};
type DisplayEntry =
  | SourceIndexedEntry<Exclude<ChatEntry, { kind: 'event' }>>
  | EventEntry
  | ActivityGroupEntry;

const GROUPED_ACTIVITY_EVENT_TYPES: CodexEvent['type'][] = [
  'tool_call',
  'command_exec',
  'file_read',
  'file_edit',
  'approval_request',
  'plan_update',
  'goal_update',
  'goal_cleared',
];

function groupChatEntries(entries: ChatEntry[]): DisplayEntry[] {
  const grouped: DisplayEntry[] = [];
  let pendingEvents: EventEntry[] = [];

  const flushPendingEvents = () => {
    if (pendingEvents.length === 0) return;
    if (pendingEvents.length === 1) {
      grouped.push(pendingEvents[0]);
    } else {
      grouped.push({
        kind: 'activity-group',
        events: pendingEvents.map((entry) => entry.event),
      });
    }
    pendingEvents = [];
  };

  for (const [sourceIndex, entry] of entries.entries()) {
    const indexedEntry = { ...entry, sourceIndex } as SourceIndexedEntry<ChatEntry>;
    if (entry.kind === 'event' && isGroupedActivityEvent(entry.event)) {
      pendingEvents.push(indexedEntry as EventEntry);
      continue;
    }

    flushPendingEvents();
    grouped.push(indexedEntry as DisplayEntry);
  }

  flushPendingEvents();
  return grouped;
}

function isGroupedActivityEvent(event: CodexEvent): boolean {
  return GROUPED_ACTIVITY_EVENT_TYPES.includes(event.type);
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
}: {
  artifacts: ChatArtifact[];
  selectedArtifact: ChatArtifact | null;
  activePlan: ChatPlanSnapshot | null;
  activeGoal: ChatGoalSnapshot | null;
  onSelectArtifact: (artifactId: string) => void;
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
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-text-primary">Canvas</h3>
            <p className="truncate text-xs text-text-tertiary">
              {artifacts.length > 0
                ? `${artifacts.length} artifact${artifacts.length === 1 ? '' : 's'}`
                : 'Plan and goal context'}
            </p>
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
  if (kind === 'markdown' || kind === 'text') return <FileText size={13} className="shrink-0" />;
  if (kind === 'html') return <Eye size={13} className="shrink-0" />;
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
  if (mode === 'source' || artifact.kind === 'code' || artifact.kind === 'data') {
    return (
      <pre className="min-h-full overflow-auto p-4 font-mono text-xs leading-relaxed text-text-secondary">
        <code>{artifact.content}</code>
      </pre>
    );
  }

  if (artifact.kind === 'html') {
    return (
      <iframe
        title={artifact.title}
        sandbox=""
        srcDoc={artifact.content}
        className="h-full min-h-[520px] w-full bg-white"
      />
    );
  }

  if (artifact.kind === 'markdown') {
    return (
      <div className="mx-auto max-w-3xl px-5 py-4">
        <MarkdownRenderer content={artifact.content} />
      </div>
    );
  }

  return (
    <pre className="min-h-full whitespace-pre-wrap p-4 text-sm leading-relaxed text-text-secondary">
      {artifact.content}
    </pre>
  );
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
