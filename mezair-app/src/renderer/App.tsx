import { lazy, Suspense, useEffect, useState, useCallback, type ReactNode } from 'react';
import {
  Routes,
  Route,
  Navigate,
  useLocation,
  useNavigate,
  useSearchParams,
} from 'react-router-dom';
import { AppRouter } from './components/layout/AppRouter';
import { Shell } from './components/layout/Shell';
import { ErrorBoundary } from './components/layout/ErrorBoundary';
import { SplashScreen } from './components/brand/SplashScreen';
import { ChatProvider, useChatContext } from './contexts/ChatContext';
import { BrandProvider } from './contexts/BrandContext';
import { getBrand, getBuildBrandId } from '../shared/branding';
import { WorkspaceProvider, useWorkspace } from './contexts/WorkspaceContext';
import { RepoIndexProvider } from './contexts/RepoIndexContext';
import { WorkspaceCreator } from './components/workspace/WorkspaceCreator';
import { WelcomeOverlay } from './components/onboard/WelcomeOverlay';
import { RoleHiddenNotice } from './components/shared/RoleHiddenNotice';
import type { UserRole, Feature, AppTheme } from '../shared/types';
import { ROLE_FEATURES } from '../shared/types';
import { resolveLegacyRoute } from './utils/sidebar-navigation';

const ReposView = lazy(() =>
  import('./components/repos/ReposView').then((module) => ({ default: module.ReposView })),
);
const OverviewView = lazy(() =>
  import('./components/overview/OverviewView').then((module) => ({
    default: module.OverviewView,
  })),
);
const WorkspaceView = lazy(() =>
  import('./components/workspace/WorkspaceView').then((module) => ({
    default: module.WorkspaceView,
  })),
);
const ChatView = lazy(() =>
  import('./components/chat/ChatView').then((module) => ({ default: module.ChatView })),
);
const ThreadPickupView = lazy(() =>
  import('./components/share/ThreadPickupView').then((module) => ({
    default: module.ThreadPickupView,
  })),
);
// Native fixture route is stripped from release builds.
const ProcessingPreview = import.meta.env.DEV
  ? lazy(() => import('./components/chat/replay/ProcessingPreview'))
  : null;
const ChangeReviewView = lazy(() =>
  import('./components/review/ChangeReviewView').then((module) => ({
    default: module.ChangeReviewView,
  })),
);
const WorkItemsView = lazy(() =>
  import('./components/workitems/WorkItemsView').then((module) => ({
    default: module.WorkItemsView,
  })),
);
const BaView = lazy(() =>
  import('./components/ba/BaView').then((module) => ({ default: module.BaView })),
);
const DbInsightsView = lazy(() =>
  import('./components/dbinsights/DbInsightsView').then((module) => ({
    default: module.DbInsightsView,
  })),
);
const CodeReviewView = lazy(() =>
  import('./components/codereview/CodeReviewView').then((module) => ({
    default: module.CodeReviewView,
  })),
);
const AutomationsView = lazy(() =>
  import('./components/automations/AutomationsView').then((module) => ({
    default: module.AutomationsView,
  })),
);
const FactoriesView = lazy(() =>
  import('./components/factories/FactoriesView').then((module) => ({
    default: module.FactoriesView,
  })),
);
const DojoView = lazy(() =>
  import('./components/dojo/DojoView').then((module) => ({ default: module.DojoView })),
);
const GovernanceView = lazy(() =>
  import('./components/governance/GovernanceView').then((module) => ({
    default: module.GovernanceView,
  })),
);
const BrowserPanel = lazy(() =>
  import('./components/browser/BrowserPanel').then((module) => ({ default: module.BrowserPanel })),
);
const ArgentView = lazy(() =>
  import('./components/argent/ArgentView').then((module) => ({ default: module.ArgentView })),
);
const GitView = lazy(() =>
  import('./components/git/GitView').then((module) => ({ default: module.GitView })),
);
const DiagnosticsView = lazy(() =>
  import('./components/diagnostics/DiagnosticsView').then((module) => ({
    default: module.DiagnosticsView,
  })),
);
const MezairCloudView = lazy(() =>
  import('./components/cloud/MezairCloudView').then((module) => ({
    default: module.MezairCloudView,
  })),
);
const SettingsView = lazy(() =>
  import('./components/settings/SettingsView').then((module) => ({ default: module.SettingsView })),
);
const CodexRegistryView = lazy(() =>
  import('./components/settings/CodexRegistryView').then((module) => ({
    default: module.CodexRegistryView,
  })),
);
const OpenInMezairView = lazy(() =>
  import('./components/launch/OpenInMezairView').then((module) => ({
    default: module.OpenInMezairView,
  })),
);
const NotesView = lazy(() =>
  import('./components/notes/NotesView').then((module) => ({ default: module.NotesView })),
);
const InboxView = lazy(() =>
  import('./components/inbox/InboxView').then((module) => ({ default: module.InboxView })),
);

