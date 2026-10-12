import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShortcuts } from '../../hooks/useShortcuts';
import { formatShortcut, shortcutFor } from '../../utils/shortcuts';
import { useNavigate } from 'react-router-dom';
import {
  BookOpen,
  Activity,
  Bell,
  Boxes,
  Code,
  Cloud,
  Compass,
  Database,
  FileDiff,
  FileText,
  FolderMinus,
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
  NotebookPen,
  StickyNote,
  Target,
  Workflow,
} from 'lucide-react';
import type { ChatLayout, Feature, UserRole } from '../../../shared/types';
import { ROLE_FEATURES } from '../../../shared/types';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useChatContext } from '../../contexts/ChatContext';
import { getNextListboxIndex } from '../../utils/list-navigation';
import { slugForDomId } from '../../utils/dom-id';
import { isEditableShortcutTarget } from '../../utils/keyboard';
import { getSidebarNavigationEntries, navItemGateReason } from '../../utils/sidebar-navigation';

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
  recent?: boolean;
  action: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  userRole: UserRole;
  onToggleTerminal: () => void;
  onCreateWorkspace: () => void;
  cloudFeaturesEnabled: boolean;
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
  const nextLayout: ChatLayout = currentLayout === 'workitems' ? 'classic' : 'workitems';
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

interface SearchablePaletteCommand {
  label: string;
  description?: string;
  section: string;
  keywords?: string[];
  recent?: boolean;
}

export function filterCommandPaletteCommands<T extends SearchablePaletteCommand>(
  commands: T[],
  query: string,
): T[] {
  const trimmedQuery = query.trim().toLowerCase();
  const candidates = trimmedQuery
    ? commands
    : (() => {
        let recentThreads = 0;
        return commands.filter((command) => {
          if (command.section !== 'Threads') return true;
          if (!command.recent || recentThreads >= 8) return false;
          recentThreads += 1;
          return true;
        });
      })();

  if (!trimmedQuery) return candidates;
  return candidates.filter((command) =>
    [command.label, command.description, command.section, ...(command.keywords ?? [])]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(trimmedQuery),
  );
}

export function groupPaletteCommands<T extends { section: string }>(commands: T[]) {
  const groups = new Map<string, T[]>();
  for (const command of commands) {
    const group = groups.get(command.section);
    if (group) group.push(command);
    else groups.set(command.section, [command]);
  }
  return Array.from(groups, ([section, items]) => ({ section, items }));
}

