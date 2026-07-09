import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  BarChart3,
  Bot,
  CheckCircle,
  Clock3,
  ClipboardCheck,
  Code2,
  Cloud,
  FolderGit2,
  Gauge,
  Loader2,
  MonitorSmartphone,
  Palette,
  Puzzle,
  RefreshCcw,
  Save,
  Settings,
  ShieldAlert,
  Smartphone,
  Trash2,
  UserRound,
  XCircle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type {
  AppSettings,
  AppTheme,
  CodexCliStatus,
  CodexUsageSnapshot,
  DocsProvider,
  MobileCompanionDevice,
  MobileCompanionStatus,
  MobilePairingTicket,
  RaycastCompanionToken,
  ReasoningEffort,
  UserRole,
} from '../../../shared/types';
import {
  CODEX_MODEL_OPTIONS,
  CODEX_REASONING_EFFORTS,
  DEFAULT_CODEX_MODEL,
  resolveCodexReasoningEffort,
  type CodexModelOption,
} from '../../../shared/codex-models';
import { useBrand } from '../../contexts/BrandContext';
import { dispatchCodexSelectionChanged } from '../../utils/codex-selection';

type TestStatus = 'idle' | 'testing' | 'ok' | 'error';
type SettingsCategoryId = 'profile' | 'ai' | 'delivery' | 'review' | 'devices' | 'danger';
type CodexAgentsStatus = { tone: 'success' | 'error'; message: string };
type CodexModelPickerOption = CodexModelOption & { source: 'docs' | 'cli' };

const SETTINGS_CATEGORIES: Array<{
  id: SettingsCategoryId;
  label: string;
  description: string;
  icon: LucideIcon;
}> = [
  {
    id: 'profile',
    label: 'Profile & appearance',
    description: 'Role, visible tools, and theme.',
    icon: UserRound,
  },
  {
    id: 'ai',
    label: 'AI & Codex',
    description: 'Model backend, reasoning, skills, and MCPs.',
    icon: Bot,
  },
  {
    id: 'delivery',
    label: 'Delivery integrations',
    description: 'Work items, docs, Git, and remote credentials.',
    icon: FolderGit2,
  },
  {
    id: 'review',
    label: 'Review defaults',
    description: 'Rubrics used by code review workflows.',
    icon: ClipboardCheck,
  },
  {
    id: 'devices',
    label: 'Devices & system',
    description: 'Repo defaults and mobile companion access.',
    icon: MonitorSmartphone,
  },
  {
    id: 'danger',
    label: 'Danger area',
    description: 'Reset setup state and workspace selections.',
    icon: ShieldAlert,
  },
];

interface SettingsViewProps {
  onSettingsSaved?: () => void;
  onRoleChange?: (role: UserRole) => void;
  onThemeChange?: (theme: AppTheme) => void;
  userRole?: UserRole;
}

const THEME_OPTIONS: Array<{
  id: AppTheme;
  label: string;
  description: string;
  swatches: [string, string, string];
}> = [
  {
    id: 'system',
    label: 'System',
    description: 'Use the default Anvil workspace theme.',
    swatches: ['#0b1020', '#1f2937', '#ff8a3d'],
  },
  {
    id: 'dark',
    label: 'Anvil Core',
    description: 'Cooler default, less toasted workshop.',
    swatches: ['#0b1020', '#14213d', '#ff8a3d'],
  },
  {
    id: 'prompt-whisperer',
    label: 'Prompt Whisperer',
    description: 'Soft teal for calm context herding.',
    swatches: ['#071b1f', '#12343b', '#3ddbd9'],
  },
  {
    id: 'merge-conflict',
    label: 'Merge Conflict',
    description: 'Red and cyan, but on speaking terms.',
    swatches: ['#120d18', '#2d1736', '#ff5c8a'],
  },
  {
    id: 'token-bender',
    label: 'Token Bender',
    description: 'High-energy violet for long reasoning loops.',
    swatches: ['#100f2a', '#211a4f', '#9f7aea'],
  },
  {
    id: 'agent-after-hours',
    label: 'Agent After Hours',
    description: 'Late-night graphite with laser green signal.',
    swatches: ['#07110d', '#17241d', '#6ee7b7'],
  },
];

function buildCodexModelOptions(status: CodexCliStatus | null): CodexModelPickerOption[] {
  const detected = status?.models
    ?.filter((model) => !model.hidden)
    .map<CodexModelPickerOption>((model) => ({
      id: model.id,
      label: model.displayName ?? model.id,
      tier: 'preview',
      description: model.description ?? 'Detected from the local Codex CLI model catalog.',
      defaultReasoningEffort: model.defaultReasoningEffort ?? 'medium',
      supportedReasoningEfforts: model.supportedReasoningEfforts,
      recommended: model.id === DEFAULT_CODEX_MODEL,
      source: 'cli',
    }));

  if (detected?.length) {
    return detected;
  }

  return CODEX_MODEL_OPTIONS.map((model) => ({ ...model, source: 'docs' }));
}

