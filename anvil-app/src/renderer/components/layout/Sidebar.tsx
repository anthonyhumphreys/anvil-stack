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
  Bell,
  RadioTower,
  Wrench,
  Activity,
  Boxes,
  Workflow,
  NotebookPen,
  StickyNote,
  MonitorSmartphone,
  GripVertical,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useBrand } from '../../contexts/BrandContext';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { RunButton } from './RunButton';
import { AnvilLogo } from '../brand/AnvilLogo';
import type { UserRole, WorkspaceFeatureAvailability } from '../../../shared/types';
import { useStoredPanelState } from '../../hooks/useStoredPanelState';
import {
  buildAggregateActivityIndicator,
  SidebarActivityBadge,
  useSidebarActivity,
} from './SidebarActivityCenter';
import {
  getAvailableSidebarNavigation,
  isSidebarNavItemActive,
  type SidebarNavItemDefinition,
} from '../../utils/sidebar-navigation';

const NAV_ICONS: Record<string, ReactNode> = {
  '/inbox': <Bell size={19} />,
  '/chat': <MessageSquare size={19} />,
  '/repos': <Code size={19} />,
  '/automations': <RadioTower size={19} />,
  '/workflows': <GitFork size={18} />,
  '/meeting-notes': <NotebookPen size={18} />,
  '/workspace-notes': <StickyNote size={18} />,
  '/editor': <SquareTerminal size={18} />,
  '/db-insights': <Database size={18} />,
  '/onboard': <Compass size={18} />,
  '/workitems': <TicketCheck size={18} />,
  '/dependencies': <Boxes size={18} />,
  '/security': <Shield size={18} />,
  '/codereview': <GitPullRequest size={18} />,
  '/cicd': <Workflow size={18} />,
  '/cloud': <Cloud size={18} />,
  '/docs': <FileText size={18} />,
  '/adrs': <BookOpen size={18} />,
  '/diagrams': <GitFork size={18} />,
  '/governance': <Landmark size={18} />,
  '/browser': <Globe size={18} />,
  '/argent': <MonitorSmartphone size={18} />,
  '/git': <GitBranch size={18} />,
  '/compliance': <Scale size={18} />,
};

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
  const { items: activityItems, indicators: activityIndicators } = useSidebarActivity();
  const { width, setWidth, collapsed, toggleCollapsed } = useStoredPanelState({
    storageKey: 'layout:main-sidebar:v2',
    defaultWidth: 252,
    minWidth: 224,
    maxWidth: 340,
  });
  const [autoCompact, setAutoCompact] = useState(false);
  const [narrowExpansion, setNarrowExpansion] = useState(false);
  const [automateOpen, setAutomateOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
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

  const navigation = getAvailableSidebarNavigation(userRole, cloudFeaturesEnabled);
  const automateActive = navigation.automate.some((item) =>
    isSidebarNavItemActive(location.pathname, item),
  );
  const toolsActive = navigation.tools.some((group) =>
    group.items.some((item) => isSidebarNavItemActive(location.pathname, item)),
  );
  const inboxIndicator = buildAggregateActivityIndicator(activityItems);
  const automateRoute = navigation.automate[0]?.path;

  useEffect(() => {
    if (automateActive) setAutomateOpen(true);
  }, [automateActive]);

  useEffect(() => {
    if (toolsActive) setToolsOpen(true);
  }, [toolsActive]);

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

  const handleResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (compact || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') {
      setWidth(224);
      return;
    }
    if (event.key === 'End') {
      setWidth(340);
      return;
    }
    setWidth(width + (event.key === 'ArrowRight' ? 24 : -24));
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
              {navigation.primary.map((item) => (
                <SidebarNavButton
                  key={item.path}
                  item={item}
                  active={isSidebarNavItemActive(location.pathname, item)}
                  compact={compact}
                  featureAvailability={featureAvailability}
                  indicator={
                    item.path === '/inbox' ? inboxIndicator : activityIndicators[item.feature]
                  }
                  onNavigate={navigate}
                  prominent={item.path === '/chat'}
                />
              ))}

              {navigation.automate.length > 0 && (
                <div className={compact ? 'mt-1' : 'mt-2 border-t border-border-subtle pt-2'}>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        if (automateRoute) navigate(automateRoute);
                      }}
                      className={`titlebar-no-drag relative flex min-w-0 flex-1 items-center rounded-lg border py-2 text-sm font-medium transition-colors ${
                        automateActive
                          ? 'border-accent/30 bg-accent/12 text-text-primary'
                          : 'border-transparent text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
                      } ${compact ? 'justify-center px-2.5' : 'gap-3 px-3'}`}
                      aria-label="Automate"
                      title="Automate"
                    >
                      <RadioTower size={19} />
                      {!compact && <span className="truncate">Automate</span>}
                    </button>
                    {!compact && navigation.automate.length > 1 && (
                      <button
                        type="button"
                        onClick={() => setAutomateOpen((open) => !open)}
                        className="titlebar-no-drag rounded-lg p-2.5 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary"
                        aria-label={automateOpen ? 'Collapse Automate' : 'Expand Automate'}
                        aria-expanded={automateOpen}
                      >
                        <ChevronRight
                          size={14}
                          className={`transition-transform ${automateOpen ? 'rotate-90' : ''}`}
                        />
                      </button>
                    )}
                  </div>
                  {!compact && automateOpen && (
                    <div className="mt-1 flex flex-col gap-0.5 pl-2">
                      {navigation.automate.map((item) => (
                        <SidebarNavButton
                          key={item.path}
                          item={item}
                          active={isSidebarNavItemActive(location.pathname, item)}
                          compact={false}
                          featureAvailability={featureAvailability}
                          indicator={activityIndicators[item.feature]}
                          onNavigate={navigate}
                          compactDensity
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}

              {navigation.tools.length > 0 && (
                <div className={compact ? '' : 'mt-1'}>
                  <button
                    type="button"
                    onClick={() => {
                      if (compact) {
                        handleCollapseToggle();
                        setToolsOpen(true);
                      } else {
                        setToolsOpen((open) => !open);
                      }
                    }}
                    className={`titlebar-no-drag relative flex w-full items-center rounded-lg border border-transparent py-2 text-sm font-medium transition-colors ${
                      toolsActive
                        ? 'bg-bg-tertiary text-text-primary'
                        : 'text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
                    } ${compact ? 'justify-center px-2.5' : 'gap-3 px-3'}`}
                    aria-label="Tools"
                    aria-expanded={toolsOpen}
                    title="Tools"
                  >
                    <Wrench size={19} />
                    {!compact && (
                      <>
                        <span className="truncate">Tools</span>
                        <ChevronRight
                          size={14}
                          className={`ml-auto transition-transform ${toolsOpen ? 'rotate-90' : ''}`}
                        />
                      </>
                    )}
                  </button>
                  {!compact && toolsOpen && (
                    <div className="mt-2 space-y-3 pb-2 pl-2">
                      {navigation.tools.map((group) => (
                        <div key={group.id}>
                          <div className="px-3 pb-1 text-xs font-medium text-text-tertiary">
                            {group.label}
                          </div>
                          <div className="flex flex-col gap-0.5">
                            {group.items.map((item) => (
                              <SidebarNavButton
                                key={item.path}
                                item={item}
                                active={isSidebarNavItemActive(location.pathname, item)}
                                compact={false}
                                featureAvailability={featureAvailability}
                                indicator={activityIndicators[item.feature]}
                                onNavigate={navigate}
                                compactDensity
                              />
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </nav>
        </div>

        {/* Footer — connection status + settings */}
        <div className="shrink-0 border-t border-border-subtle p-2.5">
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
          onKeyDown={handleResizeKeyDown}
          className="group absolute -right-1.5 bottom-0 top-0 z-20 flex w-3 cursor-col-resize items-center justify-center"
          role="separator"
          aria-label="Resize navigation"
          aria-orientation="vertical"
          aria-valuemin={224}
          aria-valuemax={340}
          aria-valuenow={width}
          tabIndex={0}
        >
          <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border/60 transition-colors group-hover:bg-accent" />
          <span className="relative flex h-9 w-3 items-center justify-center rounded-full border border-border bg-bg-elevated text-text-muted shadow-sm transition-colors group-hover:border-accent/50 group-hover:text-accent">
            <GripVertical size={10} />
          </span>
        </div>
      )}
    </aside>
  );
}

function SidebarNavButton({
  item,
  active,
  compact,
  featureAvailability,
  indicator,
  onNavigate,
  prominent = false,
  compactDensity = false,
}: {
  item: SidebarNavItemDefinition;
  active: boolean;
  compact: boolean;
  featureAvailability: WorkspaceFeatureAvailability;
  indicator?: ReturnType<typeof buildAggregateActivityIndicator>;
  onNavigate: (path: string) => void;
  prominent?: boolean;
  compactDensity?: boolean;
}) {
  const disabled = item.requiresChat
    ? !featureAvailability.chatEnabled
    : item.requiresRepoFeature
      ? !featureAvailability.repoFeaturesEnabled
      : false;

  return (
    <button
      type="button"
      onClick={() => {
        if (!disabled) onNavigate(item.path);
      }}
      disabled={disabled}
      className={`titlebar-no-drag relative flex w-full items-center rounded-lg border text-sm transition-colors ${
        compactDensity ? 'py-1.5' : 'py-2'
      } ${
        active
          ? 'border-accent/30 bg-accent/12 font-medium text-text-primary'
          : disabled
            ? 'cursor-not-allowed border-transparent text-text-tertiary opacity-50'
            : prominent
              ? 'border-border-subtle bg-bg-tertiary/45 font-medium text-text-primary hover:border-border hover:bg-bg-tertiary'
              : 'border-transparent text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
      } ${compact ? 'justify-center px-2.5' : 'gap-3 px-3'}`}
      aria-label={item.label}
      title={disabled ? featureAvailability.repoFeatureReason : item.label}
    >
      {NAV_ICONS[item.path]}
      {!compact && <span className="truncate">{item.label}</span>}
      <SidebarActivityBadge indicator={indicator} collapsed={compact} />
    </button>
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