function navigationIconForPath(path: string): React.ReactNode {
  const icons: Record<string, React.ReactNode> = {
    '/inbox': <Bell size={16} />,
    '/chat': <MessageSquare size={16} />,
    '/workspace': <Code size={16} />,
    '/automations': <RadioTower size={16} />,
    '/workflows': <GitFork size={16} />,
    '/dojo': <Target size={16} />,
    '/workitems': <TicketCheck size={16} />,
    '/editor': <SquareTerminal size={16} />,
    '/browser': <Globe size={16} />,
    '/onboard': <Compass size={16} />,
    '/argent': <MonitorSmartphone size={16} />,
    '/review': <FileDiff size={16} />,
    '/codereview': <GitPullRequest size={16} />,
    '/cicd': <Workflow size={16} />,
    '/git': <GitBranch size={16} />,
    '/cloud': <Cloud size={16} />,
    '/db-insights': <Database size={16} />,
    '/dependencies': <Boxes size={16} />,
    '/security': <Shield size={16} />,
    '/meeting-notes': <NotebookPen size={16} />,
    '/workspace-notes': <StickyNote size={16} />,
    '/docs': <FileText size={16} />,
    '/adrs': <BookOpen size={16} />,
    '/diagrams': <GitFork size={16} />,
    '/governance': <Landmark size={16} />,
    '/compliance': <Scale size={16} />,
    '/settings': <Settings size={16} />,
    '/diagnostics': <Activity size={16} />,
  };
  return icons[path] ?? <Compass size={16} />;
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
  cloudFeaturesEnabled,
}: CommandPaletteProps) {
  const navigate = useNavigate();
  const { overrides: shortcuts } = useShortcuts();
  const { activeWorkspace, workspaces, switchWorkspace, removeRepos, featureAvailability } =
    useWorkspace();
  const { threads, startTemporaryChat } = useChatContext();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [chatLayout, setChatLayout] = useState<ChatLayout>('classic');
  // WS4: two-step "Remove repository" picker — null = normal command mode.
  const [repoRemoval, setRepoRemoval] = useState<{ confirmRepoId?: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // ⌃1–9 switches workspaces from anywhere in the shell (WS4). The palette is
  // always mounted, so the listener lives here even when the palette is closed.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (event.key < '1' || event.key > '9') return;
      if (isEditableShortcutTarget(event.target)) return;
      const workspace = workspaces[Number(event.key) - 1];
      if (!workspace || workspace.id === activeWorkspace?.id) return;
      event.preventDefault();
      void switchWorkspace(workspace.id);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [workspaces, activeWorkspace?.id, switchWorkspace]);

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

      // Switch workspace (WS4) — ⌃1–9 matches the WorkspaceRail order.
      ...workspaces.map((workspace) => {
        const position = workspaces.indexOf(workspace) + 1;
        const isActive = workspace.id === activeWorkspace?.id;
        return {
          id: `workspace-switch-${workspace.id}`,
          label: `Switch to ${workspace.name}`,
          description: isActive
            ? 'Current workspace'
            : `${workspace.repoCount} repo${workspace.repoCount === 1 ? '' : 's'}`,
          section: 'Workspace',
          icon: <FolderOpen size={16} />,
          shortcut: position <= 9 ? `Ctrl+${position}` : undefined,
          keywords: ['workspace', 'switch', workspace.name.toLowerCase()],
          action: () => {
            if (!isActive) void switchWorkspace(workspace.id);
            onClose();
          },
        };
      }),

      // Thread commands remain searchable across the full thread history.
      ...[...threads]
        .sort(
          (a, b) =>
            Number(!!a.settledAt) - Number(!!b.settledAt) ||
            dateValueForSort(b.lastMessageAt ?? b.updatedAt) -
              dateValueForSort(a.lastMessageAt ?? a.updatedAt),
        )
        .map((thread) => ({
          id: `thread-${thread.id}`,
          label: `Jump to thread: ${thread.title}`,
          description: thread.preview || 'Open this conversation in Chat.',
          section: 'Threads',
          icon: <MessageSquare size={16} />,
          feature: 'chat' as Feature,
          recent: !thread.settledAt,
          keywords: ['thread', 'chat', 'jump', thread.title.toLowerCase()],
          action: () =>
            go(
              `/chat?thread=${encodeURIComponent(thread.id)}&persona=${encodeURIComponent(thread.personaId)}`,
            ),
        })),

      // Navigation comes from the same catalog as the sidebar.
      ...getSidebarNavigationEntries(userRole, cloudFeaturesEnabled).map(({ item, section }) => ({
        id: `nav-${item.path.slice(1).replaceAll('/', '-')}`,
        label: `Go to ${item.label}`,
        description: navItemGateReason(item, featureAvailability) ?? item.description,
        section,
        icon: navigationIconForPath(item.path),
        shortcut:
          item.path === '/settings'
            ? formatShortcut(shortcutFor('settings', shortcuts), navigator.platform.includes('Mac'))
            : undefined,
        feature: item.feature,
        keywords: [
          item.path.slice(1).replaceAll('-', ' '),
          item.label.toLowerCase(),
          ...(item.keywords ?? []),
        ],
        action: () => go(item.path),
      })),
      // Actions
      {
        id: 'act-terminal',
        label: 'Toggle Terminal',
        description: 'Open the built-in terminal panel.',
        section: 'Actions',
        icon: <Terminal size={16} />,
        shortcut: formatShortcut(
          shortcutFor('terminal', shortcuts),
          navigator.platform.includes('Mac'),
        ),
        keywords: ['terminal', 'console', 'shell'],
        action: () => {
          onToggleTerminal();
          onClose();
        },
      },
      {
        id: 'act-workspace',
        shortcut: formatShortcut(
          shortcutFor('newWorkspace', shortcuts),
          navigator.platform.includes('Mac'),
        ),
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
        action: () => go('/workspace'),
      },
      ...(activeWorkspace && activeWorkspace.repos.length > 0
        ? [
            {
              id: 'act-remove-repo',
              label: 'Remove Repository from Workspace…',
              description: `Detach a repository from ${activeWorkspace.name}.`,
              section: 'Actions',
              icon: <FolderMinus size={16} />,
              feature: 'repos' as Feature,
              keywords: ['remove', 'detach', 'repository', 'repo', 'workspace'],
              action: () => {
                setQuery('');
                setSelectedIndex(0);
                setRepoRemoval({});
              },
            },
          ]
        : []),
      {
        ...buildNewChatThreadCommandMetadata(),
        shortcut: formatShortcut(
          shortcutFor('newThread', shortcuts),
          navigator.platform.includes('Mac'),
        ),
        section: 'Actions',
        icon: <MessageSquare size={16} />,
        feature: 'chat',
        action: () => {
          navigate('/chat', { state: { newThreadRequest: crypto.randomUUID() } });
          onClose();
        },
      },
      {
        id: 'act-temporary-chat',
        label: 'Start Temporary Chat',
        description: 'Start a session that ends when Anvil closes, without workspace context.',
        section: 'Actions',
        icon: <MessageSquare size={16} />,
        feature: 'chat',
        keywords: ['temporary', 'ephemeral', 'private', 'no workspace', 'new chat'],
        action: () => {
          void (async () => {
            await startTemporaryChat();
            navigate('/chat?temporary=1');
            onClose();
          })();
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
        label: 'Run PR Review',
        section: 'Actions',
        icon: <GitPullRequest size={16} />,
        feature: 'codereview',
        keywords: ['run', 'code', 'review', 'pr', 'pull request'],
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
      workspaces,
      switchWorkspace,
      threads,
      cloudFeaturesEnabled,
      featureAvailability,
      go,
      navigate,
      onClose,
      onCreateWorkspace,
      shortcuts,
      onToggleTerminal,
      promptChat,
      chatLayout,
      toggleChatLayout,
      startTemporaryChat,
    ],
  );

  // Repo-removal picker commands (WS4): step one picks a repo, step two
  // confirms. The actual removal goes through WorkspaceContext.removeRepos.
  const pickerCommands = useMemo<Command[]>(() => {
    if (!repoRemoval || !activeWorkspace) return [];

    if (repoRemoval.confirmRepoId) {
      const repo = activeWorkspace.repos.find((r) => r.id === repoRemoval.confirmRepoId);
      if (!repo) return [];
      return [
        {
          id: `remove-repo-confirm-${repo.id}`,
          label: `Remove ${repo.name} from ${activeWorkspace.name}`,
          description:
            'The repository stays connected in Anvil; it is only detached from this workspace.',
          section: 'Confirm removal',
          icon: <FolderMinus size={16} />,
          action: () => {
            void removeRepos([repo.id]);
            setRepoRemoval(null);
            onClose();
          },
        },
        {
          id: 'remove-repo-cancel',
          label: 'Keep repository',
          section: 'Confirm removal',
          icon: <Code size={16} />,
          action: () => {
            setRepoRemoval({});
            setSelectedIndex(0);
          },
        },
      ];
    }

    return activeWorkspace.repos.map((repo) => ({
      id: `remove-repo-${repo.id}`,
      label: `Remove ${repo.name}`,
      description: repo.path,
      section: 'Remove repository',
      icon: <FolderMinus size={16} />,
      keywords: ['remove', 'repo', repo.name.toLowerCase()],
      action: () => {
        setRepoRemoval({ confirmRepoId: repo.id });
        setQuery('');
        setSelectedIndex(0);
      },
    }));
  }, [repoRemoval, activeWorkspace, removeRepos, onClose]);

  // Filter by role and query
  const filtered = useMemo(() => {
    const allowed = (repoRemoval ? pickerCommands : commands).filter(
      (cmd) => !cmd.feature || ROLE_FEATURES[userRole].includes(cmd.feature),
    );
    const matches = filterCommandPaletteCommands(allowed, query);
    if (!query.trim()) return matches;
    if (repoRemoval) return matches;

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
  }, [activeWorkspace, commands, pickerCommands, promptChat, query, repoRemoval, userRole]);

  // Group by section
  const sections = useMemo(() => groupPaletteCommands(filtered), [filtered]);
  const orderedCommands = useMemo(() => sections.flatMap((section) => section.items), [sections]);

  // Reset on open/close
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
      setRepoRemoval(null);
      requestAnimationFrame(() => inputRef.current?.focus());
      window.anvil.settings
        .get()
        .then((settings) => setChatLayout(settings.chatLayout ?? 'classic'))
        .catch(console.error);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement;
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus();
      }
    };
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
    if (selectedIndex >= orderedCommands.length) {
      setSelectedIndex(Math.max(0, orderedCommands.length - 1));
    }
  }, [orderedCommands.length, selectedIndex]);

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'Tab': {
          const focusable = Array.from(
            dialogRef.current?.querySelectorAll<HTMLElement>(
              'input:not([disabled]), button:not([disabled]):not([tabindex="-1"])',
            ) ?? [],
          );
          if (focusable.length === 0) break;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
          break;
        }
        case 'ArrowDown':
        case 'ArrowUp':
        case 'Home':
        case 'End':
          e.preventDefault();
          setSelectedIndex(
            (index) => getNextListboxIndex(e.key, index, orderedCommands.length) ?? index,
          );
          break;
        case 'Enter':
          e.preventDefault();
          orderedCommands[selectedIndex]?.action();
          break;
        case 'Escape':
          e.preventDefault();
          if (repoRemoval) {
            setRepoRemoval(null);
            setQuery('');
            setSelectedIndex(0);
          } else {
            onClose();
          }
          break;
      }
    },
    [orderedCommands, selectedIndex, onClose, repoRemoval],
  );

  if (!open) return null;

  let flatIndex = 0;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]" onClick={onClose}>
      {/* Backdrop */}
      <div className="absolute inset-0 bg-scrim" />

      {/* Palette */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
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
            placeholder={
              repoRemoval
                ? repoRemoval.confirmRepoId
                  ? 'Confirm removal…'
                  : 'Remove which repository from this workspace?'
                : 'Search commands, workflows, prompts...'
            }
            role="combobox"
            aria-label="Search commands"
            aria-autocomplete="list"
            aria-expanded={filtered.length > 0}
            aria-controls={COMMAND_PALETTE_LIST_ID}
            aria-activedescendant={
              orderedCommands[selectedIndex]
                ? buildCommandPaletteOptionId(orderedCommands[selectedIndex].id)
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

          {sections.map(({ section, items }) => (
            <div key={section}>
              <div className="flex items-center justify-between px-3 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-text-tertiary">
                {section}
                <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-xs normal-case tracking-normal text-text-muted">
                  {items.length}
                </span>
              </div>
              {items.map((cmd) => {
                const idx = flatIndex++;
                return (
                  <button
                    id={buildCommandPaletteOptionId(cmd.id)}
                    key={cmd.id}
                    data-index={idx}
                    tabIndex={-1}
                    role="option"
                    aria-selected={idx === selectedIndex}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    onFocus={() => setSelectedIndex(idx)}
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
                      <kbd className="shrink-0 rounded border border-border-subtle bg-bg-tertiary px-1.5 py-0.5 text-eyebrow text-text-tertiary">
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

function dateValueForSort(value?: string): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}