type OnboardingPreviewStep = 'welcome';
const WorkflowsView = lazy(() =>
  import('./components/workflows/WorkflowsView').then((module) => ({
    default: module.WorkflowsView,
  })),
);

function WorkspaceGate({ children }: { children: ReactNode }) {
  const { workspaces, loading, refreshWorkspaces } = useWorkspace();

  if (loading) return <SplashScreen label="Loading workspace" />;

  if (workspaces.length === 0) {
    return (
      <WorkspaceCreator
        onCreated={async () => {
          // J9/3.3: mark onboarding complete — a relaunch skips the welcome
          // flow and lands on the workspace.
          await window.mezair.settings.update({ onboardingStep: 'done' }).catch(() => undefined);
          // §7 funnel — local-only activation event.
          void window.mezair.metrics
            .track('onboarding_step_completed', { step: 'workspace' })
            .catch(() => undefined);
          await refreshWorkspaces();
        }}
      />
    );
  }

  return <>{children}</>;
}

/**
 * NV5: the catch-all route is a decision, not a hardcode. Returning users
 * with pending attention items land on Activity (`/inbox`); new users land
 * on Chat.
 */
function DefaultRedirect() {
  const { workspaceActivity, repos, loading } = useWorkspace();
  if (loading) return <SplashScreen label="Loading workspace" />;
  const isNewUser = repos.length === 0;
  const hasPendingAttention = workspaceActivity.some(
    (summary) => summary.count > 0 && (summary.status === 'warning' || summary.status === 'error'),
  );
  return <Navigate to={!isNewUser && hasPendingAttention ? '/inbox' : '/chat'} replace />;
}

const LEGACY_REDIRECT_PATHS = [
  '/security/*',
  '/dependencies/*',
  '/cicd/*',
  '/onboard',
  '/adrs',
  '/diagrams/*',
  '/docs',
  '/compliance',
  '/library',
  '/meeting-notes',
  '/workspace-notes',
];

/** Repo the repo-setup wizard last worked on (OnboardView persists it). */
const ONBOARD_REPO_STORAGE_KEY = 'mezair:onboard-repo';

/**
 * Spec §12: removed destinations redirect to their new homes (repo detail
 * Health/Setup, the Library, or Notes) so old links, notifications, launch
 * intents, tool windows and pins keep landing somewhere sensible.
 */
function LegacyRedirect() {
  const location = useLocation();
  const { repos, loading } = useWorkspace();
  if (loading) return <SplashScreen label="Loading workspace" />;
  let onboardRepoId: string | null = null;
  try {
    const remembered = window.localStorage.getItem(ONBOARD_REPO_STORAGE_KEY);
    if (remembered && repos.some((repo) => repo.id === remembered)) onboardRepoId = remembered;
  } catch {
    // Storage can be unavailable; fall back to the repository picker.
  }
  const target =
    resolveLegacyRoute(location.pathname, location.search, { onboardRepoId }) ?? '/workspace';
  return <Navigate to={target} replace />;
}

function ChatRoute({ userRole }: { userRole: UserRole }) {
  const [searchParams] = useSearchParams();
  const temporary = searchParams.get('temporary') === '1';
  const { isTemporaryChat, resumeTemporaryChat, showWorkspaceChat } = useChatContext();

  useEffect(() => {
    if (temporary) {
      if (!isTemporaryChat) void resumeTemporaryChat();
    } else if (isTemporaryChat) {
      showWorkspaceChat();
    }
  }, [isTemporaryChat, resumeTemporaryChat, showWorkspaceChat, temporary]);

  const view = (
    <ErrorBoundary>
      <ChatView userRole={userRole} />
    </ErrorBoundary>
  );
  return temporary ? view : <WorkspaceGate>{view}</WorkspaceGate>;
}

