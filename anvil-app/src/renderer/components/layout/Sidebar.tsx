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
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
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
  PictureInPicture2,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { RunButton } from './RunButton';
import { WorkspaceMenu } from '../workspace/WorkspaceMenu';
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
  userRole: UserRole;
  cloudFeaturesEnabled: boolean;
  reserveTitlebarSpace?: boolean;
  onCreateWorkspace: () => void;
}

export function Sidebar({
  userRole,
  cloudFeaturesEnabled,
  reserveTitlebarSpace = true,
  onCreateWorkspace,
}: SidebarProps) {
  const location = useLocation();
  const navigate = useNavigate();
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
  const openToolWindow = (path: string) => {
    void window.anvil.appWindow.openToolWindow(path, activeWorkspace?.id);
  };

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
      className="relative z-30 flex h-full min-h-0 shrink-0 flex-col bg-bg-secondary transition-[width] duration-200"
      style={{ width: compact ? 72 : width }}
    >
      {/* Titlebar drag region — clears macOS traffic lights outside fullscreen. */}
      {reserveTitlebarSpace && <div className="titlebar-drag h-14" />}

      {/* Border starts below the traffic lights */}
      <div className="flex min-h-0 flex-1 flex-col border-r border-border">
        {/* Branding */}
        <div className="shrink-0 px-3 pb-3 pt-2.5">
          <div className="flex items-center">
            <WorkspaceMenu
              compact={compact}
              statusLabel={statusLabel}
              onCreateNew={onCreateWorkspace}
            />
          </div>
        </div>

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
                  onOpenInNewWindow={openToolWindow}
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
                    {!compact && automateRoute && (
                      <button
                        type="button"
                        onClick={() => openToolWindow(automateRoute)}
                        className="titlebar-no-drag rounded-lg p-2.5 text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                        title="Open Automate in new window"
                        aria-label="Open Automate in new window"
                      >
                        <PictureInPicture2 size={13} />
                      </button>
                    )}
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
                          onOpenInNewWindow={openToolWindow}
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
                                onOpenInNewWindow={openToolWindow}
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
          <button
            type="button"
            onClick={handleCollapseToggle}
            className={`titlebar-no-drag mb-2 flex h-9 w-full items-center rounded-lg text-sm text-text-tertiary transition-colors hover:bg-bg-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
              compact ? 'justify-center' : 'gap-2 px-2.5'
            }`}
            title={compact ? 'Expand navigation' : 'Collapse navigation'}
            aria-label={compact ? 'Expand navigation' : 'Collapse navigation'}
          >
            {compact ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
            {!compact && <span>Collapse</span>}
          </button>
          <SidebarFooterButton
            path="/settings"
            label="Settings"
            icon={<Settings size={16} />}
            compact={compact}
            active={location.pathname.startsWith('/settings')}
            onNavigate={navigate}
            onOpenInNewWindow={openToolWindow}
            className="mt-2"
          />
          <SidebarFooterButton
            path="/diagnostics"
            label="Diagnostics"
            icon={<Activity size={16} />}
            compact={compact}
            active={location.pathname.startsWith('/diagnostics')}
            onNavigate={navigate}
            onOpenInNewWindow={openToolWindow}
            className="mt-1"
          />
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
  onOpenInNewWindow,
  prominent = false,
  compactDensity = false,
}: {
  item: SidebarNavItemDefinition;
  active: boolean;
  compact: boolean;
  featureAvailability: WorkspaceFeatureAvailability;
  indicator?: ReturnType<typeof buildAggregateActivityIndicator>;
  onNavigate: (path: string) => void;
  onOpenInNewWindow: (path: string) => void;
  prominent?: boolean;
  compactDensity?: boolean;
}) {
  const disabled = item.requiresChat
    ? !featureAvailability.chatEnabled
    : item.requiresRepoFeature
      ? !featureAvailability.repoFeaturesEnabled
      : false;

  return (
    <div className="group/nav relative flex min-w-0 items-center">
      <button
        type="button"
        onClick={() => {
          if (!disabled) onNavigate(item.path);
        }}
        disabled={disabled}
        className={`titlebar-no-drag relative flex min-w-0 flex-1 items-center rounded-lg border text-sm transition-colors ${
          compactDensity ? 'py-1.5' : 'py-2'
        } ${
          active
            ? 'border-accent/30 bg-accent/12 font-medium text-text-primary'
            : disabled
              ? 'cursor-not-allowed border-transparent text-text-tertiary opacity-50'
              : prominent
                ? 'border-border-subtle bg-bg-tertiary/45 font-medium text-text-primary hover:border-border hover:bg-bg-tertiary'
                : 'border-transparent text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
        } ${compact ? 'justify-center px-2.5' : 'gap-3 pl-3 pr-9'}`}
        aria-label={item.label}
        title={disabled ? featureAvailability.repoFeatureReason : item.label}
      >
        {NAV_ICONS[item.path]}
        {!compact && <span className="truncate">{item.label}</span>}
        <SidebarActivityBadge indicator={indicator} collapsed={compact} />
      </button>
      {!compact && !disabled && (
        <button
          type="button"
          onClick={() => onOpenInNewWindow(item.path)}
          className="titlebar-no-drag absolute right-1.5 rounded-md p-1 text-text-tertiary opacity-0 transition-[color,background-color,opacity] hover:bg-bg-elevated hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 group-hover/nav:opacity-100"
          title={`Open ${item.label} in new window`}
          aria-label={`Open ${item.label} in new window`}
        >
          <PictureInPicture2 size={13} />
        </button>
      )}
    </div>
  );
}

function SidebarFooterButton({
  path,
  label,
  icon,
  compact,
  active,
  onNavigate,
  onOpenInNewWindow,
  className,
}: {
  path: string;
  label: string;
  icon: ReactNode;
  compact: boolean;
  active: boolean;
  onNavigate: (path: string) => void;
  onOpenInNewWindow: (path: string) => void;
  className?: string;
}) {
  return (
    <div className={`group/footer relative flex items-center ${className ?? ''}`}>
      <button
        type="button"
        onClick={() => onNavigate(path)}
        className={`titlebar-no-drag flex min-w-0 flex-1 items-center rounded-lg py-2 text-sm font-medium transition-colors ${
          active
            ? 'border-accent/30 bg-accent/10 text-text-primary'
            : 'border-transparent text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
        } ${compact ? 'justify-center px-2' : 'gap-2 pl-3 pr-9'}`}
        aria-label={label}
        title={label}
      >
        {icon}
        {!compact && label}
      </button>
      {!compact && (
        <button
          type="button"
          onClick={() => onOpenInNewWindow(path)}
          className="titlebar-no-drag absolute right-1.5 rounded-md p-1 text-text-tertiary opacity-0 transition-[color,background-color,opacity] hover:bg-bg-elevated hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 group-hover/footer:opacity-100"
          title={`Open ${label} in new window`}
          aria-label={`Open ${label} in new window`}
        >
          <PictureInPicture2 size={13} />
        </button>
      )}
    </div>
  );
}
