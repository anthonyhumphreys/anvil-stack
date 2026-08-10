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
  MonitorSmartphone,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useBrand } from '../../contexts/BrandContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { RunButton } from './RunButton';
import { AnvilLogo } from '../brand/AnvilLogo';
import type { UserRole, Feature } from '../../../shared/types';
import { ROLE_FEATURES } from '../../../shared/types';
import { useStoredPanelState } from '../../hooks/useStoredPanelState';
import {
  SidebarActivityBadge,
  SidebarActivityCenter,
  useSidebarActivity,
} from './SidebarActivityCenter';

interface NavItem {
  path: string;
  label: string;
  icon: ReactNode;
  feature: Feature;
  requiresRepoFeature?: boolean;
  requiresChat?: boolean;
}

const navItems: NavItem[] = [
  { path: '/repos', label: 'Workspace', icon: <Code size={20} />, feature: 'repos' },
  {
    path: '/chat',
    label: 'Outcomes',
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
    path: '/workflows',
    label: 'Workflows',
    icon: <GitFork size={20} />,
    feature: 'workflows',
    requiresChat: true,
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
    path: '/argent',
    label: 'Argent',
    icon: <MonitorSmartphone size={20} />,
    feature: 'argent',
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

const PRIMARY_NAV_PATHS = new Set(['/chat', '/repos', '/editor']);
const WORK_NAV_PATHS = new Set(['/workitems', '/automations', '/workflows', '/codereview']);
const PRIMARY_NAV_ORDER = ['/chat', '/repos', '/editor'];
const WORK_NAV_ORDER = ['/workitems', '/automations', '/workflows', '/codereview'];

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
  const {
    items: activityItems,
    indicators: activityIndicators,
    activeCount,
  } = useSidebarActivity();
  const { width, setWidth, collapsed, toggleCollapsed } = useStoredPanelState({
    storageKey: 'layout:main-sidebar:v2',
    defaultWidth: 252,
    minWidth: 224,
    maxWidth: 340,
  });
  const [autoCompact, setAutoCompact] = useState(false);
  const [narrowExpansion, setNarrowExpansion] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const compact = collapsed || (autoCompact && !narrowExpansion);

  useEffect(() => {
    const updateCompactMode = () => {
      const shouldCompact = location.pathname.startsWith('/chat') && window.innerWidth < 1500;
      setAutoCompact(shouldCompact);
      if (!shouldCompact) setNarrowExpansion(false);
    };

    updateCompactMode();
    window.addEventListener('resize', updateCompactMode);
    return () => window.removeEventListener('resize', updateCompactMode);
  }, [location.pathname]);

  const availableNavItems = navItems.filter(
    (item) =>
      ROLE_FEATURES[userRole].includes(item.feature) &&
      (item.feature !== 'cloud' || cloudFeaturesEnabled),
  );
  const primaryNavItems = orderNavItems(availableNavItems, PRIMARY_NAV_ORDER);
  const workNavItems = orderNavItems(availableNavItems, WORK_NAV_ORDER);
  const moreNavItems = availableNavItems.filter(
    (item) => !PRIMARY_NAV_PATHS.has(item.path) && !WORK_NAV_PATHS.has(item.path),
  );
  const moreActive = moreNavItems.some((item) => location.pathname.startsWith(item.path));

  useEffect(() => {
    if (moreActive) setMoreOpen(true);
  }, [moreActive]);

  const handleCollapseToggle = () => {
    if (autoCompact) {
      if (collapsed) {
        toggleCollapsed();
        setNarrowExpansion(true);
      } else {
        setNarrowExpansion((expanded) => !expanded);
      }
      return;
    }
    toggleCollapsed();
  };

  const statusLabel =
    featureAvailability.statusLabel === 'scaffolding'
      ? 'Scaffolding'
      : featureAvailability.statusLabel === 'indexing'
        ? 'Indexing'
        : featureAvailability.statusLabel === 'empty'
          ? 'Empty'
          : 'Ready';

  const handleResizeStart = (event: React.MouseEvent<HTMLDivElement>) => {
    if (compact) return;

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
      style={{ width: compact ? 72 : width }}
    >
      {/* Titlebar drag region — clears macOS traffic lights outside fullscreen. */}
      {reserveTitlebarSpace && <div className="titlebar-drag h-14" />}

      {/* Border starts below the traffic lights */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-r border-border">
        {/* Branding */}
        <div className={`${compact ? 'px-3 pb-3' : 'px-4 pb-3'} shrink-0 pt-2.5`}>
          <div className={`flex items-center ${compact ? 'justify-center' : 'justify-between'}`}>
            <div className={`flex min-w-0 items-center ${compact ? '' : 'gap-2.5'}`}>
              <AnvilLogo size={compact ? 36 : 38} showGlow />
              {!compact && (
                <h1 className="min-w-0 truncate text-base font-semibold tracking-tight text-text-primary">
                  <BrandName name={brand.appName} collapsed={compact} />
                </h1>
              )}
            </div>
            {!compact && (
              <button
                onClick={handleCollapseToggle}
                className="titlebar-no-drag rounded-lg p-1.5 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                title="Collapse navigation"
                aria-label="Collapse navigation"
              >
                <ChevronLeft size={14} />
              </button>
            )}
          </div>
          {compact && (
            <button
              onClick={handleCollapseToggle}
              className="titlebar-no-drag mt-2 flex w-full items-center justify-center rounded-lg px-2 py-1.5 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
              title="Expand navigation"
              aria-label="Expand navigation"
            >
              <ChevronRight size={14} />
            </button>
          )}
        </div>

        {/* Active Workspace */}
        {!compact && (
          <div className="shrink-0 border-b border-border-subtle px-4 pb-3">
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
          <RunButton compact={compact} />
        </div>

        {/* Navigation */}
        <div className="min-h-0 flex-1 px-2.5 py-2.5">
          <nav className="h-full overflow-y-auto pr-1">
            <div className="flex flex-col gap-1">
              {[...primaryNavItems, ...workNavItems].map((item, index) => {
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
                    className={`titlebar-no-drag relative flex w-full items-center rounded-lg border py-2 text-sm font-medium transition-colors ${
                      active
                        ? 'border-accent/30 bg-accent/12 text-text-primary'
                        : disabled
                          ? 'cursor-not-allowed border-transparent text-text-tertiary opacity-50'
                          : item.path === '/chat'
                            ? 'border-border-subtle bg-bg-tertiary/45 text-text-primary hover:border-border hover:bg-bg-tertiary'
                            : 'border-transparent text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
                    } ${compact ? 'justify-center px-2.5' : 'gap-3 px-3'} ${index === primaryNavItems.length && !compact ? 'mt-2 border-t-0' : ''}`}
                    aria-label={item.label}
                    title={disabled ? featureAvailability.repoFeatureReason : item.label}
                  >
                    {item.icon}
                    {!compact && <span className="truncate">{item.label}</span>}
                    <SidebarActivityBadge
                      indicator={activityIndicators[item.feature]}
                      collapsed={compact}
                    />
                  </button>
                );
              })}

              {moreNavItems.length > 0 && !compact && (
                <div className="mt-2 border-t border-border-subtle pt-2">
                  <button
                    type="button"
                    onClick={() => setMoreOpen((open) => !open)}
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                    aria-expanded={moreOpen}
                  >
                    {moreOpen ? (
                      <ChevronLeft size={13} className="-rotate-90" />
                    ) : (
                      <ChevronRight size={13} />
                    )}
                    <span>More tools</span>
                    <span className="ml-auto text-[11px]">{moreNavItems.length}</span>
                  </button>
                  {moreOpen && (
                    <div className="mt-1 flex flex-col gap-0.5">
                      {moreNavItems.map((item) => {
                        const active = location.pathname.startsWith(item.path);
                        const disabled = item.requiresChat
                          ? !featureAvailability.chatEnabled
                          : item.requiresRepoFeature
                            ? !featureAvailability.repoFeaturesEnabled
                            : false;
                        return (
                          <button
                            key={item.path}
                            onClick={() => !disabled && navigate(item.path)}
                            disabled={disabled}
                            className={`relative flex w-full items-center gap-3 rounded-lg px-3 py-1.5 text-sm transition-colors ${
                              active
                                ? 'bg-accent/10 text-text-primary'
                                : disabled
                                  ? 'cursor-not-allowed text-text-tertiary opacity-45'
                                  : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
                            }`}
                            title={disabled ? featureAvailability.repoFeatureReason : item.label}
                          >
                            {item.icon}
                            <span className="truncate">{item.label}</span>
                            <SidebarActivityBadge
                              indicator={activityIndicators[item.feature]}
                              collapsed={false}
                            />
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </nav>
        </div>

        {/* Footer — connection status + settings */}
        <div className="shrink-0 border-t border-border-subtle p-2.5">
          <SidebarActivityCenter
            items={activityItems}
            activeCount={activeCount}
            collapsed={compact}
          />
          {!compact && <ConnectionSummary connectionStatus={connectionStatus} />}
          <button
            onClick={() => navigate('/settings')}
            className={`titlebar-no-drag mt-2 flex w-full items-center rounded-lg py-2 text-sm font-medium transition-colors ${
              location.pathname.startsWith('/settings')
                ? 'border-accent/30 bg-accent/10 text-text-primary'
                : 'border-transparent text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
            } ${compact ? 'justify-center px-2' : 'gap-2 px-3'}`}
            aria-label="Settings"
            title="Settings"
          >
            <Settings size={16} />
            {!compact && 'Settings'}
          </button>
          <button
            onClick={() => navigate('/diagnostics')}
            className={`titlebar-no-drag mt-1 flex w-full items-center rounded-lg py-2 text-sm font-medium transition-colors ${
              location.pathname.startsWith('/diagnostics')
                ? 'border-accent/30 bg-accent/10 text-text-primary'
                : 'border-transparent text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
            } ${compact ? 'justify-center px-2' : 'gap-2 px-3'}`}
            aria-label="Diagnostics"
            title="Diagnostics"
          >
            <Activity size={16} />
            {!compact && 'Diagnostics'}
          </button>
        </div>
      </div>
      {/* end border wrapper */}

      {!compact && (
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

function ConnectionSummary({
  connectionStatus,
}: {
  connectionStatus: SidebarProps['connectionStatus'];
}) {
  const services = Object.values(connectionStatus);
  const connected = services.filter((status) => status === true).length;
  const failed = services.filter((status) => status === false).length;
  const label =
    failed > 0
      ? `${failed} connection issue${failed === 1 ? '' : 's'}`
      : connected > 0
        ? `${connected} connected`
        : 'Connections';

  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 text-xs text-text-tertiary"
      title="Foundry, work items, and Confluence connection health"
    >
      <span
        className={`h-2 w-2 rounded-full ${failed > 0 ? 'bg-error' : connected > 0 ? 'bg-success' : 'bg-text-tertiary'}`}
      />
      <span>{label}</span>
    </div>
  );
}

function BrandName({ name, collapsed = false }: { name: string; collapsed?: boolean }) {
  if (collapsed) return <>{name.slice(0, 3)}</>;
  return <>{name}</>;
}

function orderNavItems(items: NavItem[], paths: string[]): NavItem[] {
  return paths.flatMap((path) => {
    const item = items.find((candidate) => candidate.path === path);
    return item ? [item] : [];
  });
}