export function SettingsView({
  onSettingsSaved,
  onRoleChange,
  onThemeChange,
  userRole,
}: SettingsViewProps) {
  const navigate = useNavigate();
  const brand = useBrand();
  const [settings, setSettings] = useState<Partial<AppSettings>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [llmStatus, setLlmStatus] = useState<TestStatus>('idle');
  const [appleFoundationModelsStatus, setAppleFoundationModelsStatus] =
    useState<TestStatus>('idle');
  const [wiStatus, setWiStatus] = useState<TestStatus>('idle');
  const [confluenceStatus, setConfluenceStatus] = useState<TestStatus>('idle');
  const [testError, setTestError] = useState<string | null>(null);
  const [linearTeams, setLinearTeams] = useState<Array<{ id: string; name: string; key: string }>>(
    [],
  );
  const [loadingTeams, setLoadingTeams] = useState(false);
  const [gitProvider, setGitProvider] = useState<'github' | 'ado'>('github');
  const [gitStatus, setGitStatus] = useState<TestStatus>('idle');
  const [ghUsername, setGhUsername] = useState<string | null>(null);
  const [ghError, setGhError] = useState<string | null>(null);
  const [docsProvider, setDocsProvider] = useState<DocsProvider | 'none'>('confluence');
  const [docsStatus, setDocsStatus] = useState<TestStatus>('idle');
  const [notionMcpInstalled, setNotionMcpInstalled] = useState(false);
  const [notionInstalling, setNotionInstalling] = useState(false);
  const [notionConnecting, setNotionConnecting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetDone, setResetDone] = useState(false);
  const [mobileStatus, setMobileStatus] = useState<MobileCompanionStatus | null>(null);
  const [mobileDevices, setMobileDevices] = useState<MobileCompanionDevice[]>([]);
  const [pairingTicket, setPairingTicket] = useState<MobilePairingTicket | null>(null);
  const [raycastToken, setRaycastToken] = useState<RaycastCompanionToken | null>(null);
  const [mobileBusy, setMobileBusy] = useState(false);
  const [codexUsage, setCodexUsage] = useState<CodexUsageSnapshot | null>(null);
  const [codexUsageLoading, setCodexUsageLoading] = useState(false);
  const [codexStatus, setCodexStatus] = useState<CodexCliStatus | null>(null);
  const [codexAgentsContent, setCodexAgentsContent] = useState('');
  const [codexAgentsPath, setCodexAgentsPath] = useState('~/.codex/AGENTS.md');
  const [codexAgentsExists, setCodexAgentsExists] = useState(false);
  const [codexAgentsUpdatedAt, setCodexAgentsUpdatedAt] = useState<string | null>(null);
  const [codexAgentsLoading, setCodexAgentsLoading] = useState(false);
  const [codexAgentsSaving, setCodexAgentsSaving] = useState(false);
  const [codexAgentsStatus, setCodexAgentsStatus] = useState<CodexAgentsStatus | null>(null);

  useEffect(() => {
    window.anvil.settings.get().then((s) => {
      setSettings(s);
      if (s.adoPat || s.adoOrganizationUrl) {
        setGitProvider('ado');
      }
      setDocsProvider(s.docsProvider ?? 'confluence');
    });
    // Check gh CLI auth on mount
    window.anvil.repo.ghAuthStatus().then((status) => {
      if (status.authenticated) {
        setGhUsername(status.username ?? null);
        setGitStatus('ok');
      } else {
        setGhError(status.error ?? null);
      }
    });
    // Check Notion MCP status
    window.anvil.settings.getNotionMcpStatus().then((s) => {
      setNotionMcpInstalled(s.installed);
    });
    window.anvil.settings.getCodexStatus().then(setCodexStatus).catch(console.warn);
    refreshMobileCompanion().catch(console.error);
    refreshCodexUsage().catch(console.error);
    refreshCodexAgentsFile().catch(console.error);
  }, []);

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const updateCloudFeatures = async (enabled: boolean) => {
    setSettings((prev) => ({ ...prev, cloudFeaturesEnabled: enabled }));
    setSaved(false);
    try {
      await window.anvil.settings.update({ cloudFeaturesEnabled: enabled });
      window.dispatchEvent(new CustomEvent('anvil:cloud-feature-changed', { detail: { enabled } }));
      setSaved(true);
      onSettingsSaved?.();
    } catch (err) {
      setTestError(err instanceof Error ? err.message : 'Failed to update Anvil Cloud access');
    }
  };

  const updateTheme = async (theme: AppTheme) => {
    setSettings((prev) => ({ ...prev, theme }));
    setSaved(false);
    onThemeChange?.(theme);

    try {
      await window.anvil.settings.update({ theme });
      setSaved(true);
      onSettingsSaved?.();
    } catch (err) {
      setTestError(err instanceof Error ? err.message : 'Failed to update theme');
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const model = settings.openaiModel ?? DEFAULT_CODEX_MODEL;
      const reasoningEffort = resolveCodexReasoningEffort(
        model,
        settings.reasoningLevel,
        codexStatus?.models,
      );
      const settingsToSave = {
        ...settings,
        openaiModel: model,
        reasoningLevel: reasoningEffort,
      };
      await window.anvil.settings.update(settingsToSave);
      setSettings(settingsToSave);
      if (settingsToSave.chatLayout === 'classic' || settingsToSave.chatLayout === 'workitems') {
        window.dispatchEvent(
          new CustomEvent('anvil:chat-layout-changed', { detail: settingsToSave.chatLayout }),
        );
      }
      dispatchCodexSelectionChanged({ model, reasoningEffort });
      setSaved(true);
      onSettingsSaved?.();
    } finally {
      setSaving(false);
    }
  };

  const saveBeforeTest = async () => {
    await window.anvil.settings.update(settings);
  };

  const refreshMobileCompanion = async () => {
    const [status, devices] = await Promise.all([
      window.anvil.mobileCompanion.getStatus(),
      window.anvil.mobileCompanion.listDevices(),
    ]);
    setMobileStatus(status);
    setMobileDevices(devices);
  };

  const refreshCodexUsage = async () => {
    setCodexUsageLoading(true);
    try {
      setCodexUsage(await window.anvil.codexUsage.snapshot());
    } finally {
      setCodexUsageLoading(false);
    }
  };

  const refreshCodexAgentsFile = async () => {
    setCodexAgentsLoading(true);
    setCodexAgentsStatus(null);
    try {
      const file = await window.anvil.settings.getCodexAgentsFile();
      setCodexAgentsContent(file.content);
      setCodexAgentsPath(file.path);
      setCodexAgentsExists(file.exists);
      setCodexAgentsUpdatedAt(file.updatedAt ?? null);
    } catch (err) {
      setCodexAgentsStatus({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Failed to read Codex AGENTS.md',
      });
    } finally {
      setCodexAgentsLoading(false);
    }
  };

  const saveCodexAgentsFile = async () => {
    setCodexAgentsSaving(true);
    setCodexAgentsStatus(null);
    try {
      const result = await window.anvil.settings.saveCodexAgentsFile(codexAgentsContent);
      setCodexAgentsPath(result.path);
      setCodexAgentsExists(true);
      setCodexAgentsUpdatedAt(result.savedAt);
      setCodexAgentsStatus({
        tone: 'success',
        message: `Saved ${new Intl.NumberFormat().format(result.bytes)} bytes.`,
      });
    } catch (err) {
      setCodexAgentsStatus({
        tone: 'error',
        message: err instanceof Error ? err.message : 'Failed to save Codex AGENTS.md',
      });
    } finally {
      setCodexAgentsSaving(false);
    }
  };

  const toggleMobileCompanion = async () => {
    setMobileBusy(true);
    setTestError(null);
    try {
      const status = await window.anvil.mobileCompanion.setEnabled(!mobileStatus?.enabled);
      setMobileStatus(status);
      if (!status.enabled) setPairingTicket(null);
      await refreshMobileCompanion();
    } catch (err) {
      setTestError(err instanceof Error ? err.message : 'Failed to update mobile companion');
    } finally {
      setMobileBusy(false);
    }
  };

  const createPairingTicket = async () => {
    setMobileBusy(true);
    setTestError(null);
    try {
      const ticket = await window.anvil.mobileCompanion.createPairingTicket();
      setPairingTicket(ticket);
      await refreshMobileCompanion();
    } catch (err) {
      setTestError(err instanceof Error ? err.message : 'Failed to create pairing QR code');
    } finally {
      setMobileBusy(false);
    }
  };

  const createRaycastToken = async () => {
    setMobileBusy(true);
    setTestError(null);
    try {
      const token = await window.anvil.mobileCompanion.createRaycastToken();
      setRaycastToken(token);
      await refreshMobileCompanion();
    } catch (err) {
      setTestError(err instanceof Error ? err.message : 'Failed to create Raycast token');
    } finally {
      setMobileBusy(false);
    }
  };

  const revokeMobileDevice = async (deviceId: string) => {
    setMobileBusy(true);
    try {
      await window.anvil.mobileCompanion.revokeDevice(deviceId);
      await refreshMobileCompanion();
    } finally {
      setMobileBusy(false);
    }
  };

  const testLlm = async () => {
    setLlmStatus('testing');
    setTestError(null);
    await saveBeforeTest();
    const result = await window.anvil.settings.testFoundryConnection();
    setLlmStatus(result.ok ? 'ok' : 'error');
    if (result.error) setTestError(result.error);
  };

  const testAppleFoundationModels = async () => {
    setAppleFoundationModelsStatus('testing');
    setTestError(null);
    await saveBeforeTest();
    const result = await window.anvil.settings.testAppleFoundationModels();
    setAppleFoundationModelsStatus(result.ok ? 'ok' : 'error');
    if (result.error) setTestError(result.error);
  };

  const testWi = async () => {
    setWiStatus('testing');
    setTestError(null);
    try {
      await saveBeforeTest();
      const result = await window.anvil.settings.testWorkItemProviderConnection();
      setWiStatus(result.ok ? 'ok' : 'error');
      if (result.error) setTestError(result.error);
    } catch (err) {
      setWiStatus('error');
      setTestError(err instanceof Error ? err.message : 'Connection test failed');
    }
  };

  const testConfluence = async () => {
    setConfluenceStatus('testing');
    setTestError(null);
    await saveBeforeTest();
    const result = await window.anvil.settings.testConfluenceConnection();
    setConfluenceStatus(result.ok ? 'ok' : 'error');
    if (result.error) setTestError(result.error);
  };

  const testGit = async () => {
    setGitStatus('testing');
    setTestError(null);
    setGhError(null);
    await saveBeforeTest();
    try {
      if (gitProvider === 'github') {
        const status = await window.anvil.repo.ghAuthStatus();
        if (status.authenticated) {
          setGitStatus('ok');
          setGhUsername(status.username ?? null);
        } else {
          setGitStatus('error');
          setGhError(status.error ?? 'Not authenticated');
          setTestError(status.error ?? 'Not authenticated');
        }
      } else {
        const result = await window.anvil.settings.testGitConnection();
        setGitStatus(result.ok ? 'ok' : 'error');
        if (result.error) setTestError(result.error);
      }
    } catch (err) {
      setGitStatus('error');
      setTestError(err instanceof Error ? err.message : 'Connection test failed');
    }
  };

  const testDocs = async () => {
    setDocsStatus('testing');
    setTestError(null);
    await saveBeforeTest();
    try {
      const result = await window.anvil.settings.testDocsProviderConnection();
      setDocsStatus(result.ok ? 'ok' : 'error');
      if (result.error) setTestError(result.error);
    } catch (err) {
      setDocsStatus('error');
      setTestError(err instanceof Error ? err.message : 'Connection test failed');
    }
  };

  const installNotionMcp = async () => {
    setNotionInstalling(true);
    setTestError(null);
    try {
      const result = await window.anvil.settings.installNotionMcp();
      if (result.success) {
        setNotionMcpInstalled(true);
      } else {
        setTestError(result.error ?? 'Failed to install Notion MCP');
      }
    } catch (err) {
      setTestError(err instanceof Error ? err.message : 'Failed to install Notion MCP');
    } finally {
      setNotionInstalling(false);
    }
  };

  const connectNotion = async () => {
    setNotionConnecting(true);
    setTestError(null);
    try {
      const { authUrl } = await window.anvil.settings.startNotionOAuthFlow();
      if (authUrl) {
        window.open(authUrl, '_blank');
      }
    } catch (err) {
      setTestError(err instanceof Error ? err.message : 'Failed to start Notion OAuth');
    } finally {
      setNotionConnecting(false);
    }
  };

  const handleResetOnboarding = async () => {
    setResetting(true);
    setTestError(null);
    try {
      const result = await window.anvil.settings.resetOnboarding();
      if (result.success) {
        setResetDone(true);
        setTimeout(() => setResetDone(false), 3000);
      } else {
        setTestError(result.error ?? 'Failed to reset onboarding');
      }
    } catch (err) {
      setTestError(err instanceof Error ? err.message : 'Failed to reset onboarding');
    } finally {
      setResetting(false);
    }
  };

  const provider = settings.llmProvider ?? 'codex';
  const wiProvider = settings.workItemProvider ?? 'ado';
  const selectedDocsProvider = docsProvider;
  const themeOptions = THEME_OPTIONS;
  const persistedTheme = settings.theme ?? brand.defaultTheme;
  const selectedTheme = themeOptions.some((theme) => theme.id === persistedTheme)
    ? persistedTheme
    : brand.defaultTheme;
  const selectedThemeLabel =
    themeOptions.find((theme) => theme.id === selectedTheme)?.label ?? selectedTheme;
  const selectedChatLayout = settings.chatLayout ?? 'classic';
  const selectedChatLayoutLabel = selectedChatLayout === 'workitems' ? 'Work items' : 'Classic';
  const roleLabel =
    userRole === 'ba-brm' ? 'BA / BRM' : userRole === 'design' ? 'Design' : 'Developer';
  const aiProviderLabel =
    provider === 'codex' ? 'Codex CLI' : provider === 'azure' ? 'Azure AI Foundry' : 'OpenAI API';
  const codexModelOptions = buildCodexModelOptions(codexStatus);
  const selectedModelId = settings.openaiModel ?? DEFAULT_CODEX_MODEL;
  const selectedModel = codexModelOptions.find((model) => model.id === selectedModelId);
  const reasoningOptions = selectedModel?.supportedReasoningEfforts?.length
    ? selectedModel.supportedReasoningEfforts
    : CODEX_REASONING_EFFORTS;
  const selectedReasoningEffort = resolveCodexReasoningEffort(
    selectedModelId,
    settings.reasoningLevel,
    codexStatus?.models,
  );
  const updateCodexModel = (modelId: string) => {
    const reasoningEffort = resolveCodexReasoningEffort(
      modelId,
      settings.reasoningLevel,
      codexStatus?.models,
    );
    setSettings((prev) => ({ ...prev, openaiModel: modelId, reasoningLevel: reasoningEffort }));
    setSaved(false);
  };
  const deliverySummary = [
    wiProvider === 'none' ? 'No work items' : wiProvider.toUpperCase(),
    selectedDocsProvider === 'none' ? 'No docs' : selectedDocsProvider,
    gitProvider === 'ado' ? 'ADO Git' : 'GitHub',
  ];
  const saveStateLabel = saving ? 'Saving' : saved ? 'Saved' : 'Unsaved changes';

  const jumpToCategory = (id: SettingsCategoryId) => {
    document.getElementById(`settings-${id}`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  };

  return (
    <div className="h-full overflow-auto p-4 md:p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        <header className="rounded-lg border border-border bg-bg-secondary p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 space-y-2">
              <div className="flex items-center gap-3">
                <div className="rounded-md border border-border-subtle bg-bg-primary p-2 text-accent">
                  <Settings size={20} />
                </div>
                <div>
                  <h2 className="text-xl font-semibold text-text-primary">Settings</h2>
                  <p className="text-sm text-text-secondary">
                    Configure identity, AI backends, delivery tools, and local devices.
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                <SummaryChip label="Role" value={roleLabel} />
                <SummaryChip label="Theme" value={selectedThemeLabel} />
                <SummaryChip label="Chat" value={selectedChatLayoutLabel} />
                <SummaryChip label="AI" value={aiProviderLabel} />
                <SummaryChip label="Cloud" value={settings.cloudFeaturesEnabled ? 'On' : 'Off'} />
                <SummaryChip label="Mobile" value={mobileStatus?.enabled ? 'Enabled' : 'Off'} />
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-3">
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
                  saved
                    ? 'border-success/30 bg-success/10 text-success'
                    : 'border-border-subtle bg-bg-primary text-text-tertiary'
                }`}
              >
                {saving ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : saved ? (
                  <CheckCircle size={12} />
                ) : (
                  <Save size={12} />
                )}
                {saveStateLabel}
              </span>
              <button
                onClick={handleSave}
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
                aria-label={saving ? 'Saving settings' : 'Save settings'}
              >
                {saving && <Loader2 size={14} className="animate-spin" />}
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>

          {testError && (
            <div className="mt-4 rounded-md border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
              {testError}
            </div>
          )}
        </header>

        <nav className="flex gap-2 overflow-x-auto pb-1 lg:hidden" aria-label="Settings sections">
          {SETTINGS_CATEGORIES.map((category) => {
            const Icon = category.icon;
            return (
              <button
                key={category.id}
                onClick={() => jumpToCategory(category.id)}
                className="inline-flex shrink-0 items-center gap-2 rounded-md border border-border bg-bg-secondary px-3 py-2 text-sm text-text-secondary transition-colors hover:border-text-tertiary hover:text-text-primary"
              >
                <Icon size={14} />
                {category.label}
              </button>
            );
          })}
        </nav>

        <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <aside className="hidden lg:block">
            <nav
              className="sticky top-6 space-y-1 rounded-lg border border-border bg-bg-secondary p-2"
              aria-label="Settings sections"
            >
              {SETTINGS_CATEGORIES.map((category) => {
                const Icon = category.icon;
                return (
                  <button
                    key={category.id}
                    onClick={() => jumpToCategory(category.id)}
                    className="flex w-full items-start gap-3 rounded-md px-3 py-2 text-left transition-colors hover:bg-bg-tertiary"
                  >
                    <Icon size={16} className="mt-0.5 shrink-0 text-accent" />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-text-primary">
                        {category.label}
                      </span>
                      <span className="block text-xs text-text-tertiary">
                        {category.description}
                      </span>
                    </span>
                  </button>
                );
              })}
            </nav>
          </aside>

          <main className="space-y-6">
            <SettingsCategory
              id="profile"
              title="Profile & appearance"
              description="Choose who the workspace is optimised for and how the app presents itself."
              icon={Palette}
            >
              <SettingsPanel
                title="Role"
                description="Controls which tools are visible in the sidebar."
              >
                <ButtonGrid>
                  <ProviderButton
                    label="Developer"
                    description="Full access to all tools"
                    active={userRole === 'developer'}
                    onClick={async () => {
                      try {
                        await window.anvil.settings.update({ userRole: 'developer' });
                        onRoleChange?.('developer');
                      } catch (err) {
                        console.error('[Settings] Failed to update role:', err);
                      }
                    }}
                  />
                  <ProviderButton
                    label="BA / BRM"
                    description="Docs, diagrams, chat & work items"
                    active={userRole === 'ba-brm'}
                    onClick={async () => {
                      try {
                        await window.anvil.settings.update({ userRole: 'ba-brm' });
                        onRoleChange?.('ba-brm');
                      } catch (err) {
                        console.error('[Settings] Failed to update role:', err);
                      }
                    }}
                  />
                  <ProviderButton
                    label="Design"
                    description="Design companion with Figma & diagrams"
                    active={userRole === 'design'}
                    onClick={async () => {
                      try {
                        await window.anvil.settings.update({ userRole: 'design' });
                        onRoleChange?.('design');
                      } catch (err) {
                        console.error('[Settings] Failed to update role:', err);
                      }
                    }}
                  />
                </ButtonGrid>
              </SettingsPanel>

              <SettingsPanel
                title="Theme"
                description="Pick the colour mood for the app. The names are not ISO-certified, which is frankly for the best."
              >
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {themeOptions.map((theme) => (
                    <ThemeButton
                      key={theme.id}
                      label={theme.label}
                      description={theme.description}
                      swatches={theme.swatches}
                      active={selectedTheme === theme.id}
                      onClick={() => updateTheme(theme.id)}
                    />
                  ))}
                </div>
              </SettingsPanel>

              <SettingsPanel
                title="Chat layout"
                description="Choose how Chat organises conversations."
              >
                <ButtonGrid>
                  <ProviderButton
                    label="Classic threads"
                    description="Threads are grouped by persona"
                    active={selectedChatLayout === 'classic'}
                    onClick={() => update('chatLayout', 'classic')}
                  />
                  <ProviderButton
                    label="Work-item threads"
                    description="Left panel tickets own the threads"
                    active={selectedChatLayout === 'workitems'}
                    onClick={() => update('chatLayout', 'workitems')}
                  />
                </ButtonGrid>
              </SettingsPanel>
            </SettingsCategory>

            <SettingsCategory
              id="ai"
              title="AI & Codex"
              description="Model routing, reasoning behaviour, skills, and MCP registry access."
              icon={Bot}
            >
              <SettingsPanel
                title="LLM Provider"
                description="Select the backend used for AI calls."
              >
                <div className="space-y-3">
                  <label className="block text-sm text-text-secondary">Backend</label>
                  <ButtonGrid>
                    <ProviderButton
                      label="Codex CLI"
                      description="Zero-config — uses your existing Codex login"
                      active={provider === 'codex'}
                      onClick={() => update('llmProvider', 'codex')}
                    />
                    <ProviderButton
                      label="OpenAI API Key"
                      description="Use a separate API key"
                      active={provider === 'openai'}
                      onClick={() => update('llmProvider', 'openai')}
                    />
                    <ProviderButton
                      label="Azure AI Foundry"
                      description="Enterprise Azure — configured via Codex"
                      active={provider === 'azure'}
                      onClick={() => update('llmProvider', 'azure')}
                    />
                  </ButtonGrid>
                </div>

                {provider === 'codex' && (
                  <p className="text-sm text-text-secondary">
                    Preferred path. Routes requests through your local Codex CLI using ChatGPT
                    sign-in and the same local app-server protocol as Codex surfaces. API keys stay
                    optional for direct OpenAI utility calls.
                  </p>
                )}

                {provider === 'openai' && (
                  <>
                    <Field
                      label="API Key"
                      value={settings.openaiApiKey ?? ''}
                      onChange={(v) => update('openaiApiKey', v)}
                      type="password"
                      placeholder="sk-..."
                    />
                  </>
                )}

                {(provider === 'codex' || provider === 'openai') && (
                  <div className="space-y-4 rounded-md border border-border bg-bg-primary p-4">
                    <div className="space-y-1">
                      <label className="block text-sm text-text-secondary">Codex Model</label>
                      <select
                        value={selectedModelId}
                        onChange={(event) => updateCodexModel(event.target.value)}
                        className="w-full rounded-md border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
                      >
                        {codexModelOptions.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.label} - {model.id}
                          </option>
                        ))}
                      </select>
                      <p className="text-xs text-text-tertiary">
                        {codexStatus?.installed
                          ? `Codex CLI ${codexStatus.version ?? 'installed'}${
                              codexStatus.models?.length
                                ? ` · ${codexStatus.models.length} models detected`
                                : ' · using docs-backed defaults'
                            }`
                          : 'Using docs-backed model defaults until Codex CLI is available.'}
                      </p>
                      {codexStatus?.features && (
                        <div className="flex flex-wrap gap-2 pt-1">
                          <CapabilityChip
                            label="Computer use"
                            active={Boolean(codexStatus.features.computer_use?.enabled)}
                          />
                          <CapabilityChip
                            label="Browser use"
                            active={Boolean(codexStatus.features.browser_use?.enabled)}
                          />
                          <CapabilityChip
                            label="Multi-agent"
                            active={Boolean(codexStatus.features.multi_agent?.enabled)}
                          />
                          <CapabilityChip
                            label="Voice"
                            active={Boolean(codexStatus.features.realtime_conversation?.enabled)}
                          />
                          <CapabilityChip
                            label={`Web search: ${codexStatus.webSearchMode ?? 'unknown'}`}
                            active={
                              Boolean(codexStatus.webSearchMode) &&
                              codexStatus.webSearchMode !== 'disabled'
                            }
                          />
                        </div>
                      )}
                    </div>

                    <div className="grid gap-2 sm:grid-cols-2">
                      {codexModelOptions.map((model) => (
                        <button
                          key={model.id}
                          type="button"
                          onClick={() => updateCodexModel(model.id)}
                          className={`rounded-lg border p-3 text-left transition-colors ${
                            selectedModelId === model.id
                              ? 'border-accent bg-accent/10'
                              : 'border-border bg-bg-secondary hover:bg-bg-tertiary'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span
                              className={`text-sm font-medium ${
                                selectedModelId === model.id ? 'text-accent' : 'text-text-primary'
                              }`}
                            >
                              {model.label}
                            </span>
                            {model.recommended && (
                              <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-success">
                                Recommended
                              </span>
                            )}
                          </div>
                          <p className="mt-1 text-xs text-text-tertiary">{model.description}</p>
                          {model.source === 'cli' && (
                            <p className="mt-2 text-[10px] font-medium uppercase tracking-wide text-text-tertiary">
                              Detected from Codex CLI
                            </p>
                          )}
                        </button>
                      ))}
                    </div>

                    <div className="space-y-1">
                      <label className="block text-sm text-text-secondary">Reasoning Effort</label>
                      <div className="grid gap-2 sm:grid-cols-4">
                        {reasoningOptions.map((effort) => (
                          <ReasoningButton
                            key={effort}
                            label={formatReasoningLabel(effort)}
                            description={describeReasoningEffort(effort)}
                            active={selectedReasoningEffort === effort}
                            onClick={() => update('reasoningLevel', effort)}
                          />
                        ))}
                      </div>
                      <p className="text-xs text-text-tertiary">
                        Max gives one task more depth. Ultra uses subagents for work that can split
                        into meaningful parts.
                      </p>
                    </div>
                  </div>
                )}

                {provider === 'azure' && (
                  <div className="rounded-md border border-border bg-bg-primary p-4 space-y-3">
                    <p className="text-sm text-text-primary">
                      Azure AI Foundry is configured through the Codex CLI's{' '}
                      <code className="rounded bg-bg-tertiary px-1.5 py-0.5 text-xs font-mono text-text-primary">
                        ~/.codex/config.toml
                      </code>
                    </p>
                    <div className="rounded-md bg-bg-tertiary p-3 font-mono text-xs leading-relaxed space-y-0.5 overflow-x-auto">
                      <p className="text-text-tertiary select-none"># ~/.codex/config.toml</p>
                      <p>
                        <span className="text-text-secondary">model</span>{' '}
                        <span className="text-text-tertiary">=</span>{' '}
                        <span className="text-success">"gpt-5.6-sol"</span>{' '}
                        <span className="text-text-tertiary">
                          # Replace with your actual Azure model deployment name
                        </span>
                      </p>
                      <p>
                        <span className="text-text-secondary">model_provider</span>{' '}
                        <span className="text-text-tertiary">=</span>{' '}
                        <span className="text-success">"azure"</span>
                      </p>
                      <p>
                        <span className="text-text-secondary">model_reasoning_effort</span>{' '}
                        <span className="text-text-tertiary">=</span>{' '}
                        <span className="text-success">"medium"</span>
                      </p>
                      <p />
                      <p>
                        <span className="text-text-tertiary">[model_providers.azure]</span>
                      </p>
                      <p>
                        <span className="text-text-secondary">name</span>{' '}
                        <span className="text-text-tertiary">=</span>{' '}
                        <span className="text-success">"Azure OpenAI"</span>
                      </p>
                      <p>
                        <span className="text-text-secondary">base_url</span>{' '}
                        <span className="text-text-tertiary">=</span>{' '}
                        <span className="text-success">
                          "https://your-resource.cognitiveservices.azure.com/openai/v1"
                        </span>
                      </p>
                      <p>
                        <span className="text-text-secondary">env_key</span>{' '}
                        <span className="text-text-tertiary">=</span>{' '}
                        <span className="text-success">"AZURE_OPENAI_API_KEY"</span>
                      </p>
                      <p>
                        <span className="text-text-secondary">wire_api</span>{' '}
                        <span className="text-text-tertiary">=</span>{' '}
                        <span className="text-success">"responses"</span>
                      </p>
                    </div>
                    <p className="text-sm text-text-secondary">
                      Set{' '}
                      <code className="rounded bg-bg-tertiary px-1.5 py-0.5 text-xs font-mono text-text-primary">
                        AZURE_OPENAI_API_KEY
                      </code>{' '}
                      to your Azure API key in your shell profile, then restart {brand.appName}.
                    </p>
                    <a
                      href="https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/codex?tabs=npm"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-sm text-info hover:underline"
                    >
                      Full setup guide — Microsoft Learn ↗
                    </a>
                  </div>
                )}

                <div className="rounded-md border border-border bg-bg-primary p-4 space-y-3">
                  <div className="space-y-1">
                    <label className="block text-sm text-text-secondary">
                      Apple Foundation Models
                    </label>
                    <p className="text-sm text-text-secondary">
                      Optionally try the on-device Apple model for short helper prompts, then fall
                      back to the selected backend when unavailable or unsuitable.
                    </p>
                  </div>
                  <ButtonGrid>
                    <ProviderButton
                      label="Off"
                      description="Always use selected backend"
                      active={(settings.appleFoundationModelsMode ?? 'off') === 'off'}
                      onClick={() => update('appleFoundationModelsMode', 'off')}
                    />
                    <ProviderButton
                      label="Prefer simple"
                      description="Try local model for small helper prompts"
                      active={settings.appleFoundationModelsMode === 'prefer-simple'}
                      onClick={() => update('appleFoundationModelsMode', 'prefer-simple')}
                    />
                  </ButtonGrid>
                  <p className="text-xs text-text-tertiary">
                    Requires macOS 26, Apple Intelligence support, and Apple Intelligence enabled.
                    Chat, BA sessions, code review analysis, security, compliance, diagrams, and
                    long-context work stay on the configured backend.
                  </p>
                  <TestButton
                    status={appleFoundationModelsStatus}
                    onClick={testAppleFoundationModels}
                    label="Test Apple Models"
                  />
                </div>

                {provider !== 'azure' && <TestButton status={llmStatus} onClick={testLlm} />}
              </SettingsPanel>

              <SettingsPanel
                title="Codex Registry"
                description="Inspect registered Codex skills and MCP servers, then install new skills from skills.sh."
              >
                <button
                  onClick={() => navigate('/settings/codex-registry')}
                  className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium text-text-secondary transition-colors hover:border-text-tertiary hover:bg-bg-tertiary hover:text-text-primary"
                >
                  <Puzzle size={14} />
                  Manage Skills & MCPs
                </button>
              </SettingsPanel>

              <SettingsPanel
                title="Codex Usage"
                description="Live account usage and quota windows from Codex app-server when the local CLI exposes them."
              >
                <CodexUsagePanel
                  snapshot={codexUsage}
                  loading={codexUsageLoading}
                  onRefresh={refreshCodexUsage}
                />
              </SettingsPanel>

              <SettingsPanel
                title="Personal Codex instructions"
                description="Edit the global AGENTS.md that Codex reads from your home configuration."
              >
                <div className="space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-border bg-bg-primary p-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                        <Code2 size={15} className="text-accent" />
                        <span className="truncate font-mono text-xs">{codexAgentsPath}</span>
                      </div>
                      <p className="text-xs text-text-tertiary">
                        {codexAgentsExists
                          ? codexAgentsUpdatedAt
                            ? `Last saved ${new Date(codexAgentsUpdatedAt).toLocaleString()}`
                            : 'Existing personal instructions file.'
                          : 'File does not exist yet. Saving here will create it.'}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <button
                        onClick={refreshCodexAgentsFile}
                        disabled={codexAgentsLoading || codexAgentsSaving}
                        className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:border-text-tertiary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
                      >
                        {codexAgentsLoading ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : (
                          <RefreshCcw size={13} />
                        )}
                        Reload
                      </button>
                      <button
                        onClick={saveCodexAgentsFile}
                        disabled={codexAgentsLoading || codexAgentsSaving}
                        className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
                      >
                        {codexAgentsSaving ? (
                          <Loader2 size={13} className="animate-spin" />
                        ) : (
                          <Save size={13} />
                        )}
                        Save
                      </button>
                    </div>
                  </div>
                  <textarea
                    value={codexAgentsContent}
                    onChange={(event) => {
                      setCodexAgentsContent(event.target.value);
                      setCodexAgentsStatus(null);
                    }}
                    disabled={codexAgentsLoading}
                    placeholder="# Personal Codex Instructions"
                    rows={12}
                    className="min-h-72 w-full resize-y rounded-md border border-border bg-bg-primary px-3 py-2 font-mono text-sm leading-relaxed text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none disabled:opacity-60"
                  />
                  {codexAgentsStatus && (
                    <p
                      className={`text-sm ${
                        codexAgentsStatus.tone === 'success' ? 'text-success' : 'text-error'
                      }`}
                    >
                      {codexAgentsStatus.message}
                    </p>
                  )}
                </div>
              </SettingsPanel>

              <SettingsPanel
                title="Anvil Cloud"
                description="Expose Cell checks, local runtime inspection, and Lens from inside the app."
              >
                <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-bg-primary p-4 transition-colors hover:bg-bg-tertiary">
                  <input
                    type="checkbox"
                    checked={settings.cloudFeaturesEnabled ?? false}
                    onChange={(event) => void updateCloudFeatures(event.target.checked)}
                    className="mt-1 h-4 w-4 accent-accent"
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 text-sm font-medium text-text-primary">
                      <Cloud size={15} className="text-accent" />
                      Enable Cloud workbench
                    </span>
                    <span className="mt-1 block text-sm leading-relaxed text-text-secondary">
                      Adds a workspace tool for Anvil Cloud CLI diagnostics, local Cell artifacts,
                      workflows, services, agents, logs, and Anvil Lens. Nothing is enabled until
                      this box is checked.
                    </span>
                  </span>
                </label>
              </SettingsPanel>
            </SettingsCategory>

            <SettingsCategory
              id="delivery"
              title="Delivery integrations"
              description={deliverySummary.join(' / ')}
              icon={FolderGit2}
            >
              <SettingsPanel
                title="Work Items"
                description="Connect backlog and issue providers used by planning workflows."
              >
                <div className="space-y-3">
                  <label className="block text-sm text-text-secondary">Provider</label>
                  <ButtonGrid>
                    <ProviderButton
                      label="None"
                      description="No work item tracking"
                      active={wiProvider === 'none'}
                      onClick={() => update('workItemProvider', 'none')}
                    />
                    <ProviderButton
                      label="Azure DevOps"
                      description="ADO boards and backlogs"
                      active={wiProvider === 'ado'}
                      onClick={() => update('workItemProvider', 'ado')}
                    />
                    <ProviderButton
                      label="Linear"
                      description="Modern issue tracking"
                      active={wiProvider === 'linear'}
                      onClick={() => update('workItemProvider', 'linear')}
                    />
                    <ProviderButton
                      label="JIRA"
                      description="Atlassian project tracking"
                      active={wiProvider === 'jira'}
                      onClick={() => update('workItemProvider', 'jira')}
                    />
                  </ButtonGrid>
                </div>

                {wiProvider === 'ado' && (
                  <>
                    <Field
                      label="Organisation URL"
                      value={settings.adoOrganizationUrl ?? ''}
                      onChange={(v) => update('adoOrganizationUrl', v)}
                      placeholder="https://dev.azure.com/your-org"
                    />
                    <Field
                      label="Project"
                      value={settings.adoProject ?? ''}
                      onChange={(v) => update('adoProject', v)}
                    />
                    <Field
                      label="Team (optional)"
                      value={settings.adoTeam ?? ''}
                      onChange={(v) => update('adoTeam', v)}
                    />
                    <Field
                      label="Personal Access Token"
                      value={settings.adoPat ?? ''}
                      onChange={(v) => update('adoPat', v)}
                      type="password"
                    />
                  </>
                )}

                {wiProvider === 'linear' && (
                  <>
                    <Field
                      label="API Key"
                      value={settings.linearApiKey ?? ''}
                      onChange={(v) => update('linearApiKey', v)}
                      type="password"
                      placeholder="lin_api_..."
                    />
                    <div className="space-y-1">
                      <label className="block text-sm text-text-secondary">Team (optional)</label>
                      <div className="flex gap-2">
                        <select
                          value={settings.linearTeamId ?? ''}
                          onChange={(e) => update('linearTeamId', e.target.value)}
                          className="flex-1 rounded-md border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary focus:border-accent focus:outline-none"
                        >
                          <option value="">All teams</option>
                          {linearTeams.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name} ({t.key})
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={async () => {
                            setLoadingTeams(true);
                            await saveBeforeTest();
                            try {
                              const teams = await window.anvil.settings.listLinearTeams();
                              setLinearTeams(teams);
                            } catch {
                              setTestError('Failed to fetch teams — check your API key');
                            } finally {
                              setLoadingTeams(false);
                            }
                          }}
                          disabled={loadingTeams || !settings.linearApiKey}
                          className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-sm text-text-secondary transition-colors hover:border-text-tertiary hover:text-text-primary disabled:opacity-50"
                        >
                          {loadingTeams && <Loader2 size={12} className="animate-spin" />}
                          Fetch Teams
                        </button>
                      </div>
                      <p className="text-sm text-text-tertiary">
                        Save your API key first, then click Fetch Teams to discover available teams.
                      </p>
                    </div>
                  </>
                )}

                {wiProvider === 'jira' && (
                  <>
                    <Field
                      label="Host"
                      value={settings.jiraHost ?? ''}
                      onChange={(v) => update('jiraHost', v)}
                      placeholder="mycompany.atlassian.net"
                    />
                    <div className="space-y-1">
                      <label className="block text-sm text-text-secondary">Auth Mode</label>
                      <div className="flex gap-2">
                        <ProviderButton
                          label="Cloud"
                          description="Atlassian Cloud"
                          active={(settings.jiraAuthMode ?? 'cloud') === 'cloud'}
                          onClick={() => update('jiraAuthMode', 'cloud')}
                        />
                        <ProviderButton
                          label="Server"
                          description="Data Center / Server"
                          active={settings.jiraAuthMode === 'server'}
                          onClick={() => update('jiraAuthMode', 'server')}
                        />
                      </div>
                    </div>
                    <Field
                      label="Project Key"
                      value={settings.jiraProject ?? ''}
                      onChange={(v) => update('jiraProject', v)}
                      placeholder="ENG"
                    />
                    <Field
                      label="Board ID (optional)"
                      value={settings.jiraBoardId ?? ''}
                      onChange={(v) => update('jiraBoardId', v)}
                      placeholder="Auto-discovered if blank"
                    />
                    {(settings.jiraAuthMode ?? 'cloud') === 'cloud' && (
                      <Field
                        label="Email"
                        value={settings.jiraEmail ?? ''}
                        onChange={(v) => update('jiraEmail', v)}
                        placeholder="you@company.com"
                      />
                    )}
                    <Field
                      label="API Token"
                      value={settings.jiraApiToken ?? ''}
                      onChange={(v) => update('jiraApiToken', v)}
                      type="password"
                    />
                  </>
                )}

                {wiProvider !== 'none' && <TestButton status={wiStatus} onClick={testWi} />}
              </SettingsPanel>

              <SettingsPanel
                title="Documentation"
                description="Configure documentation providers for generated and retrieved project knowledge."
              >
                <div className="space-y-3">
                  <label className="block text-sm text-text-secondary">Provider</label>
                  <ButtonGrid>
                    <ProviderButton
                      label="None"
                      description="No documentation integration"
                      active={selectedDocsProvider === 'none'}
                      onClick={() => {
                        setDocsProvider('none');
                        update('docsProvider', 'none');
                      }}
                    />
                    <ProviderButton
                      label="Confluence"
                      description="Confluence Data Center"
                      active={selectedDocsProvider === 'confluence'}
                      onClick={() => {
                        setDocsProvider('confluence');
                        update('docsProvider', 'confluence');
                      }}
                    />
                    <ProviderButton
                      label="Notion"
                      description="Notion via MCP"
                      active={selectedDocsProvider === 'notion'}
                      onClick={() => {
                        setDocsProvider('notion');
                        update('docsProvider', 'notion');
                      }}
                    />
                  </ButtonGrid>
                </div>

                {selectedDocsProvider === 'confluence' && (
                  <>
                    <Field
                      label="Base URL"
                      value={settings.confluenceBaseUrl ?? ''}
                      onChange={(v) => update('confluenceBaseUrl', v)}
                      placeholder="https://confluence.internal.lancs.ac.uk"
                    />
                    <Field
                      label="Space Key"
                      value={settings.confluenceSpaceKey ?? ''}
                      onChange={(v) => update('confluenceSpaceKey', v)}
                    />
                    <Field
                      label="Personal Access Token"
                      value={settings.confluencePat ?? ''}
                      onChange={(v) => update('confluencePat', v)}
                      type="password"
                    />
                    <TestButton status={confluenceStatus} onClick={testConfluence} />
                  </>
                )}

                {selectedDocsProvider === 'notion' && (
                  <div className="space-y-4">
                    <div className="rounded-md border border-border bg-bg-primary p-4 space-y-3">
                      <h4 className="text-sm font-medium text-text-primary">Notion MCP Server</h4>
                      <p className="text-xs text-text-tertiary">
                        Notion integration requires the MCP server to be installed for Codex CLI.
                      </p>
                      {notionMcpInstalled ? (
                        <div className="flex items-center gap-2 text-sm text-success">
                          <CheckCircle size={14} />
                          MCP server installed
                        </div>
                      ) : (
                        <button
                          onClick={installNotionMcp}
                          disabled={notionInstalling}
                          className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:border-text-tertiary hover:text-text-primary disabled:opacity-50"
                        >
                          {notionInstalling && <Loader2 size={12} className="animate-spin" />}
                          Install MCP Server
                        </button>
                      )}
                    </div>

                    <div className="rounded-md border border-border bg-bg-primary p-4 space-y-3">
                      <h4 className="text-sm font-medium text-text-primary">
                        Notion Authentication
                      </h4>
                      <p className="text-xs text-text-tertiary">
                        Connect your Notion account via OAuth to access and create pages.
                      </p>
                      {settings.notionOauthToken ? (
                        <div className="flex items-center gap-2 text-sm text-success">
                          <CheckCircle size={14} />
                          Connected to Notion
                        </div>
                      ) : (
                        <button
                          onClick={connectNotion}
                          disabled={notionConnecting}
                          className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:border-text-tertiary hover:text-text-primary disabled:opacity-50"
                        >
                          {notionConnecting && <Loader2 size={12} className="animate-spin" />}
                          Connect Notion
                        </button>
                      )}
                    </div>

                    <Field
                      label="Database ID (optional)"
                      value={settings.notionDatabaseId ?? ''}
                      onChange={(v) => update('notionDatabaseId', v)}
                      placeholder="Used as default parent for new pages"
                    />
                  </div>
                )}

                {selectedDocsProvider !== 'none' && (
                  <TestButton status={docsStatus} onClick={testDocs} />
                )}
              </SettingsPanel>

              <SettingsPanel
                title="Git Provider"
                description="Credentials used to browse and clone remote repositories."
              >
                <div className="space-y-3">
                  <label className="block text-sm text-text-secondary">Provider</label>
                  <ButtonGrid>
                    <ProviderButton
                      label="GitHub"
                      description="GitHub.com or Enterprise"
                      active={gitProvider === 'github'}
                      onClick={() => setGitProvider('github')}
                    />
                    <ProviderButton
                      label="Azure DevOps"
                      description="ADO repositories"
                      active={gitProvider === 'ado'}
                      onClick={() => setGitProvider('ado')}
                    />
                  </ButtonGrid>
                </div>

                {gitProvider === 'github' && (
                  <div className="rounded-md border border-border bg-bg-primary p-3">
                    {ghUsername ? (
                      <div className="flex items-center gap-2">
                        <CheckCircle size={14} className="text-success" />
                        <span className="text-sm text-text-primary">
                          Authenticated as{' '}
                          <span className="font-medium text-accent">{ghUsername}</span>
                        </span>
                      </div>
                    ) : (
                      <div className="space-y-2">
                        <p className="text-sm text-text-secondary">
                          GitHub uses the{' '}
                          <code className="rounded bg-bg-tertiary px-1 py-0.5 text-xs font-mono text-accent">
                            gh
                          </code>{' '}
                          CLI for authentication.
                        </p>
                        {ghError && (
                          <div className="flex items-center gap-2 text-sm text-warning">
                            <XCircle size={14} />
                            {ghError}
                          </div>
                        )}
                        <p className="text-xs text-text-tertiary">
                          Run{' '}
                          <code className="rounded bg-bg-tertiary px-1 py-0.5 font-mono text-accent">
                            gh auth login
                          </code>{' '}
                          in your terminal, then check again.
                        </p>
                      </div>
                    )}
                  </div>
                )}

                {gitProvider === 'ado' && (
                  <>
                    <Field
                      label="Organisation URL"
                      value={settings.adoOrganizationUrl ?? ''}
                      onChange={(v) => update('adoOrganizationUrl', v)}
                      placeholder="https://dev.azure.com/your-org"
                    />
                    <Field
                      label="Personal Access Token"
                      value={settings.adoPat ?? ''}
                      onChange={(v) => update('adoPat', v)}
                      type="password"
                    />
                    <p className="text-xs text-text-tertiary">
                      These credentials are shared with Work Items if you also use ADO there.
                    </p>
                  </>
                )}

                <TestButton status={gitStatus} onClick={testGit} />
              </SettingsPanel>
            </SettingsCategory>

            <SettingsCategory
              id="review"
              title="Review defaults"
              description="Custom rubrics used when the app asks an agent to inspect code."
              icon={Code2}
            >
              <SettingsPanel
                title="Code Review Rubrics"
                description="Leave a rubric empty to use the built-in default for that review mode."
              >
                <div className="space-y-1">
                  <label className="block text-sm text-text-secondary">Quick Glance Rubric</label>
                  <p className="text-xs text-text-tertiary">
                    Custom review criteria for quick reviews. Leave empty to use the default.
                  </p>
                  <textarea
                    value={settings.codeReviewQuickGlanceRubric ?? ''}
                    onChange={(e) => update('codeReviewQuickGlanceRubric', e.target.value)}
                    placeholder="e.g. Focus on naming conventions, unused imports, and obvious null checks..."
                    rows={4}
                    className="w-full rounded-md border border-border bg-bg-primary px-3 py-1.5 font-mono text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-sm text-text-secondary">
                    Senior Dev Review Rubric
                  </label>
                  <p className="text-xs text-text-tertiary">
                    Custom review criteria for thorough reviews. Leave empty to use the default.
                  </p>
                  <textarea
                    value={settings.codeReviewSeniorDevRubric ?? ''}
                    onChange={(e) => update('codeReviewSeniorDevRubric', e.target.value)}
                    placeholder="e.g. Check for SOLID violations, test coverage gaps, race conditions, N+1 queries..."
                    rows={4}
                    className="w-full rounded-md border border-border bg-bg-primary px-3 py-1.5 font-mono text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
                  />
                </div>
              </SettingsPanel>
            </SettingsCategory>

            <SettingsCategory
              id="devices"
              title="Devices & system"
              description="Local defaults, companion devices, and network pairing."
              icon={MonitorSmartphone}
            >
              <SettingsPanel
                title="General"
                description="Defaults used when the app needs a local repository location."
              >
                <Field
                  label="Default Repo Path"
                  value={settings.defaultRepoPath ?? ''}
                  onChange={(v) => update('defaultRepoPath', v)}
                  placeholder="/Users/you/repos"
                />
              </SettingsPanel>

              <SettingsPanel
                title="Mobile Companion"
                description="Control this Anvil instance from phone, widgets, Raycast, watch, and the macOS menu bar over your local network or Tailscale."
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                      <Smartphone size={16} className="text-accent" />
                      Control this Anvil instance from companion surfaces
                    </div>
                    <p className="text-sm text-text-secondary">
                      Pair over your local network or Tailscale. Companion surfaces can resolve
                      approvals, launch status sweeps, review changes, hunt missing tests, draft
                      handoffs, publish live widget status, and interrupt active sessions without
                      exposing a tiny remote shell.
                    </p>
                    {mobileStatus?.baseUrl && (
                      <p className="truncate font-mono text-xs text-text-tertiary">
                        {mobileStatus.baseUrl}
                      </p>
                    )}
                  </div>
                  <button
                    onClick={toggleMobileCompanion}
                    disabled={mobileBusy}
                    className={`shrink-0 rounded-md border px-3 py-1.5 text-sm transition-colors disabled:opacity-50 ${
                      mobileStatus?.enabled
                        ? 'border-success/50 text-success hover:bg-success/10'
                        : 'border-border text-text-secondary hover:bg-bg-tertiary hover:text-text-primary'
                    }`}
                  >
                    {mobileStatus?.enabled ? 'Enabled' : 'Enable'}
                  </button>
                </div>

                {mobileStatus?.enabled && (
                  <div className="space-y-4">
                    <div className="rounded-md border border-border bg-bg-primary p-3">
                      <p className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
                        Command deck workflows
                      </p>
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        {[
                          'Status sweep',
                          'Review current change',
                          'Find missing tests',
                          'Ship handoff',
                        ].map((item) => (
                          <div
                            key={item}
                            className="rounded-md border border-border-subtle bg-bg-secondary px-3 py-2 text-sm font-medium text-text-primary"
                          >
                            {item}
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="rounded-md border border-border bg-bg-primary p-3">
                      <p className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
                        Available addresses
                      </p>
                      <div className="mt-2 space-y-1">
                        {mobileStatus.advertisedAddresses.map((address) => (
                          <div
                            key={address.url}
                            className="flex items-center justify-between gap-3"
                          >
                            <span className="text-sm text-text-secondary">{address.label}</span>
                            <span className="truncate font-mono text-xs text-text-tertiary">
                              {address.url}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-start gap-4">
                      <button
                        onClick={createPairingTicket}
                        disabled={mobileBusy}
                        className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
                      >
                        {pairingTicket ? 'Refresh QR code' : 'Create QR code'}
                      </button>
                      {pairingTicket && (
                        <div className="rounded-lg border border-border bg-white p-3">
                          <div
                            className="h-48 w-48"
                            dangerouslySetInnerHTML={{ __html: pairingTicket.qrSvg }}
                          />
                        </div>
                      )}
                      {pairingTicket && (
                        <div className="min-w-0 flex-1 space-y-1">
                          <p className="text-sm text-text-secondary">
                            Scan this in the mobile app. Expires{' '}
                            {new Date(pairingTicket.expiresAt).toLocaleTimeString()}.
                          </p>
                          <p className="break-all font-mono text-xs text-text-tertiary">
                            {pairingTicket.pairingUrl}
                          </p>
                        </div>
                      )}
                    </div>

                    <div className="rounded-md border border-border bg-bg-primary p-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 space-y-1">
                          <p className="text-sm font-medium text-text-primary">Raycast access</p>
                          <p className="text-sm text-text-secondary">
                            Create a bearer token for the internal Raycast extension. The token is
                            shown once, because secrets should not become decorative UI.
                          </p>
                        </div>
                        <button
                          onClick={createRaycastToken}
                          disabled={mobileBusy}
                          className="shrink-0 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
                        >
                          Create Raycast token
                        </button>
                      </div>
                      {raycastToken && (
                        <div className="mt-3 space-y-2 rounded-md border border-warning/30 bg-warning/5 p-3">
                          <p className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
                            Copy into Raycast extension preferences
                          </p>
                          <p className="break-all font-mono text-xs text-text-secondary">
                            Base URL: {raycastToken.baseUrl}
                          </p>
                          <p className="break-all font-mono text-xs text-text-secondary">
                            Token: {raycastToken.token}
                          </p>
                        </div>
                      )}
                    </div>

                    <div className="space-y-2">
                      <p className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
                        Paired devices
                      </p>
                      {mobileDevices.length === 0 ? (
                        <p className="text-sm text-text-tertiary">No paired devices yet.</p>
                      ) : (
                        <div className="space-y-2">
                          {mobileDevices.map((device) => (
                            <div
                              key={device.id}
                              className="flex items-center justify-between gap-3 rounded-md border border-border bg-bg-primary px-3 py-2"
                            >
                              <div className="min-w-0">
                                <p className="truncate text-sm font-medium text-text-primary">
                                  {device.name}
                                </p>
                                <p className="text-xs text-text-tertiary">
                                  {formatCompanionClientType(device.clientType)} -{' '}
                                  {device.revokedAt
                                    ? `Revoked ${new Date(device.revokedAt).toLocaleString()}`
                                    : device.lastSeenAt
                                      ? `Last seen ${new Date(device.lastSeenAt).toLocaleString()}`
                                      : `Paired ${new Date(device.createdAt).toLocaleString()}`}
                                </p>
                              </div>
                              {!device.revokedAt && (
                                <button
                                  onClick={() => void revokeMobileDevice(device.id)}
                                  disabled={mobileBusy}
                                  className="rounded-md p-1.5 text-text-tertiary transition-colors hover:bg-error/10 hover:text-error disabled:opacity-50"
                                  title="Revoke device"
                                  aria-label={`Revoke ${device.name}`}
                                >
                                  <Trash2 size={14} />
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </SettingsPanel>
            </SettingsCategory>

            <SettingsCategory
              id="danger"
              title="Danger area"
              description="Reset first-run setup and workspace selections. Handle with tongs."
              icon={ShieldAlert}
            >
              <SettingsPanel
                title="Reset onboarding"
                description="Start the MissionControl wizard again. This clears workspace selections and preferences."
                tone="danger"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    onClick={handleResetOnboarding}
                    disabled={resetting}
                    className="flex items-center gap-2 rounded-md border border-error/50 px-3 py-1.5 text-sm text-error transition-colors hover:bg-error/10 disabled:opacity-50"
                  >
                    {resetting && <Loader2 size={12} className="animate-spin" />}
                    {resetting ? 'Resetting...' : 'Reset MissionControl'}
                  </button>
                  {resetDone && (
                    <span className="flex items-center gap-1 text-sm text-success">
                      <CheckCircle size={14} /> Onboarding state cleared
                    </span>
                  )}
                </div>
              </SettingsPanel>
            </SettingsCategory>
          </main>
        </div>
      </div>
    </div>
  );
}

function CodexUsagePanel({
  snapshot,
  loading,
  onRefresh,
}: {
  snapshot: CodexUsageSnapshot | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const defaultLimit = snapshot?.defaultLimit;
  const additionalLimits =
    snapshot?.limits.filter((limit) => limit.id !== defaultLimit?.id).slice(0, 3) ?? [];
  const recentBuckets = snapshot?.tokenUsage?.recentDailyBuckets ?? [];
  const peakRecentTokens = Math.max(1, ...recentBuckets.map((bucket) => bucket.tokens));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          <SummaryChip
            label="CLI"
            value={
              snapshot?.cliInstalled
                ? snapshot.cliVersion || 'Installed'
                : loading
                  ? 'Checking'
                  : 'Missing'
            }
          />
          {defaultLimit?.planType && <SummaryChip label="Plan" value={defaultLimit.planType} />}
          {snapshot?.resetCreditsAvailable !== null &&
            snapshot?.resetCreditsAvailable !== undefined && (
              <SummaryChip label="Resets" value={String(snapshot.resetCreditsAvailable)} />
            )}
        </div>
        <button
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:border-text-tertiary hover:bg-bg-tertiary hover:text-text-primary disabled:opacity-50"
        >
          {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCcw size={13} />}
          Refresh
        </button>
      </div>

      {snapshot?.status === 'unavailable' && (
        <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">
            {snapshot.error ||
              'Codex usage is not available from the local CLI. Run codex login, then refresh.'}
          </span>
        </div>
      )}

      {!snapshot && loading && (
        <div className="flex items-center gap-2 rounded-md border border-border bg-bg-primary px-3 py-2 text-sm text-text-secondary">
          <Loader2 size={14} className="animate-spin" />
          Reading Codex account usage
        </div>
      )}

      {defaultLimit && (
        <div className="rounded-md border border-border bg-bg-primary p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <Gauge size={16} className="shrink-0 text-accent" />
              <h5 className="truncate text-sm font-semibold text-text-primary">
                {defaultLimit.label} quota
              </h5>
            </div>
            {defaultLimit.rateLimitReachedType && (
              <span className="rounded-full border border-error/30 bg-error/10 px-2 py-0.5 text-xs text-error">
                Limited
              </span>
            )}
          </div>
          <div className="space-y-3">
            {defaultLimit.primary && (
              <CodexQuotaRow label="Session" window={defaultLimit.primary} />
            )}
            {defaultLimit.secondary && (
              <CodexQuotaRow label="Weekly" window={defaultLimit.secondary} />
            )}
          </div>
          {defaultLimit.credits && (
            <p className="mt-3 text-xs text-text-tertiary">
              Credits:{' '}
              {defaultLimit.credits.unlimited
                ? 'unlimited'
                : defaultLimit.credits.hasCredits
                  ? defaultLimit.credits.balance || 'available'
                  : 'none available'}
            </p>
          )}
        </div>
      )}

      {snapshot?.tokenUsage && (
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <div className="rounded-md border border-border bg-bg-primary p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary">
              <BarChart3 size={16} className="text-accent" />
              Token usage
            </div>
            <div className="grid grid-cols-2 gap-2">
              <MetricTile
                label="Lifetime"
                value={formatTokenCount(snapshot.tokenUsage.lifetimeTokens)}
              />
              <MetricTile
                label="Peak day"
                value={formatTokenCount(snapshot.tokenUsage.peakDailyTokens)}
              />
              <MetricTile
                label="Current streak"
                value={formatDays(snapshot.tokenUsage.currentStreakDays)}
              />
              <MetricTile
                label="Longest turn"
                value={formatSeconds(snapshot.tokenUsage.longestRunningTurnSec)}
              />
            </div>
          </div>

          <div className="rounded-md border border-border bg-bg-primary p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary">
              <Clock3 size={16} className="text-accent" />
              Recent daily tokens
            </div>
            {recentBuckets.length === 0 ? (
              <p className="text-sm text-text-tertiary">No recent token buckets reported.</p>
            ) : (
              <div className="flex h-28 items-end gap-1">
                {recentBuckets.map((bucket) => (
                  <div
                    key={bucket.startDate}
                    className="flex min-w-0 flex-1 flex-col items-center gap-1"
                    title={`${bucket.startDate}: ${formatTokenCount(bucket.tokens)}`}
                  >
                    <div className="flex h-20 w-full items-end rounded-sm bg-bg-tertiary">
                      <div
                        className="w-full rounded-sm bg-accent/80"
                        style={{
                          height: `${Math.max(4, (bucket.tokens / peakRecentTokens) * 100)}%`,
                        }}
                      />
                    </div>
                    <span className="max-w-full truncate text-[10px] text-text-tertiary">
                      {formatShortDate(bucket.startDate)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {additionalLimits.length > 0 && (
        <div className="rounded-md border border-border bg-bg-primary p-4">
          <h5 className="mb-3 text-sm font-semibold text-text-primary">Model-specific limits</h5>
          <div className="space-y-3">
            {additionalLimits.map((limit) => (
              <div key={limit.id} className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-sm font-medium text-text-primary">
                    {limit.label}
                  </span>
                  {limit.primary && (
                    <span className="shrink-0 text-xs text-text-tertiary">
                      {limit.primary.remainingPercent}% left
                    </span>
                  )}
                </div>
                {limit.primary && <ProgressBar percent={limit.primary.usedPercent} />}
              </div>
            ))}
          </div>
        </div>
      )}

      {snapshot?.refreshedAt && (
        <p className="text-xs text-text-tertiary">
          Last checked {new Date(snapshot.refreshedAt).toLocaleString()}
        </p>
      )}
    </div>
  );
}

function CodexQuotaRow({
  label,
  window,
}: {
  label: string;
  window: NonNullable<CodexUsageSnapshot['defaultLimit']>['primary'];
}) {
  if (!window) return null;

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="font-medium text-text-primary">{label}</span>
        <span className="text-text-secondary">
          {window.remainingPercent}% left
          {window.resetsAt ? ` - resets ${formatResetTime(window.resetsAt)}` : ''}
        </span>
      </div>
      <ProgressBar percent={window.usedPercent} />
      <p className="text-xs text-text-tertiary">
        {formatDurationMins(window.windowDurationMins)} window, {window.usedPercent}% used
      </p>
    </div>
  );
}

function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="h-2 overflow-hidden rounded-full bg-bg-tertiary">
      <div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
    </div>
  );
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border-subtle bg-bg-secondary px-3 py-2">
      <div className="text-xs text-text-tertiary">{label}</div>
      <div className="mt-0.5 truncate text-sm font-semibold text-text-primary">{value}</div>
    </div>
  );
}

function ThemeButton({
  label,
  description,
  swatches,
  active,
  onClick,
}: {
  label: string;
  description: string;
  swatches: [string, string, string];
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg border p-3 text-left transition-colors ${
        active ? 'border-accent bg-accent/10' : 'border-border bg-bg-primary hover:bg-bg-tertiary'
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className={`text-sm font-medium ${active ? 'text-accent' : 'text-text-primary'}`}>
          {label}
        </div>
        <div className="flex shrink-0 overflow-hidden rounded-full border border-border-subtle">
          {swatches.map((swatch) => (
            <span
              key={swatch}
              className="h-5 w-5"
              style={{ backgroundColor: swatch }}
              aria-hidden="true"
            />
          ))}
        </div>
      </div>
      <div className="mt-1 text-sm text-text-tertiary">{description}</div>
    </button>
  );
}

function ProviderButton({
  label,
  description,
  active,
  onClick,
}: {
  label: string;
  description: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`min-w-0 flex-1 rounded-lg border p-3 text-left transition-colors sm:min-w-[10rem] ${
        active ? 'border-accent bg-accent/10' : 'border-border bg-bg-primary hover:bg-bg-tertiary'
      }`}
    >
      <div className={`text-sm font-medium ${active ? 'text-accent' : 'text-text-primary'}`}>
        {label}
      </div>
      <div className="mt-0.5 text-sm text-text-tertiary">{description}</div>
    </button>
  );
}

function formatReasoningLabel(effort: ReasoningEffort): string {
  if (effort === 'xhigh') return 'Extra High';
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

function describeReasoningEffort(effort: ReasoningEffort): string {
  switch (effort) {
    case 'none':
      return 'No extended reasoning';
    case 'minimal':
      return 'Tiny prompts';
    case 'low':
      return 'Quick scoped work';
    case 'medium':
      return 'Default coding';
    case 'high':
      return 'Complex changes';
    case 'xhigh':
      return 'Hard tradeoffs';
    case 'max':
      return 'Deep single task';
    case 'ultra':
      return 'Subagent work';
  }
}

function ReasoningButton({
  label,
  description,
  active,
  onClick,
}: {
  label: string;
  description: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`min-w-0 flex-1 rounded-lg border p-3 text-left transition-colors sm:min-w-[9rem] ${
        active ? 'border-accent bg-accent/10' : 'border-border bg-bg-primary hover:bg-bg-tertiary'
      }`}
    >
      <div className={`text-sm font-medium ${active ? 'text-accent' : 'text-text-primary'}`}>
        {label}
      </div>
      <div className="mt-0.5 text-sm text-text-tertiary">{description}</div>
    </button>
  );
}

function CapabilityChip({ label, active }: { label: string; active: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
        active
          ? 'border-success/40 bg-success/10 text-success'
          : 'border-border-subtle bg-bg-secondary text-text-tertiary'
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-success' : 'bg-text-tertiary/50'}`}
      />
      {label}
    </span>
  );
}

function SummaryChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border-subtle bg-bg-primary px-2.5 py-1 text-xs text-text-secondary">
      <span className="text-text-tertiary">{label}</span>
      <span className="font-medium text-text-primary">{value}</span>
    </span>
  );
}

function formatTokenCount(value: number | null): string {
  if (value === null) return 'Unknown';
  return new Intl.NumberFormat(undefined, {
    notation: value >= 1_000_000 ? 'compact' : 'standard',
    maximumFractionDigits: value >= 1_000_000 ? 1 : 0,
  }).format(value);
}

function formatDays(value: number | null): string {
  if (value === null) return 'Unknown';
  return `${value}d`;
}

function formatSeconds(value: number | null): string {
  if (value === null) return 'Unknown';
  if (value < 60) return `${value}s`;
  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function formatDurationMins(value: number | null): string {
  if (value === null) return 'Unknown';
  if (value < 60) return `${value} min`;
  const hours = value / 60;
  if (Number.isInteger(hours)) return `${hours} hr`;
  return `${hours.toFixed(1)} hr`;
}

function formatResetTime(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatShortDate(value: string): string {
  return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function ButtonGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">{children}</div>;
}

function formatCompanionClientType(type: MobileCompanionDevice['clientType']): string {
  switch (type) {
    case 'raycast':
      return 'Raycast';
    case 'watch':
      return 'Watch';
    case 'widget':
      return 'Widget';
    case 'menubar':
      return 'Menu bar';
    case 'mobile':
    default:
      return 'Mobile';
  }
}

function SettingsCategory({
  id,
  title,
  description,
  icon: Icon,
  children,
}: {
  id: SettingsCategoryId;
  title: string;
  description: string;
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <section id={`settings-${id}`} className="scroll-mt-6 space-y-3">
      <div className="flex items-start gap-3">
        <div className="rounded-md border border-border-subtle bg-bg-secondary p-2 text-accent">
          <Icon size={18} />
        </div>
        <div className="min-w-0">
          <h3 className="text-lg font-semibold text-text-primary">{title}</h3>
          <p className="text-sm text-text-secondary">{description}</p>
        </div>
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function SettingsPanel({
  title,
  description,
  tone = 'default',
  children,
}: {
  title: string;
  description?: string;
  tone?: 'default' | 'danger';
  children: ReactNode;
}) {
  return (
    <section
      className={`space-y-4 rounded-lg border p-5 ${
        tone === 'danger' ? 'border-error/30 bg-error/5' : 'border-border bg-bg-secondary'
      }`}
    >
      <div>
        <h4 className="text-base font-semibold text-text-primary">{title}</h4>
        {description && <p className="mt-1 text-sm text-text-secondary">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: 'text' | 'password';
}) {
  return (
    <div className="space-y-1">
      <label className="block text-sm text-text-secondary">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary placeholder:text-text-tertiary focus:border-accent focus:outline-none"
      />
    </div>
  );
}

function TestButton({
  status,
  onClick,
  label = 'Test Connection',
}: {
  status: TestStatus;
  onClick: () => void;
  label?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={status === 'testing'}
      className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:border-text-tertiary hover:text-text-primary disabled:opacity-50"
    >
      {status === 'testing' && <Loader2 size={12} className="animate-spin" />}
      {status === 'ok' && <CheckCircle size={12} className="text-success" />}
      {status === 'error' && <XCircle size={12} className="text-error" />}
      {label}
    </button>
  );
}
