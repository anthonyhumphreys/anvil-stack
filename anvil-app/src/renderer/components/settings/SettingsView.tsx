import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bot,
  CheckCircle,
  ClipboardCheck,
  Code2,
  FolderGit2,
  Loader2,
  MonitorSmartphone,
  Palette,
  Puzzle,
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
  DocsProvider,
  MobileCompanionDevice,
  MobileCompanionStatus,
  MobilePairingTicket,
  RaycastCompanionToken,
  UserRole,
} from '../../../shared/types';
import { useBrand } from '../../contexts/BrandContext';

type TestStatus = 'idle' | 'testing' | 'ok' | 'error';
type SettingsCategoryId = 'profile' | 'ai' | 'delivery' | 'review' | 'devices' | 'danger';

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
    refreshMobileCompanion().catch(console.error);
  }, []);

  const update = (key: keyof AppSettings, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
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
      await window.anvil.settings.update(settings);
      if (settings.chatLayout === 'classic' || settings.chatLayout === 'workitems') {
        window.dispatchEvent(
          new CustomEvent('anvil:chat-layout-changed', { detail: settings.chatLayout }),
        );
      }
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

  const provider = settings.llmProvider ?? 'openai';
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
                    Routes requests through your local Codex CLI installation. No API key needed —
                    just run <code className="rounded bg-bg-primary px-1 text-xs">codex</code> and
                    sign in if you haven't already. Model is controlled by your Codex config
                    (~/.codex/config.toml).
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
                    <Field
                      label="Model"
                      value={settings.openaiModel ?? 'gpt-5.5'}
                      onChange={(v) => update('openaiModel', v)}
                      placeholder="gpt-5.5"
                    />
                    <div className="space-y-1">
                      <label className="block text-sm text-text-secondary">Reasoning Level</label>
                      <div className="flex gap-2">
                        <ReasoningButton
                          label="Low"
                          description="Fast responses, simple tasks"
                          active={settings.reasoningLevel === 'low'}
                          onClick={() => update('reasoningLevel', 'low')}
                        />
                        <ReasoningButton
                          label="Medium"
                          description="Balanced for most coding"
                          active={settings.reasoningLevel === 'medium'}
                          onClick={() => update('reasoningLevel', 'medium')}
                        />
                        <ReasoningButton
                          label="High"
                          description="Deep planning & architecture"
                          active={settings.reasoningLevel === 'high'}
                          onClick={() => update('reasoningLevel', 'high')}
                        />
                      </div>
                      <p className="text-xs text-text-tertiary">
                        GPT-5.5 reasoning effort: low for quick answers, medium for coding, high for
                        planning.
                      </p>
                    </div>
                    <p className="text-xs text-text-tertiary">
                      Recommended: gpt-5.5 (default), gpt-5.4, gpt-5.3-codex (optimised for code)
                    </p>
                  </>
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
                        <span className="text-success">"gpt-5.5"</span>{' '}
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

function SummaryChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border-subtle bg-bg-primary px-2.5 py-1 text-xs text-text-secondary">
      <span className="text-text-tertiary">{label}</span>
      <span className="font-medium text-text-primary">{value}</span>
    </span>
  );
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

function TestButton({ status, onClick }: { status: TestStatus; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={status === 'testing'}
      className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:border-text-tertiary hover:text-text-primary disabled:opacity-50"
    >
      {status === 'testing' && <Loader2 size={12} className="animate-spin" />}
      {status === 'ok' && <CheckCircle size={12} className="text-success" />}
      {status === 'error' && <XCircle size={12} className="text-error" />}
      Test Connection
    </button>
  );
}
