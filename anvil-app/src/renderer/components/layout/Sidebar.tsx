import { useLocation, useNavigate } from 'react-router-dom';
import {
  Code,
  Cloud,
  Database,
  MessageSquare,
  Compass,
  TicketCheck,
  Shield,
  GitPullRequest,
  FileText,
  BookOpen,
  Settings,
  GitFork,
  Landmark,
  Globe,
  GitBranch,
  Scale,
  SquareTerminal,
  ChevronLeft,
  ChevronRight,
  Bot,
  Activity,
  Boxes,
  Workflow,
  NotebookPen,
  StickyNote,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useBrand } from '../../contexts/BrandContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { RunButton } from './RunButton';
import { AnvilLogo } from '../brand/AnvilLogo';
import type { UserRole, Feature } from '../../../shared/types';
import { ROLE_FEATURES } from '../../../shared/types';
import { useStoredPanelState } from '../../hooks/useStoredPanelState';

interface NavItem {
  path: string;
  label: string;
  icon: ReactNode;
  feature: Feature;
  requiresRepoFeature?: boolean;
  requiresChat?: boolean;
}

const navItems: NavItem[] = [
  { path: '/repos', label: 'Repositories', icon: <Code size={20} />, feature: 'repos' },
  {
    path: '/chat',
    label: 'Chat',
    icon: <MessageSquare size={20} />,
    feature: 'chat',
    requiresChat: true,
  },
  {
    path: '/meeting-notes',
    label: 'Meeting Notes',
    icon: <NotebookPen size={20} />,
    feature: 'meeting-notes',
  },
  {
    path: '/workspace-notes',
    label: 'Workspace Notes',
    icon: <StickyNote size={20} />,
    feature: 'workspace-notes',
  },
  {
    path: '/editor',
    label: 'Editor',
    icon: <SquareTerminal size={20} />,
    feature: 'editor',
    requiresRepoFeature: true,
  },
  {
    path: '/automations',
    label: 'Automations',
    icon: <Bot size={20} />,
    feature: 'automations',
  },
  {
    path: '/db-insights',
    label: 'DB Insights',
    icon: <Database size={20} />,
    feature: 'dbinsights',
  },
  {
    path: '/onboard',
    label: 'Onboarding',
    icon: <Compass size={20} />,
    feature: 'onboard',
    requiresRepoFeature: true,
  },
  {
    path: '/workitems',
    label: 'Work Items',
    icon: <TicketCheck size={20} />,
    feature: 'workitems',
  },
  {
    path: '/dependencies',
    label: 'Dependencies',
    icon: <Boxes size={20} />,
    feature: 'dependencies',
    requiresRepoFeature: true,
  },
  {
    path: '/security',
    label: 'Security',
    icon: <Shield size={20} />,
    feature: 'security',
    requiresRepoFeature: true,
  },
  {
    path: '/codereview',
    label: 'Code Review',
    icon: <GitPullRequest size={20} />,
    feature: 'codereview',
    requiresRepoFeature: true,
  },
  {
    path: '/cicd',
    label: 'CI/CD',
    icon: <Workflow size={20} />,
    feature: 'cicd',
    requiresRepoFeature: true,
  },
  {
    path: '/cloud',
    label: 'Cloud',
    icon: <Cloud size={20} />,
    feature: 'cloud',
    requiresRepoFeature: true,
  },
  { path: '/docs', label: 'Documentation', icon: <FileText size={20} />, feature: 'docs' },
  {
    path: '/adrs',
    label: 'ADRs',
    icon: <BookOpen size={20} />,
    feature: 'adrs',
    requiresRepoFeature: true,
  },
  {
    path: '/diagrams',
    label: 'Diagrams',
    icon: <GitFork size={20} />,
    feature: 'diagrams',
    requiresRepoFeature: true,
  },
  { path: '/governance', label: 'Governance', icon: <Landmark size={20} />, feature: 'governance' },
  {
    path: '/browser',
    label: 'Browser',
    icon: <Globe size={20} />,
    feature: 'browser',
    requiresRepoFeature: true,
  },
  {
    path: '/git',
    label: 'Git',
    icon: <GitBranch size={20} />,
    feature: 'git',
    requiresRepoFeature: true,
  },
  {
    path: '/compliance',
    label: 'Data & Compliance',
    icon: <Scale size={20} />,
    feature: 'compliance',
    requiresRepoFeature: true,
  },
];