function LaunchIntentRouter() {
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;

    void Promise.all([
      window.mezair.launch.getPendingIntent().catch(() => null),
      window.mezair.shares.pickupPending().catch(() => false),
    ]).then(([intent, pickupPending]) => {
      if (cancelled) return;
      if (pickupPending) {
        navigate('/pick-up-thread', {
          replace: true,
          state: { pickupRequest: crypto.randomUUID() },
        });
      } else if (intent) {
        navigate('/open', { replace: true });
      }
    });

    const cleanup = window.mezair.launch.onIntent(() => {
      if (!cancelled) {
        navigate('/open', { replace: true });
      }
    });
    const cleanupPickup = window.mezair.shares.onPickupRequested(() => {
      if (!cancelled)
        navigate('/pick-up-thread', { state: { pickupRequest: crypto.randomUUID() } });
    });

    return () => {
      cancelled = true;
      cleanup();
      cleanupPickup();
    };
  }, [navigate]);

  return null;
}

export function App() {
  return (
    <AppRouter>
      <AppContent />
    </AppRouter>
  );
}

function AppContent() {
  const fallbackBrand = getBrand(getBuildBrandId());
  const resolveSystemTheme = useCallback((): Exclude<AppTheme, 'system'> => {
    if (fallbackBrand.defaultTheme !== 'system') return fallbackBrand.defaultTheme;
    const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
    return prefersDark ? 'dark' : 'light';
  }, [fallbackBrand.defaultTheme]);
  const [connectionStatus, setConnectionStatus] = useState<{
    foundry: boolean | null;
    ado: boolean | null;
    confluence: boolean | null;
  }>({
    foundry: null,
    ado: null,
    confluence: null,
  });

  const [userRole, setUserRole] = useState<UserRole | null>(null);
  const [appTheme, setAppTheme] = useState<AppTheme>(fallbackBrand.defaultTheme);
  const [cloudFeaturesEnabled, setCloudFeaturesEnabled] = useState(false);
  const [roleLoaded, setRoleLoaded] = useState(false);
  // ST8: "Show all tools" — bypasses role hiding for this install.
  const [showAllTools, setShowAllTools] = useState(false);
  const [connectorsConfigured, setConnectorsConfigured] = useState(false);
  const [onboardingPreviewStep, setOnboardingPreviewStep] = useState<OnboardingPreviewStep | null>(
    null,
  );

  const checkConnections = useCallback(async () => {
    try {
      const settings = await window.mezair.settings.get();
      const brand = await window.brand.get();
      const [pendingLaunchIntent, pendingPickup] = await Promise.all([
        window.mezair.launch.getPendingIntent(),
        window.mezair.shares.pickupPending().catch(() => false),
      ]);

      setAppTheme(settings.theme ?? brand.defaultTheme);
      setCloudFeaturesEnabled(settings.cloudFeaturesEnabled);
      if (settings.userRole) {
        setUserRole(settings.userRole);
      }
      setShowAllTools(settings.showAllTools === true);
      // Skip the welcome flow for existing users, launch intents, shared
      // thread pickups, and onboarding resumes before a workspace was created.
      if (
        settings.activeWorkspaceId ||
        pendingLaunchIntent ||
        pendingPickup ||
        settings.onboardingStep === 'workspace' ||
        settings.onboardingStep === 'done'
      ) {
        setConnectorsConfigured(true);
      }
      setRoleLoaded(true);

      // Only test connections that have credentials configured
      const hasLlm =
        settings.llmProvider === 'azure'
          ? true // Azure is configured via Codex CLI's config.toml
          : settings.llmProvider === 'codex' ||
              settings.llmProvider === 'cursor' ||
              settings.llmProvider === 'devin'
            ? true // CLI-backed providers use their own local auth — always test
            : settings.llmProvider === 'llmgateway'
              ? !!settings.llmGatewayApiKey
              : !!settings.openaiApiKey;
      const hasAdo = !!settings.adoOrganizationUrl && !!settings.adoPat;
      const hasConfluence = !!settings.confluenceBaseUrl && !!settings.confluencePat;

      setConnectionStatus({
        foundry: hasLlm ? null : null,
        ado: hasAdo ? null : null,
        confluence: hasConfluence ? null : null,
      });

      // Run tests in parallel for configured services
      const results = await Promise.allSettled([
        hasLlm
          ? window.mezair.settings.testFoundryConnection().then((r) => r.ok)
          : Promise.resolve(null),
        hasAdo
          ? window.mezair.settings.testWorkItemProviderConnection().then((r) => r.ok)
          : Promise.resolve(null),
        hasConfluence
          ? window.mezair.settings.testConfluenceConnection().then((r) => r.ok)
          : Promise.resolve(null),
      ]);

      setConnectionStatus({
        foundry: results[0].status === 'fulfilled' ? results[0].value : false,
        ado: results[1].status === 'fulfilled' ? results[1].value : false,
        confluence: results[2].status === 'fulfilled' ? results[2].value : false,
      });
    } catch {
      // If settings aren't accessible yet, leave as null
      setRoleLoaded(true);
    }
  }, []);

  const handleRoleChange = useCallback((role: UserRole) => {
    setUserRole(role);
  }, []);

  const handleThemeChange = useCallback((theme: AppTheme) => {
    setAppTheme(theme);
  }, []);

  // Check on mount
  useEffect(() => {
    checkConnections();
  }, [checkConnections]);

  useEffect(() => {
    const handleCloudFeatureChanged = (event: Event) => {
      const customEvent = event as CustomEvent<{ enabled: boolean }>;
      setCloudFeaturesEnabled(customEvent.detail.enabled);
    };

    window.addEventListener('mezair:cloud-feature-changed', handleCloudFeatureChanged);
    return () =>
      window.removeEventListener('mezair:cloud-feature-changed', handleCloudFeatureChanged);
  }, []);

  useEffect(() => {
    const applyTheme = () => {
      document.documentElement.dataset.theme =
        appTheme === 'system' ? resolveSystemTheme() : appTheme;
    };
    applyTheme();

    if (appTheme !== 'system') return undefined;

    const mediaQuery = window.matchMedia?.('(prefers-color-scheme: dark)');
    mediaQuery?.addEventListener('change', applyTheme);
    return () => mediaQuery?.removeEventListener('change', applyTheme);
  }, [appTheme, resolveSystemTheme]);

  // ST8: role-hidden deep links explain themselves instead of silently
  // redirecting. "Show anyway" flips the persisted showAllTools setting.
  const guard = (feature: Feature, element: React.ReactElement) => {
    if (showAllTools) return element;
    if (userRole && ROLE_FEATURES[userRole].includes(feature)) return element;
    return (
      <RoleHiddenNotice
        feature={feature}
        userRole={userRole ?? undefined}
        onShowAnyway={() => {
          setShowAllTools(true);
          void window.mezair.settings.update({ showAllTools: true });
        }}
      >
        {element}
      </RoleHiddenNotice>
    );
  };

  if (!roleLoaded) {
    return <SplashScreen label={`Starting ${fallbackBrand.appName}`} />;
  }

  if (onboardingPreviewStep) {
    return (
      <BrandProvider>
        <WelcomeOverlay
          preview
          onRoleSelected={() => undefined}
          onComplete={() => setOnboardingPreviewStep(null)}
          onExitPreview={() => setOnboardingPreviewStep(null)}
        />
      </BrandProvider>
    );
  }

  // O1–O5: first-run welcome covers role, primary agent, and optional Sync.
  // Other integrations are deferred to point of need; onboardingStep records
  // completion before the workspace creator so relaunches resume there.
  if (!userRole || !connectorsConfigured) {
    return (
      <BrandProvider>
        <WelcomeOverlay
          onRoleSelected={handleRoleChange}
          onComplete={() => {
            setConnectorsConfigured(true);
            window.mezair.settings.update({ onboardingStep: 'workspace' }).catch(() => undefined);
          }}
        />
      </BrandProvider>
    );
  }

  return (
    <BrandProvider>
      {/* RepoIndexProvider must wrap WorkspaceProvider — the workspace's
          featureAvailability consumes live index-job state (1.3). */}
      <RepoIndexProvider>
        <WorkspaceProvider>
          <ChatProvider>
            <>
              <LaunchIntentRouter />
              <Suspense fallback={<SplashScreen label="Loading workspace" />}>
                <Routes>
                  <Route
                    element={
                      <Shell
                        connectionStatus={connectionStatus}
                        userRole={userRole}
                        cloudFeaturesEnabled={cloudFeaturesEnabled}
                      />
                    }
                  >
                    <Route
                      path="/inbox"
                      element={guard(
                        'chat',
                        <WorkspaceGate>
                          <ErrorBoundary>
                            <InboxView />
                          </ErrorBoundary>
                        </WorkspaceGate>,
                      )}
                    />
                    {/* ANV-51: all-workspaces overview. */}
                    <Route
                      path="/overview"
                      element={
                        <WorkspaceGate>
                          <ErrorBoundary>
                            <OverviewView />
                          </ErrorBoundary>
                        </WorkspaceGate>
                      }
                    />
                    {/* WS2: `/workspace` is the workspace home; `/repos` keeps
                      working as the same management surface. */}
                    <Route
                      path="/workspace"
                      element={
                        <WorkspaceGate>
                          <ErrorBoundary>
                            <WorkspaceView />
                          </ErrorBoundary>
                        </WorkspaceGate>
                      }
                    />
                    {/* Spec §12: repo detail Health (Security, Dependencies, CI/CD)
                      and Setup sections — path params so embedded tools that
                      read `:repoId` work unchanged. */}
                    <Route
                      path="/workspace/repos/:repoId/:section/:tab?"
                      element={
                        <WorkspaceGate>
                          <ErrorBoundary>
                            <WorkspaceView />
                          </ErrorBoundary>
                        </WorkspaceGate>
                      }
                    />
                    {/* Merged Notes: Workspace notes | Meeting notes. */}
                    <Route
                      path="/notes"
                      element={
                        <WorkspaceGate>
                          <ErrorBoundary>
                            <NotesView />
                          </ErrorBoundary>
                        </WorkspaceGate>
                      }
                    />
                    {/* Removed destinations (spec §12) redirect to their new homes. */}
                    {LEGACY_REDIRECT_PATHS.map((path) => (
                      <Route
                        key={path}
                        path={path}
                        element={
                          <WorkspaceGate>
                            <LegacyRedirect />
                          </WorkspaceGate>
                        }
                      />
                    ))}
                    <Route
                      path="/repos"
                      element={
                        <WorkspaceGate>
                          <ErrorBoundary>
                            <ReposView />
                          </ErrorBoundary>
                        </WorkspaceGate>
                      }
                    />
                    <Route
                      path="/open"
                      element={
                        <ErrorBoundary>
                          <OpenInMezairView />
                        </ErrorBoundary>
                      }
                    />

                    <Route
                      path="/chat"
                      element={guard('chat', <ChatRoute userRole={userRole} />)}
                    />
                    <Route
                      path="/pick-up-thread"
                      element={guard(
                        'chat',
                        <WorkspaceGate>
                          <ErrorBoundary>
                            <ThreadPickupView userRole={userRole} />
                          </ErrorBoundary>
                        </WorkspaceGate>,
                      )}
                    />
                    {ProcessingPreview && (
                      <Route
                        path="/_dev/processing"
                        element={
                          <ErrorBoundary>
                            <ProcessingPreview />
                          </ErrorBoundary>
                        }
                      />
                    )}
                    <Route
                      path="/db-insights"
                      element={guard(
                        'dbinsights',
                        <WorkspaceGate>
                          <ErrorBoundary>
                            <DbInsightsView />
                          </ErrorBoundary>
                        </WorkspaceGate>,
                      )}
                    />
                    <Route
                      path="/review"
                      element={guard(
                        'codereview',
                        <WorkspaceGate>
                          <ErrorBoundary>
                            <ChangeReviewView />
                          </ErrorBoundary>
                        </WorkspaceGate>,
                      )}
                    />
                    <Route
                      path="/workitems"
                      element={guard(
                        'workitems',
                        <WorkspaceGate>
                          <ErrorBoundary>
                            <WorkItemsView />
                          </ErrorBoundary>
                        </WorkspaceGate>,
                      )}
                    />
                    <Route
                      path="/ba/:workItemId"
                      element={guard(
                        'workitems',
                        <WorkspaceGate>
                          <ErrorBoundary>
                            <BaView />
                          </ErrorBoundary>
                        </WorkspaceGate>,
                      )}
                    />
                    <Route
                      path="/codereview/:repoId?"
                      element={guard(
                        'codereview',
                        <WorkspaceGate>
                          <ErrorBoundary>
                            <CodeReviewView />
                          </ErrorBoundary>
                        </WorkspaceGate>,
                      )}
                    />
                    <Route
                      path="/cloud"
                      element={
                        cloudFeaturesEnabled ? (
                          guard(
                            'cloud',
                            <WorkspaceGate>
                              <ErrorBoundary>
                                <MezairCloudView />
                              </ErrorBoundary>
                            </WorkspaceGate>,
                          )
                        ) : (
                          <Navigate to="/settings" replace />
                        )
                      }
                    />
                    <Route
                      path="/automations"
                      element={guard(
                        'automations',
                        <WorkspaceGate>
                          <ErrorBoundary>
                            <AutomationsView />
                          </ErrorBoundary>
                        </WorkspaceGate>,
                      )}
                    />
                    <Route
                      path="/factories"
                      element={guard(
                        'automations',
                        <WorkspaceGate>
                          <ErrorBoundary>
                            <Suspense fallback={<SplashScreen label="Loading factories" />}>
                              <FactoriesView />
                            </Suspense>
                          </ErrorBoundary>
                        </WorkspaceGate>,
                      )}
                    />
                    <Route
                      path="/dojo"
                      element={guard(
                        'dojo',
                        <WorkspaceGate>
                          <ErrorBoundary>
                            <DojoView />
                          </ErrorBoundary>
                        </WorkspaceGate>,
                      )}
                    />
                    <Route
                      path="/workflows"
                      element={guard(
                        'workflows',
                        <WorkspaceGate>
                          <ErrorBoundary>
                            <Suspense fallback={<SplashScreen label="Loading workflows" />}>
                              <WorkflowsView />
                            </Suspense>
                          </ErrorBoundary>
                        </WorkspaceGate>,
                      )}
                    />
                    <Route
                      path="/governance"
                      element={guard(
                        'governance',
                        <WorkspaceGate>
                          <ErrorBoundary>
                            <GovernanceView />
                          </ErrorBoundary>
                        </WorkspaceGate>,
                      )}
                    />
                    <Route
                      path="/browser"
                      element={guard(
                        'browser',
                        <WorkspaceGate>
                          <ErrorBoundary>
                            <BrowserPanel />
                          </ErrorBoundary>
                        </WorkspaceGate>,
                      )}
                    />
                    <Route
                      path="/argent"
                      element={guard(
                        'argent',
                        <WorkspaceGate>
                          <ErrorBoundary>
                            <ArgentView />
                          </ErrorBoundary>
                        </WorkspaceGate>,
                      )}
                    />
                    <Route
                      path="/editor"
                      element={guard(
                        'editor',
                        <WorkspaceGate>
                          <ErrorBoundary>
                            <></>
                          </ErrorBoundary>
                        </WorkspaceGate>,
                      )}
                    />
                    <Route
                      path="/git"
                      element={guard(
                        'git',
                        <WorkspaceGate>
                          <ErrorBoundary>
                            <GitView />
                          </ErrorBoundary>
                        </WorkspaceGate>,
                      )}
                    />
                    <Route
                      path="/settings/:category?"
                      element={
                        <ErrorBoundary>
                          <SettingsView
                            onSettingsSaved={checkConnections}
                            onRoleChange={handleRoleChange}
                            onThemeChange={handleThemeChange}
                            onPreviewOnboarding={() => setOnboardingPreviewStep('welcome')}
                            userRole={userRole}
                          />
                        </ErrorBoundary>
                      }
                    />
                    <Route
                      path="/settings/codex-registry"
                      element={
                        <ErrorBoundary>
                          <CodexRegistryView />
                        </ErrorBoundary>
                      }
                    />
                    <Route
                      path="/diagnostics"
                      element={
                        <ErrorBoundary>
                          <DiagnosticsView />
                        </ErrorBoundary>
                      }
                    />
                    <Route path="*" element={<DefaultRedirect />} />
                  </Route>
                </Routes>
              </Suspense>
            </>
          </ChatProvider>
        </WorkspaceProvider>
      </RepoIndexProvider>
    </BrandProvider>
  );
}
