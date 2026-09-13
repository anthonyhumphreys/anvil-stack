import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BookOpen,
  Bell,
  Code,
  Compass,
  Database,
  FileText,
  GitBranch,
  GitFork,
  GitPullRequest,
  Globe,
  Landmark,
  MessageSquare,
  Palette,
  Search,
  Settings,
  Shield,
  Sparkles,
  SquareTerminal,
  Terminal,
  TicketCheck,
  RadioTower,
  Scale,
  FolderOpen,
  Wrench,
  MonitorSmartphone,
} from 'lucide-react';
import type { ChatLayout, Feature, UserRole } from '../../../shared/types';
import { ROLE_FEATURES } from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useChatContext } from '../../contexts/ChatContext';
import { getNextListboxIndex } from '../../utils/list-navigation';
import { slugForDomId } from '../../utils/dom-id';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Command {
  id: string;
  label: string;
  description?: string;
  section: string;
  icon: React.ReactNode;
  keywords?: string[];
  shortcut?: string;
  feature?: Feature;
  action: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  userRole: UserRole;
  onToggleTerminal: () => void;
  onCreateWorkspace: () => void;
}

const COMMAND_PALETTE_LIST_ID = 'command-palette-list';

export const looksLikeChatPrompt = (input: string) => {
  const trimmed = input.trim();
  return trimmed.length >= 3 && (/\s/.test(trimmed) || /[?!:]/.test(trimmed));
};

export function buildAskChatCommandMetadata(query: string, workspaceName?: string) {
  const trimmedQuery = query.trim();
  return {
    id: 'dynamic-ask-chat',
    label: `Ask Chat: ${trimmedQuery}`,
    description: workspaceName
      ? `Use ${workspaceName} as the working context.`
      : 'Start a focused chat from this command.',
    section: 'Ask',
    shortcut: 'Enter',
    keywords: ['ask', 'chat', trimmedQuery.toLowerCase()],
  };
}

export function buildNewChatThreadCommandMetadata() {
  return {
    id: 'act-new-chat',
    label: 'New Chat Thread',
    description: 'Start a clean conversation in Chat.',
    keywords: ['new', 'chat', 'thread', 'session', 'conversation'],
  };
}

export function buildToggleChatLayoutCommandMetadata(currentLayout: ChatLayout) {
  const nextLayout = currentLayout === 'workitems' ? 'classic' : 'workitems';
  return {
    id: 'act-toggle-chat-layout',
    label: nextLayout === 'workitems' ? 'Switch to Work-Item Chat' : 'Switch to Classic Chat',
    description:
      nextLayout === 'workitems'
        ? 'Use work items as the left-panel chat thread list.'
        : 'Use persona-grouped chat threads.',
    keywords: ['chat', 'layout', 'threads', 'work items', 'tickets', 'persona'],
    nextLayout,
  };
}