interface SidebarProps {
  connectionStatus: {
    foundry: boolean | null;
    ado: boolean | null;
    confluence: boolean | null;
  };
  userRole: UserRole;
  cloudFeaturesEnabled: boolean;
  reserveTitlebarSpace?: boolean;
}

export function Sidebar({
  connectionStatus,
  userRole,
  cloudFeaturesEnabled,
  reserveTitlebarSpace = true,
}: SidebarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const brand = useBrand();
  const { activeWorkspace, featureAvailability } = useWorkspace();
  const { width, setWidth, collapsed, toggleCollapsed } = useStoredPanelState({
    storageKey: 'layout:main-sidebar:v2',
    defaultWidth: 252,
    minWidth: 224,
    maxWidth: 340,
  });

  const statusLabel =
    featureAvailability.statusLabel === 'scaffolding'
      ? 'Scaffolding'
      : featureAvailability.statusLabel === 'indexing'
        ? 'Indexing'
        : featureAvailability.statusLabel === 'empty'
          ? 'Empty'
          : 'Ready';

  const handleResizeStart = (event: React.MouseEvent<HTMLDivElement>) => {
    if (collapsed) return;

    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handleMouseMove = (moveEvent: MouseEvent) => {
      setWidth(startWidth + (moveEvent.clientX - startX));
    };

    const handleMouseUp = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  return (
    <aside
      className="relative flex h-full min-h-0 shrink-0 flex-col bg-bg-secondary transition-[width] duration-200"
      style={{ width: collapsed ? 88 : width }}
    >
      {/* Titlebar drag region — clears macOS traffic lights outside fullscreen. */}
      {reserveTitlebarSpace && <div className="titlebar-drag h-14" />}

      {/* Border starts below the traffic lights */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-r border-border">
        {/* Branding */}
        <div className={`${collapsed ? 'px-3 pb-4' : 'px-5 pb-5'} shrink-0 pt-2.5`}>
          <div className={`flex items-center ${collapsed ? 'justify-center' : 'justify-between'}`}>
            <div className={`flex min-w-0 items-center ${collapsed ? '' : 'gap-3'}`}>
              <AnvilLogo size={collapsed ? 42 : 46} showGlow />
              {!collapsed && (
                <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight text-accent">
                  <BrandName name={brand.appName} collapsed={collapsed} />
                </h1>
              )}
            </div>
            {!collapsed && (
              <button
                onClick={toggleCollapsed}
                className="titlebar-no-drag rounded-lg p-1.5 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                title="Collapse sidebar"
                aria-label="Collapse sidebar"
              >
                <ChevronLeft size={14} />
              </button>
            )}
          </div>
          {!collapsed && <p className="mt-1 text-sm text-text-secondary">{brand.subtitle}</p>}
          {collapsed && (
            <button
              onClick={toggleCollapsed}
              className="titlebar-no-drag mt-3 flex w-full items-center justify-center rounded-lg border border-border-subtle px-2 py-2 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
              title="Expand sidebar"
              aria-label="Expand sidebar"
            >
              <ChevronRight size={14} />
            </button>
          )}
        </div>

        {/* Active Workspace */}
        {!collapsed && (
          <div className="shrink-0 border-b border-border-subtle px-5 pb-4">
            <div className="flex items-center gap-2">
              <div className="text-base font-semibold text-text-primary">
                {activeWorkspace?.name ?? 'No workspace selected'}
              </div>
              {activeWorkspace && (
                <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] uppercase tracking-wide text-text-tertiary">
                  {statusLabel}
                </span>
              )}
            </div>
            <div className="mt-1 text-sm leading-relaxed text-text-secondary">
              {activeWorkspace
                ? `${activeWorkspace.repos.length} repositories`
                : 'Open a link or create a workspace'}
            </div>
            {activeWorkspace && featureAvailability.repoFeatureReason && (
              <div className="mt-2 text-xs leading-relaxed text-text-tertiary">
                {featureAvailability.repoFeatureReason}
              </div>
            )}
          </div>
        )}

        {/* Run Button */}
        <div className="shrink-0">
          <RunButton compact={collapsed} />
        </div>

        {/* Navigation */}
        <div className="min-h-0 flex-1 px-3 py-3">
          <nav className="h-full overflow-y-auto pr-1">
            <div className="flex flex-col gap-1">
              {navItems
                .filter(
                  (item) =>
                    ROLE_FEATURES[userRole].includes(item.feature) &&
                    (item.feature !== 'cloud' || cloudFeaturesEnabled),
                )
                .map((item) => {
                  const active = location.pathname.startsWith(item.path);
                  const disabled = item.requiresChat
                    ? !featureAvailability.chatEnabled
                    : item.requiresRepoFeature
                      ? !featureAvailability.repoFeaturesEnabled
                      : false;
                  return (
                    <button
                      key={item.path}
                      onClick={() => {
                        if (!disabled) navigate(item.path);
                      }}
                      disabled={disabled}
                      className={`titlebar-no-drag flex w-full items-center rounded-lg border py-3 text-base font-medium transition-colors ${
                        active
                          ? 'border-accent/35 bg-accent/12 text-text-primary shadow-[0_0_0_1px_var(--color-accent-glow)]'
                          : disabled
                            ? 'cursor-not-allowed border-transparent text-text-tertiary opacity-50'
                            : 'border-transparent text-text-secondary hover:border-border hover:bg-bg-tertiary hover:text-text-primary'
                      } ${collapsed ? 'justify-center px-2.5' : 'gap-3 px-3.5'}`}
                      aria-label={item.label}
                      title={disabled ? featureAvailability.repoFeatureReason : item.label}
                    >
                      {item.icon}
                      {!collapsed && <span className="truncate">{item.label}</span>}
                    </button>
                  );
                })}
            </div>
          </nav>
        </div>

        {/* Footer — connection status + settings */}
        <div className="shrink-0 border-t border-border-subtle p-4">
          <div className={`${collapsed ? 'space-y-3' : 'space-y-2'} text-sm`}>
            <StatusDot label="Foundry" status={connectionStatus.foundry} compact={collapsed} />
            <StatusDot label="ADO" status={connectionStatus.ado} compact={collapsed} />
            <StatusDot
              label="Confluence"
              status={connectionStatus.confluence}
              compact={collapsed}
            />
          </div>
          <button
            onClick={() => navigate('/settings')}
            className={`titlebar-no-drag mt-4 flex w-full items-center rounded-lg border py-2.5 text-sm font-medium transition-colors ${
              location.pathname.startsWith('/settings')
                ? 'border-accent/30 bg-accent/10 text-text-primary'
                : 'border-border-subtle text-text-secondary hover:border-border hover:bg-bg-tertiary hover:text-text-primary'
            } ${collapsed ? 'justify-center px-2' : 'gap-2 px-3'}`}
            aria-label="Settings"
            title="Settings"
          >
            <Settings size={16} />
            {!collapsed && 'Settings'}
          </button>
          <button
            onClick={() => navigate('/diagnostics')}
            className={`titlebar-no-drag mt-2 flex w-full items-center rounded-lg border py-2.5 text-sm font-medium transition-colors ${
              location.pathname.startsWith('/diagnostics')
                ? 'border-accent/30 bg-accent/10 text-text-primary'
                : 'border-border-subtle text-text-secondary hover:border-border hover:bg-bg-tertiary hover:text-text-primary'
            } ${collapsed ? 'justify-center px-2' : 'gap-2 px-3'}`}
            aria-label="Diagnostics"
            title="Diagnostics"
          >
            <Activity size={16} />
            {!collapsed && 'Diagnostics'}
          </button>
        </div>
      </div>
      {/* end border wrapper */}

      {!collapsed && (
        <div
          onMouseDown={handleResizeStart}
          className="absolute -right-1 bottom-0 top-0 z-10 w-2 cursor-col-resize"
          aria-hidden="true"
        >
          <div className="mx-auto h-full w-px bg-border/50 transition-colors hover:bg-accent" />
        </div>
      )}
    </aside>
  );
}

function StatusDot({
  label,
  status,
  compact = false,
}: {
  label: string;
  status: boolean | null;
  compact?: boolean;
}) {
  const colour =
    status === true ? 'bg-success' : status === false ? 'bg-error' : 'bg-text-tertiary';
  return (
    <div className={`flex items-center ${compact ? 'justify-center' : 'gap-2'}`} title={label}>
      <span className={`inline-block h-2.5 w-2.5 rounded-full ${colour}`} />
      {!compact && <span className="text-sm text-text-secondary">{label}</span>}
    </div>
  );
}

function BrandName({ name, collapsed = false }: { name: string; collapsed?: boolean }) {
  if (collapsed) return <>{name.slice(0, 3)}</>;
  return <>{name}</>;
}
