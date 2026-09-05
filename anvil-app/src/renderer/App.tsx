import { lazy, Suspense, useEffect, useState, useCallback, type ReactNode } from 'react';
import { HashRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { Shell } from './components/layout/Shell';
import { ErrorBoundary } from './components/layout/ErrorBoundary';
import { SplashScreen } from './components/brand/SplashScreen';
import { ChatProvider } from './contexts/ChatContext';
import { BrandProvider } from './contexts/BrandContext';
import { getBrand, getBuildBrandId } from '../shared/branding';
import { WorkspaceProvider, useWorkspace } from './contexts/WorkspaceContext';
import { WorkspaceCreator } from './components/workspace/WorkspaceCreator';
import { RolePickerOverlay } from './components/onboard/RolePickerOverlay';
import { ConnectorSetupOverlay } from './components/onboard/ConnectorSetupOverlay';
import type { UserRole, Feature, AppTheme } from '../shared/types';
import { ROLE_FEATURES } from '../shared/types';

const ReposView = lazy(() =>
  import('./components/repos/ReposView').then((module) => ({ default: module.ReposView })),
);
const ChatView = lazy(() =>
  import('./components/chat/ChatView').then((module) => ({ default: module.ChatView })),
);
const OnboardView = lazy(() =>
  import('./components/onboard/OnboardView').then((module) => ({ default: module.OnboardView })),
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
const SecurityView = lazy(() =>
  import('./components/security/SecurityView').then((module) => ({ default: module.SecurityView })),
);
const CodeReviewView = lazy(() =>
  import('./components/codereview/CodeReviewView').then((module) => ({
    default: module.CodeReviewView,
  })),
);
const CicdView = lazy(() =>
  import('./components/cicd/CicdView').then((module) => ({ default: module.CicdView })),
);
const AutomationsView = lazy(() =>
  import('./components/automations/AutomationsView').then((module) => ({
    default: module.AutomationsView,
  })),
);
const DojoView = lazy(() =>
  import('./components/dojo/DojoView').then((module) => ({ default: module.DojoView })),
);
const DocsView = lazy(() =>
  import('./components/docs/DocsView').then((module) => ({ default: module.DocsView })),
);
const AdrsView = lazy(() =>
  import('./components/adrs/AdrsView').then((module) => ({ default: module.AdrsView })),
);
const DiagramsView = lazy(() =>
  import('./components/diagrams/DiagramsView').then((module) => ({ default: module.DiagramsView })),
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
const ComplianceView = lazy(() =>
  import('./components/compliance/ComplianceView').then((module) => ({
    default: module.ComplianceView,
  })),
);
const DependenciesView = lazy(() =>
  import('./components/dependencies/DependenciesView').then((module) => ({
    default: module.DependenciesView,
  })),
);
const DiagnosticsView = lazy(() =>
  import('./components/diagnostics/DiagnosticsView').then((module) => ({
    default: module.DiagnosticsView,
  })),
);
const AnvilCloudView = lazy(() =>
  import('./components/cloud/AnvilCloudView').then((module) => ({
    default: module.AnvilCloudView,
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
const OpenInAnvilView = lazy(() =>
  import('./components/launch/OpenInAnvilView').then((module) => ({
    default: module.OpenInAnvilView,
  })),
);
const MeetingNotesView = lazy(() =>
  import('./components/meeting/MeetingNotesView').then((module) => ({
    default: module.MeetingNotesView,
  })),
);
const InboxView = lazy(() =>
  import('./components/inbox/InboxView').then((module) => ({ default: module.InboxView })),
);
const WorkspaceNotesView = lazy(() =>
  import('./components/workspace/WorkspaceNotesView').then((module) => ({
    default: module.WorkspaceNotesView,
  })),
);

type OnboardingPreviewStep = 'role' | 'connectors';
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
          await refreshWorkspaces();
        }}
      />
    );
  }

  return <>{children}</>;
}

function LaunchIntentRouter() {
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;

    window.anvil.launch
      .getPendingIntent()
      .then((intent) => {
        if (!cancelled && intent) {
          navigate('/open', { replace: true });
        }
      })
      .catch(() => {});

    const cleanup = window.anvil.launch.onIntent(() => {
      if (!cancelled) {
        navigate('/open', { replace: true });
      }
    });

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [navigate]);

  return null;
}

export function App() {
  const fallbackBrand = getBrand(getBuildBrandId());
  const resolveSystemTheme = useCallback((): Exclude<AppTheme, 'system'> => {
    return fallbackBrand.defaultTheme === 'system' ? 'dark' : fallbackBrand.defaultTheme;
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
  const [connectorsConfigured, setConnectorsConfigured] = useState(false);
  const [onboardingPreviewStep, setOnboardingPreviewStep] = useState<OnboardingPreviewStep | null>(
    null,
  );

  const checkConnections = useCallback(async () => {
    try {
      const settings = await window.anvil.settings.get();
      const brand = await window.brand.get();
      const pendingLaunchIntent = await window.anvil.launch.getPendingIntent();

      setAppTheme(settings.theme ?? brand.defaultTheme);
      setCloudFeaturesEnabled(settings.cloudFeaturesEnabled);
      if (settings.userRole) {
        setUserRole(settings.userRole);
      }
      // Skip connector setup for existing users (they already have workspaces)
      if (settings.activeWorkspaceId || pendingLaunchIntent) {
        setConnectorsConfigured(true);
      }
      setRoleLoaded(true);

      // Only test connections that have credentials configured
      const hasLlm =
        settings.llmProvider === 'azure'
          ? true // Azure is configured via Codex CLI's config.toml
          : settings.llmProvider === 'codex' || settings.llmProvider === 'cursor'
            ? true // CLI-backed providers use their own local auth — always test
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
          ? window.anvil.settings.testFoundryConnection().then((r) => r.ok)
          : Promise.resolve(null),
        hasAdo
          ? window.anvil.settings.testWorkItemProviderConnection().then((r) => r.ok)
          : Promise.resolve(null),
        hasConfluence
          ? window.anvil.settings.testConfluenceConnection().then((r) => r.ok)
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

    window.addEventListener('anvil:cloud-feature-changed', handleCloudFeatureChanged);
    return () =>
      window.removeEventListener('anvil:cloud-feature-changed', handleCloudFeatureChanged);
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

  const guard = (feature: Feature, element: React.ReactElement) =>
    userRole && ROLE_FEATURES[userRole].includes(feature) ? (
      element
    ) : (
      <Navigate
        to={userRole && ROLE_FEATURES[userRole].includes('chat') ? '/chat' : '/repos'}
        replace
      />
    );

  if (!roleLoaded) {
    return <SplashScreen label={`Starting ${fallbackBrand.appName}`} />;
  }

  if (onboardingPreviewStep === 'role') {
    return (
      <BrandProvider>
        <RolePickerOverlay
          preview
          onRoleSelected={() => setOnboardingPreviewStep('connectors')}
          onExitPreview={() => setOnboardingPreviewStep(null)}
        />
      </BrandProvider>
    );
  }

  if (onboardingPreviewStep === 'connectors') {
    return (
      <BrandProvider>
        <ConnectorSetupOverlay
          preview
          onContinue={() => setOnboardingPreviewStep(null)}
          onExitPreview={() => setOnboardingPreviewStep(null)}
        />
      </BrandProvider>
    );
  }

  if (!userRole) {
    return (
      <BrandProvider>
        <RolePickerOverlay onRoleSelected={handleRoleChange} />
      </BrandProvider>
    );
  }

  if (!connectorsConfigured) {
    return (
      <BrandProvider>
        <ConnectorSetupOverlay onContinue={() => setConnectorsConfigured(true)} />
      </BrandProvider>
    );
  }

  return (
    <BrandProvider>
      <WorkspaceProvider>
        <ChatProvider>
          <HashRouter>
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
                        <OpenInAnvilView />
                      </ErrorBoundary>
                    }
                  />

                  <Route
                    path="/meeting-notes"
                    element={guard(
                      'meeting-notes',
                      <WorkspaceGate>
                        <ErrorBoundary>
                          <MeetingNotesView />
                        </ErrorBoundary>
                      </WorkspaceGate>,
                    )}
                  />
                  <Route
                    path="/workspace-notes"
                    element={guard(
                      'workspace-notes',
                      <WorkspaceGate>
                        <ErrorBoundary>
                          <WorkspaceNotesView />
                        </ErrorBoundary>
                      </WorkspaceGate>,
                    )}
                  />
                  <Route
                    path="/chat"
                    element={guard(
                      'chat',
                      <WorkspaceGate>
                        <ErrorBoundary>
                          <ChatView userRole={userRole} />
                        </ErrorBoundary>
                      </WorkspaceGate>,
                    )}
                  />
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
                    path="/onboard"
                    element={guard(
                      'onboard',
                      <WorkspaceGate>
                        <ErrorBoundary>
                          <OnboardView />
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
                    path="/dependencies/:repoId?"
                    element={guard(
                      'dependencies',
                      <WorkspaceGate>
                        <ErrorBoundary>
                          <DependenciesView />
                        </ErrorBoundary>
                      </WorkspaceGate>,
                    )}
                  />
                  <Route
                    path="/security/:repoId/dependencies"
                    element={guard(
                      'dependencies',
                      <WorkspaceGate>
                        <ErrorBoundary>
                          <DependenciesView />
                        </ErrorBoundary>
                      </WorkspaceGate>,
                    )}
                  />
                  <Route
                    path="/security/:repoId?"
                    element={guard(
                      'security',
                      <WorkspaceGate>
                        <ErrorBoundary>
                          <SecurityView />
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
                    path="/cicd"
                    element={guard(
                      'cicd',
                      <WorkspaceGate>
                        <ErrorBoundary>
                          <CicdView />
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
                              <AnvilCloudView />
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
                    path="/docs"
                    element={guard(
                      'docs',
                      <WorkspaceGate>
                        <ErrorBoundary>
                          <DocsView />
                        </ErrorBoundary>
                      </WorkspaceGate>,
                    )}
                  />
                  <Route
                    path="/adrs"
                    element={guard(
                      'adrs',
                      <WorkspaceGate>
                        <ErrorBoundary>
                          <AdrsView />
                        </ErrorBoundary>
                      </WorkspaceGate>,
                    )}
                  />
                  <Route
                    path="/diagrams/:repoId?"
                    element={guard(
                      'diagrams',
                      <WorkspaceGate>
                        <ErrorBoundary>
                          <DiagramsView />
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
                    path="/compliance"
                    element={guard(
                      'compliance',
                      <WorkspaceGate>
                        <ErrorBoundary>
                          <ComplianceView />
                        </ErrorBoundary>
                      </WorkspaceGate>,
                    )}
                  />
                  <Route
                    path="/settings"
                    element={
                      <ErrorBoundary>
                        <SettingsView
                          onSettingsSaved={checkConnections}
                          onRoleChange={handleRoleChange}
                          onThemeChange={handleThemeChange}
                          onPreviewOnboarding={() => setOnboardingPreviewStep('role')}
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
                  <Route path="*" element={<Navigate to="/chat" replace />} />
                </Route>
              </Routes>
            </Suspense>
          </HashRouter>
        </ChatProvider>
      </WorkspaceProvider>
    </BrandProvider>
  );
}