export function buildCommandPaletteOptionId(commandId: string): string {
  return `command-palette-option-${slugForDomId(commandId)}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CommandPalette({
  open,
  onClose,
  userRole,
  onToggleTerminal,
  onCreateWorkspace,
}: CommandPaletteProps) {
  const navigate = useNavigate();
  const { activeWorkspace } = useWorkspace();
  const { startNewSession } = useChatContext();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [chatLayout, setChatLayout] = useState<ChatLayout>('classic');
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const go = useCallback(
    (path: string) => {
      navigate(path);
      onClose();
    },
    [navigate, onClose],
  );

  const promptChat = useCallback(
    (prompt: string) => {
      navigate(`/chat?prompt=${encodeURIComponent(prompt)}`);
      onClose();
    },
    [navigate, onClose],
  );

  const toggleChatLayout = useCallback(async () => {
    const metadata = buildToggleChatLayoutCommandMetadata(chatLayout);
    setChatLayout(metadata.nextLayout);
    await window.anvil.settings.update({ chatLayout: metadata.nextLayout });
    window.dispatchEvent(
      new CustomEvent('anvil:chat-layout-changed', { detail: metadata.nextLayout }),
    );
    navigate('/chat');
    onClose();
  }, [chatLayout, navigate, onClose]);

  const commands = useMemo<Command[]>(
    () => [
      ...(activeWorkspace
        ? [
            {
              id: 'workspace-open-editor',
              label: `Open ${activeWorkspace.name} in Editor`,
              description: `${activeWorkspace.repos.length} repo${
                activeWorkspace.repos.length === 1 ? '' : 's'
              } in this workspace`,
              section: 'Workspace',
              icon: <FolderOpen size={16} />,
              feature: 'editor' as Feature,
              keywords: ['workspace', 'editor', 'code', 'ide', activeWorkspace.name.toLowerCase()],
              action: () => go('/editor'),
            },
            {
              id: 'workspace-review-changes',
              label: 'Review Current Workspace Changes',
              description: 'Ask Chat for bugs, regressions, missing tests, and risky assumptions.',
              section: 'Workspace',
              icon: <GitPullRequest size={16} />,
              feature: 'chat' as Feature,
              keywords: ['workspace', 'review', 'diff', 'changes', 'quality'],
              action: () =>
                promptChat(
                  'Review the current workspace changes. Prioritise correctness, regressions, missing tests, security risks, and developer workflow issues. Cite files and lines where possible.',
                ),
            },
            {
              id: 'workspace-dev-loop',
              label: 'Plan the Next Dev Loop',
              description: 'Ask for a practical inspect, edit, test sequence.',
              section: 'Workspace',
              icon: <Wrench size={16} />,
              feature: 'chat' as Feature,
              keywords: ['workspace', 'plan', 'next', 'dev loop', 'tests'],
              action: () =>
                promptChat(
                  'Look at this workspace like a senior developer. Identify the next highest-value improvement, the files likely involved, and the verification loop to prove it works.',
                ),
            },
          ]
        : []),

      // Navigation
      {
        id: 'nav-inbox',
        label: 'Go to Inbox',
        description: 'Review work that needs you and work still in progress.',
        section: 'Navigation',
        icon: <Bell size={16} />,
        feature: 'chat',
        keywords: ['inbox', 'attention', 'approval', 'failed', 'completed'],
        action: () => go('/inbox'),
      },
      {
        id: 'nav-repos',
        label: 'Go to Workspace',
        description: 'Connect, inspect, and index source repositories.',
        section: 'Navigation',
        icon: <Code size={16} />,
        feature: 'repos',
        keywords: ['repos', 'code'],
        action: () => go('/repos'),
      },
      {
        id: 'nav-chat',
        label: 'Go to Chat',
        description: 'Work with the active persona and attached repo context.',
        section: 'Navigation',
        icon: <MessageSquare size={16} />,
        feature: 'chat',
        keywords: ['chat', 'ai', 'conversation'],
        action: () => go('/chat'),
      },
      {
        id: 'nav-editor',
        label: 'Go to Editor',
        description: 'Inspect files and open the embedded IDE.',
        section: 'Navigation',
        icon: <SquareTerminal size={16} />,
        feature: 'editor',
        keywords: ['editor', 'inspect', 'code', 'ide'],
        action: () => go('/editor'),
      },
      {
        id: 'nav-automations',
        label: 'Go to Watchtower & schedules',
        description: 'Manage event-driven and scheduled background agent work.',
        section: 'Navigation',
        icon: <RadioTower size={16} />,
        feature: 'automations',
        keywords: ['automation', 'watchtower', 'schedule', 'daemon', 'agents'],
        action: () => go('/automations'),
      },
      {
        id: 'nav-workflows',
        label: 'Go to Workflows',
        description: 'Build and run reusable multi-step agent workflows.',
        section: 'Navigation',
        icon: <GitFork size={16} />,
        feature: 'workflows',
        keywords: ['automation', 'workflow', 'agents', 'graph'],
        action: () => go('/workflows'),
      },
      {
        id: 'nav-onboard',
        label: 'Go to Onboarding',
        section: 'Navigation',
        icon: <Compass size={16} />,
        feature: 'onboard',
        keywords: ['onboard', 'setup', 'wizard'],
        action: () => go('/onboard'),
      },
      {
        id: 'nav-db-insights',
        label: 'Go to DB Insights',
        description: 'Import database exports and analyze schemas.',
        section: 'Navigation',
        icon: <Database size={16} />,
        feature: 'dbinsights',
        keywords: ['database', 'db', 'schema', 'sql', 'insights'],
        action: () => go('/db-insights'),
      },
      {
        id: 'nav-workitems',
        label: 'Go to Work Items',
        section: 'Navigation',
        icon: <TicketCheck size={16} />,
        feature: 'workitems',
        keywords: ['work', 'items', 'tickets', 'ado', 'backlog'],
        action: () => go('/workitems'),
      },
      {
        id: 'nav-security',
        label: 'Go to Security',
        section: 'Navigation',
        icon: <Shield size={16} />,
        feature: 'security',
        keywords: ['security', 'audit', 'vulnerabilities'],
        action: () => go('/security'),
      },
      {
        id: 'nav-codereview',
        label: 'Go to Code Review',
        section: 'Navigation',
        icon: <GitPullRequest size={16} />,
        feature: 'codereview',
        keywords: ['code', 'review', 'pr'],
        action: () => go('/codereview'),
      },
      {
        id: 'nav-docs',
        label: 'Go to Documentation',
        section: 'Navigation',
        icon: <FileText size={16} />,
        feature: 'docs',
        keywords: ['docs', 'confluence', 'documentation'],
        action: () => go('/docs'),
      },
      {
        id: 'nav-adrs',
        label: 'Go to ADRs',
        section: 'Navigation',
        icon: <BookOpen size={16} />,
        feature: 'adrs',
        keywords: ['adr', 'architecture', 'decision', 'records'],
        action: () => go('/adrs'),
      },
      {
        id: 'nav-diagrams',
        label: 'Go to Diagrams',
        section: 'Navigation',
        icon: <GitFork size={16} />,
        feature: 'diagrams',
        keywords: ['diagrams', 'architecture', 'drawio'],
        action: () => go('/diagrams'),
      },
      {
        id: 'nav-governance',
        label: 'Go to Governance',
        section: 'Navigation',
        icon: <Landmark size={16} />,
        feature: 'governance',
        keywords: ['governance', 'boards', 'compliance'],
        action: () => go('/governance'),
      },
      {
        id: 'nav-browser',
        label: 'Go to Browser',
        section: 'Navigation',
        icon: <Globe size={16} />,
        feature: 'browser',
        keywords: ['browser', 'web', 'localhost', 'dev server'],
        action: () => go('/browser'),
      },
      {
        id: 'nav-argent',
        label: 'Go to Argent',
        description: 'Set up and operate Argent against the Expo companion app.',
        section: 'Navigation',
        icon: <MonitorSmartphone size={16} />,
        feature: 'argent',
        keywords: ['argent', 'expo', 'mobile', 'simulator', 'emulator', 'mcp'],
        action: () => go('/argent'),
      },
      {
        id: 'nav-git',
        label: 'Go to Git',
        description: 'Inspect branches, diffs, and repository status.',
        section: 'Navigation',
        icon: <GitBranch size={16} />,
        feature: 'git',
        keywords: ['git', 'branch', 'commit', 'diff', 'status'],
        action: () => go('/git'),
      },
      {
        id: 'nav-compliance',
        label: 'Go to Data & Compliance',
        section: 'Navigation',
        icon: <Scale size={16} />,
        feature: 'compliance',
        keywords: ['data', 'compliance', 'dpia', 'privacy', 'terms'],
        action: () => go('/compliance'),
      },
      {
        id: 'nav-settings',
        label: 'Go to Settings',
        section: 'Navigation',
        icon: <Settings size={16} />,
        shortcut: 'Cmd/Ctrl+,',
        keywords: ['settings', 'config', 'preferences'],
        action: () => go('/settings'),
      },

      // Actions
      {
        id: 'act-terminal',
        label: 'Toggle Terminal',
        description: 'Open the built-in terminal panel.',
        section: 'Actions',
        icon: <Terminal size={16} />,
        shortcut: 'Cmd/Ctrl+`',
        keywords: ['terminal', 'console', 'shell'],
        action: () => {
          onToggleTerminal();
          onClose();
        },
      },
      {
        id: 'act-workspace',
        label: 'Create Workspace',
        description: 'Group repositories into a focused working set.',
        section: 'Actions',
        icon: <Code size={16} />,
        keywords: ['workspace', 'new', 'create'],
        action: () => {
          onCreateWorkspace();
          onClose();
        },
      },
      {
        id: 'act-connect-repo',
        label: 'Connect Repository',
        section: 'Actions',
        icon: <Code size={16} />,
        feature: 'repos',
        keywords: ['connect', 'add', 'repository', 'repo'],
        action: () => go('/repos'),
      },
      {
        ...buildNewChatThreadCommandMetadata(),
        section: 'Actions',
        icon: <MessageSquare size={16} />,
        feature: 'chat',
        action: () => {
          navigate('/chat');
          onClose();
          void startNewSession();
        },
      },
      {
        ...buildToggleChatLayoutCommandMetadata(chatLayout),
        section: 'Actions',
        icon: <MessageSquare size={16} />,
        feature: 'chat',
        action: () => {
          void toggleChatLayout();
        },
      },
      {
        id: 'act-open-editor',
        label: 'Open Embedded Editor',
        description: 'Start from the active workspace and focused inspection pane.',
        section: 'Actions',
        icon: <SquareTerminal size={16} />,
        feature: 'editor',
        keywords: ['editor', 'inspect', 'browse', 'code'],
        action: () => go('/editor'),
      },
      {
        id: 'act-run-security',
        label: 'Run Security Audit',
        section: 'Actions',
        icon: <Shield size={16} />,
        feature: 'security',
        keywords: ['run', 'security', 'audit', 'scan'],
        action: () => go('/security'),
      },
      {
        id: 'act-run-review',
        label: 'Run Code Review',
        section: 'Actions',
        icon: <GitPullRequest size={16} />,
        feature: 'codereview',
        keywords: ['run', 'code', 'review'],
        action: () => go('/codereview'),
      },
      {
        id: 'act-db-import',
        label: 'Import DB Schema Exports',
        section: 'Actions',
        icon: <Database size={16} />,
        feature: 'dbinsights',
        keywords: ['database', 'db', 'sql', 'schema', 'import', 'ssms'],
        action: () => go('/db-insights'),
      },
      {
        id: 'act-create-diagram',
        label: 'Create Architecture Diagram',
        section: 'Actions',
        icon: <GitFork size={16} />,
        feature: 'diagrams',
        keywords: ['diagram', 'architecture', 'drawio', 'mermaid'],
        action: () => go('/diagrams'),
      },
      {
        id: 'act-open-browser',
        label: 'Inspect Running App',
        description: 'Open detected localhost apps in the embedded browser.',
        section: 'Actions',
        icon: <Globe size={16} />,
        feature: 'browser',
        keywords: ['browser', 'inspect', 'localhost', 'running app'],
        action: () => go('/browser'),
      },
      {
        id: 'act-open-argent',
        label: 'Inspect Expo App With Argent',
        description: 'Open Argent readiness, setup, and live-device prompt actions.',
        section: 'Actions',
        icon: <MonitorSmartphone size={16} />,
        feature: 'argent',
        keywords: ['argent', 'expo', 'mobile', 'simulator', 'profile', 'logs'],
        action: () => go('/argent'),
      },
      {
        id: 'act-gate-readiness',
        label: 'Check Governance Gate Readiness',
        section: 'Actions',
        icon: <Landmark size={16} />,
        feature: 'governance',
        keywords: ['governance', 'gate', 'readiness', 'approval'],
        action: () => go('/governance'),
      },

      // Prompt starters
      {
        id: 'prompt-repo-map',
        label: 'Prompt: Map this codebase',
        description: 'Get modules, entry points, data flow, and where to start.',
        section: 'Prompts',
        icon: <Sparkles size={16} />,
        feature: 'chat',
        keywords: ['prompt', 'repo', 'architecture', 'map', 'summary'],
        action: () =>
          promptChat(
            'Map this codebase for me. Summarise the major modules, runtime entry points, data flow, and the areas I should understand first.',
          ),
      },
      {
        id: 'prompt-implementation-plan',
        label: 'Prompt: Plan an implementation',
        description: 'Turn a vague change into files, risks, and a test loop.',
        section: 'Prompts',
        icon: <Sparkles size={16} />,
        feature: 'chat',
        keywords: ['prompt', 'plan', 'implementation', 'feature'],
        action: () =>
          promptChat(
            'Help me plan this implementation. Identify the files and layers likely to change, the risky assumptions, and a pragmatic sequence of edits and tests.',
          ),
      },
      {
        id: 'prompt-review-pragmatic',
        label: 'Prompt: Pragmatic code review',
        description: 'Bias toward bugs and production risk, not style theatre.',
        section: 'Prompts',
        icon: <GitPullRequest size={16} />,
        feature: 'chat',
        keywords: ['prompt', 'review', 'code quality', 'bugs'],
        action: () =>
          promptChat(
            'Review the current changes pragmatically. Focus on bugs, regressions, missing requirements, security risks, and test gaps. Avoid low-value style nitpicks.',
          ),
      },
      {
        id: 'prompt-security-owasp',
        label: 'Prompt: OWASP security pass',
        section: 'Prompts',
        icon: <Shield size={16} />,
        feature: 'chat',
        keywords: ['prompt', 'security', 'owasp', 'vulnerability'],
        action: () =>
          promptChat(
            'Run an OWASP-focused security pass on the relevant code. Call out concrete exploit paths, affected files, severity, and practical fixes.',
          ),
      },
      {
        id: 'prompt-ba-gaps',
        label: 'Prompt: Find requirement gaps',
        section: 'Prompts',
        icon: <TicketCheck size={16} />,
        feature: 'chat',
        keywords: ['prompt', 'requirements', 'ba', 'gaps', 'work items'],
        action: () =>
          promptChat(
            'Analyse the current requirement or work item context. Identify ambiguity, missing acceptance criteria, dependencies, risks, and questions to resolve before build.',
          ),
      },
      {
        id: 'prompt-design-polish',
        label: 'Prompt: UI polish review',
        description: 'Review hierarchy, accessibility, responsiveness, and friction.',
        section: 'Prompts',
        icon: <Palette size={16} />,
        feature: 'chat',
        keywords: ['prompt', 'design', 'ui', 'accessibility', 'polish'],
        action: () =>
          promptChat(
            'Review this UI for usability, visual hierarchy, accessibility, responsive behavior, and workflow friction. Prioritise changes that materially improve the experience.',
          ),
      },
    ],
    [
      activeWorkspace,
      go,
      navigate,
      onClose,
      onCreateWorkspace,
      onToggleTerminal,
      promptChat,
      startNewSession,
      chatLayout,
      toggleChatLayout,
    ],
  );

  // Filter by role and query
  const filtered = useMemo(() => {
    const allowed = commands.filter(
      (cmd) => !cmd.feature || ROLE_FEATURES[userRole].includes(cmd.feature),
    );
    if (!query.trim()) return allowed;

    const q = query.toLowerCase();
    const matches = allowed.filter((cmd) => {
      const haystack = [cmd.label, cmd.description, cmd.section, ...(cmd.keywords ?? [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });

    const trimmedQuery = query.trim();
    const chatAvailable = ROLE_FEATURES[userRole].includes('chat');
    if (chatAvailable && (looksLikeChatPrompt(trimmedQuery) || matches.length === 0)) {
      const askChatCommand = buildAskChatCommandMetadata(trimmedQuery, activeWorkspace?.name);
      return [
        {
          ...askChatCommand,
          icon: <MessageSquare size={16} />,
          feature: 'chat' as Feature,
          action: () => promptChat(trimmedQuery),
        },
        ...matches,
      ];
    }

    return matches;
  }, [activeWorkspace, commands, promptChat, query, userRole]);

  // Group by section
  const sections = useMemo(() => {
    const map = new Map<string, Command[]>();
    for (const cmd of filtered) {
      if (!map.has(cmd.section)) map.set(cmd.section, []);
      map.get(cmd.section)!.push(cmd);
    }
    return map;
  }, [filtered]);

  // Reset on open/close
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
      window.anvil.settings
        .get()
        .then((settings) => setChatLayout(settings.chatLayout ?? 'classic'))
        .catch(console.error);
    }
  }, [open]);

  useEffect(() => {
    const handleLayoutChanged = (event: Event) => {
      const nextLayout = (event as CustomEvent<ChatLayout>).detail;
      if (nextLayout === 'classic' || nextLayout === 'workitems') {
        setChatLayout(nextLayout);
      }
    };

    window.addEventListener('anvil:chat-layout-changed', handleLayoutChanged);
    return () => window.removeEventListener('anvil:chat-layout-changed', handleLayoutChanged);
  }, []);

  // Keep selection in bounds
  useEffect(() => {
    if (selectedIndex >= filtered.length) setSelectedIndex(Math.max(0, filtered.length - 1));
  }, [filtered.length, selectedIndex]);

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
        case 'ArrowUp':
        case 'Home':
        case 'End':
          e.preventDefault();
          setSelectedIndex((index) => getNextListboxIndex(e.key, index, filtered.length) ?? index);
          break;
        case 'Enter':
          e.preventDefault();
          filtered[selectedIndex]?.action();
          break;
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
      }
    },
    [filtered, selectedIndex, onClose],
  );

  if (!open) return null;

  let flatIndex = 0;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]" onClick={onClose}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" />

      {/* Palette */}
      <div
        className="relative w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-bg-elevated shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 border-b border-border bg-bg-secondary/70 px-4 py-3">
          <Search size={16} className="shrink-0 text-text-tertiary" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            placeholder="Search commands, workflows, prompts..."
            role="combobox"
            aria-label="Search commands"
            aria-autocomplete="list"
            aria-expanded={filtered.length > 0}
            aria-controls={COMMAND_PALETTE_LIST_ID}
            aria-activedescendant={
              filtered[selectedIndex]
                ? buildCommandPaletteOptionId(filtered[selectedIndex].id)
                : undefined
            }
            className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none"
          />
          <kbd className="rounded border border-border-subtle bg-bg-tertiary px-1.5 py-0.5 text-xs text-text-tertiary">
            esc
          </kbd>
        </div>

        {/* Command list */}
        <div
          id={COMMAND_PALETTE_LIST_ID}
          ref={listRef}
          className="max-h-[58vh] overflow-auto p-2"
          role="listbox"
          aria-label="Command palette results"
        >
          {filtered.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-text-tertiary">
              No commands match &ldquo;{query}&rdquo;
            </p>
          )}

          {Array.from(sections.entries()).map(([section, cmds]) => (
            <div key={section}>
              <div className="flex items-center justify-between px-3 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-text-tertiary">
                {section}
                <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] normal-case tracking-normal text-text-muted">
                  {cmds.length}
                </span>
              </div>
              {cmds.map((cmd) => {
                const idx = flatIndex++;
                return (
                  <button
                    id={buildCommandPaletteOptionId(cmd.id)}
                    key={cmd.id}
                    data-index={idx}
                    role="option"
                    aria-selected={idx === selectedIndex}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    onClick={cmd.action}
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors ${
                      idx === selectedIndex
                        ? 'bg-accent/15 text-text-primary'
                        : 'text-text-primary hover:bg-bg-tertiary'
                    }`}
                  >
                    <span
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${
                        idx === selectedIndex
                          ? 'border-accent/30 bg-accent/10 text-accent'
                          : 'border-border-subtle bg-bg-secondary text-text-tertiary'
                      }`}
                    >
                      {cmd.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{cmd.label}</span>
                      {cmd.description && (
                        <span className="mt-0.5 block truncate text-xs text-text-tertiary">
                          {cmd.description}
                        </span>
                      )}
                    </span>
                    {cmd.shortcut && (
                      <kbd className="shrink-0 rounded border border-border-subtle bg-bg-tertiary px-1.5 py-0.5 text-[10px] text-text-tertiary">
                        {cmd.shortcut}
                      </kbd>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Footer hint */}
        <div className="flex items-center gap-4 border-t border-border-subtle px-4 py-2 text-xs text-text-tertiary">
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border-subtle bg-bg-tertiary px-1 py-0.5">
              &uarr;
            </kbd>
            <kbd className="rounded border border-border-subtle bg-bg-tertiary px-1 py-0.5">
              &darr;
            </kbd>
            navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-border-subtle bg-bg-tertiary px-1 py-0.5">
              &crarr;
            </kbd>
            select
          </span>
        </div>
      </div>
    </div>
  );
}
